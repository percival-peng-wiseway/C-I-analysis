"""Synthetic tariffs only; exercises intake through the suggested UI contract."""
from types import SimpleNamespace

import pytest

from solar_battery.ci_bill_document import BillText, extract_bill_document
from solar_battery.ci_bill_tariff_layout import extract_layout_tariff_lines
from solar_battery.ci_evidence_intake import _parse_invoice_text
from solar_battery.ci_project_tariff_profile import _suggested_profile, validate_ci_project_tariff_profile
from solar_battery.ci_projects import CiProjectError
from tests.test_ci_bill_document import native_pdf, scan_pdf
from tests.test_ci_evidence_intake import GENERIC_BILL_TEXT

DETAIL = '''
ENERGY CHARGES
Quantity Unit Rate Unit Amount (Ex GST)
Peak 100 kWh 0.30 $/kWh $30.00
Off-Peak 200 kWh 12 c/kWh $24.00
NETWORK CHARGES
Quantity Unit Rate Unit Amount (Ex GST)
Peak 100 kWh 5 c/kWh $5.00
Off Peak 200 kWh 2 c/kWh $4.00
Rolling Demand 20 kVA 4.5 $/kVA/month $90.00
Incentive Demand 10 kVA 3 $/kVA/month $30.00
METERING CHARGES
Quantity Unit Rate Unit Amount (Ex GST)
Metering Charge 30 days 150 c/day $45.00
Value Added Service Charge 30 days 0.10 $/day $3.00
MLF: 1.02
DLF: 1.10
'''


def document(text=DETAIL, method='native_text'):
    lines = [{'page': 1, 'text': line, 'bbox': [0, i * 12, 580, i * 12 + 10], 'method': method, 'confidence': .99}
             for i, line in enumerate(text.strip().splitlines())]
    return BillText(text, [{'page': 1, 'method': method, 'lines': lines, 'tables': []}], [])


def test_native_and_ocr_candidates_prefill_without_summary_categories():
    for method in ('native_text', 'paddle_ocr'):
        bill = _parse_invoice_text(document(GENERIC_BILL_TEXT + '\nCurrent charges $46.20\n' + DETAIL, method), bill_review=None)
        draft = _suggested_profile(SimpleNamespace(inspection_result_json={'bill': bill}))
        assert draft['rates']['retail_peak_c_per_kwh'] == 30
        assert draft['rates']['retail_off_peak_c_per_kwh'] == 12
        assert draft['rates']['network_peak_c_per_kwh'] == 5
        assert draft['rates']['rolling_demand_aud_per_kva_month'] == 4.5
        assert draft['rates']['metering_aud_per_day'] == 1.5
        assert draft['rates']['value_added_c_per_day'] == 10
        assert draft['rates']['aemo_participant_c_per_kwh'] is None
        assert draft['factors'] == {'mlf': 1.02, 'dlf': 1.1}
        assert draft['additional_bill_adjustment_aud'] is None
        assert bill['review_status'] == 'confirmation_required'
        assert any(s['field'] == 'tariff_retail_peak_c_per_kwh' for s in bill['extraction_audit']['sources'])
        with pytest.raises(CiProjectError):
            validate_ci_project_tariff_profile(draft)


@pytest.mark.parametrize(('old', 'new', 'field'), [
    ('$30.00', '$31.00', 'retail_peak_c_per_kwh'),
    ('$/kVA/month', '$/kVA', 'rolling_demand_aud_per_kva_month'),
    ('$/kVA/month', '$/kVA/day', 'rolling_demand_aud_per_kva_month'),
    ('20 kVA', '20 kW', 'rolling_demand_aud_per_kva_month'),
    ('Ex GST', 'Inc GST', 'retail_peak_c_per_kwh'),
    ('ENERGY CHARGES', 'UNKNOWN CHARGES', 'retail_peak_c_per_kwh'),
    ('Peak 100 kWh', 'Shoulder 100 kWh', 'retail_peak_c_per_kwh'),
])
def test_unknown_or_unreconciled_terms_are_never_assumed(old, new, field):
    assert field not in extract_layout_tariff_lines(document(DETAIL.replace(old, new)))['rates']


def test_conflicting_rows_and_low_confidence_do_not_clear_other_good_rates():
    doc = document(DETAIL.replace('Off-Peak', 'Peak 100 kWh 0.40 $/kWh $40.00\nOff-Peak'), 'paddle_ocr')
    detected = extract_layout_tariff_lines(doc)
    assert 'retail_peak_c_per_kwh' not in detected['rates']
    assert detected['rates']['retail_off_peak_c_per_kwh'] == 12
    doc = document(method='paddle_ocr')
    doc.pages[0]['lines'][2]['confidence'] = .6
    detected = extract_layout_tariff_lines(doc)
    assert 'retail_peak_c_per_kwh' not in detected['rates']
    assert detected['rates']['network_peak_c_per_kwh'] == 5
    assert detected['issues']


def test_factor_columns_and_native_tables_have_source_backed_rates():
    text = 'ENERGY CHARGES\nQuantity Unit Rate Unit MLF DLF Amount (Ex GST)\nPeak 100 kWh 12.5 c/kWh 1.02 1.10 $14.03'
    detected = extract_layout_tariff_lines(document(text))
    assert detected['rates']['retail_peak_c_per_kwh'] == 12.5
    assert detected['factors'] == {'mlf': 1.02, 'dlf': 1.1}
    doc = document('')
    doc.pages[0]['tables'] = [{'bbox': [0, 0, 580, 100], 'rows': [line.split() for line in text.splitlines()]}]
    detected = extract_layout_tariff_lines(doc)
    assert detected['rates']['retail_peak_c_per_kwh'] == 12.5
    assert detected['sources'][0]['method'] == 'native_table'


def test_real_pdf_native_extraction_reaches_draft():
    bill = _parse_invoice_text(extract_bill_document(native_pdf(GENERIC_BILL_TEXT + '\n' + DETAIL)), bill_review=None)
    assert bill['tariff_line_items']['rates']['retail_peak_c_per_kwh'] == 30


@pytest.mark.skipif(not __import__('os').environ.get('CI_PADDLE_MODEL_DIR'), reason='optional provisioned offline models')
def test_real_offline_ocr_rates():
    text = GENERIC_BILL_TEXT + '\nCurrent charges $46.20\n' + DETAIL
    bill = _parse_invoice_text(extract_bill_document(scan_pdf(text)), bill_review=None)
    assert bill['extraction_method'] == 'paddle_ocr_layout'
    assert bill['tariff_line_items']['rates']['retail_peak_c_per_kwh'] == 30
    assert bill['tariff_line_items']['rates']['network_peak_c_per_kwh'] == 5
    assert bill['review_status'] == 'confirmation_required'


def test_unsupported_second_rate_does_not_leave_a_misleading_single_rate():
    text = DETAIL.replace('Off-Peak', 'Peak 100 kWh 30 unknown-unit $30.00\nOff-Peak')
    detected = extract_layout_tariff_lines(document(text))
    assert 'retail_peak_c_per_kwh' not in detected['rates']
    assert detected['rates']['retail_off_peak_c_per_kwh'] == 12

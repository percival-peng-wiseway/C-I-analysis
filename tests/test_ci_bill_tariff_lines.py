from copy import deepcopy
from types import SimpleNamespace

import pytest

from solar_battery.ci_bill_tariff_lines import extract_bill_tariff_lines
from solar_battery.ci_evidence_intake import _normalise_invoice_text, _parse_invoice_text
from solar_battery.ci_project_tariff_profile import _suggested_profile, validate_ci_project_tariff_profile
from solar_battery.ci_projects import CiProjectError
from tests.test_ci_evidence_intake import BILL_TEXT

# Entirely synthetic quantities, rates and totals; no customer evidence.
DETAILS = """
ENERGY CHARGES
Energy Charges Quantity Unit Rate Unit MLF DLF Amount $ (Ex GST)
Peak 100 kWh 12.500000 ¢/kWh 1.02000 1.10000 $14.03
Off-Peak 200 kWh 8.000000 ¢/kWh 1.02000 1.10000 $17.95
Total Energy Charges $35.18
NETWORK CHARGES
Network Provider: Example | Tariff: LLVT2
Incentive Demand 10 kVA 3.500000 $/kVA $35.00
Demand Charge 20 kVA 4.500000 $/kVA $90.00
Peak 120 kWh 2.500000 ¢/kWh $3.00
Off Peak 180 kWh 1.500000 ¢/kWh $2.70
Network Provider: Example | Tariff: GENR13
Embedded Generation -1 kWh 0 ¢/kWh $0.00
Total Network Charges $143.77
REGULATED CHARGES
AEMO Ancillary Charge and UFE Charge 300 kWh 0.100000 ¢/kWh 1.10000 $0.33
AEMO Participant Charge 300 kWh 0.200000 ¢/kWh 1.10000 $0.66
AEMO FRC Operations 30 Days 5.000000 ¢/Day $1.50
Total Regulated Charges $2.74
ENVIRONMENTAL CHARGES
VEEC Charge 300 kWh 10.000000 ¢/kWh 10.00 1.10000 $3.30
SREC Charge 300 kWh 5.000000 ¢/kWh 20.00 1.10000 $3.30
LREC Charge 300 kWh 2.000000 ¢/kWh 25.00 1.10000 $1.65
Sub-Total $8.25
Total Environmental Charges $9.08
METERING AND SERVICES CHARGES
Metering Charge 1 Meter 2.000000 $/Meter 30 Days $60.00
Value Added Service Charge 30 Days 10.000000 ¢/Day $3.00
Supplementary Metering Charge 1 Meter 0 ¢/Meter 30 Days $0.00
Total Meter and Service Charges $69.30
"""


def extract(details=DETAILS):
    return extract_bill_tariff_lines(_normalise_invoice_text(BILL_TEXT + details))


def test_explicit_rates_factors_and_certificate_lines_survive_intake():
    bill = _parse_invoice_text(BILL_TEXT + DETAILS, bill_review=None)
    detected = bill['tariff_line_items']
    assert detected['rates'] == {
        'retail_peak_c_per_kwh': 12.5, 'retail_off_peak_c_per_kwh': 8.0,
        'network_peak_c_per_kwh': 2.5, 'network_off_peak_c_per_kwh': 1.5,
        'incentive_demand_aud_per_kva_month': 3.5, 'rolling_demand_aud_per_kva_month': 4.5,
        'aemo_ancillary_c_per_kwh': .1, 'aemo_participant_c_per_kwh': .2,
        'aemo_frc_c_per_day': 5.0, 'metering_aud_per_day': 2.0, 'value_added_c_per_day': 10.0,
    }
    assert detected['factors'] == {'mlf': 1.02, 'dlf': 1.1}
    assert detected['environmental'] == [
        {'label': 'VEEC Charge', 'rate_c_per_kwh': 10., 'certificate_fraction': .1},
        {'label': 'SREC Charge', 'rate_c_per_kwh': 5., 'certificate_fraction': .2},
        {'label': 'LREC Charge', 'rate_c_per_kwh': 2., 'certificate_fraction': .25},
    ]
    suggestion = _suggested_profile(SimpleNamespace(inspection_result_json={'bill': bill}))
    assert suggestion['rates']['retail_peak_c_per_kwh'] == 12.5
    assert suggestion['rates']['retail_off_peak_c_per_kwh'] == 8.
    assert validate_ci_project_tariff_profile(suggestion)['environmental'] == detected['environmental']


@pytest.mark.parametrize(('old', 'new', 'key'), [
    ('$14.03', '$99.00', 'retail_peak_c_per_kwh'),
    ('12.500000 ¢/kWh', '12.500000 $/kWh', 'retail_peak_c_per_kwh'),
    ('Off-Peak 200', 'Shoulder 200', 'retail_off_peak_c_per_kwh'),
    ('0.200000 ¢/kWh', '-0.200000 ¢/kWh', 'aemo_participant_c_per_kwh'),
    ('5.000000 ¢/Day', '5.000000 ¢/kWh', 'aemo_frc_c_per_day'),
])
def test_unknown_units_labels_and_non_reconciling_rows_are_not_rates(old, new, key):
    assert key not in extract(DETAILS.replace(old, new))['rates']


def test_duplicate_peak_and_conflicting_loss_factors_fail_closed():
    duplicate = 'Peak 100 kWh 12.500000 ¢/kWh 1.02000 1.10000 $14.03\n'
    assert 'retail_peak_c_per_kwh' not in extract(DETAILS.replace('Total Energy Charges', duplicate + 'Total Energy Charges'))['rates']
    conflict = DETAILS.replace('0.200000 ¢/kWh 1.10000 $0.66', '0.200000 ¢/kWh 1.20000 $0.72')
    assert 'dlf' not in extract(conflict)['factors']


def test_missing_environmental_line_is_not_silently_dropped():
    assert 'environmental' not in extract(DETAILS.replace('LREC Charge', 'Unknown multiword charge'))


def test_summary_only_draft_has_blanks_and_cannot_be_saved_or_approved():
    bill = _parse_invoice_text(BILL_TEXT, bill_review=None)
    draft = _suggested_profile(SimpleNamespace(inspection_result_json={'bill': bill}))
    assert all(value is None for value in draft['rates'].values())
    assert draft['factors'] == {'mlf': None, 'dlf': None}
    with pytest.raises(CiProjectError):
        validate_ci_project_tariff_profile(draft)


def test_environmental_fractions_are_validated_before_calculation():
    bill = _parse_invoice_text(BILL_TEXT + DETAILS, bill_review=None)
    draft = _suggested_profile(SimpleNamespace(inspection_result_json={'bill': bill}))
    invalid = deepcopy(draft)
    invalid['environmental'][0]['certificate_fraction'] = 10
    with pytest.raises(CiProjectError):
        validate_ci_project_tariff_profile(invalid)

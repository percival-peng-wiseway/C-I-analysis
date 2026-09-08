"""Synthetic-only bill fixtures. No customer documents or identifiers."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from solar_battery import ci_bill_document as documents
from solar_battery.ci_evidence_intake import _parse_invoice_text
from tests.test_ci_evidence_intake import BILL_TEXT, GENERIC_BILL_TEXT, _generic_bill_review


def native_pdf(text: str) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    operations = ['BT /F1 11 Tf 36 755 Td 18 TL']
    for line in text.strip().splitlines():
        escaped = line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        operations.append(f'({escaped}) Tj T*')
    operations.append('ET')
    stream = DecodedStreamObject()
    stream.set_data('\n'.join(operations).encode('latin-1'))
    page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def scan_pdf(text: str, *, rotate: bool = False) -> bytes:
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(native_pdf(text)) as doc:
        page = doc[0]
        bitmap = page.render(scale=2)
        image = bitmap.to_pil().convert('RGB')
        if rotate:
            image = image.rotate(90, expand=True)
        output = io.BytesIO()
        image.save(output, format='PDF', resolution=144)
        bitmap.close()
        page.close()
        return output.getvalue()


def parse(text: str):
    return _parse_invoice_text(documents.extract_bill_document(native_pdf(text)), bill_review=None)


def test_native_origin_keeps_verified_contract_without_ocr(monkeypatch):
    monkeypatch.setattr(documents, '_ocr_pages', lambda *_: pytest.fail('Native PDF must not use OCR'))
    bill = parse(BILL_TEXT)
    assert bill['review_status'] == 'not_required'
    assert bill['total_inc_gst_aud'] == 46.2
    assert bill['invoice_arithmetic_reconciled'] is True
    audit = bill['extraction_audit']
    assert audit['sources'] and audit['pages'][0]['method'] == 'native_text'
    assert 'SYNTH00001' not in json.dumps(audit)


def test_current_charges_are_separate_from_previous_balance():
    bill = parse(GENERIC_BILL_TEXT + '\nCurrent charges $46.20\nPrevious balance $100.00\nTotal amount due $146.20\n')
    assert bill['total_inc_gst_aud'] == 46.2
    assert bill['invoice_arithmetic_reconciled']
    assert bill['review_status'] == 'confirmation_required'
    # An amount due alone is not evidence of current-period charges.
    assert parse(GENERIC_BILL_TEXT)['total_inc_gst_aud'] is None


def test_conflicting_values_are_blank_not_last_match_wins():
    bill = parse(GENERIC_BILL_TEXT + '\nInvoice total $46.20\nInvoice total $146.20\n')
    assert bill['total_inc_gst_aud'] is None
    assert not bill['invoice_arithmetic_reconciled']
    assert any(i['code'] == 'conflicting_values' for i in bill['extraction_audit']['issues'])


def test_power_factor_percentage_and_demand_units():
    bill = parse(GENERIC_BILL_TEXT.replace('0.800', '80%').replace('15.00 kVA', '15.00 kW'))
    assert bill['power_factor_at_highest_demand'] == 0.8
    assert bill['highest_metered_demand_kva'] is None
    assert parse(GENERIC_BILL_TEXT.replace('0.800', '80'))['power_factor_at_highest_demand'] is None


def test_table_cells_supply_structured_fields():
    doc = documents.BillText('AGL Electricity Tax Invoice', [{'page': 1, 'method': 'native_text', 'lines': [], 'tables': [
        {'bbox': [0, 0, 300, 80], 'rows': [['Subtotal', '$42.00'], ['GST', '$4.20'], ['Invoice total', '$46.20']]}
    ]}], [])
    bill = _parse_invoice_text(doc, bill_review=None)
    assert bill['subtotal_ex_gst_aud'] == 42.0
    assert bill['total_inc_gst_aud'] == 46.2
    assert all(source['method'] == 'native_table' for source in bill['extraction_audit']['sources'])


def test_line_reconciliation_uses_cents_and_reports_bad_amount():
    bill = parse(GENERIC_BILL_TEXT + '\nCurrent charges $46.20\nPeak 100 kWh 30 c/kWh $30.00\nSupply 2 days 1.5 $/day $4.00\n')
    rows = bill['extraction_audit']['line_items']
    assert [r['passed'] for r in rows] == [True, False]
    assert rows[1]['difference_aud'] == -1.0
    assert bill['tariff_line_items']['rates'] == {}


def test_review_reconciles_categories_and_signed_credit():
    document = documents.extract_bill_document(native_pdf(GENERIC_BILL_TEXT))
    review = _generic_bill_review()
    review['charge_categories_ex_gst_aud'] = dict(energy_charges=11, network_charges=20, regulated_charges=3,
        environmental_charges=4, metering_charges=5, additional_charges=-1)
    bill = _parse_invoice_text(document, bill_review=review)
    assert bill['invoice_arithmetic_scope'] == 'charge_categories_and_totals'
    assert bill['invoice_arithmetic_reconciled']
    assert bill['review_status'] == 'analyst_confirmed'
    review['charge_categories_ex_gst_aud']['energy_charges'] = 100
    bill = _parse_invoice_text(document, bill_review=review)
    assert not bill['invoice_arithmetic_reconciled']
    assert bill['review_status'] == 'confirmation_required'


def test_scan_failure_is_visible_and_can_be_manually_reviewed(monkeypatch):
    monkeypatch.setattr(documents, '_ocr_pages', lambda *_: ({}, 'ocr_timeout'))
    document = documents.extract_bill_document(scan_pdf(GENERIC_BILL_TEXT))
    bill = _parse_invoice_text(document, bill_review=None)
    assert bill['total_inc_gst_aud'] is None
    assert bill['extraction_audit']['issues'][0]['code'] == 'ocr_timeout'
    reviewed = _parse_invoice_text(document, bill_review=_generic_bill_review(nmi='SYNTH00001'))
    assert reviewed['review_status'] == 'analyst_confirmed'
    assert reviewed['extraction_audit']['issues'][0]['resolved_by_review'] is True


def test_low_confidence_and_conflicting_ocr_site_identity_are_not_trusted():
    doc = documents.BillText('Invoice total $46.20', [{'page': 1, 'method': 'paddle_ocr', 'tables': [], 'lines': [
        {'text': 'Invoice total $46.20', 'bbox': [0, 0, 200, 20], 'page': 1, 'method': 'paddle_ocr', 'confidence': .7}]}], [])
    bill = _parse_invoice_text(doc, bill_review=None)
    assert bill['total_inc_gst_aud'] is None
    assert bill['extraction_audit']['issues'][0]['code'] == 'low_ocr_confidence'


def test_ocr_admission_is_nonblocking(monkeypatch, tmp_path):
    monkeypatch.setenv('CI_PADDLE_MODEL_DIR', str(tmp_path))
    with documents._OCR_LOCK:
        assert documents._ocr_pages(b'pdf', [0]) == ({}, 'ocr_busy')


@pytest.mark.skipif(not os.environ.get('CI_PADDLE_MODEL_DIR'), reason='Explicit offline models required for Paddle smoke test')
@pytest.mark.parametrize('rotate', [False, True])
def test_real_offline_paddle_scan(rotate):
    document = documents.extract_bill_document(scan_pdf(GENERIC_BILL_TEXT + '\nCurrent charges $46.20', rotate=rotate))
    assert not document.warnings, document.warnings
    bill = _parse_invoice_text(document, bill_review=None)
    assert bill['extraction_method'] == 'paddle_ocr_layout'
    assert bill['total_inc_gst_aud'] == 46.2
    assert bill['consumption_kwh'] == 288
    assert bill['review_status'] == 'confirmation_required'


def test_template_detail_subtotals_do_not_override_invoice_summary():
    bill = parse(BILL_TEXT + '\nENERGY CHARGES\nSub-Total $10.00\nGST $1.00\nTotal Energy Charges $11.00\n')
    assert bill['subtotal_ex_gst_aud'] == 42
    assert bill['gst_aud'] == 4.2
    assert bill['charge_categories_ex_gst_aud']['energy_charges'] == 10
    assert bill['review_status'] == 'not_required'


def test_line_mismatch_needs_explicit_review_and_never_imports_rates():
    document = documents.extract_bill_document(native_pdf(GENERIC_BILL_TEXT + '\nSupply 2 days 1.5 $/day $4.00\n'))
    review = _generic_bill_review()
    unreviewed = _parse_invoice_text(document, bill_review=review)
    assert not unreviewed['invoice_arithmetic_reconciled']
    assert unreviewed['review_status'] == 'confirmation_required'
    reviewed = _parse_invoice_text(document, bill_review={**review, 'line_items_reviewed': True})
    assert reviewed['invoice_arithmetic_reconciled']
    assert reviewed['extraction_audit']['line_items_reviewed']
    assert reviewed['tariff_line_items']['rates'] == {}
    assert not reviewed['extraction_audit']['line_items'][0]['passed']


def test_upload_parser_does_not_block_the_api_event_loop(monkeypatch):
    import asyncio
    import time
    from types import SimpleNamespace
    from fastapi import UploadFile
    from api import ci_routes
    events = []
    def slow_parser(*args):
        time.sleep(.1)
        events.append('parsed')
        return {'synthetic': True}
    monkeypatch.setattr(ci_routes, 'inspect_ci_evidence_pair', slow_parser)
    async def run():
        task = asyncio.create_task(ci_routes.inspect_ci_evidence_uploads(
            bill=UploadFile(file=io.BytesIO(b'pdf')),
            nem12=UploadFile(file=io.BytesIO(b'interval')),
            identity_provider=SimpleNamespace(current=lambda: None),
        ))
        await asyncio.sleep(.01)
        events.append('heartbeat')
        await task
    asyncio.run(run())
    assert events == ['heartbeat', 'parsed']


@pytest.mark.parametrize('limit,expected', [('time', 'ocr_timeout'), ('memory', 'ocr_memory_limit')])
def test_ocr_worker_is_killed_and_private_inputs_removed(monkeypatch, tmp_path, limit, expected):
    import subprocess
    import sys
    monkeypatch.setenv('CI_PADDLE_MODEL_DIR', str(tmp_path))
    monkeypatch.setattr(documents, 'OCR_BUDGET_SECONDS', .2 if limit == 'time' else 5)
    monkeypatch.setattr(documents, 'OCR_MAX_RSS_BYTES', 1 if limit == 'memory' else 2 * 1024**3)
    original = subprocess.Popen
    inputs, processes = [], []
    def worker(command, **kwargs):
        inputs.append(Path(command[3]))
        process = original([sys.executable, '-c', 'import time; time.sleep(10)'], **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(documents.subprocess, 'Popen', worker)
    assert documents._ocr_pages(b'synthetic document', [0]) == ({}, expected)
    assert processes[0].poll() is not None
    assert not inputs[0].parent.exists()
    assert not documents._OCR_LOCK.locked()


def test_review_race_cannot_overwrite_a_newer_inspection(monkeypatch, tmp_path):
    from tests.durable_test_helpers import create_test_client, sqlite_url_for_path
    from tests.test_ci_evidence_intake import _nem12_bytes
    from api import ci_routes
    with create_test_client(sqlite_url_for_path(tmp_path / 'race.sqlite3'), object_store_root=tmp_path / 'objects') as client:
        project = client.post('/api/commercial-industrial/projects', json={'display_name': 'Synthetic review race'}).json()['project_id']
        base = f'/api/commercial-industrial/projects/{project}/evidence-intake'
        initial = client.post(base + '/inspect', files={'bill': ('synthetic.pdf', native_pdf(GENERIC_BILL_TEXT), 'application/pdf'), 'nem12': ('synthetic.csv', _nem12_bytes(), 'text/csv')})
        assert initial.status_code == 200
        monkeypatch.setattr(ci_routes, 'update_ci_project_evidence_inspection_if_current', lambda *a, **kw: False)
        response = client.post(base + '/review', json=_generic_bill_review())
        assert response.status_code == 409
        stored = client.get(base).json()['evidence']['inspection']
        assert stored['bill']['review_status'] == 'confirmation_required'
        assert stored['bill']['total_inc_gst_aud'] is None

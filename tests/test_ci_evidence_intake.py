from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pytest

from solar_battery import ci_evidence_intake
from solar_battery.ci_evidence_intake import (
    _annual_demand_heatmap,
    _wide_interval_datetime,
    enrich_ci_evidence_tariff_summary,
    inspect_ci_evidence_pair,
)
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


BILL_TEXT = """
Your Business Electricity Tax Invoice 05 Jan 26 - 05 Jan 26
originenergy.com.au
NMI SYNTH00001
Supply address: Unit 4, 18 Example Road North Sydney NSW 2060
No. of Days 1
INVOICE SUMMARY
Energy Charges $10.00
Network Charges $20.00
Regulated Charges $3.00
Environmental Charges $4.00
Metering Charges $5.00
Additional Charges, Credits & Adjustments $0.00
Sub-Total $42.00
GST $4.20
Total $46.20
INVOICE CHARGE SUMMARY
Consumption this period: 288.000 kWh
Highest metered demand this period is 15.00 kVA
Power Factor at highest demand 0.800
Network Provider: POWCP | Tariff: LLVT2
"""

GENERIC_BILL_TEXT = """
AGL Electricity Tax Invoice
NMI: SYNTH00001
Site address: 25 Test Street Melbourne VIC 3000
Billing Period: 05/01/2026 to 05/01/2026
Network Tariff Code: LLVT2
Total electricity usage: 288.000 kWh
Maximum demand: 15.00 kVA
Power Factor: 0.800
Subtotal $42.00
GST $4.20
Amount due $46.20
"""


def _generic_bill_review(*, nmi: str | None = None) -> dict[str, object]:
    return {
        "confirmed": True,
        "retailer": "AGL",
        "invoice_kind": "Electricity Tax Invoice",
        "nmi": nmi,
        "billing_period_start": "2026-01-05",
        "billing_period_end": "2026-01-05",
        "network_tariff_code": "LLVT2",
        "consumption_kwh": 288.0,
        "highest_metered_demand_kva": 15.0,
        "power_factor_at_highest_demand": 0.8,
        "subtotal_ex_gst_aud": 42.0,
        "gst_aud": 4.2,
        "total_inc_gst_aud": 46.2,
    }


def _nem12_bytes(
    nmi: str = "SYNTH00001",
    *,
    stream_ids: tuple[str, ...] = ("B1", "E1", "K1", "Q1"),
    q1_day: str = "20260105",
) -> bytes:
    rows = ["100,NEM12,202601060000,SYNTHETIC"]
    values = ",".join(["1.0"] * 288)
    reactive = ",".join(["0.75"] * 288)
    zeros = ",".join(["0.0"] * 288)
    for register, unit, intervals in (
        ("B1", "kWh", zeros),
        ("E1", "kWh", values),
        ("K1", "kVArh", zeros),
        ("Q1", "kVArh", reactive),
    ):
        if register not in stream_ids:
            continue
        rows.append(f"200,{nmi},B1E1K1Q1,{register},{register},N1,METER1,{unit},5")
        day = q1_day if register == "Q1" else "20260105"
        rows.append(f"300,{day},{intervals},A,,,")
    rows.append("900")
    return ("\n".join(rows) + "\n").encode()


def _annual_nem12_bytes(nmi: str = "SYNTH00001") -> bytes:
    rows = ["100,NEM12,202601060000,SYNTHETIC"]
    values = ",".join(["1.0"] * 288)
    reactive = ",".join(["0.75"] * 288)
    zeros = ",".join(["0.0"] * 288)
    start = date(2025, 1, 6)
    for register, unit, intervals in (
        ("B1", "kWh", zeros),
        ("E1", "kWh", values),
        ("K1", "kVArh", zeros),
        ("Q1", "kVArh", reactive),
    ):
        rows.append(
            f"200,{nmi},B1E1K1Q1,{register},{register},N1,METER1,{unit},5"
        )
        for offset in range(365):
            meter_day = start + timedelta(days=offset)
            rows.append(f"300,{meter_day:%Y%m%d},{intervals},A,,,")
    rows.append("900")
    return ("\n".join(rows) + "\n").encode()


def _wide_30_minute_bytes() -> bytes:
    headings = [
        "NMI", "Meter", "Period", "ReadingDateTime", "E", "B", "Q", "K",
        "kWh", "kW", "kVA", "PowerFactor", "Quality", "QualityText",
    ]
    rows = ["\t".join(headings)]
    start = datetime(2026, 1, 5)
    for index in range(48):
        timestamp = start + timedelta(minutes=30 * index)
        rows.append("\t".join([
            "SYNTH00001", "METER1", "30", timestamp.strftime("%d/%m/%Y %H:%M"),
            "", "", "", "", "5", "10", "12.5", "0.8", "A", "Actual",
        ]))
    return ("\n".join(rows) + "\n").encode()


def test_evidence_intake_matches_bill_and_nem12_and_returns_only_the_site_address(
    monkeypatch,
) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(b"synthetic-pdf", _nem12_bytes())

    assert result["contract_version"] == "ci_evidence_intake_v9"
    assert result["intake_status"] == "ready_for_profile_review"
    assert result["bill"]["network_tariff_code"] == "LLVT2"
    assert result["bill"]["total_inc_gst_aud"] == 46.20
    assert result["bill"]["extraction_method"] == "verified_origin_template"
    assert result["bill"]["review_status"] == "not_required"
    assert result["bill"]["site_address"] == "Unit 4, 18 Example Road North Sydney NSW 2060"
    assert result["nem12"]["stream_ids"] == ["B1", "E1", "K1", "Q1"]
    assert result["nem12"]["input_format"] == "nem12_standard"
    assert result["nem12"]["aligned_stream_ids"] == ["B1", "E1", "K1", "Q1"]
    assert result["nem12"]["missing_stream_ids"] == []
    assert result["nem12"]["unaligned_stream_ids"] == []
    assert result["nem12"]["full_tariff_analysis_ready"] is True
    assert result["nem12"]["interval_minutes"] == 5
    heatmap = result["annual_demand_heatmap"]
    assert heatmap["metric"] == "measured_apparent_demand"
    assert heatmap["source_streams"] == ["E1", "Q1"]
    assert heatmap["unit"] == "kVA"
    assert heatmap["interval_minutes"] == 15
    assert heatmap["time_basis"] == "fixed_aest_meter_time"
    assert heatmap["tariff_window_status"] == "not_applied_pre_tariff"
    assert heatmap["reactive_data_status"] == "available"
    assert heatmap["shared_scale_maximum_demand"] == 15.0
    assert heatmap["years"] == [
        {
            "year": 2026,
            "coverage_start": "2026-01-05",
            "coverage_end": "2026-01-05",
            "day_count": 1,
            "complete_calendar_year": False,
            "interval_count": 96,
            "expected_interval_count": 96,
            "missing_interval_count": 0,
            "maximum_interval_demand": 15.0,
            "average_interval_demand": 15.0,
            "days": [
                {"date": "2026-01-05", "interval_demand": [15.0] * 96}
            ],
        }
    ]
    assert result["privacy"] == {
        "files_persisted": False,
        "customer_identifiers_returned": True,
        "customer_facing_permission": False,
    }
    assert "nmi" not in result["bill"]
    assert all(check["passed"] for check in result["pair_checks"])
    assert result["detected_tariff"]["status"] == "category_totals_detected"
    assert [group["key"] for group in result["detected_tariff"]["groups"]] == [
        "fixed",
        "other_usage",
        "energy_import",
    ]
    assert result["annual_bill_estimate"]["status"] == "unavailable"


def test_evidence_intake_withholds_annual_dollars_without_approved_tariff_replay(
    monkeypatch,
) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(b"synthetic-pdf", _annual_nem12_bytes())

    estimate = result["annual_bill_estimate"]
    assert estimate["status"] == "unavailable"
    assert estimate["method"] == "approved_tariff_replay_required"
    assert estimate["confidence"] == "unavailable"
    assert estimate["coverage_start"] == "2025-01-06"
    assert estimate["coverage_end"] == "2026-01-05"
    assert estimate["annual_import_kwh"] == 105_120.0
    assert estimate["total_ex_gst_aud"] is None
    assert estimate["customer_facing_permission"] is False
    assert estimate["groups"] == []
    assert "Public regional" in " ".join(estimate["assumptions"])


def test_saved_v8_evidence_can_be_enriched_without_reinterpreting_the_bill(
    monkeypatch,
) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)
    original = inspect_ci_evidence_pair(b"synthetic-pdf", _annual_nem12_bytes())
    saved_v8 = {
        key: value
        for key, value in original.items()
        if key not in {"detected_tariff", "annual_bill_estimate"}
    }
    saved_v8["contract_version"] = "ci_evidence_intake_v8"

    upgraded = enrich_ci_evidence_tariff_summary(
        saved_v8, _annual_nem12_bytes()
    )

    assert upgraded["contract_version"] == "ci_evidence_intake_v9"
    assert upgraded["bill"] == saved_v8["bill"]
    assert upgraded["annual_bill_estimate"]["method"] == (
        "approved_tariff_replay_required"
    )
    assert upgraded["annual_bill_estimate"]["total_ex_gst_aud"] is None


def test_annual_import_profile_selects_latest_365_days_and_rejects_gaps() -> None:
    leap_start = date(2024, 1, 1)
    leap_year = {
        leap_start + timedelta(days=offset): 100.0 + offset
        for offset in range(366)
    }

    profile = ci_evidence_intake._latest_complete_annual_import_profile(leap_year)

    assert profile is not None
    assert profile["coverage_start"] == "2024-01-02"
    assert profile["coverage_end"] == "2024-12-31"
    assert profile["day_count"] == 365

    with_gap = dict(leap_year)
    del with_gap[date(2024, 7, 1)]
    assert ci_evidence_intake._latest_complete_annual_import_profile(with_gap) is None


def test_evidence_intake_reports_a_site_mismatch_without_echoing_identifiers(monkeypatch) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(b"synthetic-pdf", _nem12_bytes("OTHER00001"))

    assert result["intake_status"] == "action_required"
    checks = {check["code"]: check for check in result["pair_checks"]}
    assert checks["site_identity_match"]["passed"] is False
    assert "SYNTH00001" not in str(result)
    assert "OTHER00001" not in str(result)


def test_evidence_intake_explains_that_only_e1_is_mandatory(monkeypatch) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    with pytest.raises(ci_evidence_intake.CiEvidenceIntakeError) as exc_info:
        inspect_ci_evidence_pair(
            b"synthetic-pdf",
            _nem12_bytes(stream_ids=("B1",)),
        )

    assert exc_info.value.code == "nem12_active_import_unavailable"
    assert "requires one valid five-minute E1" in str(exc_info.value)


def test_generic_text_bill_is_prefilled_but_requires_one_analyst_confirmation(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        ci_evidence_intake, "_extract_pdf_text", lambda _: GENERIC_BILL_TEXT
    )

    first_pass = inspect_ci_evidence_pair(b"generic-pdf", _nem12_bytes())

    assert first_pass["intake_status"] == "action_required"
    assert first_pass["bill"]["retailer"] == "AGL"
    assert first_pass["bill"]["billing_period_start"] == "2026-01-05"
    assert first_pass["bill"]["network_tariff_code"] == "LLVT2"
    assert first_pass["bill"]["review_status"] == "confirmation_required"
    assert first_pass["bill"]["site_identity_status"] == "extracted"
    assert first_pass["bill"]["site_address"] == "25 Test Street Melbourne VIC 3000"
    assert first_pass["detected_tariff"]["status"] == "review_required"
    assert first_pass["annual_bill_estimate"]["status"] == "unavailable"
    assert "SYNTH00001" not in str(first_pass)

    confirmed = inspect_ci_evidence_pair(
        b"generic-pdf",
        _nem12_bytes(),
        bill_review=_generic_bill_review(),
    )

    assert confirmed["intake_status"] == "ready_for_profile_review"
    assert confirmed["bill"]["review_status"] == "analyst_confirmed"
    assert confirmed["bill"]["invoice_arithmetic_scope"] == "invoice_totals_only"
    assert confirmed["detected_tariff"]["status"] == "review_required"
    assert confirmed["annual_bill_estimate"]["status"] == "unavailable"
    assert all(item["passed"] for item in confirmed["pair_checks"])


def test_site_address_extraction_rejects_mailing_and_unlabelled_addresses(monkeypatch) -> None:
    for bill_text in (
        "Postal address: PO Box 123 Sydney NSW 2000",
        "18 Example Road North Sydney NSW 2060",
    ):
        monkeypatch.setattr(
            ci_evidence_intake,
            "_extract_pdf_text",
            lambda _, text=bill_text: text,
        )
        assert ci_evidence_intake.extract_ci_site_address(b"synthetic-pdf") is None


def test_scanned_bill_can_use_request_local_manual_review_without_a_retailer_adapter(
    monkeypatch,
) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: "")

    first_pass = inspect_ci_evidence_pair(b"scanned-pdf", _nem12_bytes())

    assert first_pass["intake_status"] == "action_required"
    assert first_pass["bill"]["extraction_method"] == "manual_review_only"
    assert first_pass["bill"]["site_identity_status"] == "missing"
    assert "site_identity" in first_pass["bill"]["missing_fields"]

    confirmed = inspect_ci_evidence_pair(
        b"scanned-pdf",
        _nem12_bytes(),
        bill_review=_generic_bill_review(nmi="SYNTH00001"),
    )

    assert confirmed["intake_status"] == "ready_for_profile_review"
    assert confirmed["bill"]["review_status"] == "analyst_confirmed"
    assert "SYNTH00001" not in str(confirmed)


def test_annual_demand_heatmap_groups_years_and_uses_one_shared_scale() -> None:
    start = date(2024, 12, 31)
    active_rows = {
        start + timedelta(days=index): [0.5] * 288
        for index in range(366)
    }
    reactive_rows = {day: [0.375] * 288 for day in active_rows}

    heatmap = _annual_demand_heatmap(active_rows, reactive_rows)

    assert [item["year"] for item in heatmap["years"]] == [2024, 2025]
    assert heatmap["shared_scale_maximum_demand"] == 7.5
    assert heatmap["years"][0]["complete_calendar_year"] is False
    year_2025 = heatmap["years"][1]
    assert year_2025["complete_calendar_year"] is True
    assert year_2025["day_count"] == 365
    assert year_2025["interval_count"] == 365 * 96
    assert year_2025["expected_interval_count"] == 365 * 96
    assert year_2025["missing_interval_count"] == 0
    assert year_2025["maximum_interval_demand"] == 7.5
    assert year_2025["average_interval_demand"] == 7.5
    assert year_2025["days"][0]["interval_demand"] == [7.5] * 96


def test_evidence_intake_accepts_e1_only_for_setup_and_kw_heatmap(monkeypatch) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(
        b"synthetic-pdf",
        _nem12_bytes(stream_ids=("E1",)),
    )

    assert result["intake_status"] == "ready_for_profile_review"
    assert result["nem12"]["capability_status"] == "active_import_only"
    assert result["nem12"]["aligned_stream_ids"] == ["E1"]
    assert result["nem12"]["missing_stream_ids"] == ["B1", "K1", "Q1"]
    assert result["nem12"]["full_tariff_analysis_ready"] is False
    check = next(
        item for item in result["pair_checks"] if item["code"] == "stream_capability"
    )
    assert check["passed"] is True
    assert check["severity"] == "warning"
    assert "E1 active import is available" in check["message"]
    heatmap = result["annual_demand_heatmap"]
    assert heatmap["metric"] == "measured_active_demand"
    assert heatmap["source_streams"] == ["E1"]
    assert heatmap["unit"] == "kW"
    assert heatmap["reactive_data_status"] == "unavailable_active_only"
    assert heatmap["shared_scale_maximum_demand"] == 12.0
    assert heatmap["years"][0]["days"][0]["interval_demand"] == [12.0] * 96


def test_evidence_intake_uses_aligned_q1_for_kva_but_keeps_full_analysis_locked(
    monkeypatch,
) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(
        b"synthetic-pdf",
        _nem12_bytes(stream_ids=("E1", "Q1")),
    )

    assert result["intake_status"] == "ready_for_profile_review"
    assert result["nem12"]["capability_status"] == "active_reactive_import"
    assert result["nem12"]["missing_stream_ids"] == ["B1", "K1"]
    assert result["nem12"]["full_tariff_analysis_ready"] is False
    assert result["annual_demand_heatmap"]["unit"] == "kVA"
    assert result["annual_demand_heatmap"]["shared_scale_maximum_demand"] == 15.0


def test_evidence_intake_does_not_infer_kva_from_unaligned_q1(monkeypatch) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(
        b"synthetic-pdf",
        _nem12_bytes(stream_ids=("E1", "Q1"), q1_day="20260106"),
    )

    assert result["nem12"]["unaligned_stream_ids"] == ["Q1"]
    assert result["annual_demand_heatmap"]["unit"] == "kW"


def test_evidence_intake_accepts_wide_30_minute_reported_demand(monkeypatch) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)

    result = inspect_ci_evidence_pair(b"synthetic-pdf", _wide_30_minute_bytes())

    assert result["intake_status"] == "ready_for_profile_review"
    assert result["nem12"]["input_format"] == "wide_interval_30_minute"
    assert result["nem12"]["interval_minutes"] == 30
    assert result["nem12"]["capability_status"] == "measured_apparent_demand"
    assert result["nem12"]["full_tariff_analysis_ready"] is False
    heatmap = result["annual_demand_heatmap"]
    assert heatmap["interval_minutes"] == 30
    assert heatmap["source_streams"] == ["kVA"]
    assert heatmap["unit"] == "kVA"
    assert heatmap["reactive_data_status"] == "reported_apparent_demand"
    assert heatmap["time_basis"] == "source_local_time_unverified"
    assert heatmap["years"][0]["interval_count"] == 48
    assert heatmap["years"][0]["expected_interval_count"] == 48
    assert heatmap["years"][0]["missing_interval_count"] == 0
    assert heatmap["years"][0]["days"][0]["interval_demand"] == [12.5] * 48
    checks = {item["code"]: item for item in result["pair_checks"]}
    assert checks["supported_interval_width"]["severity"] == "warning"
    assert "not upsampled" in checks["supported_interval_width"]["message"]


def test_wide_interval_datetime_accepts_common_australian_12_hour_format() -> None:
    assert _wide_interval_datetime("05/01/2026 12:30 AM AEDT") == datetime(
        2026, 1, 5, 0, 30
    )


def test_evidence_intake_api_is_available_before_profile_readiness(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(ci_evidence_intake, "_extract_pdf_text", lambda _: BILL_TEXT)
    with create_test_client(sqlite_url_for_path(tmp_path / "ci.sqlite3")) as client:
        response = client.post(
            "/api/commercial-industrial/evidence-intake/inspect",
            files={
                "bill": ("invoice.pdf", b"synthetic-pdf", "application/pdf"),
                "nem12": ("meter.csv", _nem12_bytes(), "text/csv"),
            },
        )

    assert response.status_code == 200
    assert response.json()["intake_status"] == "ready_for_profile_review"


def test_project_intake_restores_files_for_generic_bill_confirmation(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        ci_evidence_intake, "_extract_pdf_text", lambda _: GENERIC_BILL_TEXT
    )
    with create_test_client(
        sqlite_url_for_path(tmp_path / "ci-generic.sqlite3"),
        object_store_root=tmp_path / "ci-generic-objects",
    ) as client:
        project = client.post(
            "/api/commercial-industrial/projects", json={"display_name": "Generic bill"}
        ).json()
        first_response = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/inspect",
            files={
                "bill": ("invoice.pdf", b"synthetic-pdf", "application/pdf"),
                "nem12": ("meter.csv", _nem12_bytes(), "text/csv"),
            },
        )
        assert first_response.status_code == 200
        assert first_response.json()["intake_status"] == "action_required"
        assert first_response.json()["privacy"]["files_persisted"] is True

        response = client.post(
            f"/api/commercial-industrial/projects/{project['project_id']}/evidence-intake/review",
            json=_generic_bill_review(),
        )

    assert response.status_code == 200
    assert response.json()["intake_status"] == "ready_for_profile_review"
    assert response.json()["bill"]["review_status"] == "analyst_confirmed"
    assert response.json()["privacy"]["files_persisted"] is True

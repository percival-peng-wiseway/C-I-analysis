from __future__ import annotations

import hashlib
import json

import pytest

from solar_battery.ci_tariff_analysis import (
    CiTariffAnalysisError,
    analyze_ci_nem12,
    load_ci_tariff_profile,
)
from solar_battery.ci_workspace_readiness import ci_workspace_readiness_contract
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


def _nem12_bytes() -> bytes:
    return _nem12_bytes_for_dates(["20260105"])


def _nem12_bytes_for_dates(days: list[str]) -> bytes:
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
        rows.append(
            f"200,SYNTH0001,B1E1K1Q1,{register},{register},N1,METER1,{unit},5"
        )
        for day in days:
            rows.append(f"300,{day},{intervals},A,,,")
    rows.append("900")
    return ("\n".join(rows) + "\n").encode()


def _profile(nem12: bytes) -> dict[str, object]:
    zero_rates = {
        "retail_peak_c_per_kwh": 0.0,
        "retail_off_peak_c_per_kwh": 0.0,
        "incentive_demand_aud_per_kva_month": 0.0,
        "rolling_demand_aud_per_kva_month": 0.0,
        "network_peak_c_per_kwh": 0.0,
        "network_off_peak_c_per_kwh": 0.0,
        "aemo_ancillary_c_per_kwh": 0.0,
        "aemo_participant_c_per_kwh": 0.0,
        "aemo_frc_c_per_day": 0.0,
        "environmental": [],
        "metering_aud_per_day": 0.0,
        "value_added_c_per_day": 0.0,
    }
    return {
        "contract_version": "ci_tariff_profile_v1",
        "profile_id": "synthetic_llvt2",
        "display_label": "Synthetic LLVT2 evidence",
        "network_tariff_code": "LLVT2",
        "source_version": "synthetic-v1",
        "source_bill_sha256": "0" * 64,
        "expected_nem12_sha256": hashlib.sha256(nem12).hexdigest(),
        "timezone_name": "Australia/Melbourne",
        "meter_time_basis": "fixed_aest_interval_records",
        "gst_basis": "exclusive_then_10_percent_invoice_gst",
        "gst_rate": 0.10,
        "billing_period": {"start_date": "2026-01-05", "end_date": "2026-01-05"},
        "rolling_period": {"start_date": "2026-01-05", "end_date": "2026-01-05"},
        "retail_energy_window": {
            "start": "07:00", "end": "23:00", "time_basis": "meter_aest", "excluded_dates": []
        },
        "network_energy_window": {
            "start": "07:00", "end": "19:00", "time_basis": "local", "excluded_dates": []
        },
        "rolling_demand_window": {
            "start": "07:00", "end": "19:00", "time_basis": "local", "excluded_dates": []
        },
        "incentive_demand_window": {
            "start": "16:00", "end": "19:00", "time_basis": "local", "excluded_dates": []
        },
        "minimum_chargeable_rolling_kva": 0.0,
        "factors": {"mlf": 1.0, "dlf": 1.0},
        "rates": zero_rates,
        "expected_reconciliation": {
            "import_kwh": 288.0,
            "export_kwh": 0.0,
            "retail_peak_kwh": 192.0,
            "retail_off_peak_kwh": 96.0,
            "network_peak_kwh": 144.0,
            "network_off_peak_kwh": 144.0,
            "rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_power_factor": 0.8,
            "category_energy_charges_aud": 0.0,
            "category_network_charges_aud": 0.0,
            "category_regulated_charges_aud": 0.0,
            "category_environmental_charges_aud": 0.0,
            "category_metering_charges_aud": 0.0,
            "category_additional_charges_aud": 0.0,
            "subtotal_ex_gst_aud": 0.0,
            "gst_aud": 0.0,
            "total_inc_gst_aud": 0.0,
        },
    }


def test_ci_analysis_reconciles_synthetic_aest_and_kva_evidence() -> None:
    nem12 = _nem12_bytes()
    result = analyze_ci_nem12(nem12, profile=_profile(nem12))

    assert result["analysis_status"] == "ready"
    assert result["customer_facing_permission"] is False
    assert result["data_quality"]["status"] == "pass"
    assert result["demand_evidence"]["rolling_demand_kva"] == pytest.approx(15.0)
    assert result["demand_evidence"]["billing_period_max_power_factor"] == pytest.approx(0.8)
    assert result["bill_reconciliation"]["status"] == "pass"
    assert all(check["passed"] for check in result["bill_reconciliation"]["checks"])


def test_ci_analysis_still_rejects_e1_only_evidence() -> None:
    values = ",".join(["1.0"] * 288)
    e1_only = (
        "\n".join(
            [
                "100,NEM12,202601060000,SYNTHETIC",
                "200,SYNTH0001,B1E1K1Q1,E1,E1,N1,METER1,kWh,5",
                f"300,20260105,{values},A,,,",
                "900",
            ]
        )
        + "\n"
    ).encode()

    with pytest.raises(CiTariffAnalysisError) as exc_info:
        analyze_ci_nem12(e1_only, profile=_profile(e1_only))

    assert exc_info.value.code == "stream_contract_mismatch"


def test_ci_analysis_accepts_one_cent_invoice_gst_rounding_difference() -> None:
    nem12 = _nem12_bytes()
    profile = _profile(nem12)
    profile["expected_reconciliation"]["gst_aud"] = 0.01
    profile["expected_reconciliation"]["total_inc_gst_aud"] = 0.01

    result = analyze_ci_nem12(nem12, profile=profile)

    checks = {item["code"]: item for item in result["bill_reconciliation"]["checks"]}
    assert checks["gst_aud"]["passed"] is True
    assert checks["total_inc_gst_aud"]["passed"] is True


def test_bill_period_reconciliation_includes_a_signed_one_time_adjustment() -> None:
    nem12 = _nem12_bytes()
    profile = _profile(nem12)
    profile["additional_bill_adjustment_aud"] = -5.0
    profile["expected_reconciliation"].update(
        {
            "category_additional_charges_aud": -5.0,
            "subtotal_ex_gst_aud": -5.0,
            "gst_aud": -0.5,
            "total_inc_gst_aud": -5.5,
        }
    )

    result = analyze_ci_nem12(nem12, profile=profile)

    reconciliation = result["bill_reconciliation"]
    assert reconciliation["charge_categories"]["additional_charges"] == -5.0
    assert reconciliation["calculated_subtotal_ex_gst_aud"] == -5.0
    assert reconciliation["calculated_gst_aud"] == -0.5
    assert reconciliation["calculated_total_inc_gst_aud"] == -5.5


def test_ci_analysis_allows_a_separate_optimizer_analysis_period(
    tmp_path,
) -> None:
    nem12 = _nem12_bytes_for_dates(["20260105", "20260106"])
    profile = _profile(nem12)
    profile["analysis_period"] = {
        "start_date": "2026-01-06",
        "end_date": "2026-01-06",
    }
    profile_path = tmp_path / "separate-periods.json"
    profile_path.write_text(json.dumps(profile), encoding="utf-8")

    loaded = load_ci_tariff_profile(profile_path)
    result = analyze_ci_nem12(nem12, profile=loaded)

    assert result["profile"]["billing_period_start"] == "2026-01-05"
    assert result["bill_reconciliation"]["status"] == "pass"
    assert result["demand_evidence"]["rolling_demand_kva"] == pytest.approx(15.0)


@pytest.mark.parametrize(
    ("period_name", "missing_date"),
    [
        ("billing_period", "2026-01-06"),
        ("rolling_period", "2026-01-06"),
        ("analysis_period", "2026-01-06"),
    ],
)
def test_ci_analysis_fails_closed_when_either_period_lacks_complete_streams(
    period_name: str,
    missing_date: str,
) -> None:
    nem12 = _nem12_bytes()
    profile = _profile(nem12)
    if period_name == "billing_period":
        profile["billing_period"] = {
            "start_date": missing_date,
            "end_date": missing_date,
        }
        profile["rolling_period"] = {
            "start_date": "2026-01-05",
            "end_date": missing_date,
        }
    elif period_name == "rolling_period":
        profile["rolling_period"] = {
            "start_date": "2026-01-05",
            "end_date": missing_date,
        }
    else:
        profile["analysis_period"] = {
            "start_date": missing_date,
            "end_date": missing_date,
        }

    with pytest.raises(CiTariffAnalysisError) as error:
        analyze_ci_nem12(nem12, profile=profile)
    assert error.value.code == "coverage_incomplete"


def test_ci_analysis_rejects_two_cent_invoice_rounding_difference() -> None:
    nem12 = _nem12_bytes()
    profile = _profile(nem12)
    profile["expected_reconciliation"]["gst_aud"] = 0.02

    with pytest.raises(CiTariffAnalysisError) as mismatch:
        analyze_ci_nem12(nem12, profile=profile)

    assert mismatch.value.code == "bill_reconciliation_failed"


def test_ci_analysis_rejects_an_upload_not_bound_to_the_profile() -> None:
    nem12 = _nem12_bytes()
    with pytest.raises(CiTariffAnalysisError) as mismatch:
        analyze_ci_nem12(nem12 + b"\n", profile=_profile(nem12))
    assert mismatch.value.code == "evidence_identity_mismatch"


def test_ci_api_and_readiness_use_the_local_evidence_profile(tmp_path, monkeypatch) -> None:
    nem12 = _nem12_bytes()
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(_profile(nem12)), encoding="utf-8")
    monkeypatch.setenv("CI_TARIFF_PROFILE_PATH", str(profile_path))

    assert load_ci_tariff_profile()["profile_id"] == "synthetic_llvt2"
    readiness = ci_workspace_readiness_contract()
    assert readiness["availability"] == "evidence_limited"
    assert {
        area["workspace_id"]
        for area in readiness["workspace_areas"]
        if area["availability"] == "evidence_limited"
    } == {"data_qc", "tariff_mapping", "kw_kva_pf_evidence"}
    assert {
        area["workspace_id"]
        for area in readiness["workspace_areas"]
        if area["availability"] == "input_required"
    } == {"peak_shaving", "scenario_ranking", "report_preview"}

    with create_test_client(sqlite_url_for_path(tmp_path / "ci.sqlite3")) as client:
        response = client.post(
            "/api/commercial-industrial/powercor-llvt2-analysis",
            files={"file": ("synthetic-nem12.csv", nem12, "text/csv")},
        )
    assert response.status_code == 200
    assert response.json()["bill_reconciliation"]["status"] == "pass"

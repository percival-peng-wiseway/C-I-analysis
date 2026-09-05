from copy import deepcopy

import pytest

from solar_battery.ci_reference_benchmark import (
    CONTRACT_VERSION, REQUIRED_BASIS, compare_ci_reference_case,
)


def case():
    # Synthetic analyst declarations; no customer inputs or third-party output.
    basis = {
        "period_start": "2025-01-01", "period_end": "2025-12-31",
        "timezone": "Australia/Brisbane", "interval_minutes": 15,
        "load_basis": "gross_site_load", "existing_pv_kwp": 0,
        "added_pv_kwp": 100, "battery_nominal_kwh": 200,
        "battery_usable_kwh": 180, "battery_power_kw": 100,
        "pv_inverter_kw": 100, "topology": "shared_hybrid_dc",
        "efficiency_basis": "pack_dc_with_one_way_conversion",
        "charge_efficiency": 0.95, "discharge_efficiency": 0.95,
        "standby_loss_per_month": 0, "initial_soc_fraction": 1,
        "terminal_soc_policy": "equal_to_initial",
        "import_limit_kw": "unlimited", "export_limit_kw": 0,
        "reactive_control": "disabled", "dispatch_objective": "tariff_cost",
        "dispatch_horizon_hours": 48, "throughput_cost_basis": "discharge_only",
        "throughput_cost_aud_per_kwh": 0.05,
        "demand_savings_realisation_fraction": 1,
        "analysis_mode": "representative_year", "discount_rate": 0.05,
        "analysis_term_years": 15, "escalation_basis": "nominal_2_percent_annually",
        "value_degradation_basis": "aggregate_0.5_percent_annually",
        "replacement_schedule": [], "annual_om_aud": 1800,
        "currency": "AUD", "tax_basis": "ex_GST", "price_terms": "nominal",
        "net_capex_aud": 120000, "rebate_basis": "none",
    }
    for key in ("load_series_sha256", "pv_series_sha256", "reactive_series_sha256", "tariff_sha256"):
        basis[key] = "a" * 64
    assert set(basis) == set(REQUIRED_BASIS)
    return {
        "contract_version": CONTRACT_VERSION, "basis_reviewed": True, "basis": basis,
        "metrics": {"baseline_bill_aud": 100000, "post_dispatch_bill_aud": 80000,
                    "annual_savings_aud": 20000, "post_dispatch_peak_kva": 150,
                    "net_capex_aud": 120000, "npv_aud": 80000, "payback_years": 6},
    }


def test_matching_case_is_agreement_not_an_accuracy_claim():
    reference = case()
    candidate = deepcopy(reference)
    result = compare_ci_reference_case(reference, candidate)
    assert result["status"] == "within_targets"
    assert result["customer_facing_permission"] is False
    assert result["recommendation_permitted"] is False
    assert "accuracy" not in result
    assert candidate == reference


@pytest.mark.parametrize("key,value", [("interval_minutes", 30), ("discount_rate", .08),
                                      ("reactive_control", "off"), ("topology", "separate_ac")])
def test_equal_numbers_cannot_pass_mismatched_assumptions(key, value):
    reference, candidate = case(), case()
    candidate["basis"][key] = value
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "not_comparable"
    assert key in report["basis_mismatches"]


def test_absent_unreviewed_or_unknown_inputs_fail_closed():
    reference, candidate = case(), case()
    candidate["basis_reviewed"] = False
    candidate["basis"]["topology"] = "unknown"
    del candidate["basis"]["pv_series_sha256"]
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "not_comparable"
    assert "candidate.basis_reviewed" in report["input_issues"]
    assert "candidate.basis.topology" in report["input_issues"]
    assert "candidate.basis.pv_series_sha256" in report["input_issues"]


def test_savings_within_twenty_percent_is_not_enough_if_baseline_bill_is_wrong():
    reference, candidate = case(), case()
    candidate["metrics"].update(baseline_bill_aud=103000, post_dispatch_bill_aud=81000, annual_savings_aud=22000)
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "outside_targets"
    assert next(row for row in report["metrics"] if row["metric"] == "annual_savings_aud")["status"] == "pass"


def test_zero_and_negative_reference_values_are_not_divided_naively():
    reference, candidate = case(), case()
    reference["metrics"].update(post_dispatch_bill_aud=100000, annual_savings_aud=0, npv_aud=-10000)
    candidate["metrics"].update(post_dispatch_bill_aud=99999.9, annual_savings_aud=0.1, npv_aud=10000)
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "outside_targets"
    rows = {r["metric"]: r for r in report["metrics"]}
    assert rows["annual_savings_aud"]["relative_error"] is None
    assert rows["npv_aud"]["relative_error"] == 2


@pytest.mark.parametrize("bad", [True, float("nan"), float("inf"), "20000", 10 ** 400])
def test_invalid_metric_is_not_compared(bad):
    reference, candidate = case(), case()
    candidate["metrics"]["annual_savings_aud"] = bad
    assert compare_ci_reference_case(reference, candidate)["status"] == "not_comparable"


def test_missing_metric_and_non_payback_are_distinct():
    reference, candidate = case(), case()
    reference["metrics"]["payback_years"] = None
    candidate["metrics"]["payback_years"] = None
    assert compare_ci_reference_case(reference, candidate)["status"] == "within_targets"
    del candidate["metrics"]["payback_years"]
    assert compare_ci_reference_case(reference, candidate)["status"] == "not_comparable"


def test_extra_assumption_cannot_be_silently_ignored():
    reference, candidate = case(), case()
    candidate["basis"]["extra_control"] = "enabled"
    assert compare_ci_reference_case(reference, candidate)["basis_mismatches"] == ["extra_control"]


@pytest.mark.parametrize("key,value", [
    ("interval_minutes", []), ("interval_minutes", True), ("interval_minutes", 0),
    ("interval_minutes", 15.0), ("interval_minutes", 1441),
    ("discount_rate", "0.05"), ("discount_rate", float("nan")),
    ("charge_efficiency", 2), ("discharge_efficiency", 0),
    ("analysis_term_years", -15), ("analysis_term_years", 10 ** 400),
    ("battery_nominal_kwh", -1), ("battery_usable_kwh", 201),
    ("standby_loss_per_month", 1.1), ("dispatch_horizon_hours", 0),
    ("annual_om_aud", float("inf")), ("net_capex_aud", -1),
    ("topology", []), ("load_basis", True), ("currency", {}),
    ("currency", "USD"), ("tax_basis", "inc_GST"),
    ("import_limit_kw", None), ("export_limit_kw", -1),
    ("replacement_schedule", None), ("replacement_schedule", [1]),
    ("replacement_schedule", [{"year": 16, "cost_aud": 1000}]),
    ("replacement_schedule", [{"year": 5, "cost_aud": -1}]),
    ("period_start", "bad-date"), ("period_end", "2024-12-31"),
])
def test_identical_invalid_basis_cannot_create_false_agreement(key, value):
    reference, candidate = case(), case()
    reference["basis"][key] = value
    candidate["basis"][key] = value
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "not_comparable"
    assert any(issue.startswith(f"reference.basis.{key}") for issue in report["input_issues"])


def test_replacement_schedule_with_explicit_cost_and_year_can_be_compared():
    reference, candidate = case(), case()
    for item in (reference, candidate):
        item["basis"]["replacement_schedule"] = [{"year": 10, "cost_aud": 20000}]
    assert compare_ci_reference_case(reference, candidate)["status"] == "within_targets"


@pytest.mark.parametrize("key,value,issue", [
    ("annual_savings_aud", 50000, "annual_savings_aud.reconciliation"),
    ("net_capex_aud", 1, "net_capex_aud.reconciliation"),
    ("payback_years", 20, "payback_years.exceeds_term"),
    ("baseline_bill_aud", -100, "annual_savings_aud.reconciliation"),
])
def test_identical_internally_inconsistent_metrics_are_not_comparable(key, value, issue):
    reference, candidate = case(), case()
    for item in (reference, candidate):
        item["metrics"][key] = value
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "not_comparable"
    assert f"reference.metrics.{issue}" in report["input_issues"]


def test_reconciliation_allows_only_currency_rounding_not_percentage_error():
    reference, candidate = case(), case()
    for item in (reference, candidate):
        item["metrics"]["annual_savings_aud"] += 0.02
        item["metrics"]["net_capex_aud"] += 0.01
    assert compare_ci_reference_case(reference, candidate)["status"] == "within_targets"
    candidate["metrics"]["annual_savings_aud"] += 0.01
    assert compare_ci_reference_case(reference, candidate)["status"] == "not_comparable"


def test_finite_metrics_with_overflowing_difference_do_not_break_report_serialisation():
    import json

    reference, candidate = case(), case()
    reference["metrics"]["npv_aud"] = -1e308
    candidate["metrics"]["npv_aud"] = 1e308
    report = compare_ci_reference_case(reference, candidate)
    assert report["status"] == "not_comparable"
    json.dumps(report, allow_nan=False)

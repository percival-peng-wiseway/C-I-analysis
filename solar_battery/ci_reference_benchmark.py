"""Offline, fail-closed comparison of analyst-normalised feasibility results.

Agreement with another model is not evidence of real-world accuracy. This tool
does not run a simulation, alter inputs or approve customer-facing claims.
"""
from __future__ import annotations

import argparse
from datetime import date
import json
import math
from pathlib import Path
from typing import Any


CONTRACT_VERSION = "ci_reference_benchmark_v1"
# Explicitly include model semantics, not just matching equipment capacities.
REQUIRED_BASIS = (
    "load_series_sha256", "pv_series_sha256", "reactive_series_sha256",
    "tariff_sha256", "period_start", "period_end", "timezone",
    "interval_minutes", "load_basis", "existing_pv_kwp", "added_pv_kwp",
    "battery_nominal_kwh", "battery_usable_kwh", "battery_power_kw",
    "pv_inverter_kw", "topology", "efficiency_basis", "charge_efficiency",
    "discharge_efficiency", "standby_loss_per_month", "initial_soc_fraction",
    "terminal_soc_policy", "import_limit_kw", "export_limit_kw",
    "reactive_control", "dispatch_objective", "dispatch_horizon_hours",
    "throughput_cost_basis", "throughput_cost_aud_per_kwh",
    "demand_savings_realisation_fraction", "analysis_mode", "discount_rate",
    "analysis_term_years", "escalation_basis", "value_degradation_basis",
    "replacement_schedule", "annual_om_aud", "currency", "tax_basis",
    "price_terms", "net_capex_aud", "rebate_basis",
)
# Engineering acceptance targets, not published Orkestra guarantees. A 20%
# savings error is one target among these; it is never labelled "80% accurate".
METRIC_TOLERANCES = {
    "baseline_bill_aud": (0.02, 1.0),
    "post_dispatch_bill_aud": (0.05, 1.0),
    "annual_savings_aud": (0.20, 1.0),
    "post_dispatch_peak_kva": (0.10, 0.1),
    "net_capex_aud": (0.01, 1.0),
    "npv_aud": (0.20, 1.0),
    "payback_years": (0.20, 0.1),
}


def _number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _known(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip()) and value.strip().lower() not in {"unknown", "tbd", "not_known"}
    if isinstance(value, dict):
        return bool(value) and all(isinstance(k, str) and _known(v) for k, v in value.items())
    if isinstance(value, list):
        return bool(value) and all(_known(v) for v in value)
    return isinstance(value, bool) or _number(value)


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _basis_value_known(key: str, value: Any) -> bool:
    # Only this field has an explicitly defined empty-list meaning.
    return (key == "replacement_schedule" and value == []) or _known(value)


def _basis_issues(basis: dict[str, Any]) -> list[str]:
    issues = []
    nonnegative = {
        "existing_pv_kwp", "added_pv_kwp", "battery_nominal_kwh",
        "battery_usable_kwh", "battery_power_kw", "pv_inverter_kw",
        "throughput_cost_aud_per_kwh", "annual_om_aud", "net_capex_aud",
    }
    fractions = {"standby_loss_per_month", "initial_soc_fraction",
                 "demand_savings_realisation_fraction", "discount_rate"}
    efficiencies = {"charge_efficiency", "discharge_efficiency"}
    integer_fields = {"interval_minutes", "analysis_term_years"}
    special = nonnegative | fractions | efficiencies | integer_fields | {
        "dispatch_horizon_hours", "import_limit_kw", "export_limit_kw",
        "replacement_schedule", "period_start", "period_end",
    }
    for key in REQUIRED_BASIS:
        value = basis.get(key)
        valid = _basis_value_known(key, value)
        if key in nonnegative:
            valid = _number(value) and value >= 0
        elif key in fractions:
            valid = _number(value) and 0 <= value <= 1
        elif key in efficiencies:
            valid = _number(value) and 0 < value <= 1
        elif key in integer_fields:
            valid = type(value) is int and _number(value) and value > 0
            if key == "interval_minutes":
                valid = valid and value <= 1440
        elif key == "dispatch_horizon_hours":
            valid = _number(value) and value > 0
        elif key in {"import_limit_kw", "export_limit_kw"}:
            valid = value == "unlimited" or (_number(value) and value >= 0)
        elif key in {"period_start", "period_end"}:
            try:
                valid = isinstance(value, str) and date.fromisoformat(value).isoformat() == value
            except ValueError:
                valid = False
        elif key == "replacement_schedule":
            valid = isinstance(value, list)
            if valid:
                for event in value:
                    if not isinstance(event, dict):
                        valid = False
                        break
                    year, cost = event.get("year"), event.get("cost_aud")
                    term = basis.get("analysis_term_years")
                    if (type(year) is not int or not _number(year) or year <= 0
                            or not _number(cost) or cost < 0
                            or (type(term) is int and year > term)
                            or not _known(event)):
                        valid = False
                        break
        elif key not in special:
            valid = isinstance(value, str) and _known(value)
        if key == "currency":
            valid = value == "AUD"
        elif key == "tax_basis":
            valid = value == "ex_GST"
        if not valid:
            issues.append(key)
    if not any(key in issues for key in ("period_start", "period_end")):
        if basis["period_end"] < basis["period_start"]:
            issues.append("period_end.before_start")
    if not any(key in issues for key in ("battery_usable_kwh", "battery_nominal_kwh")):
        if basis["battery_usable_kwh"] > basis["battery_nominal_kwh"]:
            issues.append("battery_usable_kwh.exceeds_nominal")
    return issues


def _metric_reconciliation_issues(case: dict[str, Any]) -> list[str]:
    metrics = case.get("metrics")
    basis = case.get("basis")
    if not isinstance(metrics, dict) or not isinstance(basis, dict):
        return []
    issues = []
    before, after, savings = (metrics.get(key) for key in (
        "baseline_bill_aud", "post_dispatch_bill_aud", "annual_savings_aud"))
    if all(_number(value) for value in (before, after, savings)):
        difference = before - after
        if not _number(difference) or not math.isclose(savings, difference, rel_tol=0, abs_tol=0.020000001):
            issues.append("metrics.annual_savings_aud.reconciliation")
    capital, declared_capital = metrics.get("net_capex_aud"), basis.get("net_capex_aud")
    if _number(capital) and _number(declared_capital):
        if not math.isclose(capital, declared_capital, rel_tol=0, abs_tol=0.010000001):
            issues.append("metrics.net_capex_aud.reconciliation")
    payback, term = metrics.get("payback_years"), basis.get("analysis_term_years")
    if _number(payback) and _number(term) and payback > term:
        issues.append("metrics.payback_years.exceeds_term")
    return issues


def compare_ci_reference_case(reference: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Compare one aligned case; missing/mismatched assumptions block a verdict.

    Inputs use canonical units and definitions documented in the benchmark guide.
    Dataset digests and basis declarations must be independently checked by the
    analyst; equality here cannot certify how a third-party model was executed.
    """
    issues: list[str] = []
    bases: list[dict[str, Any]] = []
    for label, case in (("reference", reference), ("candidate", candidate)):
        if not isinstance(case, dict):
            raise ValueError(f"{label} must be a JSON object")
        if case.get("contract_version") != CONTRACT_VERSION:
            issues.append(f"{label}.contract_version")
        if case.get("basis_reviewed") is not True:
            issues.append(f"{label}.basis_reviewed")
        basis = case.get("basis")
        if not isinstance(basis, dict):
            basis = {}
        bases.append(basis)
        issues.extend(f"{label}.basis.{key}" for key in _basis_issues(basis))
        issues.extend(f"{label}.{issue}" for issue in _metric_reconciliation_issues(case))
        for key in ("load_series_sha256", "pv_series_sha256", "reactive_series_sha256", "tariff_sha256"):
            digest = basis.get(key)
            if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                issues.append(f"{label}.basis.{key}.digest")
    mismatches = sorted(
        key for key in bases[0].keys() | bases[1].keys()
        if key not in bases[0] or key not in bases[1]
        or not _basis_value_known(key, bases[0][key]) or not _basis_value_known(key, bases[1][key])
        or _canonical(bases[0][key]) != _canonical(bases[1][key])
    )
    rows = []
    for key, (relative_tolerance, absolute_tolerance) in METRIC_TOLERANCES.items():
        ref_metrics = reference.get("metrics")
        actual_metrics = candidate.get("metrics")
        ref_metrics = ref_metrics if isinstance(ref_metrics, dict) else {}
        actual_metrics = actual_metrics if isinstance(actual_metrics, dict) else {}
        row: dict[str, Any] = {
            "metric": key, "relative_tolerance": relative_tolerance,
            "absolute_tolerance": absolute_tolerance,
        }
        expected, actual = ref_metrics.get(key), actual_metrics.get(key)
        if key not in ref_metrics or key not in actual_metrics:
            row.update(status="missing", absolute_error=None, relative_error=None)
        elif key == "payback_years" and expected is None and actual is None:
            row.update(status="pass", absolute_error=None, relative_error=None,
                       interpretation="Neither model recovers cost within the matched analysis term.")
        elif not _number(expected) or not _number(actual) or (key != "npv_aud" and key != "annual_savings_aud" and (expected < 0 or actual < 0)):
            row.update(status="invalid", absolute_error=None, relative_error=None)
        else:
            error = abs(actual - expected)
            limit = max(absolute_tolerance, relative_tolerance * abs(expected))
            if not _number(error):
                row.update(status="invalid", absolute_error=None, relative_error=None)
                rows.append(row)
                continue
            sign_flip = ((expected < 0 < actual) or (actual < 0 < expected)) and abs(expected) > absolute_tolerance and abs(actual) > absolute_tolerance
            row.update(status="pass" if error <= limit + 1e-9 and not sign_flip else "fail",
                       absolute_error=error,
                       relative_error=error / abs(expected) if abs(expected) > absolute_tolerance else None,
                       reference=expected, candidate=actual)
        rows.append(row)
    # Missing data is not a failed accuracy test; it is not a test at all.
    not_comparable = bool(issues or mismatches or any(r["status"] in {"missing", "invalid"} for r in rows))
    return {
        "contract_version": CONTRACT_VERSION,
        "status": "not_comparable" if not_comparable else ("within_targets" if all(r["status"] == "pass" for r in rows) else "outside_targets"),
        "input_issues": sorted(set(issues)), "basis_mismatches": mismatches,
        "metrics": rows,
        "customer_facing_permission": False, "recommendation_permitted": False,
        "statement": "Cross-model agreement on one reviewed case is not measured accuracy or a customer recommendation.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    try:
        report = compare_ci_reference_case(
            json.loads(args.reference.read_text(encoding="utf-8-sig")),
            json.loads(args.candidate.read_text(encoding="utf-8-sig")),
        )
    except (OSError, ValueError, TypeError):
        parser.exit(2, "Invalid benchmark input. Check both local JSON files and the benchmark contract.\n")
    print(json.dumps(report, indent=2, allow_nan=False))
    return 0 if report["status"] == "within_targets" else 2


if __name__ == "__main__":
    raise SystemExit(main())

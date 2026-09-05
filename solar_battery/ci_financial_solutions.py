from __future__ import annotations

import hashlib
import json
import math
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import desc, select

from solar_battery.durable_cockpit.orm import CiFinancialSolutionModel, utcnow
from solar_battery.ci_pricing_catalog import resolve_price
from solar_battery.ci_peak_shaving_optimizer import (
    CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
)
from solar_battery.ci_scenario_analysis import (
    CI_OPTIMIZER_AUDIT_PROJECTION_CONTRACT_VERSION,
    CI_OPTIMIZER_RUN_SNAPSHOT_CONTRACT_VERSION,
)


CONTRACT_VERSION = "ci_financial_solution_v4"


class CiFinancialSolutionError(ValueError):
    pass


def calculate_metrics(assumptions: dict[str, Any]) -> dict[str, object]:
    capex = _positive(assumptions, "upfront_cost_aud")
    annual_value = _finite(assumptions, "first_year_net_value_aud")
    annual_om = _non_negative(assumptions, "annual_om_cost_aud", default=0.0)
    discount_rate = _rate(assumptions, "discount_rate")
    degradation_rate = _rate(assumptions, "annual_value_degradation_rate")
    escalation_rate = _rate(
        {
            "annual_value_escalation_rate": assumptions.get(
                "annual_value_escalation_rate", 0.0
            )
        },
        "annual_value_escalation_rate",
    )
    term_years = assumptions.get("analysis_term_years")
    if isinstance(term_years, bool) or not isinstance(term_years, int) or not 1 <= term_years <= 50:
        raise CiFinancialSolutionError("analysis_term_years must be an integer from 1 to 50")

    replacement_by_year = _replacement_events(
        assumptions.get("replacement_events_aud"), term_years=term_years
    )
    cashflows = [-capex]
    annual_projection: list[dict[str, object]] = []
    cumulative_cashflow = -capex
    for year in range(1, term_years + 1):
        escalation_factor = (1 + escalation_rate) ** (year - 1)
        value_retention_factor = (1 - degradation_rate) ** (year - 1)
        projected_value = annual_value * escalation_factor * value_retention_factor
        replacement = replacement_by_year.get(year, 0.0)
        cashflow = projected_value - annual_om - replacement
        cashflows.append(cashflow)
        cumulative_cashflow += cashflow
        annual_projection.append(
            {
                "year": year,
                "value_escalation_factor": escalation_factor,
                "aggregate_value_retention_factor": value_retention_factor,
                "projected_tariff_savings_aud": round(projected_value, 2),
                "annual_om_cost_aud": round(annual_om, 2),
                "replacement_cost_aud": round(replacement, 2),
                "net_cashflow_aud": round(cashflow, 2),
                "discounted_cashflow_aud": round(cashflow / ((1 + discount_rate) ** year), 2),
                "cumulative_cashflow_aud": round(cumulative_cashflow, 2),
            }
        )
    npv = sum(value / ((1 + discount_rate) ** year) for year, value in enumerate(cashflows))
    payback = _payback_years(cashflows)
    irr = _irr(cashflows)
    irr_status = (
        "non_conventional_cashflows"
        if _cashflow_sign_changes(cashflows) > 1
        else "calculated" if irr is not None else "no_bracketed_root"
    )
    return {
        "net_present_value_aud": round(npv, 2),
        "payback_period_years": round(payback, 3) if payback is not None else None,
        "internal_rate_of_return": round(irr, 6) if irr is not None else None,
        "internal_rate_of_return_status": irr_status,
        "lifetime_net_value_undiscounted_aud": round(sum(cashflows), 2),
        "annual_cashflows_aud": [round(value, 2) for value in cashflows[1:]],
        "annual_projection": annual_projection,
        "projection_method": "representative_year_aggregate_value_projection_v1",
        "physical_redispatch_each_year": False,
        "projection_disclosure": (
            "One saved tariff-aware year is projected using aggregate value "
            "escalation and degradation. These factors do not separately model "
            "PV generation degradation or battery capacity ageing. Future-year "
            "dispatch, demand peaks and tariffs are not re-optimised. O&M is "
            "constant nominal AUD; replacement costs do not restore capacity."
        ),
    }


def calculate_catalog_projection(
    session,
    *,
    workspace_id: str,
    owner_id: str,
    authored_inputs: dict[str, Any],
    assumptions: dict[str, Any],
    pricing_catalog_version_id: UUID,
    product_ids: list[str],
    installation_item_ids: list[str],
    first_year_values_aud: dict[str, float],
    value_source: str,
    tariff_value: dict[str, Any] | None = None,
) -> dict[str, object]:
    try:
        capacity_kwh = float(authored_inputs["nominal_capacity_kwh"])
        discharge_kw = float(authored_inputs["max_discharge_kw"])
        pv_capacity_kw = float(authored_inputs["pv_capacity_kwp_dc"])
        pv_inverter_kw = float(authored_inputs["pv_inverter_capacity_kw_ac"])
    except (KeyError, TypeError, ValueError) as exc:
        raise CiFinancialSolutionError(
            "physical scenario capacity and power are invalid"
        ) from exc
    separate_ac = authored_inputs.get("dispatch_topology") == "separate_ac"
    battery_inverter_kw = (
        _non_negative(authored_inputs, "battery_inverter_capacity_kw_ac")
        if separate_ac
        else None
    )
    pricing = resolve_price(
        session,
        version_id=pricing_catalog_version_id,
        product_ids=product_ids,
        installation_item_ids=installation_item_ids,
        capacity_kwh=capacity_kwh,
        discharge_kw=discharge_kw,
        pv_capacity_kw=pv_capacity_kw,
        pv_inverter_kw=pv_inverter_kw,
        battery_inverter_kw=battery_inverter_kw,
        workspace_id=workspace_id,
        owner_id=owner_id,
    )
    term_years = assumptions.get("analysis_term_years")
    value_key = str(pricing["tax_basis"])
    if value_key not in first_year_values_aud:
        raise CiFinancialSolutionError("financial value tax basis is unavailable")
    normalized: dict[str, Any] = {
        "upfront_cost_aud": pricing["resolved_upfront_cost_aud"],
        "first_year_net_value_aud": _finite(
            first_year_values_aud, value_key
        ),
        "annual_om_cost_aud": pricing["resolved_annual_om_cost_aud"],
        "replacement_events_aud": _pricing_replacement_events(
            pricing["lines"], term_years=term_years
        ),
        "discount_rate": _rate(assumptions, "discount_rate"),
        "annual_value_degradation_rate": _rate(
            assumptions, "annual_value_degradation_rate"
        ),
        "analysis_term_years": term_years,
        "currency": "AUD",
        "value_source": value_source,
        "pricing_resolution": pricing,
        "dispatch_topology": "separate_ac" if separate_ac else "shared_hybrid_dc",
        "pv_inverter_capacity_kw_ac": pv_inverter_kw,
        "battery_inverter_capacity_kw_ac": battery_inverter_kw,
    }
    if tariff_value is not None:
        normalized["tariff_value"] = tariff_value
    return {
        "assumptions": normalized,
        "metrics": calculate_metrics(normalized),
    }


def save_solution(
    session,
    *,
    workspace_id: str,
    owner_id: str,
    actor_id: str,
    label: str,
    scenario_id: str,
    source_physical_scenario: dict[str, Any],
    assumptions: dict[str, Any],
    pricing_catalog_version_id: UUID,
    product_ids: list[str],
    installation_item_ids: list[str],
) -> dict[str, object]:
    clean_label = _text(label, "label")
    clean_scenario_id = _text(scenario_id, "scenario_id")
    if source_physical_scenario.get("scenario_id") != clean_scenario_id:
        raise CiFinancialSolutionError("physical scenario identity does not match")
    source_digest = hashlib.sha256(
        json.dumps(source_physical_scenario, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    authored_inputs = source_physical_scenario.get("authored_inputs")
    if not isinstance(authored_inputs, dict):
        raise CiFinancialSolutionError("physical scenario inputs are missing")
    optimizer_snapshot, optimizer_audit = _optimizer_evidence(
        source_physical_scenario
    )
    tariff_value = _tariff_value_snapshot(source_physical_scenario)
    projection = calculate_catalog_projection(
        session,
        workspace_id=workspace_id,
        owner_id=owner_id,
        authored_inputs=authored_inputs,
        assumptions=assumptions,
        pricing_catalog_version_id=pricing_catalog_version_id,
        product_ids=product_ids,
        installation_item_ids=installation_item_ids,
        first_year_values_aud={
            "gst_exclusive": _finite(
                tariff_value, "first_year_value_ex_gst_aud"
            ),
            "gst_inclusive": _finite(
                tariff_value, "first_year_value_inc_gst_aud"
            ),
        },
        value_source="evidence_bound_tariff_scenario",
        tariff_value=tariff_value,
    )
    normalized = projection["assumptions"]
    metrics = projection["metrics"]
    now = utcnow()
    row = CiFinancialSolutionModel(
        id=uuid4(),
        workspace_id=workspace_id,
        owner_id=owner_id,
        label=clean_label,
        scenario_id=clean_scenario_id,
        source_physical_scenario_sha256=source_digest,
        optimizer_run_snapshot_sha256=optimizer_snapshot["snapshot_sha256"],
        optimizer_run_snapshot_json=optimizer_snapshot,
        optimizer_audit_projection_json=optimizer_audit,
        assumptions_json=normalized,
        metrics_json=metrics,
        starred=False,
        created_by_actor_id=actor_id,
        updated_by_actor_id=actor_id,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.flush()
    return _serialize(row)


def list_solutions(session, *, workspace_id: str, owner_id: str) -> list[dict[str, object]]:
    rows = session.scalars(
        select(CiFinancialSolutionModel)
        .where(
            CiFinancialSolutionModel.workspace_id == workspace_id,
            CiFinancialSolutionModel.owner_id == owner_id,
        )
        .order_by(desc(CiFinancialSolutionModel.updated_at))
    ).all()
    return [_serialize(row) for row in rows]


def set_starred(
    session,
    *,
    solution_id: UUID,
    starred: bool,
    workspace_id: str,
    owner_id: str,
    actor_id: str,
) -> dict[str, object]:
    row = session.scalar(
        select(CiFinancialSolutionModel)
        .where(
            CiFinancialSolutionModel.id == solution_id,
            CiFinancialSolutionModel.workspace_id == workspace_id,
            CiFinancialSolutionModel.owner_id == owner_id,
        )
        .with_for_update()
    )
    if row is None:
        raise CiFinancialSolutionError("financial solution not found")
    row.starred = starred
    row.updated_by_actor_id = actor_id
    row.updated_at = utcnow()
    session.flush()
    return _serialize(row)


def _serialize(row: CiFinancialSolutionModel) -> dict[str, object]:
    contract_version = (
        CONTRACT_VERSION
        if row.optimizer_run_snapshot_sha256 is not None
        and isinstance(row.optimizer_run_snapshot_json, dict)
        and row.optimizer_run_snapshot_json.get("contract_version")
        == CI_OPTIMIZER_RUN_SNAPSHOT_CONTRACT_VERSION
        else "ci_financial_solution_v3"
        if row.optimizer_run_snapshot_sha256 is not None
        else "ci_financial_solution_v2"
        if row.assumptions_json.get("value_source") == "evidence_bound_tariff_scenario"
        else "ci_financial_solution_v1"
    )
    return {
        "contract_version": contract_version,
        "solution_id": str(row.id),
        "label": row.label,
        "scenario_id": row.scenario_id,
        "source_physical_scenario_sha256": row.source_physical_scenario_sha256,
        "optimizer_run_snapshot_sha256": row.optimizer_run_snapshot_sha256,
        "optimizer_run_snapshot": row.optimizer_run_snapshot_json,
        "optimizer_audit_projection": row.optimizer_audit_projection_json,
        "assumptions": row.assumptions_json,
        "metrics": row.metrics_json,
        "starred": row.starred,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "customer_facing_permission": False,
    }


def _optimizer_evidence(
    source_physical_scenario: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    post_dispatch = source_physical_scenario.get("post_dispatch")
    snapshot = source_physical_scenario.get("optimizer_run_snapshot")
    audit = source_physical_scenario.get("optimizer_audit_projection")
    if (
        not isinstance(post_dispatch, dict)
        or post_dispatch.get("authority_source")
        != CI_PEAK_SHAVING_ROLLING_REPLAY_ID
        or not isinstance(snapshot, dict)
        or snapshot.get("contract_version")
        != CI_OPTIMIZER_RUN_SNAPSHOT_CONTRACT_VERSION
        or snapshot.get("algorithm_id") != CI_PEAK_SHAVING_ROLLING_REPLAY_ID
        or snapshot.get("customer_facing_permission") is not False
        or snapshot.get("recommendation_permitted") is not False
        or not isinstance(audit, dict)
        or audit.get("contract_version")
        != CI_OPTIMIZER_AUDIT_PROJECTION_CONTRACT_VERSION
        or audit.get("customer_facing_permission") is not False
        or audit.get("recommendation_permitted") is not False
    ):
        raise CiFinancialSolutionError("authoritative optimizer evidence is missing")
    claimed_hash = snapshot.get("snapshot_sha256")
    snapshot_without_hash = {
        key: value for key, value in snapshot.items() if key != "snapshot_sha256"
    }
    if (
        not isinstance(claimed_hash, str)
        or len(claimed_hash) != 64
        or _canonical_sha256(snapshot_without_hash) != claimed_hash
        or audit.get("snapshot_sha256") != claimed_hash
    ):
        raise CiFinancialSolutionError("optimizer evidence digest does not match")
    authored_inputs = source_physical_scenario.get("authored_inputs")
    scenario_projection = {
        "scenario_id": source_physical_scenario.get("scenario_id"),
        "label": source_physical_scenario.get("label"),
        **(authored_inputs if isinstance(authored_inputs, dict) else {}),
    }
    input_projection = snapshot.get("input_projection")
    if (
        not isinstance(input_projection, dict)
        or input_projection.get("scenario_sha256")
        != _canonical_sha256(scenario_projection)
    ):
        raise CiFinancialSolutionError("optimizer evidence input does not match")
    return _json_copy(snapshot), _json_copy(audit)


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode()
    ).hexdigest()


def _json_copy(value: object):
    return json.loads(json.dumps(value))


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 120:
        raise CiFinancialSolutionError(f"{name} must be non-empty and at most 120 characters")
    return value.strip()


def _positive(values: dict[str, Any], key: str) -> float:
    value = values.get(key)
    if isinstance(value, bool):
        raise CiFinancialSolutionError(f"{key} must be positive")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CiFinancialSolutionError(f"{key} must be positive") from exc
    if not math.isfinite(number) or number <= 0:
        raise CiFinancialSolutionError(f"{key} must be positive")
    return number


def _finite(values: dict[str, Any], key: str) -> float:
    value = values.get(key)
    if isinstance(value, bool):
        raise CiFinancialSolutionError(f"{key} must be finite")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CiFinancialSolutionError(f"{key} must be finite") from exc
    if not math.isfinite(number):
        raise CiFinancialSolutionError(f"{key} must be finite")
    return number


def _tariff_value_snapshot(
    source_physical_scenario: dict[str, Any],
) -> dict[str, Any]:
    value = source_physical_scenario.get("annual_tariff_value")
    if (
        not isinstance(value, dict)
        or value.get("calculation_method") != "representative_year_repeat_v1"
        or value.get("customer_facing_permission") is not False
    ):
        raise CiFinancialSolutionError("automatic tariff value is missing")
    for key in (
        "baseline_cost_ex_gst_aud",
        "scenario_cost_ex_gst_aud",
        "first_year_value_ex_gst_aud",
        "baseline_cost_inc_gst_aud",
        "scenario_cost_inc_gst_aud",
        "first_year_value_inc_gst_aud",
    ):
        _finite(value, key)
    return json.loads(json.dumps(value))


def _rate(values: dict[str, Any], key: str) -> float:
    value = values.get(key)
    if isinstance(value, bool):
        raise CiFinancialSolutionError(f"{key} must be between 0 and 1")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CiFinancialSolutionError(f"{key} must be between 0 and 1") from exc
    if not math.isfinite(number) or not 0 <= number < 1:
        raise CiFinancialSolutionError(f"{key} must be between 0 and 1")
    return number


def _non_negative(
    values: dict[str, Any], key: str, *, default: float | None = None
) -> float:
    value = values.get(key, default)
    if isinstance(value, bool):
        raise CiFinancialSolutionError(f"{key} must be non-negative")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CiFinancialSolutionError(f"{key} must be non-negative") from exc
    if not math.isfinite(number) or number < 0:
        raise CiFinancialSolutionError(f"{key} must be non-negative")
    return number


def _pricing_replacement_events(
    lines: object, *, term_years: object
) -> list[dict[str, object]]:
    if isinstance(term_years, bool) or not isinstance(term_years, int):
        raise CiFinancialSolutionError(
            "analysis_term_years must be an integer from 1 to 50"
        )
    events: dict[int, float] = {}
    if not isinstance(lines, list):
        raise CiFinancialSolutionError("pricing replacement lines are invalid")
    for line in lines:
        if not isinstance(line, dict):
            raise CiFinancialSolutionError("pricing replacement lines are invalid")
        amount = _non_negative(line, "replacement_cost_aud", default=0.0)
        interval = line.get("replacement_interval_years")
        if amount == 0:
            continue
        if isinstance(interval, bool) or not isinstance(interval, int) or interval < 1:
            raise CiFinancialSolutionError("pricing replacement interval is invalid")
        for year in range(interval, term_years, interval):
            events[year] = events.get(year, 0.0) + amount
    return [
        {"year": year, "amount_aud": round(amount, 2)}
        for year, amount in sorted(events.items())
    ]


def _replacement_events(
    value: object, *, term_years: int
) -> dict[int, float]:
    if value is None:
        return {}
    if not isinstance(value, list):
        raise CiFinancialSolutionError("replacement_events_aud must be a list")
    events: dict[int, float] = {}
    for item in value:
        if not isinstance(item, dict):
            raise CiFinancialSolutionError("replacement event is invalid")
        year = item.get("year")
        if isinstance(year, bool) or not isinstance(year, int) or not 1 <= year <= term_years:
            raise CiFinancialSolutionError("replacement event year is invalid")
        amount = _non_negative(item, "amount_aud")
        events[year] = events.get(year, 0.0) + amount
    return events


def _payback_years(cashflows: list[float]) -> float | None:
    cumulative = cashflows[0]
    for year, value in enumerate(cashflows[1:], start=1):
        before = cumulative
        cumulative += value
        if cumulative >= 0:
            return (year - 1) + (-before / value)
    return None


def _irr(cashflows: list[float]) -> float | None:
    # A later negative cashflow (for example a replacement) can create multiple
    # IRRs. Do not return one arbitrary bracketed root as a unique project yield.
    if _cashflow_sign_changes(cashflows) > 1:
        return None

    def value(rate: float) -> float:
        return sum(cashflow / ((1 + rate) ** year) for year, cashflow in enumerate(cashflows))

    low, high = -0.999999, 10.0
    low_value, high_value = value(low), value(high)
    if low_value * high_value > 0:
        return None
    for _ in range(120):
        midpoint = (low + high) / 2
        midpoint_value = value(midpoint)
        if abs(midpoint_value) < 1e-9:
            return midpoint
        if low_value * midpoint_value <= 0:
            high = midpoint
        else:
            low, low_value = midpoint, midpoint_value
    return (low + high) / 2


def _cashflow_sign_changes(cashflows: list[float]) -> int:
    signs = [1 if value > 0 else -1 for value in cashflows if value != 0]
    return sum(left != right for left, right in zip(signs, signs[1:]))

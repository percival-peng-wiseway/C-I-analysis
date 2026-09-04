from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from uuid import UUID

from sqlalchemy import select

from solar_battery.ci_annual_financial_comparison import (
    CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION,
)
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_device_profile import (
    CI_BATTERY_PRODUCT_ID,
    CI_INVERTER_PRODUCT_ID,
    CI_PV_PRODUCT_ID,
    device_profile_sha256,
)
from solar_battery.ci_projects import CiProjectError, require_ci_project
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import CiProjectAnnualFinancialResultModel


CI_PROJECT_ANNUAL_FINANCIAL_STATE_CONTRACT_VERSION = (
    "ci_project_annual_financial_state_v1"
)


def record_ci_annual_financial_result(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    expected_tariff_replay_result_sha256: str,
    expected_rebate_profile_sha256: str | None,
    active_tariff_replay_result: dict[str, object],
    result: dict[str, object],
) -> dict[str, object]:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    if (
        canonical_sha256(active_tariff_replay_result)
        != expected_tariff_replay_result_sha256
    ):
        raise CiProjectError(
            "ci_project_annual_financial_inputs_changed",
            "Tariff replay changed while finance was running. Run finance again.",
        )
    _validate_result(
        result,
        project_id=project_id,
        expected_tariff_replay_result_sha256=(
            expected_tariff_replay_result_sha256
        ),
    )
    assumptions = result.get("assumptions")
    if (
        not isinstance(assumptions, dict)
        or assumptions.get("rebate_profile_sha256")
        != expected_rebate_profile_sha256
    ):
        raise CiProjectError(
            "ci_project_annual_financial_result_invalid",
            "The annual finance result rebate profile binding is invalid.",
        )
    stored_result = json.loads(json.dumps(result, sort_keys=True, allow_nan=False))
    now = datetime.now(timezone.utc)
    row = session.scalar(
        select(CiProjectAnnualFinancialResultModel).where(
            CiProjectAnnualFinancialResultModel.project_id == project_id,
            CiProjectAnnualFinancialResultModel.workspace_id == actor.workspace_id,
            CiProjectAnnualFinancialResultModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        row = CiProjectAnnualFinancialResultModel(
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            result_contract_version=(
                CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION
            ),
            tariff_replay_result_sha256=expected_tariff_replay_result_sha256,
            rebate_profile_sha256=expected_rebate_profile_sha256,
            result_sha256=canonical_sha256(stored_result),
            result_json=stored_result,
            created_by_actor_id=actor.actor_id,
            updated_by_actor_id=actor.actor_id,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        row.result_contract_version = (
            CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION
        )
        row.tariff_replay_result_sha256 = expected_tariff_replay_result_sha256
        row.rebate_profile_sha256 = expected_rebate_profile_sha256
        row.result_sha256 = canonical_sha256(stored_result)
        row.result_json = stored_result
        row.updated_by_actor_id = actor.actor_id
        row.updated_at = now
    project.current_stage = "financial_simulation"
    project.updated_by_actor_id = actor.actor_id
    project.updated_at = now
    session.flush()
    return _state_contract(status="ready", row=row, result=stored_result)


def ci_annual_financial_state(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    active_tariff_replay_result: dict[str, object] | None,
    active_device_profile: dict[str, object] | None = None,
    active_rebate_profile_sha256: str | None = None,
    rebate_profile_blocks_finance: bool = False,
) -> dict[str, object]:
    require_ci_project(session, project_id=project_id, actor=actor)
    row = session.scalar(
        select(CiProjectAnnualFinancialResultModel).where(
            CiProjectAnnualFinancialResultModel.project_id == project_id,
            CiProjectAnnualFinancialResultModel.workspace_id == actor.workspace_id,
            CiProjectAnnualFinancialResultModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        return {
            "contract_version": CI_PROJECT_ANNUAL_FINANCIAL_STATE_CONTRACT_VERSION,
            "status": "not_saved",
            "saved_at": None,
            "stale_reasons": [],
            "result": None,
        }
    stale_reasons: list[str] = []
    if (
        active_tariff_replay_result is None
        or canonical_sha256(active_tariff_replay_result)
        != row.tariff_replay_result_sha256
    ):
        stale_reasons.append("tariff_replay_changed")
    if (
        row.result_contract_version
        != CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION
        or row.result_json.get("contract_version")
        != CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION
    ):
        stale_reasons.append("result_contract_unsupported")
    assumptions = row.result_json.get("assumptions")
    if (
        isinstance(assumptions, dict)
        and assumptions.get("price_source") == "workspace_device_profile"
        and (
            active_device_profile is None
            or assumptions.get("device_profile_sha256")
            != device_profile_sha256(active_device_profile)
        )
    ):
        stale_reasons.append("device_profile_changed")
    if rebate_profile_blocks_finance:
        stale_reasons.append("rebate_profile_approval_required")
    elif row.rebate_profile_sha256 != active_rebate_profile_sha256:
        stale_reasons.append("rebate_profile_changed")
    try:
        integrity_ok = canonical_sha256(row.result_json) == row.result_sha256
    except (TypeError, ValueError):
        integrity_ok = False
    if not integrity_ok:
        stale_reasons.append("result_integrity_failed")
    if stale_reasons:
        return _state_contract(
            status="stale", row=row, result=None, stale_reasons=stale_reasons
        )
    _validate_result(
        row.result_json,
        project_id=project_id,
        expected_tariff_replay_result_sha256=(
            row.tariff_replay_result_sha256
        ),
    )
    return _state_contract(status="ready", row=row, result=dict(row.result_json))


def _validate_result(
    result: dict[str, object],
    *,
    project_id: UUID,
    expected_tariff_replay_result_sha256: str,
) -> None:
    solutions = result.get("solutions")
    order = result.get("financial_review_order")
    assumptions = result.get("assumptions")
    price_source = assumptions.get("price_source") if isinstance(assumptions, dict) else None
    equipment_selection = assumptions.get("equipment_selection") if isinstance(assumptions, dict) else None
    selection_is_safe = equipment_selection == {
        "pv_product_id": CI_PV_PRODUCT_ID,
        "battery_product_id": CI_BATTERY_PRODUCT_ID,
        "inverter_product_id": CI_INVERTER_PRODUCT_ID,
    }
    safe_solutions = isinstance(solutions, list) and all(
        isinstance(item, dict)
        and item.get("customer_facing_permission") is False
        and item.get("recommendation_permitted") is False
        and isinstance(item.get("metrics"), dict)
        and _safe_rebate_solution(
            item,
            price_source=price_source,
            ruleset_sha256=(
                assumptions.get("rebate_ruleset_sha256")
                if isinstance(assumptions, dict)
                else None
            ),
        )
        for item in solutions
    )
    if (
        result.get("contract_version")
        != CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION
        or result.get("status") != "ready"
        or result.get("analysis_mode")
        != "evidence_limited_internal_financial_comparison"
        or result.get("project_id") != str(project_id)
        or not _sha256(result.get("source_tariff_replay_sha256"))
        or result.get("source_tariff_replay_sha256")
        != expected_tariff_replay_result_sha256
        or result.get("customer_facing_permission") is not False
        or result.get("recommendation_permitted") is not False
        or result.get("currency_values_permitted") is not True
        or not isinstance(solutions, list)
        or not 1 <= len(solutions) <= 200
        or not safe_solutions
        or not isinstance(order, dict)
        or order.get("recommendation_permitted") is not False
        or not isinstance(assumptions, dict)
        or assumptions.get("currency") != "AUD"
        or assumptions.get("tax_basis") != "gst_exclusive"
        or assumptions.get("price_source")
        not in {
            "workspace_device_profile",
            "analyst_entered_total_solution_price",
        }
        or (price_source == "workspace_device_profile" and not selection_is_safe)
        or (price_source == "analyst_entered_total_solution_price" and equipment_selection is not None)
        or assumptions.get("rebate_ruleset_id") != "au_ci_rebates_2026_v1"
        or not _optional_sha256(assumptions.get("rebate_profile_sha256"))
        or not _sha256(assumptions.get("rebate_ruleset_sha256"))
        or assumptions.get("rebate_application_basis")
        not in {
            "deducted_from_workspace_device_profile_gross_cost",
            "not_deducted_from_analyst_entered_manual_quote",
        }
        or assumptions.get("rebate_application_basis")
        != (
            "deducted_from_workspace_device_profile_gross_cost"
            if price_source == "workspace_device_profile"
            else "not_deducted_from_analyst_entered_manual_quote"
        )
    ):
        raise CiProjectError(
            "ci_project_annual_financial_result_invalid",
            "The annual finance result did not satisfy the persisted safety contract.",
        )


def _safe_rebate_solution(
    item: dict[str, object], *, price_source: object, ruleset_sha256: object
) -> bool:
    gross = _finite_number(item.get("gross_upfront_cost_aud_ex_gst"))
    rebate = _finite_number(item.get("upfront_rebate_aud_ex_gst"))
    net = _finite_number(item.get("upfront_cost_aud_ex_gst"))
    if (
        gross is None
        or rebate is None
        or net is None
        or gross <= 0
        or rebate < 0
        or net <= 0
        or abs(gross - rebate - net) > 0.011
    ):
        return False

    expected_status = (
        "applied_to_device_profile_gross_cost"
        if price_source == "workspace_device_profile"
        else "not_applied_to_manual_quote"
    )
    if item.get("rebate_application_status") != expected_status:
        return False

    breakdown = item.get("rebate_breakdown")
    calculation = item.get("rebate_calculation")
    if not isinstance(breakdown, list) or len(breakdown) != 3:
        return False
    if not isinstance(calculation, dict):
        return False
    if calculation.get("scenario_id") != item.get("scenario_id"):
        return False
    if (
        calculation.get("contract_version")
        != "ci_scenario_rebate_calculation_v1"
        or calculation.get("eligibility_guaranteed") is not False
        or calculation.get("customer_facing_permission") is not False
    ):
        return False
    if calculation.get("ruleset_id") != "au_ci_rebates_2026_v1":
        return False
    if (
        not _sha256(ruleset_sha256)
        or calculation.get("ruleset_sha256") != ruleset_sha256
    ):
        return False

    expected_program_ids = {"solar_stc", "battery_stc", "vic_deemed_veec"}
    calculated_programs = calculation.get("programs")
    if (
        not isinstance(calculated_programs, dict)
        or set(calculated_programs) != expected_program_ids
    ):
        return False
    observed_program_ids: set[object] = set()
    breakdown_total = 0.0
    for entry in breakdown:
        if not isinstance(entry, dict):
            return False
        program_id = entry.get("program_id")
        entry_rebate = _finite_number(entry.get("rebate_aud_ex_gst"))
        quantity = entry.get("certificate_quantity")
        if (
            program_id not in expected_program_ids
            or program_id in observed_program_ids
            or entry_rebate is None
            or entry_rebate < 0
            or isinstance(quantity, bool)
            or not isinstance(quantity, int)
            or quantity < 0
        ):
            return False
        calculated = calculated_programs.get(program_id)
        if not isinstance(calculated, dict):
            return False
        calculated_rebate = _finite_number(
            calculated.get("rebate_aud_ex_gst")
        )
        calculated_price = calculated.get("unit_price_aud_ex_gst")
        entry_price = entry.get("unit_price_aud_ex_gst")
        prices_match = (
            calculated_price is None
            and entry_price is None
        ) or (
            _finite_number(calculated_price) is not None
            and _finite_number(entry_price) is not None
            and abs(float(calculated_price) - float(entry_price)) <= 0.001
        )
        if (
            calculated.get("program_id") != program_id
            or calculated.get("label") != entry.get("label")
            or calculated.get("status") != entry.get("status")
            or calculated.get("certificate_quantity") != quantity
            or calculated_rebate is None
            or calculated_rebate < 0
            or abs(calculated_rebate - entry_rebate) > 0.001
            or not prices_match
            or not _safe_rebate_program(calculated)
        ):
            return False
        observed_program_ids.add(program_id)
        breakdown_total += entry_rebate
    if observed_program_ids != expected_program_ids:
        return False

    calculation_total = _finite_number(
        calculation.get("total_rebate_aud_ex_gst")
    )
    if (
        calculation_total is None
        or calculation_total < 0
        or abs(breakdown_total - calculation_total) > 0.011
    ):
        return False
    if price_source == "workspace_device_profile":
        return abs(rebate - breakdown_total) <= 0.011
    return rebate == 0


def _safe_rebate_program(program: dict[str, object]) -> bool:
    status = program.get("status")
    quantity = program.get("certificate_quantity")
    rebate = _finite_number(program.get("rebate_aud_ex_gst"))
    price = program.get("unit_price_aud_ex_gst")
    formula = program.get("formula")
    sources = program.get("sources")
    if (
        status not in {"disabled", "ineligible", "applied"}
        or isinstance(quantity, bool)
        or not isinstance(quantity, int)
        or quantity < 0
        or rebate is None
        or rebate < 0
        or not isinstance(program.get("reason_codes"), list)
        or not isinstance(program.get("reason_messages"), list)
        or not isinstance(formula, dict)
        or not isinstance(formula.get("rule_id"), str)
        or not formula["rule_id"]
        or not isinstance(formula.get("operands"), dict)
        or not isinstance(formula.get("rounding"), str)
        or not isinstance(sources, dict)
    ):
        return False
    if price is not None:
        numeric_price = _finite_number(price)
        if numeric_price is None or numeric_price < 0:
            return False
    if status in {"disabled", "ineligible"}:
        return quantity == 0 and rebate == 0
    return price is not None and abs(rebate - quantity * float(price)) <= 0.011


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _optional_sha256(value: object) -> bool:
    return value is None or _sha256(value)


def _state_contract(
    *,
    status: str,
    row: CiProjectAnnualFinancialResultModel,
    result: dict[str, object] | None,
    stale_reasons: list[str] | None = None,
) -> dict[str, object]:
    return {
        "contract_version": CI_PROJECT_ANNUAL_FINANCIAL_STATE_CONTRACT_VERSION,
        "status": status,
        "saved_at": row.updated_at.isoformat(),
        "stale_reasons": stale_reasons or [],
        "result": result,
    }

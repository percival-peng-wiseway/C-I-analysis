from __future__ import annotations

from datetime import datetime, timezone
import json
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
    _validate_result(result, project_id=project_id)
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
    _validate_result(row.result_json, project_id=project_id)
    return _state_contract(status="ready", row=row, result=dict(row.result_json))


def _validate_result(result: dict[str, object], *, project_id: UUID) -> None:
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
        for item in solutions
    )
    if (
        result.get("contract_version")
        != CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION
        or result.get("status") != "ready"
        or result.get("analysis_mode")
        != "evidence_limited_internal_financial_comparison"
        or result.get("project_id") != str(project_id)
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
    ):
        raise CiProjectError(
            "ci_project_annual_financial_result_invalid",
            "The annual finance result did not satisfy the persisted safety contract.",
        )


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

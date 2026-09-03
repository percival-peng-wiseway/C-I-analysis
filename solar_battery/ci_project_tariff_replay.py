from __future__ import annotations

from datetime import datetime, timezone
import json
from uuid import UUID

from sqlalchemy import select

from solar_battery.ci_project_feasibility import (
    canonical_sha256,
    design_candidates_sha256,
)
from solar_battery.ci_projects import CiProjectError, require_ci_project
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import (
    CiProjectEvidenceModel,
    CiProjectTariffReplayResultModel,
)


CI_PROJECT_TARIFF_REPLAY_STATE_CONTRACT_VERSION = (
    "ci_project_tariff_replay_state_v1"
)
CI_TARIFF_REPLAY_RESULT_CONTRACT_VERSION = "ci_physical_scenario_review_v6"


def tariff_profile_sha256(profile: dict[str, object]) -> str:
    return canonical_sha256(profile)


def record_ci_tariff_replay_result(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    expected_interval_sha256: str,
    expected_design_candidates_sha256: str,
    expected_tariff_profile_sha256: str,
    expected_scenario_ids: list[str],
    active_tariff_profile: dict[str, object],
    result: dict[str, object],
) -> dict[str, object]:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    candidates = project.design_candidates_json
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    if (
        candidates is None
        or evidence is None
        or evidence.interval_sha256 != expected_interval_sha256
        or design_candidates_sha256(list(candidates))
        != expected_design_candidates_sha256
        or tariff_profile_sha256(active_tariff_profile)
        != expected_tariff_profile_sha256
    ):
        raise CiProjectError(
            "ci_project_tariff_replay_inputs_changed",
            "The project inputs changed while tariff replay was running. Run it again.",
        )

    _validate_result_for_storage(
        result,
        candidates=list(candidates),
        expected_scenario_ids=expected_scenario_ids,
    )
    stored_result = json.loads(json.dumps(result, sort_keys=True, allow_nan=False))
    result_digest = canonical_sha256(stored_result)
    now = datetime.now(timezone.utc)
    row = session.scalar(
        select(CiProjectTariffReplayResultModel).where(
            CiProjectTariffReplayResultModel.project_id == project_id,
            CiProjectTariffReplayResultModel.workspace_id == actor.workspace_id,
            CiProjectTariffReplayResultModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        row = CiProjectTariffReplayResultModel(
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            result_contract_version=CI_TARIFF_REPLAY_RESULT_CONTRACT_VERSION,
            interval_sha256=expected_interval_sha256,
            design_candidates_sha256=expected_design_candidates_sha256,
            tariff_profile_sha256=expected_tariff_profile_sha256,
            result_sha256=result_digest,
            result_json=stored_result,
            created_by_actor_id=actor.actor_id,
            updated_by_actor_id=actor.actor_id,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        row.result_contract_version = CI_TARIFF_REPLAY_RESULT_CONTRACT_VERSION
        row.interval_sha256 = expected_interval_sha256
        row.design_candidates_sha256 = expected_design_candidates_sha256
        row.tariff_profile_sha256 = expected_tariff_profile_sha256
        row.result_sha256 = result_digest
        row.result_json = stored_result
        row.updated_by_actor_id = actor.actor_id
        row.updated_at = now
    project.current_stage = "tariff_replay"
    project.updated_by_actor_id = actor.actor_id
    project.updated_at = now
    session.flush()
    return _state_contract(status="ready", row=row, result=stored_result)


def ci_tariff_replay_state(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    active_tariff_profile: dict[str, object] | None,
) -> dict[str, object]:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    row = session.scalar(
        select(CiProjectTariffReplayResultModel).where(
            CiProjectTariffReplayResultModel.project_id == project_id,
            CiProjectTariffReplayResultModel.workspace_id == actor.workspace_id,
            CiProjectTariffReplayResultModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        return {
            "contract_version": CI_PROJECT_TARIFF_REPLAY_STATE_CONTRACT_VERSION,
            "status": "not_saved",
            "saved_at": None,
            "stale_reasons": [],
            "result": None,
        }

    stale_reasons: list[str] = []
    candidates = project.design_candidates_json
    if (
        candidates is None
        or design_candidates_sha256(list(candidates))
        != row.design_candidates_sha256
    ):
        stale_reasons.append("design_changed")
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    if evidence is None or evidence.interval_sha256 != row.interval_sha256:
        stale_reasons.append("interval_evidence_changed")
    if (
        active_tariff_profile is None
        or tariff_profile_sha256(active_tariff_profile)
        != row.tariff_profile_sha256
    ):
        stale_reasons.append("tariff_profile_changed")
    if (
        row.result_contract_version != CI_TARIFF_REPLAY_RESULT_CONTRACT_VERSION
        or row.result_json.get("contract_version")
        != CI_TARIFF_REPLAY_RESULT_CONTRACT_VERSION
    ):
        stale_reasons.append("result_contract_unsupported")
    try:
        result_integrity_ok = canonical_sha256(row.result_json) == row.result_sha256
    except (TypeError, ValueError):
        result_integrity_ok = False
    if not result_integrity_ok:
        stale_reasons.append("result_integrity_failed")

    if stale_reasons:
        return _state_contract(
            status="stale",
            row=row,
            result=None,
            stale_reasons=stale_reasons,
        )
    _validate_result_for_storage(row.result_json, candidates=list(candidates or []))
    return _state_contract(status="ready", row=row, result=dict(row.result_json))


def _evidence_row(
    session, *, project_id: UUID, actor: LocalActorContext
) -> CiProjectEvidenceModel | None:
    return session.scalar(
        select(CiProjectEvidenceModel).where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
        )
    )


def _validate_result_for_storage(
    result: dict[str, object],
    *,
    candidates: list[dict[str, object]],
    expected_scenario_ids: list[str] | None = None,
) -> None:
    scenarios = result.get("scenarios")
    report_preview = result.get("report_preview")
    candidate_scenario_ids = [
        item.get("scenario_id") for item in candidates if isinstance(item, dict)
    ]
    actual_scenario_ids = (
        [
            item.get("scenario_id")
            for item in scenarios
            if isinstance(item, dict)
        ]
        if isinstance(scenarios, list)
        else []
    )
    safe_scenarios = isinstance(scenarios, list) and all(
        isinstance(item, dict)
        and item.get("recommendation_permitted", False) is False
        and isinstance(item.get("annual_tariff_value"), dict)
        and item["annual_tariff_value"].get("customer_facing_permission") is False
        for item in scenarios
    )
    if (
        result.get("contract_version") != CI_TARIFF_REPLAY_RESULT_CONTRACT_VERSION
        or result.get("analysis_status") != "ready"
        or result.get("analysis_mode") != "evidence_limited_internal_review"
        or result.get("customer_facing_permission") is not False
        or result.get("recommendation_permitted") is not False
        or result.get("currency_values_permitted") is not True
        or not isinstance(scenarios, list)
        or not 1 <= len(scenarios) <= 200
        or len(candidate_scenario_ids) != len(candidates)
        or any(
            not isinstance(scenario_id, str) or not scenario_id
            for scenario_id in candidate_scenario_ids
        )
        or len(set(candidate_scenario_ids)) != len(candidate_scenario_ids)
        or len(actual_scenario_ids) != len(scenarios)
        or any(
            not isinstance(scenario_id, str) or not scenario_id
            for scenario_id in actual_scenario_ids
        )
        or len(set(actual_scenario_ids)) != len(actual_scenario_ids)
        or not set(actual_scenario_ids).issubset(set(candidate_scenario_ids))
        or (
            expected_scenario_ids is not None
            and set(actual_scenario_ids) != set(expected_scenario_ids)
        )
        or not safe_scenarios
        or not isinstance(report_preview, dict)
        or report_preview.get("download_available") is not False
    ):
        raise CiProjectError(
            "ci_project_tariff_replay_result_invalid",
            "The tariff replay result did not satisfy the persisted safety contract.",
        )


def _state_contract(
    *,
    status: str,
    row: CiProjectTariffReplayResultModel,
    result: dict[str, object] | None,
    stale_reasons: list[str] | None = None,
) -> dict[str, object]:
    return {
        "contract_version": CI_PROJECT_TARIFF_REPLAY_STATE_CONTRACT_VERSION,
        "status": status,
        "saved_at": row.updated_at.isoformat(),
        "stale_reasons": stale_reasons or [],
        "result": result,
    }

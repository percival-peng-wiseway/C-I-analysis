from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import desc, select

from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import CiProjectModel


class CiProjectError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def list_ci_projects(session, *, actor: LocalActorContext) -> list[dict[str, object]]:
    rows = session.scalars(
        select(CiProjectModel)
        .where(
            CiProjectModel.workspace_id == actor.workspace_id,
            CiProjectModel.owner_id == actor.owner_id,
        )
        .order_by(desc(CiProjectModel.updated_at), desc(CiProjectModel.created_at))
    ).all()
    return [_project_contract(row) for row in rows]


def create_ci_project(
    session, *, display_name: str, actor: LocalActorContext
) -> dict[str, object]:
    normalized = display_name.strip()
    if not normalized or len(normalized) > 255:
        raise CiProjectError(
            "ci_project_name_invalid",
            "Enter a project name between one and 255 characters.",
        )
    now = datetime.now(timezone.utc)
    row = CiProjectModel(
        id=uuid4(),
        workspace_id=actor.workspace_id,
        owner_id=actor.owner_id,
        display_name=normalized,
        current_stage="setup",
        setup_status="input_required",
        design_candidate_count=0,
        created_by_actor_id=actor.actor_id,
        updated_by_actor_id=actor.actor_id,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.flush()
    return _project_contract(row)


def require_ci_project(
    session, *, project_id: UUID, actor: LocalActorContext
) -> CiProjectModel:
    row = session.scalar(
        select(CiProjectModel).where(
            CiProjectModel.id == project_id,
            CiProjectModel.workspace_id == actor.workspace_id,
            CiProjectModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        raise CiProjectError("ci_project_not_found", "The C&I project was not found.")
    return row


def mark_ci_setup_ready(
    session, *, project_id: UUID, actor: LocalActorContext
) -> dict[str, object]:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    row.setup_status = "ready"
    row.current_stage = "system_design"
    row.updated_by_actor_id = actor.actor_id
    row.updated_at = datetime.now(timezone.utc)
    session.flush()
    return _project_contract(row)


def mark_ci_setup_action_required(
    session, *, project_id: UUID, actor: LocalActorContext
) -> dict[str, object]:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    row.setup_status = "input_required"
    row.current_stage = "setup"
    row.updated_by_actor_id = actor.actor_id
    row.updated_at = datetime.now(timezone.utc)
    session.flush()
    return _project_contract(row)


def record_ci_design_candidates(
    session,
    *,
    project_id: UUID,
    candidate_count: int,
    candidates: list[dict[str, object]],
    design_context: dict[str, object],
    actor: LocalActorContext,
) -> dict[str, object]:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    row.current_stage = "system_design"
    row.design_candidate_count = candidate_count
    row.design_candidates_json = candidates
    row.design_context_json = design_context
    row.design_price_preview_json = None
    row.updated_by_actor_id = actor.actor_id
    row.updated_at = datetime.now(timezone.utc)
    session.flush()
    return _project_contract(row)


def saved_ci_design_candidates(
    session, *, project_id: UUID, actor: LocalActorContext
) -> list[dict[str, object]] | None:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    if row.design_candidates_json is None:
        return None
    return [dict(candidate) for candidate in row.design_candidates_json]


def saved_ci_design_context(
    session, *, project_id: UUID, actor: LocalActorContext
) -> dict[str, object] | None:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    if row.design_context_json is None:
        return None
    return dict(row.design_context_json)


def record_ci_design_price_preview(
    session,
    *,
    project_id: UUID,
    preview: dict[str, object],
    actor: LocalActorContext,
) -> dict[str, object]:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    row.design_price_preview_json = preview
    row.updated_by_actor_id = actor.actor_id
    row.updated_at = datetime.now(timezone.utc)
    session.flush()
    return dict(preview)


def saved_ci_design_price_preview(
    session, *, project_id: UUID, actor: LocalActorContext
) -> dict[str, object] | None:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    if row.design_price_preview_json is None:
        return None
    return dict(row.design_price_preview_json)


def mark_ci_financial_simulation_ready(
    session, *, project_id: UUID, actor: LocalActorContext
) -> dict[str, object]:
    row = require_ci_project(session, project_id=project_id, actor=actor)
    row.current_stage = "financial_simulation"
    row.updated_by_actor_id = actor.actor_id
    row.updated_at = datetime.now(timezone.utc)
    session.flush()
    return _project_contract(row)


def _project_contract(row: CiProjectModel) -> dict[str, object]:
    return {
        "project_id": str(row.id),
        "display_name": row.display_name,
        "current_stage": row.current_stage,
        "setup_status": row.setup_status,
        "design_status": (
            "ready" if row.design_candidates_json is not None else "input_required"
        ),
        "design_candidate_count": row.design_candidate_count,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }

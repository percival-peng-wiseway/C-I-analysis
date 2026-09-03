from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePath
from uuid import UUID

from sqlalchemy import select, update

from solar_battery.ci_projects import CiProjectError, require_ci_project
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.object_store import ObjectStore, StoredObject
from solar_battery.durable_cockpit.orm import CiProjectEvidenceModel


CI_PROJECT_EVIDENCE_STATE_CONTRACT_VERSION = "ci_project_evidence_state_v1"


@dataclass(frozen=True, slots=True)
class CiEvidenceSource:
    filename: str
    content_type: str
    data: bytes


def store_ci_project_evidence_files(
    object_store: ObjectStore,
    *,
    project_id: UUID,
    bill: CiEvidenceSource,
    interval: CiEvidenceSource,
) -> tuple[StoredObject, StoredObject]:
    namespace = f"ci-project-evidence/{project_id}"
    bill_object = object_store.put_bytes(
        namespace=namespace,
        filename_hint=bill.filename,
        data=bill.data,
    )
    try:
        interval_object = object_store.put_bytes(
            namespace=namespace,
            filename_hint=interval.filename,
            data=interval.data,
        )
    except Exception:
        object_store.delete(bill_object.storage_key)
        raise
    return bill_object, interval_object


def record_ci_project_evidence(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    bill: CiEvidenceSource,
    interval: CiEvidenceSource,
    bill_object: StoredObject,
    interval_object: StoredObject,
    inspection_result: dict[str, object],
) -> tuple[str, ...]:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    row = session.scalar(
        select(CiProjectEvidenceModel).where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
        )
    )
    now = datetime.now(timezone.utc)
    old_keys: tuple[str, ...] = ()
    if row is None:
        row = CiProjectEvidenceModel(
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            created_by_actor_id=actor.actor_id,
            created_at=now,
            bill_filename=_safe_filename(bill.filename, fallback="bill.pdf"),
            bill_content_type=_safe_content_type(bill.content_type, "application/pdf"),
            bill_object_store_key=bill_object.storage_key,
            bill_size_bytes=bill_object.size_bytes,
            bill_sha256=bill_object.sha256_hex,
            interval_filename=_safe_filename(interval.filename, fallback="interval.csv"),
            interval_content_type=_safe_content_type(interval.content_type, "text/csv"),
            interval_object_store_key=interval_object.storage_key,
            interval_size_bytes=interval_object.size_bytes,
            interval_sha256=interval_object.sha256_hex,
            inspection_result_json=inspection_result,
            updated_by_actor_id=actor.actor_id,
            updated_at=now,
        )
        session.add(row)
    else:
        old_keys = (row.bill_object_store_key, row.interval_object_store_key)
        row.bill_filename = _safe_filename(bill.filename, fallback="bill.pdf")
        row.bill_content_type = _safe_content_type(bill.content_type, "application/pdf")
        row.bill_object_store_key = bill_object.storage_key
        row.bill_size_bytes = bill_object.size_bytes
        row.bill_sha256 = bill_object.sha256_hex
        row.interval_filename = _safe_filename(interval.filename, fallback="interval.csv")
        row.interval_content_type = _safe_content_type(interval.content_type, "text/csv")
        row.interval_object_store_key = interval_object.storage_key
        row.interval_size_bytes = interval_object.size_bytes
        row.interval_sha256 = interval_object.sha256_hex
        row.inspection_result_json = inspection_result
        row.updated_by_actor_id = actor.actor_id
        row.updated_at = now
    # Evidence is an input to eligibility and downstream pricing. Keep the
    # generated design, but require an explicit Generate action to create a
    # new price snapshot for the replacement source files.
    project.design_price_preview_json = None
    project.updated_by_actor_id = actor.actor_id
    project.updated_at = now
    session.flush()
    return old_keys


def update_ci_project_evidence_inspection(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    inspection_result: dict[str, object],
) -> None:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    row = _require_evidence(session, project_id=project_id, actor=actor)
    now = datetime.now(timezone.utc)
    row.inspection_result_json = inspection_result
    row.updated_by_actor_id = actor.actor_id
    row.updated_at = now
    project.design_price_preview_json = None
    project.updated_by_actor_id = actor.actor_id
    project.updated_at = now
    session.flush()


def update_ci_project_evidence_inspection_if_current(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    expected_saved_at: str,
    inspection_result: dict[str, object],
) -> bool:
    """Persist a lazy inspection upgrade only when its source snapshot is current."""

    require_ci_project(session, project_id=project_id, actor=actor)
    try:
        expected_updated_at = datetime.fromisoformat(expected_saved_at)
    except (TypeError, ValueError):
        return False
    result = session.execute(
        update(CiProjectEvidenceModel)
        .where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
            CiProjectEvidenceModel.updated_at == expected_updated_at,
        )
        .values(
            inspection_result_json=inspection_result,
            updated_by_actor_id=actor.actor_id,
            updated_at=datetime.now(timezone.utc),
        )
        .execution_options(synchronize_session=False)
    )
    session.flush()
    return result.rowcount == 1


def ci_project_evidence_state(
    session, *, project_id: UUID, actor: LocalActorContext
) -> dict[str, object]:
    require_ci_project(session, project_id=project_id, actor=actor)
    row = session.scalar(
        select(CiProjectEvidenceModel).where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        return {
            "contract_version": CI_PROJECT_EVIDENCE_STATE_CONTRACT_VERSION,
            "status": "not_saved",
            "evidence": None,
        }
    return {
        "contract_version": CI_PROJECT_EVIDENCE_STATE_CONTRACT_VERSION,
        "status": "saved",
        "evidence": {
            "saved_at": row.updated_at.isoformat(),
            "files": {
                "bill": {
                    "filename": row.bill_filename,
                    "content_type": row.bill_content_type,
                    "size_bytes": row.bill_size_bytes,
                },
                "interval": {
                    "filename": row.interval_filename,
                    "content_type": row.interval_content_type,
                    "size_bytes": row.interval_size_bytes,
                },
            },
            "inspection": dict(row.inspection_result_json),
        },
    }


def load_ci_project_evidence_sources(
    session,
    object_store: ObjectStore,
    *,
    project_id: UUID,
    actor: LocalActorContext,
) -> tuple[CiEvidenceSource, CiEvidenceSource]:
    row = _require_evidence(session, project_id=project_id, actor=actor)
    bill_bytes = _read_verified(
        object_store,
        storage_key=row.bill_object_store_key,
        expected_size=row.bill_size_bytes,
        expected_sha256=row.bill_sha256,
    )
    interval_bytes = _read_verified(
        object_store,
        storage_key=row.interval_object_store_key,
        expected_size=row.interval_size_bytes,
        expected_sha256=row.interval_sha256,
    )
    return (
        CiEvidenceSource(row.bill_filename, row.bill_content_type, bill_bytes),
        CiEvidenceSource(
            row.interval_filename, row.interval_content_type, interval_bytes
        ),
    )


def _require_evidence(
    session, *, project_id: UUID, actor: LocalActorContext
) -> CiProjectEvidenceModel:
    require_ci_project(session, project_id=project_id, actor=actor)
    row = session.scalar(
        select(CiProjectEvidenceModel).where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        raise CiProjectError(
            "ci_project_evidence_not_saved",
            "Upload the project bill and interval file before confirming bill fields.",
        )
    return row


def _read_verified(
    object_store: ObjectStore,
    *,
    storage_key: str,
    expected_size: int,
    expected_sha256: str,
) -> bytes:
    try:
        with object_store.open_read(storage_key) as handle:
            data = handle.read()
    except (FileNotFoundError, OSError, ValueError) as exc:
        raise CiProjectError(
            "ci_project_evidence_unavailable",
            "The saved project evidence is unavailable. Replace the source files to continue.",
        ) from exc
    if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_sha256:
        raise CiProjectError(
            "ci_project_evidence_integrity_failed",
            "The saved project evidence failed its integrity check. Replace the source files to continue.",
        )
    return data


def _safe_filename(value: str, *, fallback: str) -> str:
    basename = PurePath(value.replace("\\", "/")).name.strip()
    return (basename or fallback)[:255]


def _safe_content_type(value: str, fallback: str) -> str:
    normalized = value.strip()
    return (normalized or fallback)[:128]

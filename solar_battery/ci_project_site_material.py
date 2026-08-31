from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePath
from uuid import UUID, uuid4

from sqlalchemy import func, select

from solar_battery.ci_projects import CiProjectError, require_ci_project
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.object_store import ObjectStore
from solar_battery.durable_cockpit.orm import CiProjectSiteMaterialModel


CI_PROJECT_SITE_MATERIAL_CONTRACT_VERSION = "ci_project_site_material_v1"
MAX_CI_SITE_PHOTO_BYTES = 15 * 1024 * 1024
MAX_CI_SITE_PHOTOS = 8
_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}


@dataclass(frozen=True, slots=True)
class CiSitePhotoSource:
    filename: str
    content_type: str
    data: bytes


def add_ci_project_site_photo(
    session,
    object_store: ObjectStore,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    source: CiSitePhotoSource,
) -> tuple[dict[str, object], str]:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    filename, content_type = _validate_source(source)
    current_count = session.scalar(
        select(func.count(CiProjectSiteMaterialModel.id)).where(
            CiProjectSiteMaterialModel.project_id == project_id,
            CiProjectSiteMaterialModel.workspace_id == actor.workspace_id,
            CiProjectSiteMaterialModel.owner_id == actor.owner_id,
        )
    )
    if int(current_count or 0) >= MAX_CI_SITE_PHOTOS:
        raise CiProjectError(
            "ci_project_site_material_limit_reached",
            f"A project can store up to {MAX_CI_SITE_PHOTOS} site photos.",
        )

    photo_id = uuid4()
    stored = object_store.put_bytes(
        namespace=f"ci-project-site-material/{project.id}",
        filename_hint=filename,
        data=source.data,
        object_identity=photo_id.hex,
    )
    try:
        row = CiProjectSiteMaterialModel(
            id=photo_id,
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            filename=filename,
            content_type=content_type,
            object_store_key=stored.storage_key,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256_hex,
            created_by_actor_id=actor.actor_id,
            created_at=datetime.now(timezone.utc),
        )
        session.add(row)
        session.flush()
    except Exception:
        object_store.delete(stored.storage_key)
        raise
    return _photo_contract(row), stored.storage_key


def list_ci_project_site_photos(
    session, *, project_id: UUID, actor: LocalActorContext
) -> list[dict[str, object]]:
    require_ci_project(session, project_id=project_id, actor=actor)
    rows = session.scalars(
        select(CiProjectSiteMaterialModel)
        .where(
            CiProjectSiteMaterialModel.project_id == project_id,
            CiProjectSiteMaterialModel.workspace_id == actor.workspace_id,
            CiProjectSiteMaterialModel.owner_id == actor.owner_id,
        )
        .order_by(
            CiProjectSiteMaterialModel.created_at,
            CiProjectSiteMaterialModel.id,
        )
    ).all()
    return [_photo_contract(row) for row in rows]


def load_ci_project_site_photo(
    session,
    object_store: ObjectStore,
    *,
    project_id: UUID,
    photo_id: UUID,
    actor: LocalActorContext,
) -> tuple[bytes, str]:
    row = _require_photo(
        session, project_id=project_id, photo_id=photo_id, actor=actor
    )
    try:
        with object_store.open_read(row.object_store_key) as handle:
            data = handle.read()
    except (FileNotFoundError, OSError, ValueError) as exc:
        raise CiProjectError(
            "ci_project_site_material_unavailable",
            "The saved site photo is unavailable. Delete it and upload the image again.",
        ) from exc
    if len(data) != row.size_bytes or hashlib.sha256(data).hexdigest() != row.sha256:
        raise CiProjectError(
            "ci_project_site_material_integrity_failed",
            "The saved site photo failed its integrity check. Delete it and upload the image again.",
        )
    return data, row.content_type


def remove_ci_project_site_photo(
    session,
    *,
    project_id: UUID,
    photo_id: UUID,
    actor: LocalActorContext,
) -> str:
    row = _require_photo(
        session, project_id=project_id, photo_id=photo_id, actor=actor
    )
    storage_key = row.object_store_key
    session.delete(row)
    session.flush()
    return storage_key


def _require_photo(
    session,
    *,
    project_id: UUID,
    photo_id: UUID,
    actor: LocalActorContext,
) -> CiProjectSiteMaterialModel:
    require_ci_project(session, project_id=project_id, actor=actor)
    row = session.scalar(
        select(CiProjectSiteMaterialModel).where(
            CiProjectSiteMaterialModel.id == photo_id,
            CiProjectSiteMaterialModel.project_id == project_id,
            CiProjectSiteMaterialModel.workspace_id == actor.workspace_id,
            CiProjectSiteMaterialModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        raise CiProjectError(
            "ci_project_site_material_not_found", "The site photo was not found."
        )
    return row


def _photo_contract(row: CiProjectSiteMaterialModel) -> dict[str, object]:
    return {
        "photo_id": str(row.id),
        "filename": row.filename,
        "content_type": row.content_type,
        "size_bytes": row.size_bytes,
        "created_at": _utc_isoformat(row.created_at),
        "content_url": (
            f"/api/commercial-industrial/projects/{row.project_id}"
            f"/site-material/{row.id}/content"
        ),
    }


def _utc_isoformat(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _validate_source(source: CiSitePhotoSource) -> tuple[str, str]:
    content_type = source.content_type.strip().lower()
    if content_type not in _ALLOWED_CONTENT_TYPES:
        raise CiProjectError(
            "ci_project_site_material_type_invalid",
            "Upload a JPG, PNG or WebP image.",
        )
    if not source.data:
        raise CiProjectError(
            "ci_project_site_material_empty", "The selected site photo is empty."
        )
    if len(source.data) > MAX_CI_SITE_PHOTO_BYTES:
        raise CiProjectError(
            "ci_project_site_material_too_large",
            f"Each site photo must be {MAX_CI_SITE_PHOTO_BYTES // (1024 * 1024)} MB or smaller.",
        )
    if not _matches_image_signature(content_type, source.data):
        raise CiProjectError(
            "ci_project_site_material_content_invalid",
            "The selected file does not contain a valid JPG, PNG or WebP image.",
        )
    basename = PurePath(source.filename.replace("\\", "/")).name.strip()
    return (basename or _fallback_filename(content_type))[:255], content_type


def _matches_image_signature(content_type: str, data: bytes) -> bool:
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _fallback_filename(content_type: str) -> str:
    return {
        "image/jpeg": "site-photo.jpg",
        "image/png": "site-photo.png",
        "image/webp": "site-photo.webp",
    }[content_type]

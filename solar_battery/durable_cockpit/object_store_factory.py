from __future__ import annotations

from solar_battery.durable_cockpit.filesystem_object_store import (
    FilesystemObjectStore,
)
from solar_battery.durable_cockpit.http_object_store import HttpObjectStore
from solar_battery.durable_cockpit.object_store import ObjectStore
from solar_battery.durable_cockpit.settings import DurableCockpitSettings


def build_object_store(settings: DurableCockpitSettings) -> ObjectStore:
    if settings.object_store_backend == "filesystem":
        return FilesystemObjectStore(settings.object_store_root)
    if settings.object_store_backend == "http":
        if not settings.object_store_http_base_url:
            raise ValueError(
                "OBJECT_STORE_HTTP_BASE_URL is required for the HTTP object store"
            )
        return HttpObjectStore(settings.object_store_http_base_url)
    raise ValueError(
        f"unsupported object-store backend: {settings.object_store_backend!r}"
    )

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from api.ci_main import create_ci_app
from api.dependencies import (
    get_durable_session_factory,
    get_object_store,
    get_settings,
)
from solar_battery.durable_cockpit.filesystem_object_store import (
    FilesystemObjectStore,
)
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import Base
from solar_battery.durable_cockpit.settings import DurableCockpitSettings


class _EngineDisposingTestClient(TestClient):
    def __init__(self, *args, engine, **kwargs) -> None:
        self._test_engine = engine
        super().__init__(*args, **kwargs)

    def __exit__(self, *args) -> None:
        try:
            super().__exit__(*args)
        finally:
            self._test_engine.dispose()

    def close(self) -> None:
        try:
            super().close()
        finally:
            self._test_engine.dispose()


def sqlite_url_for_path(path: Path) -> str:
    return f"sqlite+pysqlite:///{path}"


def synthetic_year_csv(*, year: int = 2025, interval_minutes: int = 60) -> bytes:
    zone = ZoneInfo("Australia/Melbourne")
    local_start = datetime(year, 1, 1, tzinfo=zone)
    local_end = datetime(year + 1, 1, 1, tzinfo=zone)
    start = local_start.astimezone(timezone.utc)
    end = local_end.astimezone(timezone.utc)
    interval_count = int((end - start).total_seconds() // (interval_minutes * 60))
    rows = ["timestamp,load_kwh"]
    for index in range(interval_count):
        timestamp = start + timedelta(minutes=interval_minutes * index)
        rows.append(f"{timestamp.astimezone(zone).isoformat()},1.0")
    return ("\n".join(rows) + "\n").encode()


def local_actor(
    *,
    workspace_id: str = "local-workspace",
    owner_id: str = "local-analyst",
    actor_id: str = "local-analyst",
    display_name: str = "Local analyst",
) -> LocalActorContext:
    return LocalActorContext(
        workspace_id=workspace_id,
        owner_id=owner_id,
        actor_id=actor_id,
        display_name=display_name,
    )


def durable_settings(
    database_url: str,
    *,
    object_store_root: str = ".local/object_store",
) -> DurableCockpitSettings:
    return DurableCockpitSettings(
        database_url=database_url,
        object_store_root=object_store_root,
        local_workspace_id="local-workspace",
        local_owner_id="local-analyst",
        local_actor_id="local-analyst",
        local_actor_display_name="Local analyst",
        api_auth_mode="test",
        api_bearer_token="synthetic-test-credential",
        analysis_lease_seconds=60,
        analysis_heartbeat_seconds=15,
        analysis_max_attempts=3,
    )


def create_sqlite_session_factory(database_url: str):
    engine = create_engine(database_url, future=True, poolclass=NullPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


def create_test_client(
    database_url: str,
    *,
    object_store_root: Path | None = None,
    settings_override: DurableCockpitSettings | None = None,
) -> TestClient:
    settings = settings_override or durable_settings(
        database_url,
        object_store_root=str(object_store_root or Path(".local/object_store")),
    )
    session_factory = create_sqlite_session_factory(database_url)
    object_store = FilesystemObjectStore(settings.object_store_root)

    app = create_ci_app()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_durable_session_factory] = lambda: session_factory
    app.dependency_overrides[get_object_store] = lambda: object_store
    return _EngineDisposingTestClient(
        app,
        engine=session_factory.kw["bind"],
        headers={"Authorization": f"Bearer {settings.api_bearer_token}"},
    )

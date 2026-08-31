from __future__ import annotations

import os
from dataclasses import dataclass, field


DEFAULT_LOCAL_API_BEARER_TOKEN = "ci-local-development-only"
LOOPBACK_DEVELOPMENT_AUTH_MODE = "loopback_development"


@dataclass(frozen=True, slots=True)
class DurableCockpitSettings:
    database_url: str
    object_store_root: str
    object_store_backend: str
    object_store_http_base_url: str
    local_workspace_id: str
    local_owner_id: str
    local_actor_id: str
    local_actor_display_name: str
    api_auth_mode: str
    api_bearer_token: str = field(repr=False)
    analysis_lease_seconds: int
    analysis_heartbeat_seconds: int
    analysis_max_attempts: int

    @classmethod
    def from_env(cls) -> "DurableCockpitSettings":
        api_auth_mode = os.getenv("DURABLE_API_AUTH_MODE", "restricted")
        api_bearer_token = os.getenv(
            "DURABLE_API_BEARER_TOKEN",
            DEFAULT_LOCAL_API_BEARER_TOKEN,
        )
        if (
            api_bearer_token == DEFAULT_LOCAL_API_BEARER_TOKEN
            and api_auth_mode != LOOPBACK_DEVELOPMENT_AUTH_MODE
        ):
            raise ValueError(
                "The development API credential is permitted only in explicit "
                "loopback_development mode. Configure a strong "
                "DURABLE_API_BEARER_TOKEN for any other environment."
            )
        return cls(
            database_url=os.getenv(
                "DATABASE_URL",
                "sqlite+pysqlite:///./.local/e3_ci_analyzer.sqlite3",
            ),
            object_store_root=os.getenv(
                "OBJECT_STORE_ROOT",
                ".local/object_store",
            ),
            object_store_backend=os.getenv(
                "OBJECT_STORE_BACKEND",
                "filesystem",
            ),
            object_store_http_base_url=os.getenv(
                "OBJECT_STORE_HTTP_BASE_URL",
                "",
            ),
            local_workspace_id=os.getenv(
                "LOCAL_WORKSPACE_ID",
                "local-workspace",
            ),
            local_owner_id=os.getenv("LOCAL_OWNER_ID", "local-analyst"),
            local_actor_id=os.getenv("LOCAL_ACTOR_ID", "local-analyst"),
            local_actor_display_name=os.getenv(
                "LOCAL_ACTOR_DISPLAY_NAME",
                "Local analyst",
            ),
            api_auth_mode=api_auth_mode,
            api_bearer_token=api_bearer_token,
            analysis_lease_seconds=int(
                os.getenv("ANALYSIS_LEASE_SECONDS", "60")
            ),
            analysis_heartbeat_seconds=int(
                os.getenv("ANALYSIS_HEARTBEAT_SECONDS", "15")
            ),
            analysis_max_attempts=int(
                os.getenv("ANALYSIS_MAX_ATTEMPTS", "3")
            ),
        )

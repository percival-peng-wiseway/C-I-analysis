from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from solar_battery.durable_cockpit.db import build_session_factory
from solar_battery.durable_cockpit.filesystem_object_store import (
    FilesystemObjectStore,
)
from solar_battery.durable_cockpit.identity import (
    InvalidLocalCredentialError,
    LocalIdentityProvider,
)
from solar_battery.durable_cockpit.settings import DurableCockpitSettings


@lru_cache
def get_settings() -> DurableCockpitSettings:
    return DurableCockpitSettings.from_env()


@lru_cache
def _cached_identity_provider(
    settings: DurableCockpitSettings,
) -> LocalIdentityProvider:
    return LocalIdentityProvider.from_settings(settings)


_bearer_scheme = HTTPBearer(auto_error=False)


def get_identity_provider(
    settings: Annotated[DurableCockpitSettings, Depends(get_settings)],
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(_bearer_scheme),
    ],
) -> LocalIdentityProvider:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    provider = _cached_identity_provider(settings)
    try:
        provider.authenticate(credentials.credentials)
    except InvalidLocalCredentialError as exc:
        raise _unauthorized() from exc
    return provider


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication is required for the internal workspace.",
        headers={"WWW-Authenticate": "Bearer"},
    )


@lru_cache
def _cached_session_factory(settings: DurableCockpitSettings):
    return build_session_factory(settings)


def get_durable_session_factory():
    return _cached_session_factory(get_settings())


@lru_cache
def _cached_object_store(settings: DurableCockpitSettings):
    return FilesystemObjectStore(settings.object_store_root)


def get_object_store():
    return _cached_object_store(get_settings())

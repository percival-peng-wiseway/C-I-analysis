from __future__ import annotations

from dataclasses import dataclass
from secrets import compare_digest

from solar_battery.durable_cockpit.settings import DurableCockpitSettings


@dataclass(frozen=True, slots=True)
class LocalActorContext:
    workspace_id: str
    owner_id: str
    actor_id: str
    display_name: str


class InvalidLocalCredentialError(ValueError):
    """Raised when a request does not present the configured local credential."""


class LocalIdentityProvider:
    def __init__(self, actor: LocalActorContext, *, bearer_token: str) -> None:
        if not bearer_token:
            raise ValueError("The local API bearer token must not be empty.")
        self._actor = actor
        self._bearer_token = bearer_token

    @classmethod
    def from_env(cls) -> "LocalIdentityProvider":
        return cls.from_settings(DurableCockpitSettings.from_env())

    @classmethod
    def from_settings(
        cls,
        settings: DurableCockpitSettings,
    ) -> "LocalIdentityProvider":
        return cls(
            LocalActorContext(
                workspace_id=settings.local_workspace_id,
                owner_id=settings.local_owner_id,
                actor_id=settings.local_actor_id,
                display_name=settings.local_actor_display_name,
            ),
            bearer_token=settings.api_bearer_token,
        )

    def authenticate(self, bearer_token: str) -> LocalActorContext:
        if not compare_digest(bearer_token, self._bearer_token):
            raise InvalidLocalCredentialError("Invalid local API credential.")
        return self._actor

    def current(self) -> LocalActorContext:
        return self._actor

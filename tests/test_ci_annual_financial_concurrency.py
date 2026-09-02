from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
import pytest

from api.ci_routes import post_ci_annual_financial_comparison
from api.ci_schemas import CiAnnualFinancialComparisonRequest
from solar_battery.durable_cockpit.identity import LocalIdentityProvider
from tests.durable_test_helpers import local_actor


class _FakeSession:
    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    def begin(self):
        return self


def _sequence(*values):
    remaining = list(values)

    def next_value(*_args, **_kwargs):
        assert remaining, "The route performed an unexpected extra state read."
        return remaining.pop(0)

    return next_value


def _assert_changed_input_is_not_saved(
    monkeypatch,
    *,
    pricing_mode: str,
    profiles: tuple[dict[str, object], ...],
    replay_states: tuple[dict[str, object], ...],
    device_states: tuple[dict[str, object], ...],
) -> None:
    record_calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        "api.ci_routes.approved_ci_project_tariff_calculation_profile",
        _sequence(*profiles),
    )
    monkeypatch.setattr(
        "api.ci_routes.ci_tariff_replay_state",
        _sequence(*replay_states),
    )
    monkeypatch.setattr(
        "api.ci_routes.ci_device_profile_state",
        _sequence(*device_states),
    )
    monkeypatch.setattr(
        "api.ci_routes.require_ci_project",
        lambda *_args, **_kwargs: SimpleNamespace(setup_status="ready"),
    )
    monkeypatch.setattr(
        "api.ci_routes.compare_ci_annual_financial_scenarios",
        lambda **_kwargs: {"calculated_from": "pre_change_inputs"},
    )
    monkeypatch.setattr(
        "api.ci_routes.record_ci_annual_financial_result",
        lambda *_args, **kwargs: record_calls.append(kwargs),
    )

    identity_provider = LocalIdentityProvider(local_actor(), bearer_token="test")
    with pytest.raises(HTTPException) as error:
        post_ci_annual_financial_comparison(
            project_id=uuid4(),
            payload=CiAnnualFinancialComparisonRequest(
                pricing_mode=pricing_mode,
                prices=[],
            ),
            identity_provider=identity_provider,
            session_factory=_FakeSession,
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == (
        "ci_project_annual_financial_inputs_changed"
    )
    assert record_calls == []


def test_annual_finance_does_not_save_if_approved_tariff_changes_during_calculation(
    monkeypatch,
) -> None:
    replay = {"status": "ready", "result": {"revision": "replay-a"}}
    device = {"status": "not_configured", "profile": None}

    _assert_changed_input_is_not_saved(
        monkeypatch,
        pricing_mode="manual_quotes",
        profiles=({"revision": "tariff-a"}, {"revision": "tariff-b"}),
        replay_states=(replay,),
        device_states=(device,),
    )


def test_annual_finance_does_not_save_if_replay_changes_during_calculation(
    monkeypatch,
) -> None:
    tariff = {"revision": "tariff-a"}
    device = {"status": "not_configured", "profile": None}

    _assert_changed_input_is_not_saved(
        monkeypatch,
        pricing_mode="manual_quotes",
        profiles=(tariff, tariff),
        replay_states=(
            {"status": "ready", "result": {"revision": "replay-a"}},
            {"status": "ready", "result": {"revision": "replay-b"}},
        ),
        device_states=(device,),
    )


def test_annual_finance_does_not_save_if_device_profile_changes_during_calculation(
    monkeypatch,
) -> None:
    tariff = {"revision": "tariff-a"}
    replay = {"status": "ready", "result": {"revision": "replay-a"}}

    _assert_changed_input_is_not_saved(
        monkeypatch,
        pricing_mode="device_profile",
        profiles=(tariff, tariff),
        replay_states=(replay, replay),
        device_states=(
            {"status": "ready", "profile": {"revision": "device-a"}},
            {"status": "ready", "profile": {"revision": "device-b"}},
        ),
    )

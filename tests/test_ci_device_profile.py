from __future__ import annotations

from solar_battery.ci_device_profile import suggested_ci_device_profile
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


def _profile(**overrides: object) -> dict[str, object]:
    profile = suggested_ci_device_profile()
    profile.update(overrides)
    return profile


def test_workspace_device_profile_is_explicit_and_persistent(tmp_path) -> None:
    with create_test_client(sqlite_url_for_path(tmp_path / "device-profile.sqlite3")) as client:
        initial = client.get(
            "/api/commercial-industrial/settings/device-profile"
        )
        assert initial.status_code == 200
        assert initial.json()["status"] == "not_configured"
        assert initial.json()["profile"] is None
        assert initial.json()["suggested_profile"]["pv_cost_aud_per_kwp_dc"] == 530.0

        saved = client.put(
            "/api/commercial-industrial/settings/device-profile",
            json=_profile(battery_cost_aud_per_kwh=425.0),
        )
        assert saved.status_code == 200, saved.json()
        payload = saved.json()
        assert payload["status"] == "ready"
        assert payload["profile"]["battery_cost_aud_per_kwh"] == 425.0
        assert len(payload["profile_sha256"]) == 64

        restored = client.get(
            "/api/commercial-industrial/settings/device-profile"
        ).json()
        assert restored["profile"] == payload["profile"]
        assert restored["profile_sha256"] == payload["profile_sha256"]


def test_workspace_device_profile_rejects_invalid_prices(tmp_path) -> None:
    with create_test_client(sqlite_url_for_path(tmp_path / "device-profile-invalid.sqlite3")) as client:
        response = client.put(
            "/api/commercial-industrial/settings/device-profile",
            json=_profile(pv_cost_aud_per_kwp_dc=0),
        )
        assert response.status_code == 422

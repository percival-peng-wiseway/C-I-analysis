from __future__ import annotations

import copy
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from solar_battery.ci_device_profile import (
    CI_DEVICE_PROFILE_CONTRACT_VERSION,
    CI_V2_DEVICE_PROFILE_CONTRACT_VERSION,
    ci_device_profile_state,
    device_profile_sha256,
    suggested_ci_device_profile,
    validate_ci_device_profile,
)
from solar_battery.ci_projects import CiProjectError
from solar_battery.durable_cockpit.orm import CiDeviceProfileModel
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    local_actor,
    sqlite_url_for_path,
)


def _profile(**overrides: object) -> dict[str, object]:
    profile = suggested_ci_device_profile()
    profile.update(overrides)
    return profile


def _v2_profile(**overrides: object) -> dict[str, object]:
    profile = _profile(**overrides)
    profile["contract_version"] = CI_V2_DEVICE_PROFILE_CONTRACT_VERSION
    profile.pop("solution_profiles")
    profile.pop("default_solution_profile_selection")
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
            json=_v2_profile(battery_cost_aud_per_kwh=425.0),
        )
        assert saved.status_code == 200, saved.json()
        payload = saved.json()
        assert payload["status"] == "ready"
        assert payload["profile"]["battery_cost_aud_per_kwh"] == 425.0
        assert payload["profile"]["contract_version"] == CI_DEVICE_PROFILE_CONTRACT_VERSION
        assert payload["profile"]["default_solution_profile_selection"] == {
            "solar_profile_id": "generic_crystalline_pv_v1",
            "battery_profile_id": "generic_lfp_ac_2h_v1",
        }
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
            json=_v2_profile(pv_cost_aud_per_kwp_dc=0),
        )
        assert response.status_code == 422


def test_workspace_device_profile_keeps_v2_default_for_legacy_clients(tmp_path) -> None:
    payload = _v2_profile()
    payload.pop("contract_version")

    with create_test_client(sqlite_url_for_path(tmp_path / "device-profile-default-version.sqlite3")) as client:
        response = client.put(
            "/api/commercial-industrial/settings/device-profile",
            json=payload,
        )

    assert response.status_code == 200, response.json()
    assert response.json()["profile"]["contract_version"] == (
        CI_DEVICE_PROFILE_CONTRACT_VERSION
    )


def test_suggested_v3_solution_profiles_are_explicit_screening_assumptions() -> None:
    profile = validate_ci_device_profile(suggested_ci_device_profile())

    assert profile["contract_version"] == "ci_device_profile_v3"
    solar = profile["solution_profiles"]["solar_profiles"][0]
    battery = profile["solution_profiles"]["battery_profiles"][0]
    assert solar == {
        "profile_id": "generic_crystalline_pv_v1",
        "version": 1,
        "status": "published",
        "name": "Generic crystalline PV screening profile",
        "manufacturer": "Generic",
        "model": "Screening assumption",
        "module_technology": "monocrystalline",
        "rated_power_w": 600.0,
        "module_efficiency_percent": 22.0,
        "temperature_coefficient_percent_per_c": -0.35,
        "annual_degradation_percent": 0.5,
        "default_dc_ac_ratio": 1.15,
        "source_type": "analyst_assumption",
        "source_label": "Generic screening assumption",
        "source_date": None,
    }
    assert battery["profile_id"] == "generic_lfp_ac_2h_v1"
    assert battery["manufacturer"] == "Generic"
    assert battery["model"] == "Screening assumption"
    assert battery["source_type"] == "analyst_assumption"
    assert battery["nominal_capacity_kwh_per_unit"] == 100.0
    assert battery["continuous_power_kw_per_unit"] == 50.0
    assert profile["default_solution_profile_selection"] == {
        "solar_profile_id": solar["profile_id"],
        "battery_profile_id": battery["profile_id"],
    }


def test_v2_upgrade_preserves_prices_catalog_and_finance_values() -> None:
    profile = _v2_profile(
        pv_cost_aud_per_kwp_dc=612.34,
        battery_cost_aud_per_kwh=456.78,
        inverter_cost_aud_per_kw_ac=91.23,
        discount_rate=0.091,
        analysis_term_years=23,
    )
    profile["equipment_catalog"]["pv_products"][0][
        "capital_cost_aud_per_kwp_dc"
    ] = 612.34
    profile["equipment_catalog"]["pv_products"][0][
        "replacement_cost_aud_per_kwp_dc"
    ] = 501.25
    profile["equipment_catalog"]["battery_products"][0]["cost_curve"][1][
        "capital_cost_aud"
    ] = 95_432.1
    profile["equipment_catalog"]["inverter_products"][0]["cost_curve"][2][
        "annual_om_aud"
    ] = 321.5

    normalized = validate_ci_device_profile(profile)

    assert normalized["contract_version"] == CI_DEVICE_PROFILE_CONTRACT_VERSION
    assert normalized["pv_cost_aud_per_kwp_dc"] == 612.34
    assert normalized["battery_cost_aud_per_kwh"] == 456.78
    assert normalized["inverter_cost_aud_per_kw_ac"] == 91.23
    assert normalized["discount_rate"] == 0.091
    assert normalized["analysis_term_years"] == 23
    assert normalized["equipment_catalog"]["pv_products"][0][
        "replacement_cost_aud_per_kwp_dc"
    ] == 501.25
    assert normalized["equipment_catalog"]["battery_products"][0]["cost_curve"][1][
        "capital_cost_aud"
    ] == 95_432.1
    assert normalized["equipment_catalog"]["inverter_products"][0]["cost_curve"][2][
        "annual_om_aud"
    ] == 321.5
    assert normalized["solution_profiles"] == suggested_ci_device_profile()[
        "solution_profiles"
    ]


def test_integrity_valid_stored_v2_profile_is_read_as_v3(tmp_path) -> None:
    session_factory = create_sqlite_session_factory(
        sqlite_url_for_path(tmp_path / "stored-v2-profile.sqlite3")
    )
    actor = local_actor()
    raw_v2 = _v2_profile(battery_cost_aud_per_kwh=477.25)
    now = datetime.now(timezone.utc)
    with session_factory() as session:
        with session.begin():
            session.add(
                CiDeviceProfileModel(
                    id=uuid4(),
                    workspace_id=actor.workspace_id,
                    owner_id=actor.owner_id,
                    profile_contract_version=CI_V2_DEVICE_PROFILE_CONTRACT_VERSION,
                    profile_sha256=device_profile_sha256(raw_v2),
                    profile_json=raw_v2,
                    created_by_actor_id=actor.actor_id,
                    updated_by_actor_id=actor.actor_id,
                    created_at=now,
                    updated_at=now,
                )
            )

    with session_factory() as session:
        state = ci_device_profile_state(session, actor=actor)

    assert state["status"] == "ready"
    assert state["profile"]["contract_version"] == CI_DEVICE_PROFILE_CONTRACT_VERSION
    assert state["profile"]["battery_cost_aud_per_kwh"] == 477.25
    assert state["profile"]["default_solution_profile_selection"][
        "battery_profile_id"
    ] == "generic_lfp_ac_2h_v1"


def test_v1_upgrade_preserves_legacy_price_and_finance_values() -> None:
    legacy = {
        "contract_version": "ci_device_profile_v1",
        "profile_id": "workspace_device_profile",
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "pv_cost_aud_per_kwp_dc": 701.25,
        "battery_cost_aud_per_kwh": 502.5,
        "inverter_cost_aud_per_kw_ac": 102.75,
        "discount_rate": 0.075,
        "annual_value_escalation_rate": 0.02,
        "annual_value_degradation_rate": 0.006,
        "annual_om_fraction_of_capex": 0.012,
        "analysis_term_years": 20,
    }

    normalized = validate_ci_device_profile(legacy)

    assert normalized["contract_version"] == CI_DEVICE_PROFILE_CONTRACT_VERSION
    assert normalized["pv_cost_aud_per_kwp_dc"] == 701.25
    assert normalized["battery_cost_aud_per_kwh"] == 502.5
    assert normalized["inverter_cost_aud_per_kw_ac"] == 102.75
    assert normalized["discount_rate"] == 0.075
    assert normalized["analysis_term_years"] == 20
    assert normalized["default_solution_profile_selection"][
        "solar_profile_id"
    ] == "generic_crystalline_pv_v1"


@pytest.mark.parametrize(
    ("path", "invalid_value"),
    [
        (("solar_profiles", 0, "rated_power_w"), 99),
        (("solar_profiles", 0, "temperature_coefficient_percent_per_c"), 0.01),
        (("battery_profiles", 0, "standby_loss_percent_per_month"), 100),
        (("battery_profiles", 0, "minimum_units"), 0),
        (("battery_profiles", 0, "source_date"), "2026-02-30"),
    ],
)
def test_v3_rejects_invalid_solution_profile_fields(
    path: tuple[str, int, str], invalid_value: object
) -> None:
    profile = suggested_ci_device_profile()
    group, index, field = path
    profile["solution_profiles"][group][index][field] = invalid_value

    with pytest.raises(CiProjectError) as exc_info:
        validate_ci_device_profile(profile)
    assert exc_info.value.code == "ci_device_profile_invalid"


def test_v3_rejects_duplicate_profile_ids() -> None:
    profile = suggested_ci_device_profile()
    profile["solution_profiles"]["battery_profiles"][0][
        "profile_id"
    ] = "generic_crystalline_pv_v1"

    with pytest.raises(CiProjectError, match="globally unique"):
        validate_ci_device_profile(profile)


@pytest.mark.parametrize("status", ["draft", "retired"])
def test_v3_default_selection_must_reference_published_profiles(status: str) -> None:
    profile = copy.deepcopy(suggested_ci_device_profile())
    profile["solution_profiles"]["solar_profiles"][0]["status"] = status

    with pytest.raises(CiProjectError, match="reference published profiles"):
        validate_ci_device_profile(profile)


def test_v3_default_selection_rejects_unknown_profile_id() -> None:
    profile = suggested_ci_device_profile()
    profile["default_solution_profile_selection"][
        "battery_profile_id"
    ] = "unknown_battery_v1"

    with pytest.raises(CiProjectError, match="reference published profiles"):
        validate_ci_device_profile(profile)

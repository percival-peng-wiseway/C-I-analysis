from __future__ import annotations

import math
from uuid import UUID

import pytest
from pydantic import ValidationError

from api.ci_schemas import CiDesignCandidatesRequest
from solar_battery.ci_design_context import validate_ci_design_context
from solar_battery.ci_device_profile import suggested_ci_device_profile
from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_solution_generator import generate_ci_solutions
from solar_battery.durable_cockpit.orm import CiProjectModel
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    sqlite_url_for_path,
)


def _device_profile(*, solar_status: str = "published") -> dict[str, object]:
    return {
        "contract_version": "ci_device_profile_v4",
        "solution_profiles": {
            "solar_profiles": [
                {
                    "profile_id": "solar-630",
                    "status": solar_status,
                    "version": 1,
                    "manufacturer": "Synthetic Solar",
                    "rated_power_w": 630.0,
                    "default_dc_ac_ratio": 1.2,
                    "source_label": "Synthetic published profile",
                }
            ],
            "battery_profiles": [
                {
                    "profile_id": "battery-7",
                    "status": "published",
                    "version": 2,
                    "manufacturer": "Synthetic Battery",
                    "coupling": "ac",
                    "nominal_capacity_kwh_per_unit": 7.0,
                    "minimum_units": 2,
                    "maximum_units": 20,
                    "continuous_power_kw_per_unit": 3.5,
                    "round_trip_efficiency_percent": 90.0,
                    "power_conversion_efficiency_percent": 98.0,
                    "usable_depth_of_discharge_percent": 90.0,
                    "source_label": "Synthetic published profile",
                }
            ],
            "inverter_profiles": [
                {
                    "profile_id": "inverter-125",
                    "status": "draft",
                    "rated_active_power_kw": 125.0,
                    "maximum_reactive_power_kvar": 82.5,
                }
            ],
        },
    }


def _request(*, maximum_pv: float = 101.0, headroom: float = 200.0):
    return {
        "contract_version": "ci_solution_generation_request_v1",
        "pv_range": {
            "minimum_kwp_dc": 100.0,
            "maximum_kwp_dc": maximum_pv,
            "step_kwp_dc": 1.0,
        },
        "battery_range": {
            "minimum_kwh": 0.0,
            "maximum_kwh": 14.0,
            "step_kwh": 7.0,
        },
        "solar_profile_id": "solar-630",
        "battery_profile_id": "battery-7",
        "site_factors": {
            "resource_basis": "gross_specific_yield_before_site_losses",
            "resource_source": "site_assessment",
            "resource_label": "Synthetic site study",
            "annual_specific_yield_kwh_per_kw": 1500.0,
            "array_azimuth_degrees": 0.0,
            "array_tilt_degrees": 20.0,
            "shading_loss_percent": 3.0,
            "soiling_loss_percent": 2.0,
            "temperature_loss_percent": 5.0,
            "wiring_mismatch_loss_percent": 2.0,
            "other_system_loss_percent": 0.0,
            "system_availability_percent": 99.0,
        },
        "connection_options": {
            "inverter_block_size_kw": 5.0,
            "site_ac_headroom_kw": headroom,
            "allow_grid_charging": False,
            "reactive_support_enabled": False,
            "reactive_support_max_kvar": 0.0,
            "grid_emissions_factor_kg_co2e_per_kwh": None,
            "initial_soc_basis": "full_soc_physical_upper_bound",
        },
    }


def test_python_generator_snaps_deduplicates_and_adds_pv_only_comparators() -> None:
    digest = "a" * 64

    first = generate_ci_solutions(
        _request(),
        device_profile=_device_profile(),
        device_profile_sha256=digest,
    )
    second = generate_ci_solutions(
        _request(),
        device_profile=_device_profile(),
        device_profile_sha256=digest,
    )

    assert first == second
    assert first["generation_summary"] == {
        "requested_count": 6,
        "deduplicated_count": 2,
        "rejected_count": 0,
        "generated_candidate_count": 4,
        "rejection_reasons": [],
    }
    candidates = first["candidates"]
    assert len(candidates) == 4
    assert {item["pv_capacity_kwp_dc"] for item in candidates} == {
        100.17,
        101.43,
    }
    assert {item["nominal_capacity_kwh"] for item in candidates} == {0.0, 14.0}
    assert all(item["pv_inverter_capacity_kw_ac"] in {85.0} for item in candidates)
    assert all(item["shared_ac_headroom_kw"] == 85.0 for item in candidates)
    assert all(
        item["grid_emissions_factor_kg_co2e_per_kwh"] == 0.0
        for item in candidates
    )
    battery_candidate = next(
        item for item in candidates if item["nominal_capacity_kwh"] > 0
    )
    expected_efficiency = math.sqrt(0.9) * 0.98
    assert battery_candidate["charge_efficiency"] == pytest.approx(
        expected_efficiency
    )
    assert battery_candidate["discharge_efficiency"] == pytest.approx(
        expected_efficiency
    )
    assert battery_candidate["min_soc_fraction"] == pytest.approx(0.1)
    assert battery_candidate["max_soc_fraction"] == 1.0
    assert battery_candidate["initial_soc_fraction"] == 1.0

    context = first["design_context"]
    assert context["contract_version"] == "ci_design_context_v2"
    assert context["profile_selection"]["device_profile_sha256"] == digest
    assert context["profile_selection"]["solar_profile"]["source_label"] == (
        "Synthetic published profile"
    )
    assert context["profile_selection"]["battery_profile"][
        "nominal_capacity_kwh_per_unit"
    ] == 7.0
    assert validate_ci_design_context(context) == context


def test_python_generator_rejects_connection_overflow_without_clamping() -> None:
    request = _request(maximum_pv=100.0, headroom=50.0)
    request["pv_range"]["minimum_kwp_dc"] = 10.0
    request["pv_range"]["step_kwp_dc"] = 90.0
    request["battery_range"] = {
        "minimum_kwh": 0.0,
        "maximum_kwh": 0.0,
        "step_kwh": 1.0,
    }

    result = generate_ci_solutions(
        request,
        device_profile=_device_profile(),
        device_profile_sha256=None,
    )

    assert result["generation_summary"] == {
        "requested_count": 2,
        "deduplicated_count": 0,
        "rejected_count": 1,
        "generated_candidate_count": 1,
        "rejection_reasons": [
            {"code": "site_ac_headroom_exceeded", "count": 1}
        ],
    }
    assert result["candidates"][0]["pv_inverter_capacity_kw_ac"] == 10.0


def test_python_generator_accepts_only_published_profiles() -> None:
    with pytest.raises(CiProjectError, match="published solar profile"):
        generate_ci_solutions(
            _request(),
            device_profile=_device_profile(solar_status="draft"),
            device_profile_sha256=None,
        )


def test_python_generator_fails_closed_for_dc_coupled_battery_profile() -> None:
    profile = _device_profile()
    profile["solution_profiles"]["battery_profiles"][0]["coupling"] = "dc"

    with pytest.raises(CiProjectError, match="only AC-coupled"):
        generate_ci_solutions(
            _request(),
            device_profile=profile,
            device_profile_sha256=None,
        )


def test_python_generator_accepts_real_v3_profiles_and_hashes_snapshots() -> None:
    profile = suggested_ci_device_profile()
    request = _request(maximum_pv=100.0)
    request["solar_profile_id"] = "generic_crystalline_pv_v1"
    request["battery_profile_id"] = "generic_lfp_ac_2h_v1"
    request["battery_range"] = {
        "minimum_kwh": 100.0,
        "maximum_kwh": 100.0,
        "step_kwh": 100.0,
    }

    original = generate_ci_solutions(
        request,
        device_profile=profile,
        device_profile_sha256=None,
    )
    profile["solution_profiles"]["solar_profiles"][0]["source_label"] = (
        "Revised screening assumption"
    )
    revised = generate_ci_solutions(
        request,
        device_profile=profile,
        device_profile_sha256=None,
    )

    assert original["design_context"]["profile_selection"]["solar_profile"][
        "version"
    ] == 1
    original_ids = {item["scenario_id"] for item in original["candidates"]}
    revised_ids = {item["scenario_id"] for item in revised["candidates"]}
    assert original_ids.isdisjoint(revised_ids)


def test_v2_design_context_rejects_tampered_derived_values() -> None:
    result = generate_ci_solutions(
        _request(),
        device_profile=_device_profile(),
        device_profile_sha256="b" * 64,
    )
    context = result["design_context"]
    context["technical_options"]["charge_efficiency_percent"] = 99.0

    with pytest.raises(CiProjectError, match="inconsistent"):
        validate_ci_design_context(context)


def test_design_request_requires_exactly_one_candidate_source() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        CiDesignCandidatesRequest()
    with pytest.raises(ValidationError, match="exactly one"):
        CiDesignCandidatesRequest(
            scenarios=[{"scenario_id": "legacy"}],
            generation_request=_request(),
        )


def test_generation_route_reads_profile_generates_and_persists_context(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "solution-generator.sqlite3")
    profile_digest = "c" * 64
    captured = {"state_calls": 0}

    def device_state(_session, *, actor):
        captured["state_calls"] += 1
        assert actor.workspace_id == "local-workspace"
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": profile_digest,
            "profile": _device_profile(),
            "suggested_profile": _device_profile(),
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Generated solution project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        try:
            with session_factory.begin() as session:
                project = session.get(CiProjectModel, UUID(project_id))
                assert project is not None
                project.setup_status = "ready"
                project.current_stage = "system_design"

            response = client.post(
                f"/api/commercial-industrial/projects/{project_id}/design-candidates",
                json={"generation_request": _request()},
            )
            assert response.status_code == 200
            result = response.json()
            assert result["candidate_count"] == 4
            assert result["generation_summary"]["requested_count"] == 6
            assert result["design_context"]["contract_version"] == (
                "ci_design_context_v2"
            )
            assert result["design_context"]["profile_selection"][
                "device_profile_sha256"
            ] == profile_digest
            assert captured["state_calls"] == 1

            restored = client.get(
                f"/api/commercial-industrial/projects/{project_id}/design-candidates"
            )
            assert restored.status_code == 200
            saved = restored.json()["design"]
            assert saved["candidate_count"] == 4
            assert saved["design_context"] == result["design_context"]

            forged = client.post(
                f"/api/commercial-industrial/projects/{project_id}/design-candidates",
                json={
                    "scenarios": result["candidates"],
                    "design_context": result["design_context"],
                },
            )
            assert forged.status_code == 422
            assert forged.json()["detail"]["code"] == "ci_design_context_invalid"
        finally:
            session_factory.kw["bind"].dispose()

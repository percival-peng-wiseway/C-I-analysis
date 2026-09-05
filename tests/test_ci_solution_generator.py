from __future__ import annotations

import copy
import math
from uuid import UUID

import pytest
from pydantic import ValidationError

from api import ci_routes
from api.ci_schemas import CiDesignCandidatesRequest
from solar_battery.ci_design_context import validate_ci_design_context
from solar_battery.ci_device_profile import (
    device_profile_sha256,
    suggested_ci_device_profile,
)
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_project_rebate_profile import (
    approved_ci_project_rebate_calculation_profile,
)
from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_solution_generator import (
    generate_ci_custom_solution,
    generate_ci_solutions,
)
from solar_battery.durable_cockpit.orm import (
    CiProjectModel,
    CiProjectRebateProfileModel,
)
from tests.durable_test_helpers import (
    create_sqlite_session_factory,
    create_test_client,
    local_actor,
    sqlite_url_for_path,
)


def _device_profile(*, solar_status: str = "published") -> dict[str, object]:
    return {
        "contract_version": "ci_device_profile_v5",
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
                    "status": "published",
                    "version": 1,
                    "rated_active_power_kw": 125.0,
                    "rated_apparent_power_kva": 137.5,
                    "reactive_support_enabled": True,
                    "maximum_reactive_power_kvar": 82.5,
                    "european_efficiency_percent": 98.1,
                    "maximum_efficiency_percent": 98.5,
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


def _stc_settings() -> dict[str, object]:
    return {
        "solar_stc_enabled": True,
        "solar_stc_price_aud_ex_gst": 39.0,
        "battery_stc_enabled": False,
        "battery_stc_price_aud_ex_gst": 39.0,
    }


def test_python_generator_preserves_screening_capacities_without_hardware_snapping() -> None:
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
        "deduplicated_count": 0,
        "rejected_count": 0,
        "generated_candidate_count": 6,
        "rejection_reasons": [],
    }
    candidates = first["candidates"]
    assert len(candidates) == 6
    assert {item["pv_capacity_kwp_dc"] for item in candidates} == {100.0, 101.0}
    assert {item["nominal_capacity_kwh"] for item in candidates} == {
        0.0,
        7.0,
        14.0,
    }
    assert [
        (
            item["pv_capacity_kwp_dc"],
            item["nominal_capacity_kwh"],
            item["pv_inverter_capacity_kw_ac"],
        )
        for item in candidates
    ] == [
        (100.0, 0.0, 83.333333333),
        (100.0, 7.0, 83.333333333),
        (100.0, 14.0, 83.333333333),
        (101.0, 0.0, 84.166666667),
        (101.0, 7.0, 84.166666667),
        (101.0, 14.0, 84.166666667),
    ]
    assert all(
        item["shared_ac_headroom_kw"]
        == item["pv_inverter_capacity_kw_ac"]
        for item in candidates
    )
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
    assert context["generation_summary"] == first["generation_summary"]
    assert validate_ci_design_context(context) == context


def test_fox_range_example_keeps_all_36_screening_combinations() -> None:
    profile = _device_profile()
    solar = profile["solution_profiles"]["solar_profiles"][0]
    battery = profile["solution_profiles"]["battery_profiles"][0]
    inverter = profile["solution_profiles"]["inverter_profiles"][0]
    solar["rated_power_w"] = 650.0
    battery.update(
        {
            "nominal_capacity_kwh_per_unit": 97.44,
            "continuous_power_kw_per_unit": 64.51,
            "minimum_units": 1,
            # Hardware quantity limits do not constrain a screening capacity.
            "maximum_units": 1,
        }
    )
    inverter.update(
        {
            "rated_active_power_kw": 100.0,
            "rated_apparent_power_kva": 110.0,
            "maximum_reactive_power_kvar": 66.0,
        }
    )
    request = _request(maximum_pv=150.0, headroom=350.0)
    request["pv_range"] = {
        "minimum_kwp_dc": 100.0,
        "maximum_kwp_dc": 150.0,
        "step_kwp_dc": 10.0,
    }
    request["battery_range"] = {
        "minimum_kwh": 350.0,
        "maximum_kwh": 400.0,
        "step_kwh": 10.0,
    }
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(
        {
            "inverter_block_size_kw": 100.0,
            "inverter_quantity": 3,
        }
    )

    result = generate_ci_solutions(
        request,
        device_profile=profile,
        device_profile_sha256="f" * 64,
    )

    assert result["generation_summary"] == {
        "requested_count": 36,
        "deduplicated_count": 0,
        "rejected_count": 0,
        "generated_candidate_count": 36,
        "rejection_reasons": [],
    }
    assert result["design_context"]["generation_summary"] == result[
        "generation_summary"
    ]
    assert sorted(
        {item["pv_capacity_kwp_dc"] for item in result["candidates"]}
    ) == [100.0, 110.0, 120.0, 130.0, 140.0, 150.0]
    assert sorted(
        {item["nominal_capacity_kwh"] for item in result["candidates"]}
    ) == [
        350.0,
        360.0,
        370.0,
        380.0,
        390.0,
        400.0,
    ]
    assert all(
        item["pv_inverter_capacity_kw_ac"]
        == pytest.approx(300.0)
        for item in result["candidates"]
    )


def test_python_generator_keeps_precise_candidate_values_distinct_in_labels() -> None:
    request = _request(maximum_pv=100.000000001, headroom=200.0)
    request["pv_range"]["step_kwp_dc"] = 0.000000001
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

    assert [item["pv_capacity_kwp_dc"] for item in result["candidates"]] == [
        100.0,
        100.000000001,
    ]
    assert [item["label"].split(" kWp", 1)[0] for item in result["candidates"]] == [
        "100",
        "100.000000001",
    ]


def test_python_generator_uses_and_persists_selected_inverter_limits() -> None:
    request = _request(maximum_pv=100.0, headroom=250.0)
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(
        {
            # Legacy callers can still send this non-binding field; the saved
            # context canonicalizes it to the selected performance reference.
            "inverter_block_size_kw": 5.0,
            "inverter_quantity": 2,
            # A selected inverter profile is authoritative, so these legacy
            # fields cannot disable or cap its saved reactive policy.
            "reactive_support_enabled": False,
            "reactive_support_max_kvar": 0.0,
        }
    )

    result = generate_ci_solutions(
        request,
        device_profile=_device_profile(),
        device_profile_sha256="d" * 64,
    )

    assert all(
        candidate["pv_inverter_capacity_kw_ac"] == pytest.approx(250.0)
        for candidate in result["candidates"]
    )
    assert all(
        candidate["reactive_support_max_kvar"] == pytest.approx(165.0)
        for candidate in result["candidates"]
    )
    assert all(
        candidate["shared_inverter_apparent_power_limit_kva"]
        == pytest.approx(275.0)
        for candidate in result["candidates"]
    )
    selection = result["design_context"]["profile_selection"]
    assert selection["inverter_profile_id"] == "inverter-125"
    assert selection["inverter_profile"]["rated_active_power_kw"] == 125.0
    assert result["design_context"]["technical_options"][
        "inverter_block_size_kw"
    ] == 125.0
    assert result["design_context"]["technical_options"]["inverter_quantity"] == 2
    assert result["design_context"]["technical_options"][
        "reactive_support_max_kvar"
    ] == 82.5
    assert result["design_context"]["technical_options"][
        "reactive_support_enabled"
    ] is True
    assert validate_ci_design_context(result["design_context"]) == result["design_context"]


def test_python_generator_scales_profile_reactive_cap_without_legacy_override() -> None:
    profile = _device_profile()
    inverter = profile["solution_profiles"]["inverter_profiles"][0]
    inverter.update(
        {
            "rated_active_power_kw": 100.0,
            "rated_apparent_power_kva": 110.0,
            "maximum_reactive_power_kvar": 66.0,
        }
    )
    request = _request(maximum_pv=150.0, headroom=250.0)
    request["pv_range"]["step_kwp_dc"] = 50.0
    request["battery_range"] = {
        "minimum_kwh": 0.0,
        "maximum_kwh": 0.0,
        "step_kwh": 1.0,
    }
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(
        {
            "reactive_support_enabled": False,
            "reactive_support_max_kvar": 0.0,
        }
    )

    result = generate_ci_solutions(
        request,
        device_profile=profile,
        device_profile_sha256="f" * 64,
    )

    by_pv = {
        candidate["pv_capacity_kwp_dc"]: candidate
        for candidate in result["candidates"]
    }
    assert by_pv[100.0]["pv_inverter_capacity_kw_ac"] == pytest.approx(83.333333333)
    assert by_pv[100.0]["reactive_support_max_kvar"] == pytest.approx(55.0)
    assert by_pv[100.0]["shared_inverter_apparent_power_limit_kva"] == pytest.approx(
        91.666666666
    )
    assert by_pv[150.0]["pv_inverter_capacity_kw_ac"] == pytest.approx(125.0)
    assert by_pv[150.0]["reactive_support_max_kvar"] == pytest.approx(82.5)
    assert by_pv[150.0]["shared_inverter_apparent_power_limit_kva"] == pytest.approx(
        137.5
    )
    assert result["design_context"]["technical_options"][
        "reactive_support_max_kvar"
    ] == 66.0


def test_python_generator_profile_can_disable_legacy_reactive_request() -> None:
    profile = _device_profile()
    inverter = profile["solution_profiles"]["inverter_profiles"][0]
    inverter["reactive_support_enabled"] = False
    request = _request(maximum_pv=100.0, headroom=250.0)
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(
        {
            "reactive_support_enabled": True,
            "reactive_support_max_kvar": 200.0,
        }
    )

    result = generate_ci_solutions(
        request,
        device_profile=profile,
        device_profile_sha256="f" * 64,
    )

    assert all(
        candidate["reactive_support_enabled"] is False
        and candidate["reactive_support_max_kvar"] == 0.0
        and candidate["shared_inverter_apparent_power_limit_kva"] is None
        for candidate in result["candidates"]
    )
    assert result["design_context"]["technical_options"][
        "reactive_support_enabled"
    ] is False
    # Retain the profile-unit capability as an audit/reference operand even
    # when the saved profile policy disables it.
    assert result["design_context"]["technical_options"][
        "reactive_support_max_kvar"
    ] == 82.5


def test_custom_solution_scales_reactive_capability_from_saved_profile() -> None:
    request = _request(maximum_pv=100.0, headroom=250.0)
    request["inverter_profile_id"] = "inverter-125"
    generated = generate_ci_solutions(
        request,
        device_profile=_device_profile(),
        device_profile_sha256="e" * 64,
    )

    custom = generate_ci_custom_solution(
        {
            "contract_version": "ci_custom_design_candidate_request_v1",
            "label": "Custom 100 kW PCS",
            "pv_capacity_kwp_dc": 100.0,
            "battery_capacity_kwh": 0.0,
            "inverter_capacity_kw_ac": 100.0,
            "quoted_net_capex_aud_ex_gst": 100_000.0,
        },
        design_context=generated["design_context"],
    )

    candidate = custom["candidate"]
    assert candidate["reactive_support_enabled"] is True
    assert candidate["reactive_support_max_kvar"] == pytest.approx(66.0)
    assert candidate["shared_inverter_apparent_power_limit_kva"] == pytest.approx(
        110.0
    )
    assert candidate["reactive_capability_provenance"] == "analyst_assumption"


def test_python_generator_includes_reactive_support_in_scenario_identity() -> None:
    disabled_request = _request(maximum_pv=100.0, headroom=250.0)
    enabled_request = _request(maximum_pv=100.0, headroom=250.0)
    enabled_request["connection_options"].update(
        {
            "reactive_support_enabled": True,
            "reactive_support_max_kvar": 40.0,
        }
    )

    disabled = generate_ci_solutions(
        disabled_request,
        device_profile=_device_profile(),
        device_profile_sha256="a" * 64,
    )
    enabled = generate_ci_solutions(
        enabled_request,
        device_profile=_device_profile(),
        device_profile_sha256="a" * 64,
    )

    disabled_ids = {candidate["scenario_id"] for candidate in disabled["candidates"]}
    enabled_ids = {candidate["scenario_id"] for candidate in enabled["candidates"]}
    assert disabled_ids.isdisjoint(enabled_ids)
    assert {candidate["battery_system_id"] for candidate in disabled["candidates"]} == {
        candidate["battery_system_id"] for candidate in enabled["candidates"]
    }


def test_python_generator_rejects_explicit_quantity_below_required_power() -> None:
    request = _request(maximum_pv=200.0, headroom=500.0)
    request["pv_range"] = {
        "minimum_kwp_dc": 200.0,
        "maximum_kwp_dc": 200.0,
        "step_kwp_dc": 1.0,
    }
    request["battery_range"] = {
        "minimum_kwh": 0.0,
        "maximum_kwh": 0.0,
        "step_kwh": 1.0,
    }
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(
        {"inverter_block_size_kw": 125.0, "inverter_quantity": 1}
    )

    with pytest.raises(CiProjectError, match="one to 200"):
        generate_ci_solutions(
            request,
            device_profile=_device_profile(),
            device_profile_sha256="e" * 64,
        )


def test_python_generator_rejects_continuous_pcs_above_headroom() -> None:
    request = _request(maximum_pv=200.0, headroom=200.0)
    request["pv_range"] = {
        "minimum_kwp_dc": 200.0,
        "maximum_kwp_dc": 200.0,
        "step_kwp_dc": 1.0,
    }
    request["battery_range"] = {
        "minimum_kwh": 0.0,
        "maximum_kwh": 0.0,
        "step_kwh": 1.0,
    }
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(
        {"inverter_block_size_kw": 125.0, "inverter_quantity": 1}
    )

    request["connection_options"]["site_ac_headroom_kw"] = 160.0

    with pytest.raises(CiProjectError, match="one to 200 screening candidates"):
        generate_ci_solutions(
            request,
            device_profile=_device_profile(),
            device_profile_sha256="f" * 64,
        )


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
    assert result["candidates"][0]["pv_inverter_capacity_kw_ac"] == pytest.approx(
        8.333333333
    )


def test_python_generator_keeps_smaller_battery_when_larger_target_exceeds_headroom() -> None:
    request = _request(maximum_pv=100.0, headroom=100.0)
    request["battery_range"] = {
        "minimum_kwh": 100.0,
        "maximum_kwh": 300.0,
        "step_kwh": 200.0,
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
    assert result["candidates"][0]["nominal_capacity_kwh"] == 100.0
    assert result["candidates"][0]["pv_inverter_capacity_kw_ac"] == pytest.approx(
        83.333333333
    )


@pytest.mark.parametrize(
    ("pv_range", "battery_range", "message"),
    [
        (
            {"minimum_kwp_dc": 1.0, "maximum_kwp_dc": 21.0, "step_kwp_dc": 1.0},
            {"minimum_kwh": 0.0, "maximum_kwh": 0.0, "step_kwh": 1.0},
            "at most 20 PV candidates",
        ),
        (
            {"minimum_kwp_dc": 100.0, "maximum_kwp_dc": 100.0, "step_kwp_dc": 1.0},
            {"minimum_kwh": 0.0, "maximum_kwh": 15.0, "step_kwh": 1.0},
            "at most 15 battery candidates",
        ),
        (
            {"minimum_kwp_dc": 1.0, "maximum_kwp_dc": 20.0, "step_kwp_dc": 1.0},
            {"minimum_kwh": 0.0, "maximum_kwh": 10.0, "step_kwh": 1.0},
            "at most 200 PV and battery combinations",
        ),
    ],
)
def test_python_generator_rejects_search_spaces_above_analysis_limits(
    pv_range: dict[str, float],
    battery_range: dict[str, float],
    message: str,
) -> None:
    request = _request(maximum_pv=100.0, headroom=1_000.0)
    request["pv_range"] = pv_range
    request["battery_range"] = battery_range

    with pytest.raises(CiProjectError, match=message):
        generate_ci_solutions(
            request,
            device_profile=_device_profile(),
            device_profile_sha256=None,
        )


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


def test_v2_design_context_normalizes_legacy_inverter_reactive_switch_without_mutation() -> None:
    request = _request(maximum_pv=100.0, headroom=250.0)
    request["inverter_profile_id"] = "inverter-125"
    generated = generate_ci_solutions(
        request,
        device_profile=_device_profile(),
        device_profile_sha256="b" * 64,
    )
    legacy_context = copy.deepcopy(generated["design_context"])
    legacy_inverter = legacy_context["profile_selection"]["inverter_profile"]
    legacy_inverter.pop("reactive_support_enabled")

    normalized = validate_ci_design_context(legacy_context)

    assert "reactive_support_enabled" not in legacy_inverter
    assert normalized["profile_selection"]["inverter_profile"][
        "reactive_support_enabled"
    ] is True
    assert normalized["technical_options"]["reactive_support_enabled"] is True


def test_generator_keeps_new_inverter_profile_validation_strict() -> None:
    profile = _device_profile()
    profile["solution_profiles"]["inverter_profiles"][0].pop(
        "reactive_support_enabled"
    )
    request = _request(maximum_pv=100.0, headroom=250.0)
    request["inverter_profile_id"] = "inverter-125"

    with pytest.raises(CiProjectError, match="reactive-support policy"):
        generate_ci_solutions(
            request,
            device_profile=profile,
            device_profile_sha256="b" * 64,
        )


def test_design_request_requires_exactly_one_candidate_source() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        CiDesignCandidatesRequest()
    with pytest.raises(ValidationError, match="exactly one"):
        CiDesignCandidatesRequest(
            scenarios=[{"scenario_id": "legacy"}],
            generation_request=_request(),
        )
    with pytest.raises(ValidationError, match="only be saved with generated solutions"):
        CiDesignCandidatesRequest(
            scenarios=[{"scenario_id": "legacy"}],
            stc_settings=_stc_settings(),
        )


def test_generation_route_records_design_before_saving_stc_in_one_transaction(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "solution-generator-stc.sqlite3")
    profile_digest = "c" * 64
    observed: dict[str, object] = {}

    def device_state(_session, *, actor):
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": profile_digest,
            "profile": _device_profile(),
            "suggested_profile": _device_profile(),
        }

    def save_stc(session, *, project_id, actor, **settings):
        project = session.get(CiProjectModel, project_id)
        assert project is not None
        assert project.design_candidate_count == 6
        assert isinstance(project.design_candidates_json, list)
        assert len(project.design_candidates_json) == 6
        assert project.design_context_json["profile_selection"][
            "device_profile_sha256"
        ] == profile_digest
        observed.update(settings)
        observed["actor_id"] = actor.actor_id
        return {"status": "approved"}

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    monkeypatch.setattr("api.ci_routes.save_ci_project_stc_settings", save_stc)
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Generated STC solution project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        response = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={
                "generation_request": _request(),
                "stc_settings": _stc_settings(),
            },
        )

        assert response.status_code == 200, response.json()
        assert observed == {**_stc_settings(), "actor_id": "local-analyst"}
        restored = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates"
        ).json()
        assert restored["status"] == "ready"
        assert restored["design"]["candidate_count"] == 6


def test_routes_restore_and_extend_legacy_v2_inverter_snapshot(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(
        tmp_path / "legacy-v2-inverter-snapshot.sqlite3"
    )
    profile = _device_profile()

    def device_state(_session, *, actor):
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": "c" * 64,
            "profile": profile,
            "suggested_profile": profile,
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    monkeypatch.setattr(
        "api.ci_routes.save_ci_project_stc_settings",
        lambda _session, **_kwargs: {"status": "approved"},
    )
    monkeypatch.setattr(
        "api.ci_routes._calculate_ci_design_price_preview_if_ready",
        lambda _session, **_kwargs: None,
    )
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Legacy inverter snapshot project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        generation_request = _request(maximum_pv=100.0, headroom=250.0)
        generation_request["inverter_profile_id"] = "inverter-125"
        generated = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={"generation_request": generation_request},
        )
        assert generated.status_code == 200, generated.json()

        # Reproduce the immutable v2 context shape saved before the v5
        # inverter-profile switch existed.
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            legacy_context = copy.deepcopy(project.design_context_json)
            legacy_context["profile_selection"]["inverter_profile"].pop(
                "reactive_support_enabled"
            )
            project.design_context_json = legacy_context

        restored = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates"
        )
        assert restored.status_code == 200, restored.json()
        assert restored.json()["design"]["design_context"]["profile_selection"][
            "inverter_profile"
        ]["reactive_support_enabled"] is True

        # A GET normalizes only its response; it does not rewrite the stored
        # context or trigger a candidate calculation.
        with session_factory() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            assert "reactive_support_enabled" not in project.design_context_json[
                "profile_selection"
            ]["inverter_profile"]

        custom = client.post(
            f"/api/commercial-industrial/projects/{project_id}"
            "/design-candidates/custom",
            json={
                "contract_version": "ci_custom_design_candidate_request_v1",
                "label": "Legacy context custom option",
                "pv_capacity_kwp_dc": 120.0,
                "battery_capacity_kwh": 14.0,
                "inverter_capacity_kw_ac": 106.0,
                "quoted_net_capex_aud_ex_gst": 245000.0,
                "stc_settings": _stc_settings(),
            },
        )
        assert custom.status_code == 200, custom.json()
        added = next(
            candidate
            for candidate in custom.json()["candidates"]
            if candidate["scenario_id"] == custom.json()["added_scenario_id"]
        )
        assert added["reactive_support_enabled"] is True
        assert added["reactive_support_max_kvar"] == pytest.approx(69.96)
        assert added["shared_inverter_apparent_power_limit_kva"] == pytest.approx(
            116.6
        )


def test_generation_route_atomically_binds_stc_to_the_new_design(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "solution-generator-stc-binding.sqlite3")
    profile = _device_profile()
    profile_digest = device_profile_sha256(profile)

    def device_state(_session, *, actor):
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": profile_digest,
            "profile": profile,
            "suggested_profile": profile,
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile.ci_device_profile_state",
        device_state,
    )
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile._site_address",
        lambda _evidence: "10 Collins Street Melbourne VIC, 3000",
    )
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Atomic STC binding project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        settings = {**_stc_settings(), "battery_stc_enabled": True}
        response = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={"generation_request": _request(), "stc_settings": settings},
        )

        assert response.status_code == 200, response.json()
        state = client.get(
            f"/api/commercial-industrial/projects/{project_id}/rebate-profile"
        )
        assert state.status_code == 200, state.json()
        assert state.json()["status"] == "approved"
        assert state.json()["blockers"] == []

    with session_factory() as session:
        project = session.get(CiProjectModel, UUID(project_id))
        assert project is not None
        calculation = approved_ci_project_rebate_calculation_profile(
            session,
            project_id=UUID(project_id),
            actor=local_actor(),
        )
        assert calculation is not None
        assert calculation["design_candidates_sha256"] == canonical_sha256(
            project.design_candidates_json
        )
        assert calculation["design_context_sha256"] == canonical_sha256(
            project.design_context_json
        )
        assert calculation["device_profile_sha256"] == profile_digest
        assert calculation["programs"]["solar_stc"][
            "eligibility_confirmed"
        ] is True
        assert calculation["programs"]["battery_stc"][
            "certified_usable_capacity_fraction"
        ] == 0.9


def test_custom_route_rebinds_approved_enabled_stc_and_keeps_price_preview_ready(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "custom-solution-stc-binding.sqlite3")
    profile = suggested_ci_device_profile()
    profile_digest = device_profile_sha256(profile)
    preview_calls = 0
    calculate_preview = ci_routes.preview_ci_design_candidate_prices

    def counted_preview(**kwargs):
        nonlocal preview_calls
        preview_calls += 1
        return calculate_preview(**kwargs)

    monkeypatch.setattr(
        "api.ci_routes.preview_ci_design_candidate_prices", counted_preview
    )

    def device_state(_session, *, actor):
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": profile_digest,
            "profile": profile,
            "suggested_profile": profile,
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile.ci_device_profile_state",
        device_state,
    )
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile._site_address",
        lambda _evidence: "10 Collins Street Melbourne VIC, 3000",
    )
    selection = profile["default_solution_profile_selection"]
    assert isinstance(selection, dict)
    generation_request = _request()
    generation_request.update(
        {
            "pv_range": {
                "minimum_kwp_dc": 60.0,
                "maximum_kwp_dc": 61.0,
                "step_kwp_dc": 1.0,
            },
            "battery_range": {
                "minimum_kwh": 0.0,
                "maximum_kwh": 0.0,
                "step_kwh": 1.0,
            },
            "solar_profile_id": selection["solar_profile_id"],
            "battery_profile_id": selection["battery_profile_id"],
        }
    )

    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Custom STC binding project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        generated = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={
                "generation_request": generation_request,
                "stc_settings": _stc_settings(),
            },
        )
        assert generated.status_code == 200, generated.json()
        generated_count = generated.json()["candidate_count"]
        assert client.get(
            f"/api/commercial-industrial/projects/{project_id}/rebate-profile"
        ).json()["status"] == "approved"

        custom = client.post(
            f"/api/commercial-industrial/projects/{project_id}"
            "/design-candidates/custom",
            json={
                "contract_version": "ci_custom_design_candidate_request_v1",
                "label": "Client STC option",
                "pv_capacity_kwp_dc": 80.0,
                "battery_capacity_kwh": 0.0,
                "inverter_capacity_kw_ac": 70.0,
                "quoted_net_capex_aud_ex_gst": 45000.0,
                "stc_settings": _stc_settings(),
            },
        )

        assert custom.status_code == 200, custom.json()
        assert custom.json()["candidate_count"] == generated_count + 1
        assert custom.json()["generation_summary"] == generated.json()[
            "generation_summary"
        ]
        rebate_state = client.get(
            f"/api/commercial-industrial/projects/{project_id}/rebate-profile"
        )
        assert rebate_state.status_code == 200, rebate_state.json()
        assert rebate_state.json()["status"] == "approved"
        assert rebate_state.json()["blockers"] == []
        preview = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-price-preview"
        )
        assert preview.status_code == 200, preview.json()
        assert preview.json()["status"] == "ready"
        assert preview.json()["candidate_count"] == generated_count + 1
        assert preview.json()["rebate_profile_sha256"] is not None
        assert all(
            item["upfront_rebate_aud_ex_gst"] > 0
            for item in preview.json()["solutions"]
        )
        restored_preview = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-price-preview"
        )
        assert restored_preview.status_code == 200, restored_preview.json()
        assert restored_preview.json() == preview.json()
        assert preview_calls == 2
        changed_stc = client.put(
            f"/api/commercial-industrial/projects/{project_id}"
            "/rebate-profile/stc-settings",
            json={
                **_stc_settings(),
                "solar_stc_price_aud_ex_gst": 40.0,
            },
        )
        assert changed_stc.status_code == 200, changed_stc.json()
        stale_preview = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-price-preview"
        )
        assert stale_preview.status_code == 409
        assert stale_preview.json()["detail"]["code"] == (
            "ci_design_price_preview_stale"
        )
        assert preview_calls == 2

    with session_factory() as session:
        project = session.get(CiProjectModel, UUID(project_id))
        assert project is not None
        calculation = approved_ci_project_rebate_calculation_profile(
            session,
            project_id=UUID(project_id),
            actor=local_actor(),
        )
        assert calculation is not None
        assert calculation["design_candidates_sha256"] == canonical_sha256(
            project.design_candidates_json
        )
        assert project.design_price_preview_json == preview.json()


def test_v4_price_preview_and_rebate_binding_survive_only_reversible_v5_migration(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(
        tmp_path / "v4-price-preview-compatibility.sqlite3"
    )
    profile = suggested_ci_device_profile()
    inverter = profile["solution_profiles"]["inverter_profiles"][0]
    inverter["status"] = "published"
    current = {"profile": profile}

    def device_state(_session, *, actor):
        active = current["profile"]
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": device_profile_sha256(active),
            "profile": active,
            "suggested_profile": active,
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile.ci_device_profile_state",
        device_state,
    )
    monkeypatch.setattr(
        "solar_battery.ci_project_rebate_profile._site_address",
        lambda _evidence: "10 Collins Street Melbourne VIC, 3000",
    )
    selection = profile["default_solution_profile_selection"]
    generation_request = _request(maximum_pv=60.0, headroom=250.0)
    generation_request.update(
        {
            "pv_range": {
                "minimum_kwp_dc": 60.0,
                "maximum_kwp_dc": 60.0,
                "step_kwp_dc": 1.0,
            },
            "battery_range": {
                "minimum_kwh": 0.0,
                "maximum_kwh": 0.0,
                "step_kwh": 1.0,
            },
            "solar_profile_id": selection["solar_profile_id"],
            "battery_profile_id": selection["battery_profile_id"],
            "inverter_profile_id": inverter["profile_id"],
        }
    )

    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "V4 price preview compatibility"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        generated = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={
                "generation_request": generation_request,
                "stc_settings": _stc_settings(),
            },
        )
        assert generated.status_code == 200, generated.json()
        current_preview = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-price-preview"
        )
        assert current_preview.status_code == 200, current_preview.json()
        assert current_preview.json()["solutions"][0][
            "upfront_rebate_aud_ex_gst"
        ] > 0

        predecessor = copy.deepcopy(profile)
        predecessor["contract_version"] = "ci_device_profile_v4"
        for item in predecessor["solution_profiles"]["inverter_profiles"]:
            item.pop("reactive_support_enabled")
        predecessor_digest = device_profile_sha256(predecessor)

        # Recreate the hashes held by a v4 design, approved rebate calculation
        # and price preview without touching their economic payloads.
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            legacy_context = copy.deepcopy(project.design_context_json)
            legacy_context["profile_selection"][
                "device_profile_sha256"
            ] = predecessor_digest
            legacy_context["profile_selection"]["inverter_profile"].pop(
                "reactive_support_enabled"
            )
            project.design_context_json = legacy_context

            rebate_row = session.query(CiProjectRebateProfileModel).one()
            calculation_profile = copy.deepcopy(
                rebate_row.calculation_profile_json
            )
            calculation_profile["design_context_sha256"] = canonical_sha256(
                legacy_context
            )
            calculation_profile[
                "device_profile_sha256"
            ] = predecessor_digest
            calculation_digest = canonical_sha256(calculation_profile)
            rebate_row.calculation_profile_json = calculation_profile
            rebate_row.calculation_profile_sha256 = calculation_digest

            legacy_preview = copy.deepcopy(project.design_price_preview_json)
            legacy_preview["device_profile_sha256"] = predecessor_digest
            legacy_preview["rebate_profile_sha256"] = calculation_digest
            project.design_price_preview_json = legacy_preview
            expected_preview = copy.deepcopy(legacy_preview)

        preview_calls = 0

        def unexpected_preview(**_kwargs):
            nonlocal preview_calls
            preview_calls += 1
            raise AssertionError("GET must not recalculate a compatible preview")

        monkeypatch.setattr(
            "api.ci_routes.preview_ci_design_candidate_prices",
            unexpected_preview,
        )
        restored = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-price-preview"
        )
        assert restored.status_code == 200, restored.json()
        assert restored.json() == expected_preview
        assert preview_calls == 0
        with session_factory() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            assert project.design_price_preview_json == expected_preview
            assert "reactive_support_enabled" not in project.design_context_json[
                "profile_selection"
            ]["inverter_profile"]

        repriced = copy.deepcopy(profile)
        repriced["equipment_catalog"]["pv_products"][0][
            "capital_cost_aud_per_kwp_dc"
        ] += 0.01
        current["profile"] = repriced
        stale = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-price-preview"
        )
        assert stale.status_code == 409, stale.json()
        assert stale.json()["detail"]["code"] == "ci_design_price_preview_stale"
        assert preview_calls == 0


def test_price_preview_get_never_calculates_when_snapshot_is_missing(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "missing-price-preview.sqlite3")
    preview_calls = 0

    def unexpected_preview(**_kwargs):
        nonlocal preview_calls
        preview_calls += 1
        raise AssertionError("GET must not calculate a Net CAPEX preview")

    monkeypatch.setattr(
        "api.ci_routes.preview_ci_design_candidate_prices", unexpected_preview
    )
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "No saved price preview"},
        )
        assert created.status_code == 201
        response = client.get(
            "/api/commercial-industrial/projects/"
            f"{created.json()['project_id']}/design-price-preview"
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ci_design_price_preview_required"
    assert preview_calls == 0


def test_custom_route_rolls_back_candidate_when_atomic_stc_save_fails(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "custom-solution-stc-rollback.sqlite3")

    def device_state(_session, *, actor):
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": "c" * 64,
            "profile": _device_profile(),
            "suggested_profile": _device_profile(),
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Custom STC rollback project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        baseline = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={"generation_request": _request()},
        )
        assert baseline.status_code == 200, baseline.json()

        def fail_stc(session, *, project_id, actor, **_settings):
            project = session.get(CiProjectModel, project_id)
            assert project is not None
            assert project.design_candidate_count == baseline.json()[
                "candidate_count"
            ] + 1
            raise CiProjectError(
                "synthetic_stc_save_failed",
                "Synthetic STC save failed.",
            )

        monkeypatch.setattr("api.ci_routes.save_ci_project_stc_settings", fail_stc)
        failed = client.post(
            f"/api/commercial-industrial/projects/{project_id}"
            "/design-candidates/custom",
            json={
                "contract_version": "ci_custom_design_candidate_request_v1",
                "label": "Rolled back option",
                "pv_capacity_kwp_dc": 120.0,
                "battery_capacity_kwh": 14.0,
                "inverter_capacity_kw_ac": 110.0,
                "quoted_net_capex_aud_ex_gst": 245000.0,
                "stc_settings": _stc_settings(),
            },
        )

        assert failed.status_code == 422
        assert failed.json()["detail"]["code"] == "synthetic_stc_save_failed"
        restored = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates"
        ).json()["design"]
        assert restored["candidate_count"] == baseline.json()["candidate_count"]
        assert restored["candidates"] == baseline.json()["candidates"]
        assert restored["design_context"] == baseline.json()["design_context"]


def test_generation_route_rolls_back_design_when_atomic_stc_save_fails(
    tmp_path, monkeypatch
) -> None:
    database_url = sqlite_url_for_path(tmp_path / "solution-generator-stc-rollback.sqlite3")

    def device_state(_session, *, actor):
        return {
            "contract_version": "ci_device_profile_state_v1",
            "status": "ready",
            "updated_at": "2026-09-01T00:00:00+00:00",
            "profile_sha256": "c" * 64,
            "profile": _device_profile(),
            "suggested_profile": _device_profile(),
        }

    monkeypatch.setattr("api.ci_routes.ci_device_profile_state", device_state)
    with create_test_client(database_url) as client:
        created = client.post(
            "/api/commercial-industrial/projects",
            json={"display_name": "Atomic STC rollback project"},
        )
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        session_factory = create_sqlite_session_factory(database_url)
        with session_factory.begin() as session:
            project = session.get(CiProjectModel, UUID(project_id))
            assert project is not None
            project.setup_status = "ready"
            project.current_stage = "system_design"

        baseline = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={"generation_request": _request()},
        )
        assert baseline.status_code == 200, baseline.json()

        def fail_stc(session, *, project_id, actor, **_settings):
            project = session.get(CiProjectModel, project_id)
            assert project is not None
            assert project.design_candidate_count == 9
            raise CiProjectError(
                "synthetic_stc_save_failed",
                "Synthetic STC save failed.",
            )

        monkeypatch.setattr("api.ci_routes.save_ci_project_stc_settings", fail_stc)
        failed = client.post(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates",
            json={
                "generation_request": _request(maximum_pv=102.0),
                "stc_settings": _stc_settings(),
            },
        )

        assert failed.status_code == 422
        assert failed.json()["detail"]["code"] == "synthetic_stc_save_failed"
        restored = client.get(
            f"/api/commercial-industrial/projects/{project_id}/design-candidates"
        ).json()
        assert restored["status"] == "ready"
        assert restored["design"]["candidate_count"] == baseline.json()[
            "candidate_count"
        ]
        assert restored["design"]["candidates"] == baseline.json()["candidates"]
        assert restored["design"]["design_context"] == baseline.json()[
            "design_context"
        ]


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
            assert result["candidate_count"] == 6
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
            assert saved["candidate_count"] == 6
            assert saved["design_context"] == result["design_context"]
            assert saved["generation_summary"] == result["generation_summary"]

            custom_payload = {
                "contract_version": "ci_custom_design_candidate_request_v1",
                "label": "Client option A",
                "pv_capacity_kwp_dc": 120,
                "battery_capacity_kwh": 14,
                "inverter_capacity_kw_ac": 106,
                "quoted_net_capex_aud_ex_gst": 245000,
                "stc_settings": {
                    **_stc_settings(),
                    "solar_stc_enabled": False,
                },
            }
            custom = client.post(
                f"/api/commercial-industrial/projects/{project_id}"
                "/design-candidates/custom",
                json=custom_payload,
            )
            assert custom.status_code == 200
            custom_result = custom.json()
            assert custom_result["candidate_count"] == 7
            assert custom_result["quoted_net_capex_aud_ex_gst"] == 245000
            added = next(
                item
                for item in custom_result["candidates"]
                if item["scenario_id"] == custom_result["added_scenario_id"]
            )
            assert added["label"] == "Client option A"
            assert added["pv_capacity_kwp_dc"] == 120
            assert added["nominal_capacity_kwh"] == 14
            assert added["pv_inverter_capacity_kw_ac"] == 106
            assert (
                custom_result["normalization"]["requested_inverter_capacity_kw_ac"]
                == 106
            )
            assert (
                custom_result["normalization"]["actual_inverter_capacity_kw_ac"]
                == 106
            )

            undersized = client.post(
                f"/api/commercial-industrial/projects/{project_id}"
                "/design-candidates/custom",
                json={
                    **custom_payload,
                    "label": "Undersized PCS",
                    "pv_capacity_kwp_dc": 150,
                    "battery_capacity_kwh": 0,
                    "inverter_capacity_kw_ac": 50,
                },
            )
            assert undersized.status_code == 422
            assert "too small" in undersized.json()["detail"]["message"]

            duplicate = client.post(
                f"/api/commercial-industrial/projects/{project_id}"
                "/design-candidates/custom",
                json=custom_payload,
            )
            assert duplicate.status_code == 422
            assert "already exists" in duplicate.json()["detail"]["message"]

            restored_custom = client.get(
                f"/api/commercial-industrial/projects/{project_id}/design-candidates"
            )
            assert restored_custom.json()["design"]["candidate_count"] == 7

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

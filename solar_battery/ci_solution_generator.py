from __future__ import annotations

from collections import Counter
from decimal import Decimal, ROUND_FLOOR
import hashlib
import json
import math
from typing import Any

from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_scenario_analysis import (
    MAX_BATTERY_SYSTEMS,
    MAX_PV_SYSTEMS,
    MAX_SOLUTIONS,
    validate_ci_design_candidates,
)


CI_SOLUTION_GENERATION_REQUEST_CONTRACT_VERSION = (
    "ci_solution_generation_request_v1"
)


def generate_ci_solutions(
    generation_request: object,
    *,
    device_profile: dict[str, object],
    device_profile_sha256: str | None,
) -> dict[str, object]:
    """Generate one canonical C&I candidate matrix entirely in Python."""
    request = _generation_request(generation_request)
    solar = _selected_profile(
        device_profile,
        collection_names=("solar_profiles", "pv_products"),
        selected_id=request["solar_profile_id"],
        label="solar",
    )
    battery = _selected_profile(
        device_profile,
        collection_names=("battery_profiles", "battery_products"),
        selected_id=request["battery_profile_id"],
        label="battery",
    )
    inverter = (
        _selected_profile(
            device_profile,
            collection_names=("inverter_profiles",),
            selected_id=request["inverter_profile_id"],
            label="inverter",
        )
        if request["inverter_profile_id"] is not None
        else None
    )
    solar_performance = _solar_performance(solar)
    battery_performance = _battery_performance(battery)
    inverter_performance = (
        _inverter_performance(inverter) if inverter is not None else None
    )
    pv_targets = _range_values(request["pv_range"], allow_zero=False)
    battery_targets = _range_values(request["battery_range"], allow_zero=True)
    requested_count = len(pv_targets) * len(battery_targets)
    if len(pv_targets) > MAX_PV_SYSTEMS:
        raise _invalid(
            f"Configure at most {MAX_PV_SYSTEMS} PV candidates for one analysis."
        )
    if len(battery_targets) > MAX_BATTERY_SYSTEMS:
        raise _invalid(
            f"Configure at most {MAX_BATTERY_SYSTEMS} battery candidates for one analysis."
        )
    if requested_count > MAX_SOLUTIONS:
        raise _invalid(
            f"Configure at most {MAX_SOLUTIONS} PV and battery combinations for one analysis."
        )
    rejection_counts: Counter[str] = Counter()

    site = request["site_factors"]
    connection = request["connection_options"]
    derating = _effective_derating(site)
    one_way_efficiency = math.sqrt(
        battery_performance["round_trip_efficiency_percent"] / 100
    ) * (battery_performance["power_conversion_efficiency_percent"] / 100)
    minimum_soc = 1 - (
        battery_performance["usable_depth_of_discharge_percent"] / 100
    )
    scenarios: list[dict[str, object]] = []
    rejected_requested = 0
    for pv_target in pv_targets:
        # The generated matrix is a screening search, not an equipment bill of
        # materials.  Preserve the analyst-authored capacities exactly and use
        # the selected profiles only for performance ratios.
        pv_capacity = _clean_number(pv_target)
        battery_options = [
            (
                _clean_number(battery_target),
                _screening_battery_power(battery_target, battery_performance),
            )
            for battery_target in battery_targets
        ]
        feasible_battery_options = [
            (capacity, power)
            for capacity, power in battery_options
            if max(
                pv_capacity / solar_performance["default_dc_ac_ratio"], power
            )
            <= connection["site_ac_headroom_kw"] + 1e-9
        ]
        rejected_for_headroom = len(battery_options) - len(
            feasible_battery_options
        )
        if rejected_for_headroom:
            rejected_requested += rejected_for_headroom
            rejection_counts["site_ac_headroom_exceeded"] += (
                rejected_for_headroom
            )
        if not feasible_battery_options:
            continue

        # A PV row represents one common screening PCS basis across all of its
        # feasible battery alternatives.  Size it continuously for the largest
        # surviving requirement so the PV-system signature remains stable while
        # infeasible large batteries do not remove smaller feasible candidates.
        inverter_capacity = _clean_number(
            max(
                pv_capacity / solar_performance["default_dc_ac_ratio"],
                max(power for _capacity, power in feasible_battery_options),
            )
        )
        for battery_capacity, battery_power in feasible_battery_options:
            battery_performance_scale = _clean_number(
                battery_capacity
                / float(battery_performance["nominal_capacity_kwh_per_unit"])
            )
            scenario = _scenario(
                solar=solar,
                battery=battery,
                inverter=inverter,
                pv_capacity_kwp_dc=pv_capacity,
                inverter_capacity_kw_ac=inverter_capacity,
                battery_performance_scale=battery_performance_scale,
                battery_capacity_kwh=battery_capacity,
                battery_power_kw=battery_power,
                annual_specific_yield=float(
                    site["annual_specific_yield_kwh_per_kw"]
                ),
                derating=derating,
                one_way_efficiency=one_way_efficiency,
                minimum_soc=minimum_soc,
                connection=connection,
                inverter_performance=inverter_performance,
            )
            scenarios.append(scenario)

    candidates = sorted(
        scenarios,
        key=lambda item: (
            float(item["pv_capacity_kwp_dc"]),
            float(item["nominal_capacity_kwh"]),
            float(item["pv_inverter_capacity_kw_ac"]),
            str(item["scenario_id"]),
        ),
    )
    if not 1 <= len(candidates) <= 200:
        raise CiProjectError(
            "ci_solution_generation_invalid",
            "The generated solution space must contain one to 200 screening candidates after connection checks.",
        )
    validated = validate_ci_design_candidates(candidates)
    canonical_candidates = list(validated["candidates"])
    generation_summary = {
        "requested_count": requested_count,
        "deduplicated_count": 0,
        "rejected_count": rejected_requested,
        "generated_candidate_count": len(canonical_candidates),
        "rejection_reasons": [
            {"code": code, "count": count}
            for code, count in sorted(rejection_counts.items())
        ],
    }
    context = _design_context(
        request,
        solar=solar,
        battery=battery,
        inverter=inverter,
        device_profile_sha256=device_profile_sha256,
        solar_performance=solar_performance,
        battery_performance=battery_performance,
        inverter_performance=inverter_performance,
        derating=derating,
        one_way_efficiency=one_way_efficiency,
        minimum_soc=minimum_soc,
        generation_summary=generation_summary,
    )
    return {
        "candidates": canonical_candidates,
        "design_context": context,
        "generation_summary": generation_summary,
    }


def generate_ci_custom_solution(
    custom_request: object,
    *,
    design_context: dict[str, object],
) -> dict[str, object]:
    """Build one profile-bound candidate using the saved Python design basis."""
    if (
        not isinstance(custom_request, dict)
        or custom_request.get("contract_version")
        != "ci_custom_design_candidate_request_v1"
        or design_context.get("contract_version") != "ci_design_context_v2"
    ):
        raise _invalid(
            "A generated profile-bound design is required before adding a custom solution."
        )
    selection = design_context.get("profile_selection")
    site = design_context.get("site_factors")
    technical = design_context.get("technical_options")
    if (
        not isinstance(selection, dict)
        or not isinstance(site, dict)
        or not isinstance(technical, dict)
    ):
        raise _invalid("The saved profile-bound design context is invalid.")
    solar = selection.get("solar_profile")
    battery = selection.get("battery_profile")
    inverter = selection.get("inverter_profile")
    if not isinstance(solar, dict) or not isinstance(battery, dict):
        raise _invalid("The saved equipment profile snapshots are unavailable.")
    if inverter is not None and not isinstance(inverter, dict):
        raise _invalid("The saved inverter profile snapshot is invalid.")

    solar_performance = _solar_performance(solar)
    battery_performance = _battery_performance(battery)
    inverter_performance = (
        _inverter_performance(inverter) if inverter is not None else None
    )
    requested_pv = _bounded(custom_request.get("pv_capacity_kwp_dc"), 1e-9, 1_000_000)
    requested_battery = _bounded(
        custom_request.get("battery_capacity_kwh"), 0, 1_000_000
    )
    requested_inverter = _bounded(
        custom_request.get("inverter_capacity_kw_ac"), 1e-9, 1_000_000
    )
    pv_actual = _clean_number(requested_pv)
    battery_capacity = _clean_number(requested_battery)
    battery_performance_scale = _clean_number(
        battery_capacity
        / float(battery_performance["nominal_capacity_kwh_per_unit"])
    )
    battery_power = _screening_battery_power(
        battery_capacity, battery_performance
    )
    inverter_capacity = _clean_number(requested_inverter)
    minimum_inverter = max(
        pv_actual / float(solar_performance["default_dc_ac_ratio"]),
        battery_power,
    )
    if inverter_capacity + 1e-9 < minimum_inverter:
        raise _invalid(
            "The custom PCS is too small for the selected profiles; use at least "
            f"{_candidate_label_number(minimum_inverter)} kW AC."
        )
    site_headroom = _bounded(technical.get("site_ac_headroom_kw"), 1e-9, 1_000_000)
    if inverter_capacity > site_headroom + 1e-9:
        raise _invalid(
            "The custom PCS exceeds the saved "
            f"{_candidate_label_number(site_headroom)} kW AC site headroom."
        )
    connection = {
        "allow_grid_charging": technical.get("allow_grid_charging"),
        "reactive_support_enabled": technical.get("reactive_support_enabled"),
        "reactive_support_max_kvar": technical.get("reactive_support_max_kvar"),
        "grid_emissions_factor_kg_co2e_per_kwh": technical.get(
            "grid_emissions_factor_kg_co2e_per_kwh"
        ),
    }
    if not isinstance(connection["allow_grid_charging"], bool) or not isinstance(
        connection["reactive_support_enabled"], bool
    ):
        raise _invalid("The saved connection switches are invalid.")
    # Rebuild these values from the saved profile and site snapshots, exactly as
    # the matrix generator does.  The display-oriented percentages in
    # technical_options are rounded and can otherwise make a reused system ID
    # appear to have a different physical signature by a few floating-point bits.
    one_way_efficiency = math.sqrt(
        float(battery_performance["round_trip_efficiency_percent"]) / 100
    ) * (float(battery_performance["power_conversion_efficiency_percent"]) / 100)
    minimum_soc = 1 - (
        float(battery_performance["usable_depth_of_discharge_percent"]) / 100
    )
    derating = _effective_derating(site)
    scenario = _scenario(
        solar=solar,
        battery=battery,
        inverter=inverter,
        pv_capacity_kwp_dc=pv_actual,
        inverter_capacity_kw_ac=inverter_capacity,
        battery_performance_scale=battery_performance_scale,
        battery_capacity_kwh=battery_capacity,
        battery_power_kw=battery_power,
        annual_specific_yield=_bounded(
            site.get("annual_specific_yield_kwh_per_kw"), 500, 3000
        ),
        derating=derating,
        one_way_efficiency=one_way_efficiency,
        minimum_soc=minimum_soc,
        connection=connection,
        inverter_performance=inverter_performance,
    )
    scenario["label"] = _text(custom_request.get("label"), "custom solution label")
    return {
        "candidate": scenario,
        "quoted_net_capex_aud_ex_gst": _bounded(
            custom_request.get("quoted_net_capex_aud_ex_gst"), 1e-9, 1_000_000_000_000
        ),
        "normalization": {
            "requested_pv_capacity_kwp_dc": requested_pv,
            "actual_pv_capacity_kwp_dc": pv_actual,
            "requested_battery_capacity_kwh": requested_battery,
            "actual_battery_capacity_kwh": battery_capacity,
            "requested_inverter_capacity_kw_ac": requested_inverter,
            "actual_inverter_capacity_kw_ac": inverter_capacity,
        },
    }


def _generation_request(value: object) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or value.get("contract_version")
        != CI_SOLUTION_GENERATION_REQUEST_CONTRACT_VERSION
    ):
        raise _invalid("The solution generation request contract is invalid.")
    pv_range = _validated_range(value.get("pv_range"), allow_zero=False)
    battery_range = _validated_range(
        value.get("battery_range"), allow_zero=True
    )
    site = _site_factors(value.get("site_factors"))
    connection = _connection_options(value.get("connection_options"))
    inverter_profile_id = value.get("inverter_profile_id")
    if inverter_profile_id is not None:
        inverter_profile_id = _text(inverter_profile_id, "inverter profile")
    return {
        "contract_version": CI_SOLUTION_GENERATION_REQUEST_CONTRACT_VERSION,
        "pv_range": pv_range,
        "battery_range": battery_range,
        "solar_profile_id": _text(value.get("solar_profile_id"), "solar profile"),
        "battery_profile_id": _text(
            value.get("battery_profile_id"), "battery profile"
        ),
        "inverter_profile_id": inverter_profile_id,
        "site_factors": site,
        "connection_options": connection,
    }


def _site_factors(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _invalid("The site factors are invalid.")
    if value.get("resource_basis") != "gross_specific_yield_before_site_losses":
        raise _invalid("The solar resource basis is invalid.")
    resource_source = value.get("resource_source")
    if resource_source not in {
        "analyst_assumption",
        "site_assessment",
        "imported_resource_study",
    }:
        raise _invalid("The solar resource source is invalid.")
    return {
        "resource_basis": "gross_specific_yield_before_site_losses",
        "resource_source": resource_source,
        "resource_label": _text(value.get("resource_label"), "resource label"),
        "annual_specific_yield_kwh_per_kw": _bounded(
            value.get("annual_specific_yield_kwh_per_kw"), 500, 3000
        ),
        "array_azimuth_degrees": _bounded(
            value.get("array_azimuth_degrees"), 0, 360
        ),
        "array_tilt_degrees": _bounded(
            value.get("array_tilt_degrees"), 0, 90
        ),
        **{
            key: _bounded(value.get(key), 0, 99)
            for key in (
                "shading_loss_percent",
                "soiling_loss_percent",
                "temperature_loss_percent",
                "wiring_mismatch_loss_percent",
                "other_system_loss_percent",
            )
        },
        "system_availability_percent": _bounded(
            value.get("system_availability_percent"), 1, 100
        ),
    }


def _connection_options(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _invalid("The connection options are invalid.")
    reactive_enabled = value.get("reactive_support_enabled")
    allow_grid_charging = value.get("allow_grid_charging")
    if not isinstance(reactive_enabled, bool) or not isinstance(
        allow_grid_charging, bool
    ):
        raise _invalid("The connection switches are invalid.")
    reactive_cap = _bounded(
        value.get("reactive_support_max_kvar"), 0, 1_000_000
    )
    if (reactive_enabled and reactive_cap <= 0) or (
        not reactive_enabled and reactive_cap != 0
    ):
        raise _invalid("The reactive-support capacity is invalid.")
    emissions = value.get("grid_emissions_factor_kg_co2e_per_kwh")
    if emissions is not None:
        emissions = _bounded(emissions, 0, 5)
    if value.get("initial_soc_basis") != "full_soc_physical_upper_bound":
        raise _invalid("The initial SOC basis is invalid.")
    inverter_quantity = value.get("inverter_quantity")
    if inverter_quantity is not None:
        inverter_quantity = _integer(inverter_quantity, 1, 10_000)
    return {
        "inverter_block_size_kw": _bounded(
            value.get("inverter_block_size_kw"), 0.1, 1000
        ),
        "inverter_quantity": inverter_quantity,
        "site_ac_headroom_kw": _bounded(
            value.get("site_ac_headroom_kw"), 1e-9, 1_000_000
        ),
        "allow_grid_charging": allow_grid_charging,
        "reactive_support_enabled": reactive_enabled,
        "reactive_support_max_kvar": reactive_cap,
        "grid_emissions_factor_kg_co2e_per_kwh": emissions,
        "initial_soc_basis": "full_soc_physical_upper_bound",
    }


def _validated_range(value: object, *, allow_zero: bool) -> dict[str, float]:
    if not isinstance(value, dict):
        raise _invalid("The solution search range is invalid.")
    minimum_key = "minimum_kwh" if allow_zero else "minimum_kwp_dc"
    maximum_key = "maximum_kwh" if allow_zero else "maximum_kwp_dc"
    step_key = "step_kwh" if allow_zero else "step_kwp_dc"
    minimum = _bounded(
        value.get(minimum_key), 0 if allow_zero else 1e-9, 1_000_000
    )
    maximum = _bounded(
        value.get(maximum_key), 0 if allow_zero else 1e-9, 1_000_000
    )
    step = _bounded(value.get(step_key), 1e-9, 1_000_000)
    if maximum < minimum:
        raise _invalid("The solution search range is invalid.")
    result = {minimum_key: minimum, maximum_key: maximum, step_key: step}
    if len(_range_values(result, allow_zero=allow_zero)) > 10_000:
        raise _invalid("The solution search range contains too many targets.")
    return result


def _range_values(value: dict[str, Any], *, allow_zero: bool) -> list[float]:
    minimum_key = "minimum_kwh" if allow_zero else "minimum_kwp_dc"
    maximum_key = "maximum_kwh" if allow_zero else "maximum_kwp_dc"
    step_key = "step_kwh" if allow_zero else "step_kwp_dc"
    minimum = Decimal(str(value[minimum_key]))
    maximum = Decimal(str(value[maximum_key]))
    step = Decimal(str(value[step_key]))
    count = int(
        ((maximum - minimum) / step).to_integral_value(rounding=ROUND_FLOOR)
    ) + 1
    return [_clean_number(float(minimum + step * index)) for index in range(count)]


def _selected_profile(
    device_profile: dict[str, object],
    *,
    collection_names: tuple[str, ...],
    selected_id: str,
    label: str,
) -> dict[str, object]:
    catalog = device_profile.get("solution_profiles")
    if not isinstance(catalog, dict):
        raise _invalid("The device profile solution profiles are unavailable.")
    collection = next(
        (catalog.get(name) for name in collection_names if name in catalog), None
    )
    if not isinstance(collection, list):
        raise _invalid(f"The published {label} profiles are unavailable.")
    matches = [
        item
        for item in collection
        if isinstance(item, dict)
        and item.get("status") == "published"
        and _profile_id(item) == selected_id
    ]
    if len(matches) != 1:
        raise _invalid(f"Select one published {label} profile.")
    try:
        return json.loads(json.dumps(matches[0], allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise _invalid(f"The selected {label} profile is invalid.") from exc


def _solar_performance(
    profile: dict[str, object],
) -> dict[str, float | int | str]:
    return {
        "profile_id": _profile_id(profile),
        "version": _integer(profile.get("version"), 1, 10_000),
        "rated_power_w": _bounded(profile.get("rated_power_w"), 1, 10_000),
        "default_dc_ac_ratio": _bounded(
            profile.get("default_dc_ac_ratio"), 0.8, 2
        ),
    }


def _battery_performance(profile: dict[str, object]) -> dict[str, float | int | str]:
    if profile.get("coupling") != "ac":
        raise _invalid(
            "The current Python dispatch engine supports only AC-coupled battery profiles."
        )
    minimum_units = _integer(profile.get("minimum_units"), 1, 1_000_000)
    maximum_units = _integer(profile.get("maximum_units"), 1, 1_000_000)
    if maximum_units < minimum_units:
        raise _invalid("The battery profile unit range is invalid.")
    return {
        "profile_id": _profile_id(profile),
        "version": _integer(profile.get("version"), 1, 10_000),
        "nominal_capacity_kwh_per_unit": _bounded(
            profile.get("nominal_capacity_kwh_per_unit"), 1e-9, 1_000_000
        ),
        "minimum_units": minimum_units,
        "maximum_units": maximum_units,
        "continuous_power_kw_per_unit": _bounded(
            profile.get("continuous_power_kw_per_unit"), 1e-9, 1_000_000
        ),
        "round_trip_efficiency_percent": _bounded(
            profile.get("round_trip_efficiency_percent"), 1, 100
        ),
        "power_conversion_efficiency_percent": _bounded(
            profile.get("power_conversion_efficiency_percent"), 1, 100
        ),
        "usable_depth_of_discharge_percent": _bounded(
            profile.get("usable_depth_of_discharge_percent"), 1, 100
        ),
    }


def _inverter_performance(
    profile: dict[str, object],
) -> dict[str, float | int | str]:
    active = _bounded(profile.get("rated_active_power_kw"), 1e-9, 1_000_000)
    apparent = _bounded(
        profile.get("rated_apparent_power_kva"), active, 1_000_000
    )
    reactive = _bounded(
        profile.get("maximum_reactive_power_kvar"), 0, apparent
    )
    return {
        "profile_id": _profile_id(profile),
        "version": _integer(profile.get("version"), 1, 10_000),
        "rated_active_power_kw": active,
        "rated_apparent_power_kva": apparent,
        "maximum_reactive_power_kvar": reactive,
        "european_efficiency_percent": _bounded(
            profile.get("european_efficiency_percent"), 1, 100
        ),
        "maximum_efficiency_percent": _bounded(
            profile.get("maximum_efficiency_percent"), 1, 100
        ),
    }


def _profile_id(profile: dict[str, object]) -> str:
    return _text(
        profile.get("profile_id", profile.get("product_id")), "profile id"
    )


def _screening_battery_power(
    capacity_kwh: float, profile: dict[str, Any]
) -> float:
    return _clean_number(
        capacity_kwh
        * float(profile["continuous_power_kw_per_unit"])
        / float(profile["nominal_capacity_kwh_per_unit"])
    )


def _scenario(
    *,
    solar: dict[str, object],
    battery: dict[str, object],
    inverter: dict[str, object] | None,
    pv_capacity_kwp_dc: float,
    inverter_capacity_kw_ac: float,
    battery_performance_scale: float,
    battery_capacity_kwh: float,
    battery_power_kw: float,
    annual_specific_yield: float,
    derating: float,
    one_way_efficiency: float,
    minimum_soc: float,
    connection: dict[str, Any],
    inverter_performance: dict[str, Any] | None,
) -> dict[str, object]:
    solar_key = {
        "profile_id": _profile_id(solar),
        "version": _integer(solar.get("version"), 1, 10_000),
        "profile_sha256": _snapshot_sha256(solar),
        "pv_capacity_kwp_dc": pv_capacity_kwp_dc,
        "inverter_capacity_kw_ac": inverter_capacity_kw_ac,
    }
    if inverter is not None:
        solar_key["inverter_profile_id"] = _profile_id(inverter)
        solar_key["inverter_profile_version"] = _integer(
            inverter.get("version"), 1, 10_000
        )
        solar_key["inverter_profile_sha256"] = _snapshot_sha256(inverter)
    battery_key = {
        "profile_id": _profile_id(battery),
        "version": _integer(battery.get("version"), 1, 10_000),
        "profile_sha256": _snapshot_sha256(battery),
        "battery_performance_scale": battery_performance_scale,
        "battery_capacity_kwh": battery_capacity_kwh,
        "battery_power_kw": battery_power_kw,
    }
    pv_system_id = _stable_id("pv", solar_key)
    battery_system_id = (
        _stable_id("battery", battery_key)
        if battery_capacity_kwh > 0
        else "battery-none"
    )
    inverter_performance_scale = (
        inverter_capacity_kw_ac
        / float(inverter_performance["rated_active_power_kw"])
        if inverter_performance is not None
        else 0.0
    )
    reactive_cap = float(connection["reactive_support_max_kvar"])
    if inverter_performance is not None and connection["reactive_support_enabled"]:
        reactive_cap = min(
            reactive_cap,
            inverter_performance_scale
            * float(inverter_performance["maximum_reactive_power_kvar"]),
        )
    apparent_limit = (
        (
            inverter_performance_scale
            * float(inverter_performance["rated_apparent_power_kva"])
            if inverter_performance is not None
            else math.hypot(inverter_capacity_kw_ac, reactive_cap)
        )
        if connection["reactive_support_enabled"]
        else None
    )
    return {
        "scenario_id": f"{pv_system_id}__{battery_system_id}",
        "label": (
            f"{_candidate_label_number(pv_capacity_kwp_dc)} kWp PV + "
            f"{_candidate_label_number(battery_capacity_kwh)} kWh battery / "
            f"{_candidate_label_number(inverter_capacity_kw_ac)} kW hybrid inverter"
        ),
        "battery_system_id": battery_system_id,
        "battery_technology_id": "generic_li_ion_ac",
        "control_profile_id": "demand_peak_shaving",
        "pv_system_id": pv_system_id,
        "pv_profile_id": "generic_normalized_solar_shape_v1",
        "pv_capacity_kwp_dc": pv_capacity_kwp_dc,
        "pv_inverter_capacity_kw_ac": inverter_capacity_kw_ac,
        "shared_ac_headroom_kw": inverter_capacity_kw_ac,
        "reactive_support_enabled": connection["reactive_support_enabled"],
        "reactive_support_max_kvar": (
            reactive_cap
            if connection["reactive_support_enabled"]
            else 0.0
        ),
        "shared_inverter_apparent_power_limit_kva": apparent_limit,
        "reactive_capability_curve": "circular_pq",
        "reactive_capability_provenance": "analyst_assumption",
        "reactive_overcompensation_permitted": False,
        "pv_annual_specific_yield_kwh_per_kw": annual_specific_yield,
        "pv_derating_factor": derating,
        "nominal_capacity_kwh": battery_capacity_kwh,
        "max_charge_kw": battery_power_kw,
        "max_discharge_kw": battery_power_kw,
        "charge_efficiency": one_way_efficiency,
        "discharge_efficiency": one_way_efficiency,
        "min_soc_fraction": minimum_soc,
        "max_soc_fraction": 1.0,
        "initial_soc_fraction": 1.0,
        "allow_grid_charging": connection["allow_grid_charging"],
        "grid_emissions_factor_kg_co2e_per_kwh": (
            connection["grid_emissions_factor_kg_co2e_per_kwh"] or 0.0
        ),
    }


def _design_context(
    request: dict[str, Any],
    *,
    solar: dict[str, object],
    battery: dict[str, object],
    inverter: dict[str, object] | None,
    device_profile_sha256: str | None,
    solar_performance: dict[str, Any],
    battery_performance: dict[str, Any],
    inverter_performance: dict[str, Any] | None,
    derating: float,
    one_way_efficiency: float,
    minimum_soc: float,
    generation_summary: dict[str, object],
) -> dict[str, object]:
    connection = request["connection_options"]
    site = request["site_factors"]
    duration = (
        float(battery_performance["nominal_capacity_kwh_per_unit"])
        / float(battery_performance["continuous_power_kw_per_unit"])
    )
    return {
        "contract_version": "ci_design_context_v2",
        "existing_solar": _empty_existing_solar(),
        "existing_battery": _empty_existing_battery(),
        "search_space": {
            "pv_range": dict(request["pv_range"]),
            "battery_range": dict(request["battery_range"]),
        },
        "generation_summary": json.loads(json.dumps(generation_summary)),
        "site_factors": dict(site),
        "profile_selection": {
            "solar_profile_id": request["solar_profile_id"],
            "battery_profile_id": request["battery_profile_id"],
            "solar_profile": solar,
            "battery_profile": battery,
            "device_profile_sha256": device_profile_sha256,
            **(
                {
                    "inverter_profile_id": request["inverter_profile_id"],
                    "inverter_profile": inverter,
                }
                if inverter is not None
                else {}
            ),
        },
        "technical_options": {
            "annual_specific_yield_kwh_per_kw": site[
                "annual_specific_yield_kwh_per_kw"
            ],
            "shading_loss_percent": site["shading_loss_percent"],
            "soiling_loss_percent": site["soiling_loss_percent"],
            "temperature_loss_percent": site["temperature_loss_percent"],
            "wiring_mismatch_loss_percent": site[
                "wiring_mismatch_loss_percent"
            ],
            "other_system_loss_percent": site["other_system_loss_percent"],
            "system_availability_percent": site[
                "system_availability_percent"
            ],
            "effective_derating_percent": round(derating * 100, 8),
            "target_dc_ac_ratio": solar_performance["default_dc_ac_ratio"],
            "inverter_block_size_kw": (
                inverter_performance["rated_active_power_kw"]
                if inverter_performance is not None
                else connection["inverter_block_size_kw"]
            ),
            **(
                {"inverter_quantity": connection["inverter_quantity"]}
                if connection["inverter_quantity"] is not None
                else {}
            ),
            "site_ac_headroom_kw": connection["site_ac_headroom_kw"],
            "battery_duration_hours": _clean_number(duration),
            "charge_efficiency_percent": round(one_way_efficiency * 100, 8),
            "discharge_efficiency_percent": round(one_way_efficiency * 100, 8),
            "minimum_soc_percent": round(minimum_soc * 100, 8),
            "maximum_soc_percent": 100.0,
            "allow_grid_charging": connection["allow_grid_charging"],
            "reactive_support_enabled": connection[
                "reactive_support_enabled"
            ],
            "reactive_support_max_kvar": connection[
                "reactive_support_max_kvar"
            ],
            "grid_emissions_factor_kg_co2e_per_kwh": (
                connection["grid_emissions_factor_kg_co2e_per_kwh"] or 0.0
            ),
            "initial_soc_basis": connection["initial_soc_basis"],
        },
    }


def _effective_derating(site: dict[str, Any]) -> float:
    factor = float(site["system_availability_percent"]) / 100
    for key in (
        "shading_loss_percent",
        "soiling_loss_percent",
        "temperature_loss_percent",
        "wiring_mismatch_loss_percent",
        "other_system_loss_percent",
    ):
        factor *= 1 - float(site[key]) / 100
    if not math.isfinite(factor) or factor <= 0:
        raise _invalid("The effective PV derating factor is invalid.")
    return factor


def _empty_existing_solar() -> dict[str, object]:
    return {
        "installed": False,
        "brand": "",
        "model": "",
        "panel_count": 0,
        "panel_rating_w": 0,
        "installed_capacity_kwp_dc": 0,
        "inverter_brand": "",
        "inverter_model": "",
        "inverter_capacity_kw_ac": 0,
        "installation_year": None,
        "operating_status": "unknown",
        "included_in_interval_baseline": False,
    }


def _empty_existing_battery() -> dict[str, object]:
    return {
        "installed": False,
        "brand": "",
        "model": "",
        "nominal_capacity_kwh": 0,
        "usable_capacity_kwh": 0,
        "power_kw": 0,
        "installation_year": None,
        "operating_status": "unknown",
        "included_in_interval_baseline": False,
    }


def _stable_id(prefix: str, value: object) -> str:
    digest = hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    ).hexdigest()[:20]
    return f"{prefix}-{digest}"


def _snapshot_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    ).hexdigest()


def _clean_number(value: float) -> float:
    return round(float(value), 9)


def _candidate_label_number(value: float) -> str:
    return f"{_clean_number(value):.9f}".rstrip("0").rstrip(".")


def _bounded(value: object, minimum: float, maximum: float) -> float:
    if isinstance(value, bool):
        raise _invalid("A numeric solution-generation field is invalid.")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise _invalid("A numeric solution-generation field is invalid.") from exc
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise _invalid("A numeric solution-generation field is out of range.")
    return result


def _integer(value: object, minimum: int, maximum: int) -> int:
    result = _bounded(value, minimum, maximum)
    if not result.is_integer():
        raise _invalid("A profile unit limit must be an integer.")
    return int(result)


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 160:
        raise _invalid(f"The {label} is invalid.")
    return value.strip()


def _invalid(message: str) -> CiProjectError:
    return CiProjectError("ci_solution_generation_invalid", message)

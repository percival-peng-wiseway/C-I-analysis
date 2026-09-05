from __future__ import annotations

import hashlib
from typing import Any
from uuid import UUID

from solar_battery.ci_financial_solutions import calculate_catalog_projection
from solar_battery.ci_projects import CiProjectError, saved_ci_design_candidates
from solar_battery.ci_scenario_analysis import analyze_ci_physical_scenarios
from solar_battery.durable_cockpit.identity import LocalActorContext


def simulate_ci_annual_financial_scenario(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    upload_bytes: bytes,
    profile: dict[str, Any],
    request: dict[str, Any],
) -> dict[str, object]:
    candidates = saved_ci_design_candidates(
        session, project_id=project_id, actor=actor
    )
    if not candidates:
        raise CiProjectError(
            "ci_project_design_required",
            "Save and validate a System design before running annual finance.",
        )
    scenario_id = str(request.get("scenario_id", ""))
    selected = next(
        (item for item in candidates if item.get("scenario_id") == scenario_id),
        None,
    )
    if selected is None:
        raise CiProjectError(
            "ci_project_design_not_found",
            "The selected saved System design is unavailable.",
        )
    if float(selected.get("nominal_capacity_kwh", 0)) <= 0:
        raise CiProjectError(
            "ci_project_battery_design_required",
            "Select a saved design with a battery for the before/after comparison.",
        )

    pv_only = _pv_only_candidate(selected)
    physical = analyze_ci_physical_scenarios(
        upload_bytes,
        profile=profile,
        scenarios=[pv_only, selected],
    )
    returned = {
        str(item["scenario_id"]): item for item in physical["scenarios"]
    }
    pv_only_result = returned[pv_only["scenario_id"]]
    battery_result = returned[scenario_id]
    pv_value = _tariff_value(pv_only_result)
    battery_value = _tariff_value(battery_result)
    value_basis = str(request["value_basis"])
    if value_basis == "battery_incremental":
        first_year_values = {
            "gst_exclusive": round(
                float(pv_value["scenario_cost_ex_gst_aud"])
                - float(battery_value["scenario_cost_ex_gst_aud"]),
                2,
            ),
            "gst_inclusive": round(
                float(pv_value["scenario_cost_inc_gst_aud"])
                - float(battery_value["scenario_cost_inc_gst_aud"]),
                2,
            ),
        }
        value_source = "battery_incremental_evidence_bound_tariff_scenario"
    else:
        first_year_values = {
            "gst_exclusive": float(
                battery_value["first_year_value_ex_gst_aud"]
            ),
            "gst_inclusive": float(
                battery_value["first_year_value_inc_gst_aud"]
            ),
        }
        value_source = "whole_solution_evidence_bound_tariff_scenario"

    projection = calculate_catalog_projection(
        session,
        workspace_id=actor.workspace_id,
        owner_id=actor.owner_id,
        authored_inputs=battery_result["authored_inputs"],
        assumptions={
            "discount_rate": request["discount_rate"],
            "annual_value_degradation_rate": request[
                "annual_value_degradation_rate"
            ],
            "analysis_term_years": request["analysis_term_years"],
        },
        pricing_catalog_version_id=request["pricing_catalog_version_id"],
        product_ids=list(request["product_ids"]),
        installation_item_ids=list(request["installation_item_ids"]),
        first_year_values_aud=first_year_values,
        value_source=value_source,
        tariff_value=battery_value,
    )
    return {
        "contract_version": "ci_annual_financial_simulation_v1",
        "status": "ready",
        "analysis_mode": "evidence_limited_internal_review",
        "project_id": str(project_id),
        "selected_design_id": scenario_id,
        "profile": physical["profile"],
        "value_basis": value_basis,
        "cases": [
            _baseline_case(physical["baseline"], battery_value),
            _scenario_case("pv_only", pv_only_result),
            _scenario_case("pv_battery", battery_result),
        ],
        "battery_incremental_value": {
            "ex_gst_aud": round(
                float(pv_value["scenario_cost_ex_gst_aud"])
                - float(battery_value["scenario_cost_ex_gst_aud"]),
                2,
            ),
            "inc_gst_aud": round(
                float(pv_value["scenario_cost_inc_gst_aud"])
                - float(battery_value["scenario_cost_inc_gst_aud"]),
                2,
            ),
        },
        "financial_projection": projection,
        "currency_values_permitted": True,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "disclaimer": (
            "Internal evidence-limited simulation only. Values depend on the "
            "uploaded NEM12, active tariff profile, selected price catalog and "
            "explicit financial assumptions; no recommendation or customer claim."
        ),
    }


def _pv_only_candidate(selected: dict[str, object]) -> dict[str, object]:
    digest = hashlib.sha256(str(selected["scenario_id"]).encode()).hexdigest()[:16]
    return {
        **selected,
        "scenario_id": f"pv-only-{digest}",
        "label": f"PV only · {selected['pv_capacity_kwp_dc']} kWp",
        "battery_system_id": "battery-none",
        "nominal_capacity_kwh": 0.0,
        "max_charge_kw": 0.0,
        "max_discharge_kw": 0.0,
        "allow_grid_charging": False,
        **(
            {
                "battery_inverter_capacity_kw_ac": 0.0,
                "reactive_support_enabled": False,
                "reactive_support_max_kvar": 0.0,
                "shared_inverter_apparent_power_limit_kva": None,
            }
            if selected.get("dispatch_topology") == "separate_ac"
            else {}
        ),
    }


def _tariff_value(scenario: dict[str, Any]) -> dict[str, Any]:
    value = scenario.get("annual_tariff_value")
    if not isinstance(value, dict):
        raise CiProjectError(
            "ci_annual_financial_value_unavailable",
            "The annual tariff value is unavailable for this scenario.",
        )
    return value


def _baseline_case(
    baseline: dict[str, Any], tariff_value: dict[str, Any]
) -> dict[str, object]:
    return {
        "case_id": "no_system",
        "label": "No system",
        "scenario_id": None,
        "annual_cost_ex_gst_aud": tariff_value["baseline_cost_ex_gst_aud"],
        "annual_cost_inc_gst_aud": tariff_value["baseline_cost_inc_gst_aud"],
        "first_year_value_ex_gst_aud": 0.0,
        "first_year_value_inc_gst_aud": 0.0,
        "raw_rolling_demand_kva": baseline["raw_rolling_demand_kva"],
    }


def _scenario_case(
    case_id: str, scenario: dict[str, Any]
) -> dict[str, object]:
    value = _tariff_value(scenario)
    return {
        "case_id": case_id,
        "label": "PV only" if case_id == "pv_only" else "PV + battery",
        "scenario_id": scenario["scenario_id"],
        "annual_cost_ex_gst_aud": value["scenario_cost_ex_gst_aud"],
        "annual_cost_inc_gst_aud": value["scenario_cost_inc_gst_aud"],
        "first_year_value_ex_gst_aud": value["first_year_value_ex_gst_aud"],
        "first_year_value_inc_gst_aud": value["first_year_value_inc_gst_aud"],
        "raw_rolling_demand_kva": scenario["post_dispatch"][
            "raw_rolling_demand_kva"
        ],
    }

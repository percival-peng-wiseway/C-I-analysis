from __future__ import annotations

import math
from typing import Any

from solar_battery.ci_financial_solutions import calculate_metrics
from solar_battery.ci_device_profile import (
    device_profile_sha256,
    validate_ci_device_profile,
)
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_project_rebate_profile import (
    rebate_calculation_profile_sha256,
)
from solar_battery.ci_rebate_calculation import calculate_ci_scenario_rebates
from solar_battery.ci_rebate_rules import (
    CI_REBATE_RULESET_ID,
    ci_rebate_ruleset_sha256,
)


CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION = (
    "ci_annual_financial_comparison_v4"
)
CI_ANNUAL_FINANCIAL_REVIEW_ORDER_ID = "ci_highest_npv_review_order_v1"
CI_ANNUAL_FINANCIAL_SELECTION_ID = "ci_analyst_selected_tariff_scenarios_v1"
CI_ANNUAL_FINANCIAL_ALL_SCENARIOS_ID = "ci_all_tariff_scenarios_v1"
CI_DESIGN_PRICE_PREVIEW_CONTRACT_VERSION = "ci_design_price_preview_v1"


def preview_ci_design_candidate_prices(
    *,
    candidates: list[dict[str, Any]],
    device_profile: dict[str, Any],
    rebate_profile: dict[str, Any] | None = None,
) -> dict[str, object]:
    if not 1 <= len(candidates) <= 200:
        raise CiProjectError(
            "ci_design_price_preview_invalid",
            "A saved solution space with 1 to 200 candidates is required.",
        )
    validated_profile = _validated_device_profile(device_profile)
    equipment_selection = _validated_equipment_selection(
        validated_profile.get("default_equipment_selection"),
        profile=validated_profile,
    )
    scenarios = [
        {
            "scenario_id": candidate.get("scenario_id"),
            "label": candidate.get("label"),
            "authored_inputs": candidate,
        }
        for candidate in candidates
    ]
    scenario_ids = [item.get("scenario_id") for item in scenarios]
    if (
        any(not isinstance(item, str) or not item for item in scenario_ids)
        or len(set(scenario_ids)) != len(scenario_ids)
    ):
        raise CiProjectError(
            "ci_design_price_preview_invalid",
            "Saved solution IDs must be present and unique before pricing.",
        )
    rebates = calculate_ci_scenario_rebates(
        scenarios,
        rebate_profile=rebate_profile,
    )
    solutions = []
    for scenario in scenarios:
        scenario_id = str(scenario["scenario_id"])
        capex_breakdown = _profile_capex_breakdown(
            scenario,
            profile=validated_profile,
            equipment_selection=equipment_selection,
        )
        gross_capex = round(sum(capex_breakdown.values()), 2)
        rebate_calculation = rebates[scenario_id]
        upfront_rebate = _finite_number(
            rebate_calculation.get("total_rebate_aud_ex_gst"),
            message="The approved project rebate result is invalid.",
        )
        net_capex = round(gross_capex - upfront_rebate, 2)
        if net_capex <= 0:
            raise CiProjectError(
                "ci_annual_financial_rebate_exceeds_cost",
                "The approved upfront rebate must be lower than the gross solution cost.",
            )
        authored = scenario["authored_inputs"]
        solutions.append(
            {
                "scenario_id": scenario_id,
                "label": str(scenario.get("label") or scenario_id),
                "pv_capacity_kwp_dc": _finite_number(
                    authored.get("pv_capacity_kwp_dc"),
                    message="A selected PV size is invalid.",
                ),
                "battery_capacity_kwh": _finite_number(
                    authored.get("nominal_capacity_kwh"),
                    message="A selected battery size is invalid.",
                ),
                "inverter_capacity_kw_ac": _finite_number(
                    authored.get("pv_inverter_capacity_kw_ac"),
                    message="A selected inverter size is invalid.",
                ),
                "gross_capex_aud_ex_gst": gross_capex,
                "upfront_rebate_aud_ex_gst": round(upfront_rebate, 2),
                "net_capex_aud_ex_gst": net_capex,
                "capex_breakdown_aud_ex_gst": capex_breakdown,
                "rebate_calculation": rebate_calculation,
            }
        )
    return {
        "contract_version": CI_DESIGN_PRICE_PREVIEW_CONTRACT_VERSION,
        "status": "ready",
        "pricing_basis": "workspace_device_profile_less_approved_rebates",
        "device_profile_sha256": device_profile_sha256(validated_profile),
        "rebate_profile_sha256": (
            rebate_calculation_profile_sha256(rebate_profile)
            if rebate_profile is not None
            else None
        ),
        "equipment_selection": equipment_selection,
        "candidate_count": len(solutions),
        "solutions": solutions,
        "quotation_override_basis": (
            "Entered quotation replaces modelled Net CAPEX and is not reduced by rebates again."
        ),
        "currency_values_permitted": True,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }


def compare_ci_annual_financial_scenarios(
    *,
    tariff_replay_result: dict[str, Any],
    request: dict[str, Any],
    device_profile: dict[str, Any] | None = None,
    rebate_profile: dict[str, Any] | None = None,
) -> dict[str, object]:
    scenarios = _tariff_scenarios(tariff_replay_result)
    pricing_mode = str(request.get("pricing_mode", "manual_quotes"))
    if pricing_mode == "device_profile":
        validated_profile = _validated_device_profile(device_profile)
        equipment_selection = _validated_equipment_selection(
            request.get("equipment_selection"), profile=validated_profile
        )
        selected = scenarios
        prices = {
            str(scenario["scenario_id"]): _profile_price(
                scenario,
                profile=validated_profile,
                equipment_selection=equipment_selection,
            )
            for scenario in selected
        }
        selection_id = CI_ANNUAL_FINANCIAL_ALL_SCENARIOS_ID
    elif pricing_mode == "manual_quotes":
        validated_profile = None
        equipment_selection = None
        selected, prices = _validated_selection(
            request.get("prices"), scenarios=scenarios
        )
        selection_id = CI_ANNUAL_FINANCIAL_SELECTION_ID
    else:
        raise CiProjectError(
            "ci_annual_financial_pricing_mode_invalid",
            "Annual finance pricing mode is not supported.",
        )
    assumptions = _validated_assumptions(request, device_profile=validated_profile)
    rebate_results = calculate_ci_scenario_rebates(
        selected,
        rebate_profile=rebate_profile,
    )
    solutions = [
        _financial_solution(
            scenario,
            upfront_cost_aud=prices[str(scenario["scenario_id"])],
            assumptions=assumptions,
            rebate_calculation=rebate_results[str(scenario["scenario_id"])],
            apply_rebate_to_upfront=validated_profile is not None,
            capex_breakdown=(
                _profile_capex_breakdown(
                    scenario,
                    profile=validated_profile,
                    equipment_selection=equipment_selection,
                )
                if validated_profile is not None and equipment_selection is not None
                else None
            ),
        )
        for scenario in selected
    ]
    ordered = sorted(
        solutions,
        key=lambda item: (
            -float(item["metrics"]["net_present_value_aud"]),
            _payback_sort_value(item["metrics"]["payback_period_years"]),
            float(item["upfront_cost_aud_ex_gst"]),
            int(item["physical_review_rank"]),
            str(item["scenario_id"]),
        ),
    )
    for rank, item in enumerate(ordered, start=1):
        item["financial_review_rank"] = rank

    profile = tariff_replay_result.get("profile")
    if not isinstance(profile, dict):
        raise CiProjectError(
            "ci_annual_financial_tariff_result_invalid",
            "The saved Tariff replay profile is unavailable.",
        )
    return {
        "contract_version": CI_ANNUAL_FINANCIAL_COMPARISON_CONTRACT_VERSION,
        "status": "ready",
        "analysis_mode": "evidence_limited_internal_financial_comparison",
        "profile": profile,
        "source_tariff_replay_sha256": canonical_sha256(tariff_replay_result),
        "assumptions": {
            "currency": "AUD",
            "tax_basis": "gst_exclusive",
            "price_source": (
                "workspace_device_profile"
                if validated_profile is not None
                else "analyst_entered_total_solution_price"
            ),
            "device_profile_sha256": (
                device_profile_sha256(validated_profile)
                if validated_profile is not None
                else None
            ),
            "device_prices": (
                {
                    "pv_cost_aud_per_kwp_dc": validated_profile[
                        "pv_cost_aud_per_kwp_dc"
                    ],
                    "battery_cost_aud_per_kwh": validated_profile[
                        "battery_cost_aud_per_kwh"
                    ],
                    "inverter_cost_aud_per_kw_ac": validated_profile[
                        "inverter_cost_aud_per_kw_ac"
                    ],
                }
                if validated_profile is not None
                else None
            ),
            "equipment_selection": equipment_selection,
            "rebate_profile_sha256": (
                rebate_calculation_profile_sha256(rebate_profile)
                if rebate_profile is not None
                else None
            ),
            "rebate_ruleset_id": CI_REBATE_RULESET_ID,
            "rebate_ruleset_sha256": ci_rebate_ruleset_sha256(),
            "rebate_application_basis": (
                "deducted_from_workspace_device_profile_gross_cost"
                if validated_profile is not None
                else "not_deducted_from_analyst_entered_manual_quote"
            ),
            **assumptions,
            "replacement_events_aud": [],
        },
        "shortlist_source": {
            "algorithm_id": selection_id,
            "available_scenario_count": len(scenarios),
            "shortlist_count": len(selected),
        },
        "financial_review_order": {
            "algorithm_id": CI_ANNUAL_FINANCIAL_REVIEW_ORDER_ID,
            "basis": (
                "Highest Python-calculated NPV, then shorter simple payback, "
                "lower net upfront cost and the saved physical review order. "
                "This is an internal financial review order, not a recommendation."
            ),
            "leader_scenario_id": ordered[0]["scenario_id"],
            "recommendation_permitted": False,
        },
        "solutions": ordered,
        "currency_values_permitted": True,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "disclaimer": (
            "Internal evidence-limited comparison only. NPV, IRR and payback "
            "depend on the saved Tariff replay, the saved ex-GST device price "
            "catalog or entered quotations, any approved project rebate profile, "
            "and displayed finance assumptions. Manual quotations are never "
            "automatically reduced by modelled rebates. "
            "The financial review leader is not a customer recommendation."
        ),
    }


def _tariff_scenarios(
    tariff_replay_result: dict[str, Any],
) -> list[dict[str, Any]]:
    scenarios = tariff_replay_result.get("scenarios")
    if (
        tariff_replay_result.get("contract_version")
        != "ci_physical_scenario_review_v6"
        or tariff_replay_result.get("analysis_status") != "ready"
        or tariff_replay_result.get("customer_facing_permission") is not False
        or tariff_replay_result.get("recommendation_permitted") is not False
        or not isinstance(scenarios, list)
        or not scenarios
        or len(scenarios) > 200
    ):
        raise CiProjectError(
            "ci_project_tariff_replay_required",
            "Run Tariff replay before starting Annual finance.",
        )
    return [item for item in scenarios if isinstance(item, dict)]


def _validated_selection(
    value: object, *, scenarios: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 200:
        raise CiProjectError(
            "ci_annual_financial_prices_invalid",
            "Select and enter a valid total price for 1 to 200 solutions.",
        )
    scenario_by_id = {
        str(item.get("scenario_id")): item
        for item in scenarios
        if isinstance(item.get("scenario_id"), str)
    }
    prices: dict[str, float] = {}
    selected: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise CiProjectError(
                "ci_annual_financial_prices_invalid",
                "Select and enter a valid total price for 1 to 200 solutions.",
            )
        scenario_id = str(item.get("scenario_id", ""))
        try:
            price = float(item["upfront_cost_aud_ex_gst"])
        except (KeyError, TypeError, ValueError) as exc:
            raise CiProjectError(
                "ci_annual_financial_prices_invalid",
                "Select and enter a valid total price for 1 to 200 solutions.",
            ) from exc
        scenario = scenario_by_id.get(scenario_id)
        if (
            scenario is None
            or scenario_id in prices
            or not math.isfinite(price)
            or price <= 0
        ):
            raise CiProjectError(
                "ci_annual_financial_prices_invalid",
                "Every quoted solution must be unique, available and have a positive price.",
            )
        prices[scenario_id] = price
        selected.append(scenario)
    return selected, prices


def _validated_device_profile(
    profile: dict[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(profile, dict):
        raise CiProjectError(
            "ci_device_profile_required",
            "Save the workspace Device profile in Settings before calculating all solutions.",
        )
    return validate_ci_device_profile(profile)


def _validated_equipment_selection(
    value: object, *, profile: dict[str, Any]
) -> dict[str, str]:
    selection = value if value is not None else profile.get("default_equipment_selection")
    if not isinstance(selection, dict):
        raise CiProjectError(
            "ci_equipment_selection_invalid",
            "Select a supported PV, battery and inverter before calculating.",
        )
    expected = profile.get("default_equipment_selection")
    normalized = {
        "pv_product_id": str(selection.get("pv_product_id", "")),
        "battery_product_id": str(selection.get("battery_product_id", "")),
        "inverter_product_id": str(selection.get("inverter_product_id", "")),
    }
    if normalized != expected:
        raise CiProjectError(
            "ci_equipment_selection_invalid",
            "The selected equipment is not in the supported workspace catalog.",
        )
    return normalized


def _validated_assumptions(
    request: dict[str, Any], *, device_profile: dict[str, Any] | None
) -> dict[str, object]:
    defaults = device_profile or {}
    return {
        "discount_rate": _rate(
            request,
            "discount_rate",
            default=float(defaults.get("discount_rate", 0.08)),
        ),
        "annual_value_escalation_rate": _rate(
            request,
            "annual_value_escalation_rate",
            default=float(defaults.get("annual_value_escalation_rate", 0.025)),
        ),
        "annual_value_degradation_rate": _rate(
            request,
            "annual_value_degradation_rate",
            default=float(defaults.get("annual_value_degradation_rate", 0.005)),
        ),
        "annual_om_fraction_of_capex": _rate(
            request,
            "annual_om_fraction_of_capex",
            default=float(defaults.get("annual_om_fraction_of_capex", 0.015)),
            maximum=0.201,
        ),
        "analysis_term_years": _term_years(
            request,
            default=int(defaults.get("analysis_term_years", 15)),
        ),
    }


def _financial_solution(
    scenario: dict[str, Any],
    *,
    upfront_cost_aud: float,
    assumptions: dict[str, object],
    rebate_calculation: dict[str, Any],
    apply_rebate_to_upfront: bool,
    capex_breakdown: dict[str, float] | None,
) -> dict[str, object]:
    tariff_value = scenario.get("annual_tariff_value")
    if not isinstance(tariff_value, dict):
        raise CiProjectError(
            "ci_annual_financial_value_unavailable",
            "The approved annual tariff value is unavailable for a selected solution.",
        )
    first_year_value = _finite_number(
        tariff_value.get("first_year_value_ex_gst_aud"),
        message="The approved annual tariff value is invalid.",
    )
    annual_cost = _finite_number(
        tariff_value.get("scenario_cost_ex_gst_aud"),
        message="The approved annual tariff cost is invalid.",
    )
    authored = scenario.get("authored_inputs")
    if not isinstance(authored, dict):
        raise CiProjectError(
            "ci_annual_financial_scenario_invalid",
            "A selected solution no longer has valid technical inputs.",
        )
    calculated_rebate = _finite_number(
        rebate_calculation.get("total_rebate_aud_ex_gst"),
        message="The approved project rebate result is invalid.",
    )
    upfront_rebate = calculated_rebate if apply_rebate_to_upfront else 0.0
    net_upfront_cost = round(upfront_cost_aud - upfront_rebate, 2)
    if net_upfront_cost <= 0:
        raise CiProjectError(
            "ci_annual_financial_rebate_exceeds_cost",
            "The approved upfront rebate must be lower than the gross solution cost.",
        )
    annual_om = upfront_cost_aud * float(
        assumptions["annual_om_fraction_of_capex"]
    )
    metrics = calculate_metrics(
        {
            "upfront_cost_aud": net_upfront_cost,
            "first_year_net_value_aud": first_year_value,
            "annual_om_cost_aud": annual_om,
            "replacement_events_aud": [],
            "discount_rate": assumptions["discount_rate"],
            "annual_value_escalation_rate": assumptions[
                "annual_value_escalation_rate"
            ],
            "annual_value_degradation_rate": assumptions[
                "annual_value_degradation_rate"
            ],
            "analysis_term_years": assumptions["analysis_term_years"],
        }
    )
    return {
        "scenario_id": scenario["scenario_id"],
        "label": scenario["label"],
        "physical_review_rank": int(scenario["physical_review_rank"]),
        "pv_capacity_kwp_dc": _finite_number(
            authored.get("pv_capacity_kwp_dc"), message="A selected PV size is invalid."
        ),
        "battery_capacity_kwh": _finite_number(
            authored.get("nominal_capacity_kwh"),
            message="A selected battery size is invalid.",
        ),
        "inverter_capacity_kw_ac": _finite_number(
            authored.get("pv_inverter_capacity_kw_ac"),
            message="A selected inverter size is invalid.",
        ),
        "upfront_cost_aud_ex_gst": net_upfront_cost,
        "gross_upfront_cost_aud_ex_gst": upfront_cost_aud,
        "upfront_rebate_aud_ex_gst": round(upfront_rebate, 2),
        "rebate_application_status": (
            "applied_to_device_profile_gross_cost"
            if apply_rebate_to_upfront
            else "not_applied_to_manual_quote"
        ),
        "rebate_breakdown": [
            {
                "program_id": item["program_id"],
                "label": item["label"],
                "status": item["status"],
                "certificate_quantity": item["certificate_quantity"],
                "unit_price_aud_ex_gst": item["unit_price_aud_ex_gst"],
                "rebate_aud_ex_gst": item["rebate_aud_ex_gst"],
            }
            for item in rebate_calculation["programs"].values()
        ],
        "rebate_calculation": rebate_calculation,
        "capex_breakdown_aud_ex_gst": capex_breakdown,
        "annual_om_cost_aud_ex_gst": round(annual_om, 2),
        "first_year_value_aud_ex_gst": first_year_value,
        "annual_cost_aud_ex_gst": annual_cost,
        "metrics": metrics,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }


def _finite_number(value: object, *, message: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise CiProjectError("ci_annual_financial_value_invalid", message) from exc
    if not math.isfinite(result):
        raise CiProjectError("ci_annual_financial_value_invalid", message)
    return result


def _rate(
    value: dict[str, Any],
    key: str,
    *,
    default: float,
    maximum: float = 1.0,
) -> float:
    try:
        raw = value.get(key)
        result = default if raw is None else float(raw)
    except (TypeError, ValueError) as exc:
        raise CiProjectError(
            "ci_annual_financial_assumptions_invalid",
            "Finance assumptions must be valid percentages.",
        ) from exc
    if not math.isfinite(result) or result < 0 or result >= maximum:
        raise CiProjectError(
            "ci_annual_financial_assumptions_invalid",
            "Finance assumptions must be valid percentages.",
        )
    return result


def _term_years(value: dict[str, Any], *, default: int) -> int:
    term = value.get("analysis_term_years")
    if term is None:
        term = default
    if isinstance(term, bool) or not isinstance(term, int) or not 1 <= term <= 50:
        raise CiProjectError(
            "ci_annual_financial_assumptions_invalid",
            "The finance term must be an integer from 1 to 50 years.",
        )
    return term


def _payback_sort_value(value: object) -> float:
    return math.inf if value is None else float(value)


def _profile_price(
    scenario: dict[str, Any],
    *,
    profile: dict[str, Any],
    equipment_selection: dict[str, str],
) -> float:
    return round(
        sum(
            _profile_capex_breakdown(
                scenario,
                profile=profile,
                equipment_selection=equipment_selection,
            ).values()
        ),
        2,
    )


def _profile_capex_breakdown(
    scenario: dict[str, Any],
    *,
    profile: dict[str, Any],
    equipment_selection: dict[str, str],
) -> dict[str, float]:
    authored = scenario.get("authored_inputs")
    if not isinstance(authored, dict):
        raise CiProjectError(
            "ci_annual_financial_scenario_invalid",
            "A selected solution no longer has valid technical inputs.",
        )
    pv_capacity = _finite_number(
        authored.get("pv_capacity_kwp_dc"), message="A selected PV size is invalid."
    )
    battery_capacity = _finite_number(
        authored.get("nominal_capacity_kwh"),
        message="A selected battery size is invalid.",
    )
    inverter_capacity = _finite_number(
        authored.get("pv_inverter_capacity_kw_ac"),
        message="A selected inverter size is invalid.",
    )
    pv_product = _selected_product(
        profile, "pv_products", equipment_selection["pv_product_id"]
    )
    battery_product = _selected_product(
        profile, "battery_products", equipment_selection["battery_product_id"]
    )
    inverter_product = _selected_product(
        profile, "inverter_products", equipment_selection["inverter_product_id"]
    )
    battery_modules = max(
        0,
        math.ceil(battery_capacity / float(battery_product["module_capacity_kwh"])),
    )
    inverter_units = max(
        0,
        math.ceil(inverter_capacity / float(inverter_product["sizing_unit_kw_ac"])),
    )
    inverter_unit_cost = _curve_cost(
        inverter_product["cost_curve"],
        x=float(inverter_product["sizing_unit_kw_ac"]),
        axis="capacity_kw_ac",
    )
    return {
        "pv_aud": round(
            pv_capacity * float(pv_product["capital_cost_aud_per_kwp_dc"]), 2
        ),
        "battery_aud": round(
            _curve_cost(
                battery_product["cost_curve"],
                x=float(battery_modules),
                axis="quantity",
            ),
            2,
        ),
        "inverter_aud": round(inverter_units * inverter_unit_cost, 2),
    }


def _selected_product(
    profile: dict[str, Any], category: str, product_id: str
) -> dict[str, Any]:
    catalog = profile.get("equipment_catalog")
    products = catalog.get(category) if isinstance(catalog, dict) else None
    if not isinstance(products, list):
        raise CiProjectError(
            "ci_device_profile_invalid", "The selected equipment catalog is invalid."
        )
    for product in products:
        if isinstance(product, dict) and product.get("product_id") == product_id:
            return product
    raise CiProjectError(
        "ci_equipment_selection_invalid",
        "The selected equipment is not in the supported workspace catalog.",
    )


def _curve_cost(points: object, *, x: float, axis: str) -> float:
    if x <= 0:
        return 0.0
    if not isinstance(points, list) or not points:
        raise CiProjectError(
            "ci_device_profile_invalid", "The selected equipment cost curve is invalid."
        )
    curve = sorted(
        (
            (float(point[axis]), float(point["capital_cost_aud"]))
            for point in points
            if isinstance(point, dict)
        ),
        key=lambda item: item[0],
    )
    if not curve or any(axis_value <= 0 for axis_value, _ in curve):
        raise CiProjectError(
            "ci_device_profile_invalid", "The selected equipment cost curve is invalid."
        )
    if len(curve) == 1:
        return x * curve[0][1] / curve[0][0]
    if x <= curve[0][0]:
        return x * curve[0][1] / curve[0][0]
    for left, right in zip(curve, curve[1:], strict=False):
        if x <= right[0]:
            return left[1] + (x - left[0]) * (right[1] - left[1]) / (right[0] - left[0])
    left, right = curve[-2], curve[-1]
    return right[1] + (x - right[0]) * (right[1] - left[1]) / (right[0] - left[0])

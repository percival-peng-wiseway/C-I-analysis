from __future__ import annotations

from datetime import date
import math
from typing import Any

from solar_battery.ci_design_feasibility import analyze_ci_design_feasibility
from solar_battery.ci_financial_solutions import calculate_metrics
from solar_battery.ci_projects import CiProjectError


CI_ANNUAL_FINANCIAL_DEMO_CONTRACT_VERSION = "ci_annual_financial_demo_v2"
CI_ANNUAL_FINANCIAL_DEMO_ORDER_ID = "ci_demo_highest_bill_blended_npv_v2"
CI_ANNUAL_FINANCIAL_DEMO_TERM_YEARS = 15
CI_ANNUAL_FINANCIAL_DEMO_DISCOUNT_RATE = 0.08
CI_ANNUAL_FINANCIAL_DEMO_VALUE_DEGRADATION_RATE = 0.005
CI_ANNUAL_FINANCIAL_DEMO_VALUE_ESCALATION_RATE = 0.025
CI_ANNUAL_FINANCIAL_DEMO_PV_KWP = 141.7
CI_ANNUAL_FINANCIAL_DEMO_PV_YIELD_KWH_PER_KWP = 1450.0
CI_ANNUAL_FINANCIAL_DEMO_PV_DERATING = 0.88
CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNIT_KW = 125.0
CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNITS = 2
CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW = (
    CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNIT_KW
    * CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNITS
)
CI_ANNUAL_FINANCIAL_DEMO_BATTERY_ROUND_TRIP_EFFICIENCY = 0.9
CI_ANNUAL_FINANCIAL_DEMO_MIN_SOC = 0.1
CI_ANNUAL_FINANCIAL_DEMO_MAX_SOC = 0.9
CI_ANNUAL_FINANCIAL_DEMO_SOLAR_OM_RATE = 0.01
CI_ANNUAL_FINANCIAL_DEMO_BATTERY_OM_RATE = 0.015
CI_ANNUAL_FINANCIAL_DEMO_SOLAR_UNIT_COST_AUD_PER_KW = 530.0
CI_ANNUAL_FINANCIAL_DEMO_BATTERY_UNIT_COST_AUD_PER_KWH = 413.0
CI_ANNUAL_FINANCIAL_DEMO_BATTERY_INVERTER_TOTAL_AUD = 20_000.0
CI_ANNUAL_FINANCIAL_DEMO_DEMAND_REALISATION = 0.85
CI_ANNUAL_FINANCIAL_DEMO_EMISSIONS_KG_PER_KWH = 0.79
CI_ANNUAL_FINANCIAL_DEMO_SOLAR_ONLY_ID = "chefq-demo-solar-only"

_DEMO_OFFERS = (
    ("chefq-demo-battery-250", 250.0, 249_800.0),
    ("chefq-demo-battery-300", 300.0, 268_800.0),
    ("chefq-demo-battery-389", 389.0, 298_600.0),
)


def analyze_ci_annual_financial_demo(
    *,
    upload_bytes: bytes,
    inspection_result: dict[str, Any],
) -> dict[str, object]:
    """Compare the three explicitly supplied Chef Q demo offers.

    This intentionally does not claim an approved tariff result. Physical energy
    outcomes come from the saved interval evidence. Dollar values use two clearly
    labelled invoice-derived equivalent rates so the demo remains fail-closed.
    """
    bill = _validated_bill(inspection_result)
    scenarios = [
        _demo_scenario(CI_ANNUAL_FINANCIAL_DEMO_SOLAR_ONLY_ID, 0.0),
        *[
            _demo_scenario(scenario_id, capacity)
            for scenario_id, capacity, _ in _DEMO_OFFERS
        ],
    ]
    feasibility = analyze_ci_design_feasibility(upload_bytes, scenarios=scenarios)
    primary_year = int(feasibility["coverage"]["primary_year"])
    returned = {str(item["scenario_id"]): item for item in feasibility["scenarios"]}

    consumption_kwh = _positive_number(bill.get("consumption_kwh"), "Bill consumption is unavailable for the finance demo.")
    subtotal_aud = _positive_number(bill.get("subtotal_ex_gst_aud"), "Bill subtotal is unavailable for the finance demo.")
    billing_days = _billing_days(bill)
    charge_categories = bill.get("charge_categories_ex_gst_aud")
    if not isinstance(charge_categories, dict):
        raise CiProjectError(
            "ci_annual_financial_demo_bill_categories_required",
            "Verified bill charge categories are required for the finance demo.",
        )
    energy_charge = _non_negative_number(
        charge_categories.get("energy_charges"),
        "The bill energy charge is unavailable for the finance demo.",
    )
    environmental_charge = _non_negative_number(
        charge_categories.get("environmental_charges"),
        "The bill environmental charge is unavailable for the finance demo.",
    )

    bill_blended_rate = subtotal_aud / consumption_kwh
    conservative_rate = (energy_charge + environmental_charge) / consumption_kwh
    annualisation_factor = 365.0 / billing_days
    annualised_bill_cost = subtotal_aud * annualisation_factor
    annualised_bill_consumption = consumption_kwh * annualisation_factor

    solar_only_annual = _primary_year_energy(
        returned[CI_ANNUAL_FINANCIAL_DEMO_SOLAR_ONLY_ID],
        primary_year=primary_year,
    )
    solar_only_physical = _physical_outcome(
        solar_only_annual, primary_year=primary_year
    )
    solar_only_first_year_value = (
        float(solar_only_physical["grid_import_reduction_kwh"])
        * bill_blended_rate
    )
    solar_only_case = {
        "scenario_id": CI_ANNUAL_FINANCIAL_DEMO_SOLAR_ONLY_ID,
        "label": "Solar only",
        "pv_capacity_kwp_dc": CI_ANNUAL_FINANCIAL_DEMO_PV_KWP,
        "battery_capacity_kwh": 0.0,
        "first_year_value_aud": round(solar_only_first_year_value, 2),
        "annualised_post_system_cost_aud": round(
            max(0.0, annualised_bill_cost - solar_only_first_year_value), 2
        ),
        "physical_outcome": solar_only_physical,
        "pricing_status": "installed_price_required",
        "financial_metrics_permitted": False,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
    }

    solutions = []
    for scenario_id, battery_kwh, capex_aud in _DEMO_OFFERS:
        scenario = returned[scenario_id]
        annual = _primary_year_energy(scenario, primary_year=primary_year)
        reduction_kwh = _non_negative_number(
            annual.get("grid_import_reduction_kwh"),
            "The measured grid-import reduction is unavailable for the finance demo.",
        )
        first_year_value = reduction_kwh * bill_blended_rate
        conservative_value = reduction_kwh * conservative_rate
        capex_breakdown = _capex_breakdown(
            capex_aud=capex_aud, battery_kwh=battery_kwh
        )
        annual_om = _annual_om_cost(battery_kwh=battery_kwh)
        metrics = _metrics(
            capex_aud=capex_aud,
            first_year_value_aud=first_year_value,
            annual_om_cost_aud=annual_om,
        )
        conservative_metrics = _metrics(
            capex_aud=capex_aud,
            first_year_value_aud=conservative_value,
            annual_om_cost_aud=annual_om,
        )
        physical_outcome = _physical_outcome(
            annual, primary_year=primary_year
        )
        solutions.append(
            {
                "scenario_id": scenario_id,
                "label": f"{int(battery_kwh)} kWh battery",
                "pv_capacity_kwp_dc": CI_ANNUAL_FINANCIAL_DEMO_PV_KWP,
                "battery_capacity_kwh": battery_kwh,
                "inverter_unit_count": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNITS,
                "inverter_unit_capacity_kw_ac": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNIT_KW,
                "inverter_capacity_kw_ac": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW,
                "upfront_cost_aud": capex_aud,
                "capex_breakdown": capex_breakdown,
                "annual_om_cost_aud": round(annual_om, 2),
                "first_year_value_aud": round(first_year_value, 2),
                "annualised_post_system_cost_aud": round(
                    max(0.0, annualised_bill_cost - first_year_value), 2
                ),
                "annualised_bill_reduction_percent": round(
                    first_year_value / annualised_bill_cost * 100, 3
                ),
                "metrics": metrics,
                "conservative_sensitivity": {
                    "first_year_value_aud": round(conservative_value, 2),
                    "metrics": conservative_metrics,
                },
                "physical_outcome": physical_outcome,
                "customer_facing_permission": False,
                "recommendation_permitted": False,
            }
        )

    ordered = sorted(
        solutions,
        key=lambda item: (
            -float(item["metrics"]["net_present_value_aud"]),
            _payback_sort_value(item["metrics"]["payback_period_years"]),
            float(item["upfront_cost_aud"]),
        ),
    )
    for rank, item in enumerate(ordered, start=1):
        item["financial_review_rank"] = rank

    leader = ordered[0]
    return {
        "contract_version": CI_ANNUAL_FINANCIAL_DEMO_CONTRACT_VERSION,
        "status": "ready",
        "analysis_mode": "invoice_derived_demo_financial_comparison",
        "demo_only": True,
        "analysis_modules": [
            {
                "module_id": "evidence",
                "label": "Load & bill evidence",
                "status": "ready",
                "detail": "Saved bill and measured interval coverage are available.",
            },
            {
                "module_id": "physical",
                "label": "Solar & battery physics",
                "status": "demo_ready",
                "detail": "Solar-only and three battery offers are interval-tested.",
            },
            {
                "module_id": "tariff",
                "label": "Tariff replay",
                "status": "input_required",
                "detail": "Retail, network and demand windows still require approved mapping.",
            },
            {
                "module_id": "finance",
                "label": "Annual finance",
                "status": "demo_ready",
                "detail": "Quoted CAPEX, O&M, escalation, NPV, IRR and payback are modelled.",
            },
            {
                "module_id": "connection",
                "label": "Grid connection",
                "status": "input_required",
                "detail": "DNSP inverter and export limits require a connection offer.",
            },
            {
                "module_id": "compliance",
                "label": "Site & compliance",
                "status": "input_required",
                "detail": "Structural, fire, electrical, warranty and insurance review remains open.",
            },
        ],
        "common_system": {
            "pv_capacity_kwp_dc": CI_ANNUAL_FINANCIAL_DEMO_PV_KWP,
            "pv_annual_specific_yield_kwh_per_kw": (
                CI_ANNUAL_FINANCIAL_DEMO_PV_YIELD_KWH_PER_KWP
            ),
            "pv_derating_factor": CI_ANNUAL_FINANCIAL_DEMO_PV_DERATING,
            "inverter_unit_count": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNITS,
            "inverter_unit_capacity_kw_ac": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_UNIT_KW,
            "inverter_capacity_kw_ac": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW,
            "battery_power_assumption_kw": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW,
            "battery_round_trip_efficiency": (
                CI_ANNUAL_FINANCIAL_DEMO_BATTERY_ROUND_TRIP_EFFICIENCY
            ),
            "minimum_soc_fraction": CI_ANNUAL_FINANCIAL_DEMO_MIN_SOC,
            "maximum_soc_fraction": CI_ANNUAL_FINANCIAL_DEMO_MAX_SOC,
            "export_limit_kw": 0.0,
            "export_rate_aud_per_kwh": 0.0,
        },
        "evidence_basis": {
            "retailer": str(bill.get("retailer", "Uploaded bill")),
            "billing_period_start": str(bill["billing_period_start"]),
            "billing_period_end": str(bill["billing_period_end"]),
            "billing_days": billing_days,
            "invoice_consumption_kwh": round(consumption_kwh, 2),
            "invoice_subtotal_ex_gst_aud": round(subtotal_aud, 2),
            "annualised_consumption_kwh": round(annualised_bill_consumption, 2),
            "annualised_baseline_cost_aud": round(annualised_bill_cost, 2),
            "measured_energy_year": primary_year,
        },
        "value_cases": {
            "bill_blended": {
                "label": "Bill-blended demo",
                "rate_aud_per_kwh": round(bill_blended_rate, 6),
                "included_bill_components": "All ex-GST invoice charges expressed as one equivalent rate",
                "formal_tariff_result": False,
            },
            "conservative_energy_only": {
                "label": "Energy-only sensitivity",
                "rate_aud_per_kwh": round(conservative_rate, 6),
                "included_bill_components": "Energy and environmental charges only",
                "formal_tariff_result": False,
            },
        },
        "tariff_inputs": {
            "status": "awaiting_approved_window_mapping",
            "rates_applied_to_finance": False,
            "demand_savings_applied": False,
            "demand_savings_realisation_fraction": (
                CI_ANNUAL_FINANCIAL_DEMO_DEMAND_REALISATION
            ),
            "retail_peak_c_per_kwh": 8.497,
            "retail_off_peak_c_per_kwh": 6.9579,
            "mlf": 1.0049,
            "dlf": 1.0606,
            "network_peak_c_per_kwh": 4.14,
            "network_off_peak_c_per_kwh": 3.24,
            "rolling_demand_aud_per_kva_month": 11.94,
            "incentive_demand_aud_per_kva_month": 10.2,
            "boundary": (
                "Rates are recorded for the demo but not monetised until peak/off-peak "
                "and demand windows, kVA treatment and minimum-demand rules are approved."
            ),
        },
        "assumptions": {
            "currency": "AUD",
            "tax_basis": "supplied_total_assumed_ex_gst_for_demo",
            "price_source": "user_supplied_total_solution_prices",
            "discount_rate": CI_ANNUAL_FINANCIAL_DEMO_DISCOUNT_RATE,
            "annual_value_degradation_rate": CI_ANNUAL_FINANCIAL_DEMO_VALUE_DEGRADATION_RATE,
            "annual_value_escalation_rate": CI_ANNUAL_FINANCIAL_DEMO_VALUE_ESCALATION_RATE,
            "analysis_term_years": CI_ANNUAL_FINANCIAL_DEMO_TERM_YEARS,
            "solar_om_fraction_of_component_capex": (
                CI_ANNUAL_FINANCIAL_DEMO_SOLAR_OM_RATE
            ),
            "battery_om_fraction_of_component_capex": (
                CI_ANNUAL_FINANCIAL_DEMO_BATTERY_OM_RATE
            ),
            "solar_unit_cost_aud_per_kw": (
                CI_ANNUAL_FINANCIAL_DEMO_SOLAR_UNIT_COST_AUD_PER_KW
            ),
            "battery_unit_cost_aud_per_kwh": (
                CI_ANNUAL_FINANCIAL_DEMO_BATTERY_UNIT_COST_AUD_PER_KWH
            ),
            "battery_inverter_total_aud": (
                CI_ANNUAL_FINANCIAL_DEMO_BATTERY_INVERTER_TOTAL_AUD
            ),
            "emissions_factor_kg_co2e_per_kwh": (
                CI_ANNUAL_FINANCIAL_DEMO_EMISSIONS_KG_PER_KWH
            ),
            "replacement_events_aud": [],
        },
        "financial_review_order": {
            "algorithm_id": CI_ANNUAL_FINANCIAL_DEMO_ORDER_ID,
            "basis": (
                "Highest NPV under the invoice-derived bill-blended demo case, then "
                "shorter simple payback and lower supplied total price. Demo review "
                "order only; it is not a recommendation."
            ),
            "leader_scenario_id": leader["scenario_id"],
            "recommendation_permitted": False,
        },
        "commercial_readout": _commercial_readout(ordered),
        "baseline_case": {
            "label": "No system",
            "annualised_cost_aud": round(annualised_bill_cost, 2),
            "annualised_grid_import_kwh": round(
                float(solar_only_annual["site_import_before_kwh"]), 3
            ),
        },
        "solar_only_case": solar_only_case,
        "solutions": ordered,
        "currency_values_permitted": True,
        "customer_facing_permission": False,
        "recommendation_permitted": False,
        "disclaimer": (
            "Demo only. Dollar values are invoice-derived illustrations, not an "
            "approved tariff simulation or customer recommendation. The bill-blended "
            "case treats all ex-GST invoice charges as an equivalent $/kWh rate and "
            "can overstate avoidable value because demand, network and fixed charges "
            "may not reduce with energy. The energy-only sensitivity excludes those "
            "unverified savings. O&M and energy escalation are included using the "
            "displayed demo assumptions; demand savings and export revenue remain zero. "
            "Confirm GST basis, tariff windows, connection limits, warranties, actual "
            "degradation and replacement costs before commercial use."
        ),
    }


def _demo_scenario(scenario_id: str, battery_kwh: float) -> dict[str, object]:
    battery_power = (
        0.0
        if battery_kwh == 0
        else CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW
    )
    return {
        "scenario_id": scenario_id,
        "label": (
            "141.7 kWp PV only"
            if battery_kwh == 0
            else f"141.7 kWp PV + {int(battery_kwh)} kWh battery"
        ),
        "battery_system_id": (
            "demo-battery-none"
            if battery_kwh == 0
            else f"demo-battery-{int(battery_kwh)}"
        ),
        "battery_technology_id": "generic_li_ion_ac",
        "control_profile_id": "demand_peak_shaving",
        "pv_system_id": "chefq-demo-pv-141-7",
        "pv_profile_id": "generic_normalized_solar_shape_v1",
        "pv_capacity_kwp_dc": CI_ANNUAL_FINANCIAL_DEMO_PV_KWP,
        "pv_inverter_capacity_kw_ac": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW,
        "shared_ac_headroom_kw": CI_ANNUAL_FINANCIAL_DEMO_INVERTER_KW,
        "reactive_support_enabled": False,
        "reactive_support_max_kvar": 0.0,
        "shared_inverter_apparent_power_limit_kva": None,
        "reactive_capability_curve": "circular_pq",
        "reactive_capability_provenance": "analyst_assumption",
        "reactive_overcompensation_permitted": False,
        "pv_annual_specific_yield_kwh_per_kw": (
            CI_ANNUAL_FINANCIAL_DEMO_PV_YIELD_KWH_PER_KWP
        ),
        "pv_derating_factor": CI_ANNUAL_FINANCIAL_DEMO_PV_DERATING,
        "nominal_capacity_kwh": battery_kwh,
        "max_charge_kw": battery_power,
        "max_discharge_kw": battery_power,
        "charge_efficiency": math.sqrt(
            CI_ANNUAL_FINANCIAL_DEMO_BATTERY_ROUND_TRIP_EFFICIENCY
        ),
        "discharge_efficiency": math.sqrt(
            CI_ANNUAL_FINANCIAL_DEMO_BATTERY_ROUND_TRIP_EFFICIENCY
        ),
        "min_soc_fraction": CI_ANNUAL_FINANCIAL_DEMO_MIN_SOC,
        "max_soc_fraction": CI_ANNUAL_FINANCIAL_DEMO_MAX_SOC,
        "initial_soc_fraction": CI_ANNUAL_FINANCIAL_DEMO_MAX_SOC,
        "allow_grid_charging": False,
    }


def _validated_bill(inspection: dict[str, Any]) -> dict[str, Any]:
    bill = inspection.get("bill")
    if not isinstance(bill, dict):
        raise CiProjectError(
            "ci_annual_financial_demo_bill_required",
            "A verified electricity bill is required for the finance demo.",
        )
    required = ("billing_period_start", "billing_period_end")
    if any(not isinstance(bill.get(key), str) or not bill[key] for key in required):
        raise CiProjectError(
            "ci_annual_financial_demo_bill_required",
            "A verified electricity bill is required for the finance demo.",
        )
    return bill


def _billing_days(bill: dict[str, Any]) -> int:
    value = bill.get("billing_days")
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    try:
        start = date.fromisoformat(str(bill["billing_period_start"]))
        end = date.fromisoformat(str(bill["billing_period_end"]))
    except (KeyError, ValueError) as exc:
        raise CiProjectError(
            "ci_annual_financial_demo_bill_period_invalid",
            "The bill period is unavailable for the finance demo.",
        ) from exc
    days = (end - start).days + 1
    if days <= 0:
        raise CiProjectError(
            "ci_annual_financial_demo_bill_period_invalid",
            "The bill period is unavailable for the finance demo.",
        )
    return days


def _primary_year_energy(
    scenario: dict[str, Any], *, primary_year: int
) -> dict[str, Any]:
    yearly = scenario.get("yearly_energy")
    if not isinstance(yearly, list):
        raise CiProjectError(
            "ci_annual_financial_demo_physical_result_invalid",
            "The measured annual result is unavailable for the finance demo.",
        )
    selected = next(
        (item for item in yearly if isinstance(item, dict) and item.get("year") == primary_year),
        None,
    )
    if selected is None:
        raise CiProjectError(
            "ci_annual_financial_demo_physical_result_invalid",
            "The measured annual result is unavailable for the finance demo.",
        )
    return selected


def _metrics(
    *,
    capex_aud: float,
    first_year_value_aud: float,
    annual_om_cost_aud: float,
) -> dict[str, object]:
    return calculate_metrics(
        {
            "upfront_cost_aud": capex_aud,
            "first_year_net_value_aud": first_year_value_aud,
            "annual_om_cost_aud": annual_om_cost_aud,
            "replacement_events_aud": [],
            "discount_rate": CI_ANNUAL_FINANCIAL_DEMO_DISCOUNT_RATE,
            "annual_value_degradation_rate": CI_ANNUAL_FINANCIAL_DEMO_VALUE_DEGRADATION_RATE,
            "annual_value_escalation_rate": CI_ANNUAL_FINANCIAL_DEMO_VALUE_ESCALATION_RATE,
            "analysis_term_years": CI_ANNUAL_FINANCIAL_DEMO_TERM_YEARS,
        }
    )


def _annual_om_cost(*, battery_kwh: float) -> float:
    solar_component = (
        CI_ANNUAL_FINANCIAL_DEMO_PV_KWP
        * CI_ANNUAL_FINANCIAL_DEMO_SOLAR_UNIT_COST_AUD_PER_KW
    )
    battery_component = (
        battery_kwh
        * CI_ANNUAL_FINANCIAL_DEMO_BATTERY_UNIT_COST_AUD_PER_KWH
    )
    return (
        solar_component * CI_ANNUAL_FINANCIAL_DEMO_SOLAR_OM_RATE
        + battery_component * CI_ANNUAL_FINANCIAL_DEMO_BATTERY_OM_RATE
    )


def _capex_breakdown(
    *, capex_aud: float, battery_kwh: float
) -> dict[str, float]:
    solar_component = (
        CI_ANNUAL_FINANCIAL_DEMO_PV_KWP
        * CI_ANNUAL_FINANCIAL_DEMO_SOLAR_UNIT_COST_AUD_PER_KW
    )
    battery_component = (
        battery_kwh
        * CI_ANNUAL_FINANCIAL_DEMO_BATTERY_UNIT_COST_AUD_PER_KWH
    )
    inverter_component = CI_ANNUAL_FINANCIAL_DEMO_BATTERY_INVERTER_TOTAL_AUD
    balance = capex_aud - solar_component - battery_component - inverter_component
    if balance < 0:
        raise CiProjectError(
            "ci_annual_financial_demo_capex_breakdown_invalid",
            "The supplied total price is lower than the displayed component assumptions.",
        )
    return {
        "solar_component_aud": round(solar_component, 2),
        "battery_component_aud": round(battery_component, 2),
        "battery_inverter_aud": round(inverter_component, 2),
        "balance_of_system_and_delivery_aud": round(balance, 2),
        "total_aud": round(capex_aud, 2),
    }


def _physical_outcome(
    annual: dict[str, Any], *, primary_year: int
) -> dict[str, object]:
    performance = annual.get("performance")
    if not isinstance(performance, dict):
        raise CiProjectError(
            "ci_annual_financial_demo_physical_result_invalid",
            "The measured physical result is unavailable for the finance demo.",
        )
    reduction_kwh = _non_negative_number(
        annual.get("grid_import_reduction_kwh"),
        "The measured grid-import reduction is unavailable for the finance demo.",
    )
    return {
        "energy_year": primary_year,
        "grid_import_reduction_kwh": round(reduction_kwh, 3),
        "grid_import_reduction_percent": _rounded_number(
            annual.get("grid_import_reduction_percent")
        ),
        "pv_generation_kwh": _rounded_number(
            annual.get("pv_generation_kwh"), digits=3
        ),
        "pv_self_consumption_percent": _rounded_number(
            annual.get("pv_self_consumption_percent")
        ),
        "battery_discharge_output_kwh": _rounded_number(
            annual.get("battery_discharge_output_kwh"), digits=3
        ),
        "battery_equivalent_full_cycles": _rounded_number(
            annual.get("battery_equivalent_full_cycles"), digits=3
        ),
        "baseline_peak_kw": _rounded_number(
            performance.get("baseline_peak_kw"), digits=3
        ),
        "post_system_peak_kw": _rounded_number(
            performance.get("grid_import_peak_kw"), digits=3
        ),
        "peak_reduction_kw": _rounded_number(
            performance.get("grid_import_peak_reduction_kw"), digits=3
        ),
        "peak_reduction_percent": _rounded_number(
            performance.get("grid_import_peak_reduction_percent")
        ),
        "avoided_emissions_t_co2e": round(
            reduction_kwh
            * CI_ANNUAL_FINANCIAL_DEMO_EMISSIONS_KG_PER_KWH
            / 1000,
            3,
        ),
    }


def _commercial_readout(ordered: list[dict[str, Any]]) -> dict[str, str]:
    leader = ordered[0]
    runner_up = ordered[1]
    npv_gap = float(leader["metrics"]["net_present_value_aud"]) - float(
        runner_up["metrics"]["net_present_value_aud"]
    )
    return {
        "headline": (
            f"The {int(float(leader['battery_capacity_kwh']))} kWh offer leads this "
            "invoice-derived demo on NPV."
        ),
        "tradeoff": (
            f"It is ahead of the next demo offer by ${npv_gap:,.0f} NPV because the "
            "three offers share the same PV and inverter capacity while the larger "
            "batteries add more CAPEX than measured energy savings."
        ),
        "decision_boundary": (
            "A verified demand-tariff dispatch may change this order if the larger "
            "battery earns additional peak-demand savings."
        ),
    }


def _positive_number(value: object, message: str) -> float:
    number = _finite_number(value, message)
    if number <= 0:
        raise CiProjectError("ci_annual_financial_demo_bill_invalid", message)
    return number


def _non_negative_number(value: object, message: str) -> float:
    number = _finite_number(value, message)
    if number < 0:
        raise CiProjectError("ci_annual_financial_demo_bill_invalid", message)
    return number


def _finite_number(value: object, message: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CiProjectError("ci_annual_financial_demo_bill_invalid", message) from exc
    if not math.isfinite(number):
        raise CiProjectError("ci_annual_financial_demo_bill_invalid", message)
    return number


def _rounded_number(value: object, *, digits: int = 6) -> float:
    number = _finite_number(
        value, "The measured physical result is unavailable for the finance demo."
    )
    return round(number, digits)


def _payback_sort_value(value: object) -> float:
    return math.inf if value is None else float(value)

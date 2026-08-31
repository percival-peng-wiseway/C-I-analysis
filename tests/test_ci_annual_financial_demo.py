from __future__ import annotations

from typing import Any

import pytest

from solar_battery.ci_annual_financial_demo import (
    analyze_ci_annual_financial_demo,
)
from solar_battery.ci_projects import CiProjectError


def test_chef_q_demo_uses_supplied_prices_and_invoice_derived_sensitivities(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "solar_battery.ci_annual_financial_demo.analyze_ci_design_feasibility",
        _physical_result,
    )

    result = analyze_ci_annual_financial_demo(
        upload_bytes=b"synthetic interval evidence",
        inspection_result={"bill": _bill()},
    )

    assert result["contract_version"] == "ci_annual_financial_demo_v2"
    assert result["demo_only"] is True
    assert result["common_system"]["pv_capacity_kwp_dc"] == 141.7
    assert result["common_system"]["pv_annual_specific_yield_kwh_per_kw"] == 1450.0
    assert result["common_system"]["battery_round_trip_efficiency"] == 0.9
    assert result["common_system"]["minimum_soc_fraction"] == 0.1
    assert result["common_system"]["maximum_soc_fraction"] == 0.9
    assert result["common_system"]["export_limit_kw"] == 0.0
    assert result["value_cases"]["bill_blended"]["rate_aud_per_kwh"] == 0.2
    assert result["value_cases"]["conservative_energy_only"]["rate_aud_per_kwh"] == 0.1
    assert result["evidence_basis"]["annualised_baseline_cost_aud"] == 235483.87
    assert result["baseline_case"]["annualised_grid_import_kwh"] == 1100000.0
    assert result["solar_only_case"]["pricing_status"] == "installed_price_required"
    assert result["solar_only_case"]["financial_metrics_permitted"] is False
    assert result["tariff_inputs"]["rates_applied_to_finance"] is False
    assert result["tariff_inputs"]["demand_savings_applied"] is False
    assert {item["status"] for item in result["analysis_modules"]} == {
        "ready",
        "demo_ready",
        "input_required",
    }

    solutions = result["solutions"]
    assert [item["battery_capacity_kwh"] for item in solutions] == [250.0, 300.0, 389.0]
    assert [item["upfront_cost_aud"] for item in solutions] == [249800.0, 268800.0, 298600.0]
    assert [item["financial_review_rank"] for item in solutions] == [1, 2, 3]
    assert solutions[0]["first_year_value_aud"] == 40000.0
    assert solutions[0]["conservative_sensitivity"]["first_year_value_aud"] == 20000.0
    assert solutions[0]["annual_om_cost_aud"] == 2299.76
    assert solutions[0]["capex_breakdown"] == {
        "solar_component_aud": 75101.0,
        "battery_component_aud": 103250.0,
        "battery_inverter_aud": 20000.0,
        "balance_of_system_and_delivery_aud": 51449.0,
        "total_aud": 249800.0,
    }
    assert solutions[0]["physical_outcome"]["avoided_emissions_t_co2e"] == 158.0
    assert solutions[0]["metrics"]["net_present_value_aud"] > solutions[1]["metrics"]["net_present_value_aud"]
    assert len(solutions[0]["metrics"]["annual_cashflows_aud"]) == 15
    assert result["financial_review_order"]["recommendation_permitted"] is False
    assert result["customer_facing_permission"] is False
    assert result["recommendation_permitted"] is False


def test_chef_q_demo_requires_verified_charge_categories(monkeypatch) -> None:
    monkeypatch.setattr(
        "solar_battery.ci_annual_financial_demo.analyze_ci_design_feasibility",
        _physical_result,
    )
    bill = _bill()
    del bill["charge_categories_ex_gst_aud"]

    with pytest.raises(CiProjectError) as exc:
        analyze_ci_annual_financial_demo(
            upload_bytes=b"synthetic interval evidence",
            inspection_result={"bill": bill},
        )

    assert exc.value.code == "ci_annual_financial_demo_bill_categories_required"


def _bill() -> dict[str, object]:
    return {
        "retailer": "Origin Energy",
        "billing_period_start": "2026-03-01",
        "billing_period_end": "2026-03-31",
        "billing_days": 31,
        "consumption_kwh": 100000.0,
        "subtotal_ex_gst_aud": 20000.0,
        "charge_categories_ex_gst_aud": {
            "energy_charges": 8000.0,
            "environmental_charges": 2000.0,
        },
    }


def _physical_result(_upload: bytes, *, scenarios: list[dict[str, Any]]) -> dict[str, object]:
    reductions = {
        "chefq-demo-solar-only": 190000.0,
        "chefq-demo-battery-250": 200000.0,
        "chefq-demo-battery-300": 200500.0,
        "chefq-demo-battery-389": 201000.0,
    }
    return {
        "coverage": {"primary_year": 2025},
        "scenarios": [
            {
                "scenario_id": scenario["scenario_id"],
                "yearly_energy": [
                    {
                        "year": 2025,
                        "grid_import_reduction_kwh": reductions[scenario["scenario_id"]],
                        "grid_import_reduction_percent": 18.0,
                        "site_import_before_kwh": 1100000.0,
                        "pv_generation_kwh": 190000.0,
                        "pv_self_consumption_percent": 99.0,
                        "battery_discharge_output_kwh": (
                            0.0 if scenario["scenario_id"] == "chefq-demo-solar-only" else 10000.0
                        ),
                        "battery_equivalent_full_cycles": (
                            0.0 if scenario["scenario_id"] == "chefq-demo-solar-only" else 30.0
                        ),
                        "performance": {
                            "baseline_peak_kw": 300.0,
                            "grid_import_peak_kw": 250.0,
                            "grid_import_peak_reduction_kw": 50.0,
                            "grid_import_peak_reduction_percent": 16.666667,
                        },
                    }
                ],
            }
            for scenario in scenarios
        ],
    }

from decimal import Decimal
from pathlib import Path

import pytest

from solar_battery.ci_handbook_guide import calculation_guide
from solar_battery.ci_device_profile import suggested_ci_device_profile
from solar_battery.ci_annual_financial_comparison import _profile_capex_breakdown
from solar_battery.ci_financial_solutions import calculate_metrics
from solar_battery.ci_solution_generator import _effective_derating
from solar_battery.ci_stc_calculator import CiStcCalculatorInput, calculate_stc_estimate
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path
from tests.test_ci_solution_generator import _device_profile, _request
from solar_battery.ci_solution_generator import generate_ci_solutions


def test_guide_available_without_a_project_and_does_not_create_one(tmp_path):
    with create_test_client(sqlite_url_for_path(tmp_path / "guide.sqlite3")) as client:
        before = client.get("/api/commercial-industrial/projects").json()
        response = client.get("/api/commercial-industrial/calculation-guide")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        guide = response.json()
        assert guide["contract_version"] == "ci_calculation_guide_v1"
        assert len(guide["chapters"]) == 5
        assert "Synthetic teaching example only" in guide["disclosure"]
        assert client.get("/api/commercial-industrial/projects").json() == before
        assert client.get("/api/commercial-industrial/calculation-guide").json() == guide


def test_guide_does_not_share_mutable_state_and_references_real_source_files():
    guide = calculation_guide()
    guide["chapters"][0]["title"] = "changed"
    assert calculation_guide()["chapters"][0]["title"] != "changed"
    root = Path(__file__).resolve().parents[1]
    for chapter in calculation_guide()["chapters"]:
        for step in chapter["steps"]:
            for reference in step["source_reference"].split("; "):
                assert (root / reference.split("::")[0]).is_file(), reference
            assert all(isinstance(v, str) and v for v in step.values())


def test_worked_example_matches_production_python_calculators():
    guide = calculation_guide()
    results = "\n".join(s["result"] for c in guide["chapters"] for s in c["steps"])
    site = dict(system_availability_percent=100, shading_loss_percent=0,
                soiling_loss_percent=0, temperature_loss_percent=0,
                wiring_mismatch_loss_percent=0, other_system_loss_percent=10)
    assert _effective_derating(site) == pytest.approx(0.9)
    assert 200 * 1500 * _effective_derating(site) == 270000
    profile = suggested_ci_device_profile()
    catalog = profile["equipment_catalog"]
    selection = {"pv_product_id": catalog["pv_products"][0]["product_id"],
                 "battery_product_id": catalog["battery_products"][0]["product_id"],
                 "inverter_product_id": catalog["inverter_products"][0]["product_id"]}
    breakdown = _profile_capex_breakdown(
        {"authored_inputs": {"pv_capacity_kwp_dc": 200, "nominal_capacity_kwh": 210,
                             "pv_inverter_capacity_kw_ac": 125, "dispatch_topology": "shared_hybrid_dc"}},
        profile=profile, equipment_selection=selection)
    assert breakdown == {"pv_aud": 106000, "battery_aud": 77578, "inverter_aud": 10000, "installation_misc_aud": 70000}
    capex = sum(breakdown.values())
    assert capex == 263578
    metrics = calculate_metrics(dict(upfront_cost_aud=capex, first_year_net_value_aud=50000,
        annual_om_cost_aud=capex * 0.01, discount_rate=0.08, annual_value_degradation_rate=0,
        annual_value_escalation_rate=0, analysis_term_years=10, replacement_events_aud=[]))
    assert metrics["net_present_value_aud"] == 54239.77
    assert metrics["payback_period_years"] == 5.565
    assert metrics["internal_rate_of_return"] == 0.123733
    assert metrics["annual_cashflows_aud"][0] == 47364.22
    assert f"${metrics['net_present_value_aud']:,.2f}" in results
    assert f"${capex:,.0f}" in results
    worksheet = calculate_stc_estimate(CiStcCalculatorInput(solar_installation_year=2025,
        solar_zone=4, pv_capacity_kwp=200, solar_certificate_price=39,
        battery_stc_count=174, battery_certificate_price=39))
    assert worksheet["solar_rebate_aud"] == 55458
    assert worksheet["battery_rebate_aud"] == 6786
    assert worksheet["total_rebate_aud"] == 62244
    assert worksheet["applied_to_finance"] is False
    assert Decimal(100) + Decimal(20) * Decimal("0.25") * Decimal("0.95") == Decimal("104.75")


def test_example_solution_sizing_and_efficiency_match_the_generator():
    profile = _device_profile()
    profile["solution_profiles"]["solar_profiles"][0]["default_dc_ac_ratio"] = 1.6
    battery = profile["solution_profiles"]["battery_profiles"][0]
    battery.update(nominal_capacity_kwh_per_unit=210, continuous_power_kw_per_unit=100,
                   round_trip_efficiency_percent=90.25)
    request = _request(headroom=350)
    request["pv_range"] = dict(minimum_kwp_dc=180, maximum_kwp_dc=220, step_kwp_dc=20)
    request["battery_range"] = dict(minimum_kwh=126, maximum_kwh=210, step_kwh=42)
    request["connection_options"]["battery_efficiency_basis"] = "whole_system_ac"
    request["site_factors"].update(system_availability_percent=100, shading_loss_percent=0,
        soiling_loss_percent=0, temperature_loss_percent=0, wiring_mismatch_loss_percent=0,
        other_system_loss_percent=10)
    generated = generate_ci_solutions(request, device_profile=profile, device_profile_sha256=None)
    assert len(generated["candidates"]) == 9
    selected = next(c for c in generated["candidates"] if c["pv_capacity_kwp_dc"] == 200 and c["nominal_capacity_kwh"] == 210)
    assert selected["pv_inverter_capacity_kw_ac"] == 125
    assert selected["max_discharge_kw"] == 100
    assert selected["charge_efficiency"] == pytest.approx(0.95)
    assert selected["min_soc_fraction"] == pytest.approx(0.1)
    assert selected["max_soc_fraction"] == selected["initial_soc_fraction"] == 1
    assert selected["pv_derating_factor"] == pytest.approx(0.9)

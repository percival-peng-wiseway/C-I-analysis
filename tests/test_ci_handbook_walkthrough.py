from copy import deepcopy

import pytest

from solar_battery.ci_handbook_walkthrough import solution_walkthroughs
from solar_battery.ci_financial_solutions import calculate_metrics


def fixture():
    metrics = calculate_metrics(dict(upfront_cost_aud=263578, first_year_net_value_aud=50000,
        annual_om_cost_aud=2635.78, discount_rate=0.08, annual_value_degradation_rate=0,
        annual_value_escalation_rate=0, analysis_term_years=10, replacement_events_aud=[]))
    def row(sid, **values):
        return dict(result_id=sid, label=sid, values=values)
    def module(mid, set_id, rows, parameters=None):
        return dict(module_id=mid, status="ready", result_sets=[dict(result_set_id=set_id, rows=rows)], parameters=parameters or [])
    return [
        module("solution_generator", "solution.solutions", [row("a", pv_capacity=200, specific_yield=1500,
            derating=.9, battery_capacity=210, soc_max=1, soc_min=.1, battery_power=100,
            charge_efficiency=.95, discharge_efficiency=.95, pv_capex=106000, battery_capex=77578,
            inverter_capex=10000, installation_misc=70000, gross_capex=263578),
            row("b", pv_capacity=100, specific_yield=1000, derating=.8, battery_capacity=0,
                battery_power=0, soc_max=1, soc_min=0, discharge_efficiency=.95)]),
        module("scenario_analysis", "scenario.tariff_replay", [row("a", baseline_cost=200000, annual_cost=150000, first_year_value=50000)]),
        module("finance_analysis", "finance.solutions", [row("a", net_capex=263578, gross_upfront=263578,
            first_year_value=50000, annual_om=2635.78, npv=metrics["net_present_value_aud"],
            annual_cashflows=metrics["annual_cashflows_aud"])], [
            dict(parameter_id="finance.assumption.discount_rate", value=.08),
            dict(parameter_id="finance.assumption.annual_om_fraction_of_capex", value=.01)])]


def test_walkthrough_uses_same_solution_numeric_operands_without_mutation():
    modules = fixture()
    before = deepcopy(modules)
    walkthroughs = solution_walkthroughs(modules, price_ready=True, replay_ready=True)
    a, b = [{s["calculation_id"]: s for s in w["steps"]} for w in walkthroughs]
    def result(key):
        return a[key]["current_example"]["result"]
    assert result("pv.yield") == 1350
    assert result("pv.annual") == 270000
    assert result("battery.usable") == 189
    assert result("battery.duration") == pytest.approx(1.7955)
    assert result("battery.rte") == pytest.approx(90.25)
    assert result("investment") == 263578
    assert result("bill.saving") == 50000
    assert result("finance.year1") == 47364.22
    assert result("finance.npv") == pytest.approx(54239.77, abs=.01)
    assert "^10" in a["finance.npv"]["current_example"]["substitution"]
    assert b["pv.annual"]["current_example"]["result"] == 80000
    assert b["battery.duration"]["current_example"] is None
    assert b["bill.saving"]["current_example"] is None
    assert b["finance.npv"]["current_example"] is None
    assert modules == before


@pytest.mark.parametrize("price_ready,replay_ready,finance_status", [(False, False, "ready"), (True, True, "stale"), (True, False, "ready")])
def test_withholds_stale_dollars_even_when_physical_module_is_ready(price_ready, replay_ready, finance_status):
    modules = fixture()
    modules[-1]["status"] = finance_status
    steps = {s["calculation_id"]: s for s in solution_walkthroughs(modules, price_ready=price_ready, replay_ready=replay_ready)[0]["steps"]}
    assert steps["finance.npv"]["current_example"] is None
    if not price_ready:
        assert steps["investment"]["current_example"] is None
    if not replay_ready:
        assert steps["bill.saving"]["current_example"] is None
    assert steps["pv.annual"]["current_example"]["result"] == 270000


def test_missing_nonfinite_and_zero_values_are_not_fabricated():
    modules = fixture()
    modules[0]["result_sets"][0]["rows"][0]["values"]["specific_yield"] = float("nan")
    steps = {s["calculation_id"]: s for s in solution_walkthroughs(modules, price_ready=True, replay_ready=True)[0]["steps"]}
    assert steps["pv.annual"]["current_example"] is None

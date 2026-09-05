from dataclasses import replace
import math

import pytest

from solar_battery.ci_peak_shaving_optimizer import (
    CiDemandCharge, CiOptimizerConfig, CiReactiveSupportSpec,
    CiOptimizerStatus, optimize_ci_peak_shaving,
)
from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_scenario_analysis import validate_ci_design_candidates, CiScenarioAnalysisError
from solar_battery.ci_solution_generator import generate_ci_solutions, generate_ci_custom_solution
from tests.test_ci_peak_shaving_optimizer import _battery, _intervals, _problem, _calendar_year_problem
from tests.test_ci_solution_generator import _device_profile, _request


def test_separate_ac_pv_charging_crosses_pv_inverter_once() -> None:
    legacy = _problem(
        intervals=_intervals((0.0, 10.0), pv=(10.0, 0.0), rates=(1.0, 1.0)),
        battery=_battery(min_soc_fraction=0.0, initial_soc_fraction=0.0, terminal_soc_fraction=0.0,
                         max_charge_kw=10.0, max_discharge_kw=10.0),
        demand_charges=(), shared_ac_headroom_kw=20.0,
        config=CiOptimizerConfig(allow_grid_charging=False),
    )
    separate = replace(legacy, dispatch_topology="separate_ac", pv_inverter_capacity_kw_ac=2.0)
    result = optimize_ci_peak_shaving(separate)
    assert result.status in {CiOptimizerStatus.OPTIMAL_LP_EXACT, CiOptimizerStatus.OPTIMAL_MILP}
    charge = result.intervals[0].pv_charge_kw
    # The AUD 0.01 secondary throughput tie-break may leave a few Wh unused.
    assert 1.98 < charge <= 2.0
    assert result.intervals[0].soc_end_kwh == pytest.approx(charge * .9, abs=1e-6)
    assert result.intervals[1].discharge_kw == pytest.approx(charge * .81, abs=1e-6)
    assert result.intervals[-1].soc_end_kwh == pytest.approx(0.0)
    assert optimize_ci_peak_shaving(legacy).intervals[0].pv_charge_kw > 9.9


def test_separate_ac_rolling_windows_keep_separate_pv_limit() -> None:
    from solar_battery.ci_peak_shaving_optimizer import execute_ci_peak_shaving_rolling
    base = _calendar_year_problem()
    problem = replace(base, dispatch_topology="separate_ac", pv_inverter_capacity_kw_ac=1.0,
                      intervals=tuple(replace(row, pv_kw=10.0 if 10 <= row.timestamp.hour < 15 else 0.0) for row in base.intervals))
    result = execute_ci_peak_shaving_rolling(problem)
    assert len(result.intervals) == 8760
    assert len(result.windows) == 365
    assert all(row.pv_to_ac_kw + row.pv_charge_kw <= 1.0 + 1e-6 for row in result.intervals)


def test_separate_ac_reactive_port_excludes_independent_pv_inverter() -> None:
    problem = _problem(
        intervals=_intervals((10.0,), pv=(8.0,), kvar=(6.0,)),
        battery=_battery(ac_round_trip_efficiency=1.0),
        demand_charges=(CiDemandCharge("kva", 100.0, (0,), basis="kva"),),
        shared_ac_headroom_kw=20.0,
        reactive_support=CiReactiveSupportSpec(enabled=True, max_reactive_support_kvar=4.0,
                                              inverter_apparent_power_limit_kva=5.0),
    )
    result = optimize_ci_peak_shaving(replace(problem, dispatch_topology="separate_ac", pv_inverter_capacity_kw_ac=8.0))
    row = result.intervals[0]
    assert row.pv_to_ac_kw == pytest.approx(8.0)
    assert row.inverter_reactive_support_kvar == pytest.approx(4.0)
    assert row.shared_inverter_apparent_power_kva == pytest.approx(4.0)
    assert row.exact_grid_import_kva == pytest.approx(8 ** 0.5)


def test_separate_ac_pv_charging_consumes_battery_reactive_headroom() -> None:
    problem = _problem(
        intervals=_intervals((0.0, 10.0), pv=(10.0, 0.0), kvar=(6.0, 0.0), rates=(1.0, 1.0)),
        battery=_battery(min_soc_fraction=0.0, initial_soc_fraction=0.0, terminal_soc_fraction=0.0,
                         max_charge_kw=10.0, max_discharge_kw=10.0),
        demand_charges=(CiDemandCharge("kva", 100.0, (0,), basis="kva"),),
        shared_ac_headroom_kw=20.0,
        reactive_support=CiReactiveSupportSpec(enabled=True, max_reactive_support_kvar=4.0,
                                              inverter_apparent_power_limit_kva=5.0),
        config=CiOptimizerConfig(allow_grid_charging=False),
    )
    result = optimize_ci_peak_shaving(replace(problem, dispatch_topology="separate_ac", pv_inverter_capacity_kw_ac=10.0))
    assert result.status in {CiOptimizerStatus.OPTIMAL_LP_EXACT, CiOptimizerStatus.OPTIMAL_MILP}
    charging = result.intervals[0]
    assert charging.inverter_reactive_support_kvar == pytest.approx(4.0)
    # sqrt(5^2 - 4^2) = 3 kW; the conservative inner polygon is slightly lower.
    # A missing PV-charge term in the battery AC port would wrongly allow 10.
    assert 2.9 < charging.pv_charge_kw <= 3.0
    assert math.hypot(charging.pv_charge_kw, charging.inverter_reactive_support_kvar) <= 5.0
    assert charging.shared_inverter_apparent_power_kva == pytest.approx(
        math.hypot(charging.pv_charge_kw, charging.inverter_reactive_support_kvar), abs=1e-6,
    )
    assert result.intervals[1].discharge_kw == pytest.approx(charging.pv_charge_kw * .81, abs=1e-6)
    assert result.intervals[-1].soc_end_kwh == pytest.approx(0.0)


@pytest.mark.parametrize("changes", [
    {"dispatch_topology": "other"},
    {"dispatch_topology": "separate_ac"},
    {"dispatch_topology": "separate_ac", "pv_inverter_capacity_kw_ac": -1},
    {"pv_inverter_capacity_kw_ac": 10},
])
def test_optimizer_rejects_ambiguous_topology(changes) -> None:
    problem = _problem(intervals=_intervals((1.0,)), battery=_battery(), demand_charges=())
    with pytest.raises(ValueError):
        replace(problem, **changes)


@pytest.mark.parametrize("basis,expected_rte", [("pack_plus_conversion", .9 * .98 ** 2), ("whole_system_ac", .9)])
def test_generator_records_independent_topology_efficiency_and_pcs(basis, expected_rte) -> None:
    request = _request(maximum_pv=101.0)
    request["inverter_profile_id"] = "inverter-125"
    request["connection_options"].update(dispatch_topology="separate_ac", battery_efficiency_basis=basis)
    result = generate_ci_solutions(request, device_profile=_device_profile(), device_profile_sha256=None)
    assert len(result["candidates"]) == 6
    for row in result["candidates"]:
        assert row["dispatch_topology"] == "separate_ac"
        assert row["battery_efficiency_basis"] == basis
        assert row["charge_efficiency"] * row["discharge_efficiency"] == pytest.approx(expected_rte)
        assert row["pv_inverter_capacity_kw_ac"] == pytest.approx(row["pv_capacity_kwp_dc"] / 1.2)
        assert row["battery_inverter_capacity_kw_ac"] == (7.0 if row["nominal_capacity_kwh"] else 0.0)
        assert row["shared_ac_headroom_kw"] == 200.0
    assert result["design_context"]["technical_options"]["battery_efficiency_basis"] == basis
    custom = generate_ci_custom_solution({
        "contract_version": "ci_custom_design_candidate_request_v1", "label": "Synthetic custom",
        "pv_capacity_kwp_dc": 100.0, "battery_capacity_kwh": 14.0,
        "inverter_capacity_kw_ac": 10.0, "quoted_net_capex_aud_ex_gst": 1000.0,
    }, design_context=result["design_context"])["candidate"]
    assert custom["battery_inverter_capacity_kw_ac"] == 10.0
    assert custom["charge_efficiency"] ** 2 == pytest.approx(expected_rte)
    invalid = dict(custom, battery_inverter_capacity_kw_ac=1.0)
    with pytest.raises(CiScenarioAnalysisError):
        validate_ci_design_candidates([invalid])
    # The current optimiser intentionally supports symmetric one-way loss;
    # rejecting an asymmetric authored pair prevents silently replacing it by
    # sqrt(charge * discharge), which would change the charge path.
    with pytest.raises(CiScenarioAnalysisError):
        validate_ci_design_candidates([dict(custom, charge_efficiency=.7)])


@pytest.mark.parametrize("key,value", [("dispatch_topology", "dc"), ("battery_efficiency_basis", "guess")])
def test_generator_rejects_unknown_physical_basis(key, value) -> None:
    request = _request()
    request["connection_options"][key] = value
    with pytest.raises(CiProjectError):
        generate_ci_solutions(request, device_profile=_device_profile(), device_profile_sha256=None)

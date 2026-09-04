from dataclasses import replace
from datetime import datetime, timedelta, timezone
import math

import pytest
import highspy

import solar_battery.ci_peak_shaving_optimizer as optimizer_module
from solar_battery.ci_peak_shaving_optimizer import (
    CI_PEAK_SHAVING_OPTIMIZER_ID,
    CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
    CiBatterySpec,
    CiBillingPeriod,
    CiDemandCharge,
    CiDemandChargeResult,
    CiOptimizerConfig,
    CiOptimizerInterval,
    CiOptimizerProblem,
    CiOptimizerStatus,
    CiReactiveSupportSpec,
    execute_ci_peak_shaving_rolling,
    optimize_ci_peak_shaving,
)


def _intervals(
    loads: tuple[float, ...],
    *,
    pv: tuple[float, ...] | None = None,
    kvar: tuple[float, ...] | None = None,
    rates: tuple[float, ...] | None = None,
    start: datetime | None = None,
) -> tuple[CiOptimizerInterval, ...]:
    origin = start or datetime(2026, 1, 1, tzinfo=timezone.utc)
    pv_values = pv or (0.0,) * len(loads)
    kvar_values = kvar or (0.0,) * len(loads)
    rate_values = rates or (0.2,) * len(loads)
    return tuple(
        CiOptimizerInterval(
            timestamp=origin + timedelta(hours=index),
            duration_hours=1.0,
            load_kw=load,
            pv_kw=pv_values[index],
            reactive_kvar=kvar_values[index],
            import_rate_aud_per_kwh=rate_values[index],
            export_credit_aud_per_kwh=0.05,
        )
        for index, load in enumerate(loads)
    )


def _battery(**overrides) -> CiBatterySpec:
    values = {
        "nominal_capacity_kwh": 10.0,
        "min_soc_fraction": 0.1,
        "max_soc_fraction": 1.0,
        "max_charge_kw": 5.0,
        "max_discharge_kw": 5.0,
        "ac_round_trip_efficiency": 0.81,
    }
    values.update(overrides)
    return CiBatterySpec(**values)


def _problem(
    *,
    intervals: tuple[CiOptimizerInterval, ...],
    battery: CiBatterySpec,
    demand_charges: tuple[CiDemandCharge, ...],
    billing_periods: tuple[CiBillingPeriod, ...] | None = None,
    shared_ac_headroom_kw: float = 250.0,
    reactive_support: CiReactiveSupportSpec | None = None,
    config: CiOptimizerConfig | None = None,
) -> CiOptimizerProblem:
    return CiOptimizerProblem(
        intervals=intervals,
        battery=battery,
        demand_charges=demand_charges,
        billing_periods=billing_periods
        or (CiBillingPeriod("billing_period", tuple(range(len(intervals)))),),
        shared_ac_headroom_kw=shared_ac_headroom_kw,
        reactive_support=reactive_support or CiReactiveSupportSpec(),
        config=config or CiOptimizerConfig(),
    )


def test_battery_accepts_profile_authored_soc_bounds() -> None:
    five_percent_reserve = _battery(min_soc_fraction=0.05)
    reduced_upper_bound = _battery(
        max_soc_fraction=0.9,
        initial_soc_fraction=0.9,
        terminal_soc_fraction=0.9,
    )

    assert five_percent_reserve.min_soc_fraction == 0.05
    assert reduced_upper_bound.max_soc_fraction == 0.9


def test_rolling_replay_accepts_a_non_january_annual_period() -> None:
    problem = _calendar_year_problem()
    shifted = replace(
        problem,
        intervals=tuple(
            replace(row, timestamp=row.timestamp + timedelta(days=5))
            for row in problem.intervals
        ),
    )

    _horizon, _commit, cycle_delta = optimizer_module._rolling_shape(shifted)

    assert cycle_delta == timedelta(days=365)


def _calendar_year_problem(
    *,
    demand_basis: str = "kw",
    reactive_kvar: float = 0.0,
) -> CiOptimizerProblem:
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    intervals = []
    month_indexes: list[list[int]] = [[] for _ in range(12)]
    for index in range(365 * 24):
        timestamp = start + timedelta(hours=index)
        intervals.append(
            CiOptimizerInterval(
                timestamp=timestamp,
                duration_hours=1.0,
                load_kw=(
                    3.0
                    if timestamp.month == 1
                    else 10.0
                    if timestamp.hour == 17
                    else 3.0
                ),
                pv_kw=2.0 if 10 <= timestamp.hour < 15 else 0.0,
                reactive_kvar=reactive_kvar,
                import_rate_aud_per_kwh=0.2,
                export_credit_aud_per_kwh=0.05,
            )
        )
        month_indexes[timestamp.month - 1].append(index)
    return _problem(
        intervals=tuple(intervals),
        battery=_battery(),
        demand_charges=tuple(
            CiDemandCharge(
                f"month_{month + 1:02}",
                0.0 if month == 0 else 10.0,
                tuple(indexes),
                basis=demand_basis,
            )
            for month, indexes in enumerate(month_indexes)
        ),
        billing_periods=tuple(
            CiBillingPeriod(f"month_{month + 1:02}", tuple(indexes))
            for month, indexes in enumerate(month_indexes)
        ),
    )


def test_joint_kw_plan_reconciles_soc_monthly_and_rolling_demand():
    intervals = _intervals((2.0, 2.0, 10.0, 2.0, 2.0, 8.0, 2.0, 2.0))
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("month_01", 10.0, (0, 1, 2, 3)),
            CiDemandCharge("month_02", 10.0, (4, 5, 6, 7)),
            CiDemandCharge("rolling_year", 5.0, tuple(range(8))),
        ),
    )

    result = optimize_ci_peak_shaving(problem)

    assert result.algorithm_id == CI_PEAK_SHAVING_OPTIMIZER_ID
    assert result.status is CiOptimizerStatus.OPTIMAL_LP_EXACT
    assert result.solver_mode == "lp"
    assert result.customer_facing_permission is False
    assert result.recommendation_permitted is False
    assert result.exact_replay_bill_aud < result.idle_baseline_bill_aud
    assert result.optimization_exactness_gap_aud == 0.0
    assert result.bill_reconciliation_difference_aud == 0.0
    assert result.intervals[0].soc_start_kwh == pytest.approx(10.0)
    assert result.intervals[-1].soc_end_kwh == pytest.approx(10.0)
    efficiency = problem.battery.symmetric_efficiency
    for row, source in zip(result.intervals, intervals, strict=True):
        assert row.soc_end_kwh == pytest.approx(
            row.soc_start_kwh
            + (row.grid_charge_kw + row.pv_charge_kw)
            * source.duration_hours
            * efficiency
            - row.discharge_kw * source.duration_hours / efficiency,
            abs=1e-8,
        )
    assert {item.component_id for item in result.demand_charges} == {
        "month_01",
        "month_02",
        "rolling_year",
    }


def test_kva_cutting_plane_uses_exact_hypot_replay_within_aud_5():
    problem = _problem(
        intervals=_intervals(
            (6.0, 12.0, 6.0, 6.0),
            kvar=(8.0, 8.0, 8.0, 8.0),
        ),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("monthly_kva", 20.0, (0, 1, 2, 3), basis="kva"),
        ),
    )

    result = optimize_ci_peak_shaving(problem)

    assert result.status in {
        CiOptimizerStatus.OPTIMAL_LP_EXACT,
        CiOptimizerStatus.BOUNDED_OPTIMAL,
    }
    assert result.kva_cut_iterations >= 1
    assert result.optimization_exactness_gap_aud <= 5.0
    assert result.bill_reconciliation_difference_aud <= 0.01
    peak = result.demand_charges[0]
    expected = max(
        (row.grid_import_kw**2 + source.reactive_kvar**2) ** 0.5
        for row, source in zip(result.intervals, problem.intervals, strict=True)
    )
    assert peak.exact_replay_peak == pytest.approx(expected, abs=1e-8)
    assert peak.exact_charge_aud == pytest.approx(round(expected * 20.0, 2))


def test_kva_cut_refinement_allocates_one_total_aud_5_budget():
    problem = _problem(
        intervals=_intervals((6.0,), kvar=(8.0,)),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("annual_kva", 20.0, (0,), basis="kva"),
            CiDemandCharge("monthly_kva", 20.0, (0,), basis="kva"),
        ),
    )
    solved = optimizer_module._idle_dispatch(problem)
    demand_results = tuple(
        optimizer_module.CiDemandChargeResult(
            component_id=component.component_id,
            basis="kva",
            optimized_limit=9.8,
            exact_replay_peak=10.0,
            exact_charge_aud=200.0,
        )
        for component in problem.demand_charges
    )
    cuts = {component.component_id: [] for component in problem.demand_charges}

    additions = optimizer_module._new_kva_cuts(
        problem,
        solved,
        demand_results,
        cuts,
    )

    assert additions == [
        "kva_tangent_cut:annual_kva:0",
        "kva_tangent_cut:monthly_kva:0",
    ]
    assert all(len(values) == 1 for values in cuts.values())


def test_kva_cut_refinement_batches_distinct_highest_apparent_directions():
    problem = _problem(
        intervals=_intervals(
            (10.0, 9.0, 8.0, 7.0, 6.0),
            kvar=(1.0, 2.0, 3.0, 4.0, 5.0),
        ),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("annual_kva", 20.0, (0, 1, 2, 3, 4), basis="kva"),
        ),
    )
    solved = optimizer_module._idle_dispatch(problem)
    exact_peak = max(
        math.hypot(load, kvar)
        for load, kvar in zip(
            solved.grid_import,
            (1.0, 2.0, 3.0, 4.0, 5.0),
            strict=True,
        )
    )
    demand_results = (
        optimizer_module.CiDemandChargeResult(
            component_id="annual_kva",
            basis="kva",
            optimized_limit=1.0,
            exact_replay_peak=exact_peak,
            exact_charge_aud=round(exact_peak * 20.0, 2),
        ),
    )
    cuts = {"annual_kva": []}

    additions = optimizer_module._new_kva_cuts(
        problem,
        solved,
        demand_results,
        cuts,
    )

    assert len(additions) == optimizer_module.KVA_CUT_BATCH_SIZE
    assert len(cuts["annual_kva"]) == optimizer_module.KVA_CUT_BATCH_SIZE
    assert len(
        {
            (
                round(active / math.hypot(active, reactive), 9),
                round(reactive / math.hypot(active, reactive), 9),
            )
            for active, reactive in cuts["annual_kva"]
        }
    ) == optimizer_module.KVA_CUT_BATCH_SIZE


def test_rolling_kva_materiality_keeps_the_annual_component_budget():
    problem = _problem(
        intervals=_intervals((6.0,), kvar=(8.0,)),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("monthly_kva", 20.0, (0,), basis="kva"),
        ),
    )
    demand_results = (
        optimizer_module.CiDemandChargeResult(
            component_id="monthly_kva",
            basis="kva",
            optimized_limit=9.8,
            exact_replay_peak=10.0,
            exact_charge_aud=200.0,
        ),
    )

    assert not optimizer_module._kva_component_materiality_excess(
        problem,
        demand_results,
    )
    assert optimizer_module._kva_component_materiality_excess(
        problem,
        demand_results,
        materiality_kva_component_count=2,
    )


def test_rolling_kva_refinement_fails_closed_on_aggregate_aud_5_excess(
    monkeypatch,
):
    problem = _problem(
        intervals=_intervals((6.0,), kvar=(8.0,)),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("annual_kva", 20.0, (0,), basis="kva"),
            CiDemandCharge("monthly_kva", 20.0, (0,), basis="kva"),
        ),
    )
    solved = replace(
        optimizer_module._idle_dispatch(problem),
        demand_peaks={"annual_kva": 9.8, "monthly_kva": 9.8},
    )
    monkeypatch.setattr(
        optimizer_module,
        "_solve_two_stage",
        lambda *_args, **_kwargs: solved,
    )
    monkeypatch.setattr(
        optimizer_module,
        "_new_kva_cuts",
        lambda *_args, **_kwargs: [],
    )

    outcome = optimizer_module._solve_fixed_limit_window(
        problem,
        fixed_soc_boundaries={},
        fixed_demand_limits={"annual_kva": 9.8, "monthly_kva": 9.8},
    )

    assert outcome.solved is None
    assert outcome.status is CiOptimizerStatus.BILL_RECONCILIATION_FAILED
    assert "rolling_kva_cut_refinement_not_converged" in outcome.corrections


def test_reactive_support_known_answer_respects_shared_pq_apparent_limit():
    problem = _problem(
        intervals=_intervals((250.0,), pv=(250.0,), kvar=(80.0,)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("shared_kva", 20.0, (0,), basis="kva"),),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=80.0,
            inverter_apparent_power_limit_kva=275.0,
        ),
    )

    result = optimize_ci_peak_shaving(problem)

    assert result.status in {
        CiOptimizerStatus.OPTIMAL_LP_EXACT,
        CiOptimizerStatus.BOUNDED_OPTIMAL,
    }
    row = result.intervals[0]
    assert row.shared_ac_port_kw == pytest.approx(250.0, abs=1e-6)
    assert row.inverter_reactive_support_kvar == pytest.approx(80.0, abs=1e-6)
    assert row.shared_inverter_apparent_power_kva == pytest.approx(
        math.hypot(250.0, 80.0), abs=1e-6
    )
    assert row.shared_inverter_apparent_power_kva == pytest.approx(
        262.48809496813374, abs=1e-6
    )
    assert row.shared_inverter_apparent_power_kva <= 275.0
    assert row.post_grid_reactive_kvar == 0.0


def test_reactive_support_is_constrained_by_site_cap_and_pq_envelope():
    cap_limited = _problem(
        intervals=_intervals((100.0,), kvar=(80.0,)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("kva", 10.0, (0,), basis="kva"),),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=30.0,
            inverter_apparent_power_limit_kva=275.0,
        ),
    )
    constrained = optimize_ci_peak_shaving(cap_limited).intervals[0]
    assert constrained.inverter_reactive_support_kvar == pytest.approx(30.0)
    assert constrained.post_grid_reactive_kvar == pytest.approx(50.0)
    assert constrained.exact_grid_import_kva == pytest.approx(math.hypot(100.0, 50.0))

    envelope_limited = replace(
        cap_limited,
        intervals=_intervals((250.0,), pv=(250.0,), kvar=(80.0,)),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=80.0,
            inverter_apparent_power_limit_kva=255.0,
        ),
    )
    constrained = optimize_ci_peak_shaving(envelope_limited).intervals[0]
    assert constrained.shared_inverter_apparent_power_kva <= 255.0 + 1e-6
    assert constrained.inverter_reactive_support_kvar <= 80.0 + 1e-9
    assert constrained.shared_ac_port_kw < 250.0
    assert constrained.post_grid_reactive_kvar >= 0.0


def test_explicit_reactive_disabled_is_numerically_compatible():
    base = _problem(
        intervals=_intervals((6.0, 12.0, 6.0), kvar=(8.0, 8.0, 8.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("kva", 20.0, (0, 1, 2), basis="kva"),),
    )
    explicit = replace(base, reactive_support=CiReactiveSupportSpec(enabled=False))

    baseline = optimize_ci_peak_shaving(base)
    disabled = optimize_ci_peak_shaving(explicit)

    assert disabled.status == baseline.status
    assert disabled.exact_replay_bill_aud == baseline.exact_replay_bill_aud
    assert disabled.demand_charges == baseline.demand_charges
    assert disabled.intervals == baseline.intervals


def test_rolling_replay_carries_reactive_support_through_exact_reconciliation():
    problem = replace(
        _calendar_year_problem(demand_basis="kva", reactive_kvar=8.0),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=5.0,
            inverter_apparent_power_limit_kva=250.0,
        ),
    )

    result = execute_ci_peak_shaving_rolling(problem)

    assert result.status in {
        CiOptimizerStatus.OPTIMAL_LP_EXACT,
        CiOptimizerStatus.OPTIMAL_MILP,
        CiOptimizerStatus.BOUNDED_OPTIMAL,
    }
    assert len(result.intervals) == len(problem.intervals)
    assert result.intervals[-1].soc_end_kwh == pytest.approx(10.0, abs=1e-6)
    assert result.bill_reconciliation_difference_aud <= 0.01
    assert result.optimization_exactness_gap_aud <= 5.0
    assert all(
        0.0 <= row.inverter_reactive_support_kvar <= 5.0 + 1e-7
        and row.post_grid_reactive_kvar >= -1e-7
        and row.shared_inverter_apparent_power_kva <= 250.0 + 1e-6
        and row.exact_grid_import_kva
        == pytest.approx(
            math.hypot(row.grid_import_kw, row.post_grid_reactive_kvar),
            abs=1e-7,
        )
        for row in result.intervals
    )


def test_unpriced_kva_reactive_support_is_applied_after_active_dispatch(
    monkeypatch,
):
    base = _calendar_year_problem(demand_basis="kva", reactive_kvar=8.0)
    problem = replace(
        base,
        demand_charges=tuple(
            replace(component, rate_aud_per_unit=0.0)
            for component in base.demand_charges
        ),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=5.0,
            inverter_apparent_power_limit_kva=250.0,
        ),
    )
    built_reactive_models: list[bool] = []
    real_build_model = optimizer_module._build_model

    def tracked_build_model(*args, **kwargs):
        built_reactive_models.append(args[0].reactive_support.enabled)
        return real_build_model(*args, **kwargs)

    monkeypatch.setattr(optimizer_module, "_build_model", tracked_build_model)

    result = execute_ci_peak_shaving_rolling(problem)

    assert result.status in {
        CiOptimizerStatus.OPTIMAL_LP_EXACT,
        CiOptimizerStatus.OPTIMAL_MILP,
        CiOptimizerStatus.BOUNDED_OPTIMAL,
    }
    assert built_reactive_models and not any(built_reactive_models)
    assert len(result.demand_charges) == len(problem.demand_charges)
    assert max(
        row.inverter_reactive_support_kvar for row in result.intervals
    ) == pytest.approx(5.0)
    assert result.bill_reconciliation_difference_aud == 0.0
    assert "reactive_support_post_dispatch_no_priced_kva_demand" in (
        result.corrections
    )
    assert dict(result.annual_planner_demand_limits) == {
        component.component_id: None for component in problem.demand_charges
    }


def test_fixed_kva_limit_uses_exact_interval_active_import_cap_without_cuts():
    problem = _problem(
        intervals=_intervals(
            (7.0, 0.0),
            kvar=(8.0, 0.0),
            rates=(0.3, 0.1),
        ),
        battery=_battery(max_charge_kw=5.0, max_discharge_kw=5.0),
        demand_charges=(
            CiDemandCharge("fixed_kva", 20.0, (0, 1), basis="kva"),
        ),
        config=CiOptimizerConfig(allow_grid_charging=True),
    )

    outcome = optimizer_module._solve_fixed_limit_window(
        problem,
        fixed_soc_boundaries={0: 10.0, 2: 10.0},
        fixed_demand_limits={"fixed_kva": 10.0},
    )

    assert outcome.solved is not None
    assert outcome.kva_iterations == 0
    assert outcome.solved.grid_import[0] <= 6.0 + 1e-8
    assert outcome.demand_results[0].exact_replay_peak <= 10.0 + 1e-8


def test_five_minute_annual_planner_uses_mappable_fifteen_minute_surrogate():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    loads = (6.0, 9.0, 12.0, 12.0, 9.0, 6.0)
    pv = (0.0, 3.0, 6.0, 6.0, 3.0, 0.0)
    intervals = tuple(
        CiOptimizerInterval(
            timestamp=start + timedelta(minutes=5 * index),
            duration_hours=1 / 12,
            load_kw=load,
            pv_kw=pv[index],
            reactive_kvar=4.0 + index,
            import_rate_aud_per_kwh=0.2,
            export_credit_aud_per_kwh=0.05,
        )
        for index, load in enumerate(loads)
    )
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("source_kva", 20.0, tuple(range(6)), basis="kva"),
        ),
        config=CiOptimizerConfig(allow_grid_charging=False),
    )

    planner_problem, aggregation = optimizer_module._annual_planner_problem(problem)

    assert aggregation is not None
    assert len(planner_problem.intervals) == 2
    assert planner_problem.intervals[0].duration_hours == pytest.approx(0.25)
    assert planner_problem.intervals[0].load_kw == pytest.approx(9.0)
    assert planner_problem.intervals[0].pv_kw == pytest.approx(3.0)
    assert planner_problem.demand_charges[0].basis == "kw"
    planner = optimize_ci_peak_shaving(planner_problem)
    references = optimizer_module._expand_planner_references(
        problem,
        planner,
        aggregation,
    )
    assert references is not None
    assert len(references.soc_boundaries_kwh) == len(intervals) + 1
    assert references.soc_boundaries_kwh[0] == pytest.approx(10.0)
    assert references.soc_boundaries_kwh[-1] == pytest.approx(10.0)
    assert dict(references.demand_limits)["source_kva"] >= dict(
        planner._planner_references.demand_limits
    )["source_kva"]


def test_five_minute_reactive_planner_aggregates_pq_and_expands_exact_source_kva():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    reactive_kvar = (10.0, 80.0, 80.0, 10.0, 80.0, 80.0)
    intervals = tuple(
        CiOptimizerInterval(
            timestamp=start + timedelta(minutes=5 * index),
            duration_hours=1 / 12,
            load_kw=100.0,
            pv_kw=50.0,
            reactive_kvar=reactive_kvar[index],
            import_rate_aud_per_kwh=0.2,
            export_credit_aud_per_kwh=0.05,
        )
        for index in range(6)
    )
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("source_kva", 20.0, tuple(range(6)), basis="kva"),
        ),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=40.0,
            inverter_apparent_power_limit_kva=150.0,
        ),
        config=CiOptimizerConfig(allow_grid_charging=False),
    )

    planner_problem, aggregation = optimizer_module._annual_planner_problem(problem)

    assert aggregation is not None
    assert len(planner_problem.intervals) == 2
    assert planner_problem.demand_charges[0].basis == "kva"
    planner = optimize_ci_peak_shaving(planner_problem)
    references = optimizer_module._expand_planner_references(
        problem,
        planner,
        aggregation,
    )
    assert references is not None
    assert len(references.soc_boundaries_kwh) == len(intervals) + 1
    assert dict(references.demand_limits)["source_kva"] >= 0.0


def test_five_minute_planner_keeps_source_resolution_when_tariff_rates_change_mid_group():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    intervals = tuple(
        CiOptimizerInterval(
            timestamp=start + timedelta(minutes=5 * index),
            duration_hours=1 / 12,
            load_kw=10.0,
            pv_kw=0.0,
            reactive_kvar=0.0,
            import_rate_aud_per_kwh=0.2 if index < 2 else 0.3,
            export_credit_aud_per_kwh=0.05,
        )
        for index in range(3)
    )
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(CiDemandCharge("source_kw", 20.0, (0, 1, 2)),),
        config=CiOptimizerConfig(allow_grid_charging=False),
    )

    planner_problem, aggregation = optimizer_module._annual_planner_problem(problem)

    assert planner_problem is problem
    assert aggregation is None


def test_fifteen_minute_kva_planner_keeps_resolution_and_uses_kw_surrogate():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    intervals = tuple(
        CiOptimizerInterval(
            timestamp=start + timedelta(minutes=15 * index),
            duration_hours=0.25,
            load_kw=10.0 + index,
            pv_kw=2.0,
            reactive_kvar=4.0,
            import_rate_aud_per_kwh=0.2,
            export_credit_aud_per_kwh=0.05,
        )
        for index in range(4)
    )
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("source_kva", 20.0, (0, 1, 2, 3), basis="kva"),
        ),
        config=CiOptimizerConfig(allow_grid_charging=False),
    )

    planner_problem, aggregation = optimizer_module._annual_planner_problem(problem)

    assert aggregation is not None
    assert len(planner_problem.intervals) == len(problem.intervals)
    assert planner_problem.demand_charges[0].basis == "kw"
    assert aggregation.source_groups == ((0,), (1,), (2,), (3,))


def test_same_dispatch_bill_reconciliation_fails_closed(monkeypatch):
    problem = _problem(
        intervals=_intervals((2.0, 10.0, 2.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("control", 20.0, (0, 1, 2)),),
    )
    real_replay = optimizer_module._replay_bill_from_dispatch

    monkeypatch.setattr(
        optimizer_module,
        "_replay_bill_from_dispatch",
        lambda supplied, dispatch: real_replay(supplied, dispatch) + 0.02,
    )

    result = optimize_ci_peak_shaving(problem)

    assert result.status is CiOptimizerStatus.BILL_RECONCILIATION_FAILED
    assert result.exact_replay_bill_aud is None
    assert result.optimization_exactness_gap_aud is None
    assert result.bill_reconciliation_difference_aud is None
    assert "same_dispatch_bill_reconciliation_failed" in result.corrections


def test_idle_candidate_is_selected_when_dispatch_is_not_strictly_cheaper():
    problem = _problem(
        intervals=_intervals((4.0, 4.0, 4.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("flat_peak", 0.0, (0, 1, 2)),),
        config=CiOptimizerConfig(wear_cost_aud_per_discharged_kwh=0.05),
    )

    result = optimize_ci_peak_shaving(problem)

    assert "battery_idle_selected" in result.corrections
    assert result.exact_replay_bill_aud == result.idle_baseline_bill_aud
    assert all(row.grid_charge_kw == 0 for row in result.intervals)
    assert all(row.pv_charge_kw == 0 for row in result.intervals)
    assert all(row.discharge_kw == 0 for row in result.intervals)


def test_each_billing_period_exposes_idle_and_dispatch_candidates_with_soc_carry():
    intervals = _intervals((2.0, 2.0, 10.0, 10.0, 2.0, 2.0))
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(CiDemandCharge("middle_peak", 20.0, (2, 3)),),
        billing_periods=(
            CiBillingPeriod("month_01", (0, 1)),
            CiBillingPeriod("month_02", (2, 3)),
            CiBillingPeriod("month_03", (4, 5)),
        ),
    )

    result = optimize_ci_peak_shaving(problem)

    assert [row.candidate_ids for row in result.billing_periods] == [
        ("battery_idle", "optimized_dispatch")
    ] * 3
    assert [row.selected_candidate for row in result.billing_periods] == [
        "battery_idle",
        "optimized_dispatch",
        "optimized_dispatch",
    ]
    assert result.billing_periods[0].start_soc_kwh == pytest.approx(10.0)
    assert result.billing_periods[0].end_soc_kwh == pytest.approx(10.0)
    assert result.billing_periods[1].end_soc_kwh < 10.0
    assert result.billing_periods[2].start_soc_kwh == pytest.approx(
        result.billing_periods[1].end_soc_kwh
    )
    assert result.billing_periods[2].end_soc_kwh == pytest.approx(10.0)


def test_billing_period_accumulated_sub_tolerance_flow_is_not_labelled_idle():
    intervals = _intervals((2.0, 2.0, 2.0))
    problem = _problem(
        intervals=intervals,
        battery=_battery(),
        demand_charges=(CiDemandCharge("flat", 0.0, (0, 1, 2)),),
    )
    idle = optimizer_module._idle_dispatch(problem)
    solved = replace(
        idle,
        grid_charge=(5e-8, 5e-8, 5e-8),
        soc=(10.0, 10.0, 10.0, 10.00000015),
    )

    result = optimizer_module._billing_period_results(problem, solved)

    assert result[0].selected_candidate == "optimized_dispatch"


def test_dynamic_reserve_looks_ahead_to_future_controlled_peak():
    problem = _problem(
        intervals=_intervals((2.0, 2.0, 2.0, 10.0, 2.0, 2.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("control", 20.0, tuple(range(6))),),
    )

    result = optimize_ci_peak_shaving(problem)

    peak_interval = result.intervals[3]
    assert result.intervals[0].dynamic_reserve_soc_kwh >= 1.0
    assert peak_interval.dynamic_reserve_soc_kwh > 1.0
    assert any(row.discharge_kw > 0 for row in result.intervals)
    assert "actual future synthetic inputs" in result.disclosures[1]


def test_dynamic_reserve_does_not_assume_disabled_grid_charging():
    problem = _problem(
        intervals=_intervals(
            (2.0, 10.0, 2.0),
            pv=(0.0, 0.0, 7.0),
        ),
        battery=_battery(),
        demand_charges=(CiDemandCharge("control", 20.0, (0, 1, 2)),),
        config=CiOptimizerConfig(allow_grid_charging=False),
    )

    result = optimize_ci_peak_shaving(problem)

    assert any(row.discharge_kw > 0 for row in result.intervals)
    assert result.intervals[0].dynamic_reserve_soc_kwh > 1.0
    assert result.intervals[2].pv_charge_kw > 0


@pytest.mark.parametrize("interval_count", [48, 60])
def test_dynamic_reserve_matches_the_suffix_scan_reference(interval_count):
    loads = tuple(9.0 if index % 7 == 0 else 3.0 for index in range(interval_count))
    pv = tuple(7.0 if index % 11 == 0 else 0.0 for index in range(interval_count))
    problem = _problem(
        intervals=_intervals(loads, pv=pv),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("control", 20.0, tuple(range(interval_count))),
        ),
    )
    demand_results = (
        CiDemandChargeResult("control", "kw", 5.0, 5.0, 100.0),
    )
    solved = optimizer_module._idle_dispatch(problem)

    actual = optimizer_module._dynamic_reserve(
        problem,
        solved,
        demand_results,
    )

    min_soc = problem.battery.nominal_capacity_kwh * problem.battery.min_soc_fraction
    max_soc = problem.battery.nominal_capacity_kwh * problem.battery.max_soc_fraction
    efficiency = problem.battery.symmetric_efficiency
    expected = []
    for start in range(interval_count):
        duration = 0.0
        end = start
        while end < interval_count and duration < 48.0:
            duration += problem.intervals[end].duration_hours
            end += 1
        required = min_soc
        for index in range(end - 1, start - 1, -1):
            row = problem.intervals[index]
            net_load = max(0.0, row.load_kw - row.pv_kw)
            required_discharge = min(
                problem.battery.max_discharge_kw,
                max(0.0, net_load - 5.0),
            )
            pv_surplus = max(0.0, row.pv_kw - row.load_kw)
            grid_charge_headroom = max(0.0, 5.0 - net_load)
            charge_headroom = min(
                problem.battery.max_charge_kw,
                pv_surplus + grid_charge_headroom,
            )
            required = max(
                min_soc,
                required
                + required_discharge * row.duration_hours / efficiency
                - charge_headroom * row.duration_hours * efficiency,
            )
        expected.append(min(max_soc, required))

    assert actual == pytest.approx(expected)


def test_pv_export_is_not_created_by_battery_discharge():
    problem = _problem(
        intervals=_intervals(
            (2.0, 2.0, 8.0, 2.0),
            pv=(6.0, 0.0, 0.0, 0.0),
        ),
        battery=_battery(),
        demand_charges=(CiDemandCharge("peak", 20.0, (0, 1, 2, 3)),),
    )

    result = optimize_ci_peak_shaving(problem)

    for source, row in zip(problem.intervals, result.intervals, strict=True):
        assert row.discharge_kw <= max(0.0, source.load_kw - source.pv_kw) + 1e-9
    assert result.intervals[0].pv_export_kw <= 4.0


def test_shared_ac_port_clips_pv_output_without_double_counting_capacity():
    problem = _problem(
        intervals=_intervals((100.0,), pv=(300.0,)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("flat", 0.0, (0,)),),
        shared_ac_headroom_kw=250.0,
    )

    result = optimize_ci_peak_shaving(problem)

    row = result.intervals[0]
    assert row.pv_to_ac_kw == pytest.approx(250.0)
    assert row.pv_export_kw == pytest.approx(150.0)
    assert row.shared_ac_port_kw == pytest.approx(250.0)
    assert row.pv_charge_kw == row.discharge_kw == row.grid_charge_kw == 0.0


def test_pv_and_discharge_share_positive_headroom_while_dc_charge_does_not():
    problem = _problem(
        intervals=_intervals(
            (200.0, 200.0, 0.0),
            pv=(80.0, 0.0, 300.0),
            rates=(1.0, 1.0, 0.1),
        ),
        battery=_battery(
            nominal_capacity_kwh=100.0,
            max_charge_kw=100.0,
            max_discharge_kw=100.0,
            ac_round_trip_efficiency=1.0,
        ),
        demand_charges=(CiDemandCharge("flat", 0.0, (0, 1, 2)),),
        shared_ac_headroom_kw=100.0,
    )

    result = optimize_ci_peak_shaving(problem)

    first, _, solar_charge = result.intervals
    assert first.pv_to_ac_kw == pytest.approx(80.0)
    assert first.discharge_kw == pytest.approx(20.0, abs=0.02)
    assert first.shared_ac_port_kw == pytest.approx(100.0, abs=0.02)
    assert solar_charge.pv_to_ac_kw == pytest.approx(100.0)
    assert solar_charge.pv_charge_kw == pytest.approx(90.0, abs=0.02)
    assert solar_charge.shared_ac_port_kw == pytest.approx(100.0, abs=0.02)
    assert solar_charge.pv_to_ac_kw + solar_charge.pv_charge_kw <= 300.0


def test_grid_charge_uses_negative_shared_ac_headroom():
    problem = _problem(
        intervals=_intervals(
            (100.0, 0.0, 0.0),
            rates=(1.0, 0.1, 0.1),
        ),
        battery=_battery(
            nominal_capacity_kwh=100.0,
            max_charge_kw=100.0,
            max_discharge_kw=100.0,
            ac_round_trip_efficiency=1.0,
        ),
        demand_charges=(CiDemandCharge("flat", 0.0, (0, 1, 2)),),
        shared_ac_headroom_kw=50.0,
    )

    result = optimize_ci_peak_shaving(problem)

    assert result.intervals[0].discharge_kw == pytest.approx(50.0, abs=0.02)
    assert sum(row.grid_charge_kw for row in result.intervals[1:]) == pytest.approx(
        50.0, abs=0.02
    )
    assert all(row.grid_charge_kw <= 50.0 + 1e-9 for row in result.intervals)
    assert min(row.shared_ac_port_kw for row in result.intervals) == pytest.approx(
        -50.0, abs=0.02
    )


def test_lp_simultaneous_flow_triggers_same_horizon_milp_fallback(monkeypatch):
    problem = _problem(
        intervals=_intervals((2.0, 2.0, 10.0, 2.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("peak", 20.0, (0, 1, 2, 3)),),
    )
    real_solve = optimizer_module._solve_two_stage
    modes: list[bool] = []

    def injected_simultaneous_flow(problem, *, cuts, binary, **kwargs):
        modes.append(binary)
        solved = real_solve(problem, cuts=cuts, binary=binary, **kwargs)
        if binary:
            return solved
        return replace(
            solved,
            grid_charge=(1.0,) + solved.grid_charge[1:],
            discharge=(1.0,) + solved.discharge[1:],
        )

    monkeypatch.setattr(
        optimizer_module,
        "_solve_two_stage",
        injected_simultaneous_flow,
    )

    result = optimize_ci_peak_shaving(problem)

    assert modes == [False, True]
    assert result.solver_mode == "milp"
    assert result.status is CiOptimizerStatus.OPTIMAL_MILP
    assert result.simultaneous_charge_discharge_detected is True
    assert "lp_to_milp_simultaneous_charge_discharge" in result.corrections


def test_year_boundary_intervals_remain_chronological_and_soc_continuous():
    start = datetime(2025, 12, 31, 22, tzinfo=timezone.utc)
    problem = _problem(
        intervals=_intervals((2.0, 8.0, 2.0, 2.0), start=start),
        battery=_battery(),
        demand_charges=(CiDemandCharge("cross_year", 15.0, (0, 1, 2, 3)),),
    )

    result = optimize_ci_peak_shaving(problem)

    assert result.intervals[1].timestamp.year == 2025
    assert result.intervals[2].timestamp.year == 2026
    assert all(
        current.soc_start_kwh == pytest.approx(previous.soc_end_kwh)
        for previous, current in zip(
            result.intervals, result.intervals[1:], strict=False
        )
    )


def test_rolling_replay_commits_24_hours_wraps_january_and_reconciles():
    problem = _calendar_year_problem()

    result = execute_ci_peak_shaving_rolling(problem)

    assert result.algorithm_id == CI_PEAK_SHAVING_ROLLING_REPLAY_ID
    assert result.status is CiOptimizerStatus.OPTIMAL_LP_EXACT
    assert result.customer_facing_permission is False
    assert result.recommendation_permitted is False
    assert len(result.intervals) == 365 * 24
    assert len(result.windows) == 365
    assert all(window.horizon_interval_count == 48 for window in result.windows)
    assert all(window.committed_interval_count == 24 for window in result.windows)
    assert result.windows[-1].wrapped_interval_count == 24
    assert all(
        window.committed_end_soc_kwh + 1e-8
        >= window.minimum_committed_soc_kwh
        for window in result.windows
    )
    assert result.intervals[0].timestamp == problem.intervals[0].timestamp
    assert result.intervals[-1].timestamp == problem.intervals[-1].timestamp
    assert result.intervals[0].soc_start_kwh == pytest.approx(10.0)
    assert result.intervals[-1].soc_end_kwh == pytest.approx(10.0)
    january = result.billing_periods[0]
    assert len(result.billing_periods) == 12
    assert all(
        period.candidate_ids == ("battery_idle", "optimized_dispatch")
        for period in result.billing_periods
    )
    assert january.period_id == "month_01"
    assert january.selected_candidate == "battery_idle"
    assert january.start_soc_kwh == pytest.approx(january.end_soc_kwh)
    assert all(
        row.grid_charge_kw == row.pv_charge_kw == row.discharge_kw == 0.0
        for row in result.intervals[: 31 * 24]
    )
    assert all(
        current.start_soc_kwh == pytest.approx(previous.end_soc_kwh, abs=1e-8)
        for previous, current in zip(
            result.billing_periods,
            result.billing_periods[1:],
            strict=False,
        )
    )
    assert all(
        current.soc_start_kwh == pytest.approx(previous.soc_end_kwh, abs=1e-8)
        for previous, current in zip(
            result.intervals,
            result.intervals[1:],
            strict=False,
        )
    )
    assert result.exact_replay_bill_aud < result.idle_baseline_bill_aud
    assert result.optimization_exactness_gap_aud <= 5.0
    assert result.bill_reconciliation_difference_aud == 0.0
    planner_limits = dict(result.annual_planner_demand_limits)
    assert planner_limits["month_01"] is None
    assert all(
        planner_limits[f"month_{month:02}"] is not None
        for month in range(2, 13)
    )
    assert "not a forecast-error model" in result.disclosures[-4]
    assert "physical viability condition" in result.disclosures[-3]
    assert "not billed twice" in result.disclosures[-2]


def test_planner_soc_commit_bound_preserves_recursive_feasibility():
    battery = _battery(ac_round_trip_efficiency=1.0)

    def window_problem(loads: tuple[float, ...]) -> CiOptimizerProblem:
        return _problem(
            intervals=_intervals(loads, rates=(1.0,) * len(loads)),
            battery=battery,
            demand_charges=(CiDemandCharge("fixed_limit", 0.0, (0, 1, 2, 3)),),
        )

    fixed_limits = {"fixed_limit": 5.0}
    first_window = window_problem((10.0, 0.0, 5.0, 5.0))
    unconstrained = optimizer_module._solve_fixed_limit_window(
        first_window,
        fixed_soc_boundaries={0: 10.0},
        fixed_demand_limits=fixed_limits,
    )
    assert unconstrained.solved is not None
    assert unconstrained.solved.soc[2] == pytest.approx(5.0)

    newly_revealed_window = window_problem((5.0, 5.0, 9.0, 9.0))
    stranded = optimizer_module._solve_fixed_limit_window(
        newly_revealed_window,
        fixed_soc_boundaries={0: unconstrained.solved.soc[2]},
        fixed_demand_limits=fixed_limits,
    )
    assert stranded.status is CiOptimizerStatus.MODEL_FAILURE

    planner_reference_soc = 9.0
    viable = optimizer_module._solve_fixed_limit_window(
        first_window,
        fixed_soc_boundaries={0: 10.0},
        minimum_soc_boundaries={2: planner_reference_soc},
        fixed_demand_limits=fixed_limits,
    )
    assert viable.solved is not None
    assert viable.solved.soc[2] >= planner_reference_soc

    continued = optimizer_module._solve_fixed_limit_window(
        newly_revealed_window,
        fixed_soc_boundaries={0: viable.solved.soc[2]},
        fixed_demand_limits=fixed_limits,
    )
    assert continued.status is CiOptimizerStatus.OPTIMAL_LP_EXACT
    assert continued.solved is not None
    assert max(continued.solved.grid_import) <= fixed_limits["fixed_limit"] + 1e-8


def test_rolling_kva_replay_separates_exactness_from_bill_reconciliation():
    problem = _calendar_year_problem(demand_basis="kva", reactive_kvar=8.0)
    problem = replace(
        problem,
        demand_charges=(
            CiDemandCharge("audited_kva_interval", 10.0, (17,), basis="kva"),
        ),
    )

    result = execute_ci_peak_shaving_rolling(problem)

    assert result.status in {
        CiOptimizerStatus.OPTIMAL_LP_EXACT,
        CiOptimizerStatus.BOUNDED_OPTIMAL,
    }
    assert 0.0 <= result.optimization_exactness_gap_aud <= 5.0
    assert result.bill_reconciliation_difference_aud <= 0.01
    assert result.demand_charges[0].basis == "kva"
    expected_peak = (
        result.intervals[17].grid_import_kw**2
        + problem.intervals[17].reactive_kvar**2
    ) ** 0.5
    assert result.demand_charges[0].exact_replay_peak == pytest.approx(
        expected_peak,
        abs=1e-8,
    )


def test_rolling_replay_failure_retains_idle_bill_and_no_optimization_benefit(
    monkeypatch,
):
    problem = _calendar_year_problem()
    idle = optimizer_module._idle_dispatch(problem)
    demand_results = optimizer_module._exact_demand_results(problem, idle)
    planner = optimizer_module.CiOptimizerResult(
        algorithm_id=CI_PEAK_SHAVING_OPTIMIZER_ID,
        status=CiOptimizerStatus.OPTIMAL_LP_EXACT,
        solver_mode="lp",
        solver_version=highspy.Highs().version(),
        customer_facing_permission=False,
        recommendation_permitted=False,
        primary_objective_aud=optimizer_module._money(idle.objective),
        exact_replay_bill_aud=optimizer_module._money(idle.objective),
        idle_baseline_bill_aud=optimizer_module._money(idle.objective),
        optimization_exactness_gap_aud=0.0,
        bill_reconciliation_difference_aud=0.0,
        mip_absolute_gap_aud=0.0,
        simultaneous_charge_discharge_detected=False,
        kva_cut_iterations=0,
        demand_charges=demand_results,
        billing_periods=optimizer_module._billing_period_results(problem, idle),
        intervals=(),
        _planner_references=optimizer_module._PlannerReferences(
            demand_limits=tuple(
                (item.component_id, item.exact_replay_peak) for item in demand_results
            ),
            soc_boundaries_kwh=idle.soc,
            idle_billing_period_ids=tuple(
                period.period_id for period in problem.billing_periods
            ),
        ),
        corrections=("battery_idle_selected",),
        disclosures=optimizer_module._disclosures(),
    )
    monkeypatch.setattr(
        optimizer_module,
        "optimize_ci_peak_shaving",
        lambda supplied: planner,
    )
    monkeypatch.setattr(
        optimizer_module,
        "_solve_fixed_limit_window",
        lambda *args, **kwargs: optimizer_module._WindowSolveOutcome(
            solved=None,
            demand_results=(),
            status=CiOptimizerStatus.NUMERICAL_FAILURE,
            solver_mode="lp",
            simultaneous_detected=False,
            kva_iterations=0,
            corrections=("synthetic_window_failure",),
        ),
    )

    result = execute_ci_peak_shaving_rolling(problem)

    assert result.status is CiOptimizerStatus.NUMERICAL_FAILURE
    assert result.exact_replay_bill_aud is None
    assert result.idle_baseline_bill_aud == planner.idle_baseline_bill_aud
    assert result.intervals == ()
    assert len(result.windows) == 1
    assert result.windows[0].committed_interval_count == 0


def test_contract_rejects_unsafe_or_ambiguous_inputs():
    with pytest.raises(ValueError, match="equal initial and terminal SOC"):
        _battery(terminal_soc_fraction=0.5)
    with pytest.raises(ValueError, match="power limits must be symmetric"):
        _battery(max_discharge_kw=4.0)
    with pytest.raises(ValueError, match="wear shadow cost"):
        CiOptimizerConfig(wear_cost_aud_per_discharged_kwh=0.04)
    with pytest.raises(ValueError, match="export credit"):
        CiOptimizerInterval(
            timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
            duration_hours=1,
            load_kw=1,
            pv_kw=0,
            reactive_kvar=0,
            import_rate_aud_per_kwh=0.1,
            export_credit_aud_per_kwh=0.2,
        )
    with pytest.raises(ValueError, match="outside"):
        _problem(
            intervals=_intervals((1.0,)),
            battery=_battery(),
            demand_charges=(CiDemandCharge("bad", 1.0, (1,)),),
        )
    with pytest.raises(ValueError, match="ordered, non-overlapping partition"):
        _problem(
            intervals=_intervals((1.0, 1.0, 1.0)),
            battery=_battery(),
            demand_charges=(CiDemandCharge("valid", 1.0, (0, 1, 2)),),
            billing_periods=(
                CiBillingPeriod("month_01", (0,)),
                CiBillingPeriod("month_02", (2,)),
            ),
        )
    with pytest.raises(ValueError, match="shared_ac_headroom_kw must be positive"):
        _problem(
            intervals=_intervals((1.0,)),
            battery=_battery(),
            demand_charges=(CiDemandCharge("valid", 1.0, (0,)),),
            shared_ac_headroom_kw=0.0,
        )


def test_primary_lp_timeout_cannot_be_relabelled_exact(monkeypatch):
    problem = _problem(
        intervals=_intervals((2.0, 8.0, 2.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("peak", 20.0, (0, 1, 2)),),
    )
    timed_out = optimizer_module._SolvedDispatch(
        model_status=highspy.HighsModelStatus.kTimeLimit,
        objective=10.0,
        mip_gap_aud=None,
        grid_import=(2.0, 8.0, 2.0),
        pv_export=(0.0, 0.0, 0.0),
        pv_to_ac=(0.0, 0.0, 0.0),
        grid_charge=(0.0, 0.0, 0.0),
        pv_charge=(0.0, 0.0, 0.0),
        discharge=(0.0, 0.0, 0.0),
        reactive_support=(0.0, 0.0, 0.0),
        soc=(10.0, 10.0, 10.0, 10.0),
        demand_peaks={"peak": 8.0},
    )
    calls = 0

    def fake_run_model(model, *, binary):
        nonlocal calls
        calls += 1
        return timed_out

    monkeypatch.setattr(optimizer_module, "_build_model", lambda *args, **kwargs: object())
    monkeypatch.setattr(optimizer_module, "_run_model", fake_run_model)

    result = optimizer_module._solve_two_stage(problem, cuts={}, binary=False)

    assert calls == 1
    assert result.model_status is highspy.HighsModelStatus.kTimeLimit


def test_two_stage_lp_uses_deterministic_simplex_then_ipm_for_small_models():
    problem = _problem(
        intervals=_intervals((2.0, 8.0, 2.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("peak", 20.0, (0, 1, 2)),),
    )
    model = optimizer_module._build_model(problem, cuts={}, binary=False)

    assert model.highs.getOptionValue("solver")[1] == "simplex"
    assert model.highs.getOptionValue("threads")[1] == 1
    assert model.highs.getOptionValue("parallel")[1] == "off"

    secondary = optimizer_module._prepare_secondary_model(
        model,
        primary_upper_bound=100.0,
        binary=False,
    )

    assert secondary is model
    assert secondary.highs.getOptionValue("solver")[1] == "ipm"


def test_reactive_two_stage_reuses_deterministic_simplex_basis_for_secondary():
    problem = _problem(
        intervals=_intervals((2.0, 8.0, 2.0), kvar=(6.0, 6.0, 6.0)),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("peak", 20.0, (0, 1, 2), basis="kva"),
        ),
        reactive_support=CiReactiveSupportSpec(
            enabled=True,
            max_reactive_support_kvar=5.0,
            inverter_apparent_power_limit_kva=20.0,
        ),
    )
    model = optimizer_module._build_model(problem, cuts={}, binary=False)

    secondary = optimizer_module._prepare_secondary_model(
        model,
        primary_upper_bound=100.0,
        binary=False,
        warm_start_simplex=True,
    )

    assert secondary is model
    assert secondary.highs.getOptionValue("solver")[1] == "simplex"
    assert secondary.highs.getOptionValue("simplex_strategy")[1] == int(
        highspy.simplex_constants.kSimplexStrategyPrimal
    )


def test_annual_size_lp_routes_the_secondary_solve_to_primal_simplex():
    class LargeProblem:
        intervals = (None,) * optimizer_module.PRIMAL_SIMPLEX_REUSE_MIN_INTERVALS
        reactive_support = CiReactiveSupportSpec()

    class SmallProblem:
        intervals = (None,) * (
            optimizer_module.PRIMAL_SIMPLEX_REUSE_MIN_INTERVALS - 1
        )
        reactive_support = CiReactiveSupportSpec()

    assert optimizer_module._warm_start_secondary_with_primal_simplex(
        LargeProblem()
    )
    assert not optimizer_module._warm_start_secondary_with_primal_simplex(
        SmallProblem()
    )


def test_two_stage_defers_secondary_until_primary_exact_kva_is_material(
    monkeypatch,
):
    problem = _problem(
        intervals=_intervals((8.0,), kvar=(6.0,)),
        battery=_battery(),
        demand_charges=(
            CiDemandCharge("peak", 20.0, (0,), basis="kva"),
        ),
    )
    primary = optimizer_module._SolvedDispatch(
        model_status=highspy.HighsModelStatus.kOptimal,
        objective=10.0,
        mip_gap_aud=0.0,
        grid_import=(8.0,),
        pv_export=(0.0,),
        pv_to_ac=(0.0,),
        grid_charge=(0.0,),
        pv_charge=(0.0,),
        discharge=(0.0,),
        reactive_support=(0.0,),
        soc=(10.0, 10.0),
        demand_peaks={"peak": 8.0},
    )
    calls = 0

    def fake_run_model(model, *, binary):
        nonlocal calls
        calls += 1
        return primary

    monkeypatch.setattr(
        optimizer_module,
        "_build_model",
        lambda *args, **kwargs: object(),
    )
    monkeypatch.setattr(optimizer_module, "_run_model", fake_run_model)
    monkeypatch.setattr(
        optimizer_module,
        "_prepare_secondary_model",
        lambda *args, **kwargs: pytest.fail("secondary solve must be deferred"),
    )

    result = optimizer_module._solve_two_stage(problem, cuts={}, binary=False)

    assert optimizer_module._whole_bill_kva_underapproximation_aud(
        problem,
        primary,
    ) == pytest.approx(40.0)
    assert calls == 1
    assert result.model_status is highspy.HighsModelStatus.kOptimal
    assert result is primary


def test_secondary_milp_timeout_preserves_timeout_status(monkeypatch):
    problem = _problem(
        intervals=_intervals((2.0, 8.0, 2.0)),
        battery=_battery(),
        demand_charges=(CiDemandCharge("peak", 20.0, (0, 1, 2)),),
    )
    primary = optimizer_module._SolvedDispatch(
        model_status=highspy.HighsModelStatus.kOptimal,
        objective=10.0,
        mip_gap_aud=0.0,
        grid_import=(2.0, 4.0, 2.0),
        pv_export=(0.0, 0.0, 0.0),
        pv_to_ac=(0.0, 0.0, 0.0),
        grid_charge=(0.0, 0.0, 0.0),
        pv_charge=(0.0, 0.0, 0.0),
        discharge=(0.0, 4.0, 0.0),
        reactive_support=(0.0, 0.0, 0.0),
        soc=(10.0, 10.0, 5.0, 10.0),
        demand_peaks={"peak": 4.0},
    )
    secondary = replace(
        primary,
        model_status=highspy.HighsModelStatus.kTimeLimit,
        objective=2.0,
    )
    results = iter((primary, secondary))

    monkeypatch.setattr(optimizer_module, "_build_model", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        optimizer_module,
        "_prepare_secondary_model",
        lambda model, **kwargs: model,
    )
    monkeypatch.setattr(
        optimizer_module,
        "_run_model",
        lambda model, *, binary: next(results),
    )

    result = optimizer_module._solve_two_stage(problem, cuts={}, binary=True)

    assert result.model_status is highspy.HighsModelStatus.kTimeLimit
    assert result.mip_gap_aud is None

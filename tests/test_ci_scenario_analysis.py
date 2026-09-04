from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from solar_battery import ci_scenario_analysis as scenario_module
from solar_battery.ci_scenario_analysis import (
    CiScenarioAnalysisError,
    _build_periods,
    _dispatch_review_projection,
    _optimizer_export_credit,
    _validated_scenarios,
    analyze_ci_physical_scenarios,
    analyze_ci_three_case_comparison,
)
from solar_battery.ci_peak_shaving_optimizer import (
    CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
    CiBillingPeriodResult,
    CiDemandChargeResult,
    CiDispatchInterval,
    CiOptimizerStatus,
    CiRollingReplayResult,
    CiRollingWindowAudit,
)
from tests.durable_test_helpers import create_test_client, sqlite_url_for_path


def _scenario(scenario_id: str, capacity: float, power: float) -> dict[str, object]:
    return {
        "scenario_id": scenario_id,
        "label": f"Synthetic {scenario_id}",
        "battery_system_id": scenario_id,
        "battery_technology_id": "generic_li_ion_ac",
        "control_profile_id": "demand_peak_shaving",
        "pv_system_id": "pv-one",
        "pv_profile_id": "generic_normalized_solar_shape_v1",
        "pv_capacity_kwp_dc": 10.0,
        "pv_inverter_capacity_kw_ac": 8.0,
        "shared_ac_headroom_kw": 50.0,
        "reactive_support_enabled": False,
        "reactive_support_max_kvar": 0.0,
        "shared_inverter_apparent_power_limit_kva": None,
        "reactive_capability_curve": "circular_pq",
        "reactive_capability_provenance": "analyst_assumption",
        "reactive_overcompensation_permitted": False,
        "pv_annual_specific_yield_kwh_per_kw": 1200.0,
        "pv_derating_factor": 0.9,
        "nominal_capacity_kwh": capacity,
        "max_charge_kw": power,
        "max_discharge_kw": power,
        "charge_efficiency": 0.95,
        "discharge_efficiency": 0.95,
        "min_soc_fraction": 0.1,
        "max_soc_fraction": 1.0,
        "initial_soc_fraction": 1.0,
        "allow_grid_charging": True,
    }


def _profile() -> dict[str, object]:
    return {
        "timezone_name": "Australia/Melbourne",
        "rolling_period": {"start_date": "2025-04-01", "end_date": "2026-03-31"},
        "billing_period": {"start_date": "2026-03-02", "end_date": "2026-03-02"},
        "rolling_demand_window": {
            "start": "07:00", "end": "19:00", "time_basis": "local", "excluded_dates": []
        },
        "incentive_demand_window": {
            "start": "16:00", "end": "19:00", "time_basis": "local", "excluded_dates": []
        },
        "retail_energy_window": {
            "start": "07:00", "end": "23:00", "time_basis": "meter_aest", "excluded_dates": []
        },
        "network_energy_window": {
            "start": "07:00", "end": "19:00", "time_basis": "local", "excluded_dates": []
        },
        "minimum_chargeable_rolling_kva": 10.0,
        "gst_rate": 0.1,
        "additional_bill_adjustment_aud": -5.0,
        "factors": {"mlf": 1.0, "dlf": 1.0},
        "rates": {
            "retail_peak_c_per_kwh": 10.0,
            "retail_off_peak_c_per_kwh": 10.0,
            "incentive_demand_aud_per_kva_month": 0.0,
            "rolling_demand_aud_per_kva_month": 1.0,
            "network_peak_c_per_kwh": 0.0,
            "network_off_peak_c_per_kwh": 0.0,
            "aemo_ancillary_c_per_kwh": 0.0,
            "aemo_participant_c_per_kwh": 0.0,
            "aemo_frc_c_per_day": 0.0,
            "environmental": [],
            "metering_aud_per_day": 0.0,
            "value_added_c_per_day": 0.0,
        },
        "annual_financial_model": {
            "method": "representative_year_repeat_v1",
            "incentive_demand_months": [12, 1, 2, 3],
            "incentive_demand_aud_per_kva_month": 2.0,
        },
    }


def test_optimizer_does_not_invent_export_revenue_from_import_charges() -> None:
    profile = _profile()
    profile["rates"]["aemo_ancillary_c_per_kwh"] = 1.5
    profile["rates"]["aemo_participant_c_per_kwh"] = 2.5

    assert _optimizer_export_credit(profile) == 0.0


def _streams() -> dict[str, dict[date, list[float]]]:
    def first_weekday(year: int, month: int) -> date:
        day = date(year, month, 1)
        while day.weekday() >= 5:
            day += timedelta(days=1)
        return day

    days = [first_weekday(2025, month) for month in range(4, 13)] + [
        first_weekday(2026, month) for month in range(1, 4)
    ]
    return {
        "B1": {day: [0.0] * 288 for day in days},
        "E1": {day: [1.0] * 288 for day in days},
        "Q1": {day: [0.75] * 288 for day in days},
    }


def _reactive_pv_only_scenarios() -> list[dict[str, object]]:
    disabled = _scenario("reactive-disabled", 0.0, 0.0)
    disabled |= {
        "battery_system_id": "battery-none",
        "pv_system_id": "pv-reactive-disabled",
    }
    enabled = {
        **disabled,
        "scenario_id": "reactive-enabled",
        "label": "Synthetic reactive-enabled",
        "pv_system_id": "pv-reactive-enabled",
        "reactive_support_enabled": True,
        "reactive_support_max_kvar": 9.0,
        "shared_inverter_apparent_power_limit_kva": 20.0,
    }
    return [disabled, enabled]


def _run_reactive_pv_only_scenarios(monkeypatch, profile):
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=profile,
        scenarios=_reactive_pv_only_scenarios(),
    )
    return {
        row["scenario_id"]: row
        for row in result["scenarios"]
    }


def _stub_rolling(problem):
    soc = problem.battery.nominal_capacity_kwh * problem.battery.initial_soc_fraction
    intervals = tuple(
        CiDispatchInterval(
            timestamp=row.timestamp,
            grid_import_kw=max(0.0, row.load_kw - 0.1),
            pv_export_kw=0.0,
            pv_to_ac_kw=0.0,
            shared_ac_port_kw=0.1,
            grid_charge_kw=0.0,
            pv_charge_kw=0.0,
            discharge_kw=0.1,
            soc_start_kwh=soc,
            soc_end_kwh=soc,
            dynamic_reserve_soc_kwh=(
                problem.battery.nominal_capacity_kwh
                * problem.battery.min_soc_fraction
            ),
            site_reactive_import_kvar=row.reactive_kvar,
            inverter_reactive_support_kvar=0.0,
            post_grid_reactive_kvar=row.reactive_kvar,
            exact_grid_import_kva=(
                max(0.0, row.load_kw - 0.1) ** 2 + row.reactive_kvar**2
            ) ** 0.5,
            shared_inverter_apparent_power_kva=0.1,
        )
        for row in problem.intervals
    )
    return CiRollingReplayResult(
        algorithm_id=CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
        status=CiOptimizerStatus.OPTIMAL_LP_EXACT,
        planner_status=CiOptimizerStatus.OPTIMAL_LP_EXACT,
        solver_version="test-stub",
        customer_facing_permission=False,
        recommendation_permitted=False,
        exact_replay_bill_aud=1.0,
        idle_baseline_bill_aud=2.0,
        optimization_exactness_gap_aud=0.0,
        bill_reconciliation_difference_aud=0.0,
        demand_charges=tuple(
            CiDemandChargeResult(item.component_id, item.basis, 1.0, 1.0, 1.0)
            for item in problem.demand_charges
        ),
        billing_periods=tuple(
            CiBillingPeriodResult(
                item.period_id,
                ("battery_idle", "optimized_dispatch"),
                "optimized_dispatch",
                soc,
                soc,
                0.0,
                0.0,
            )
            for item in problem.billing_periods
        ),
        intervals=intervals,
        windows=(
            CiRollingWindowAudit(
                0,
                len(intervals),
                len(intervals),
                0,
                CiOptimizerStatus.OPTIMAL_LP_EXACT,
                "lp",
                soc,
                soc,
                (),
            ),
        ),
        corrections=(),
        disclosures=("deterministic unit-test rolling replay",),
        annual_planner_demand_limits=tuple(
            (item.component_id, 100.0 + index)
            for index, item in enumerate(problem.demand_charges)
        ),
    )


def test_physical_scenario_review_is_ranked_without_commercial_claims(monkeypatch) -> None:
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.execute_ci_peak_shaving_rolling",
        _stub_rolling,
    )

    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=_profile(),
        scenarios=[_scenario("small", 10.0, 5.0), _scenario("large", 20.0, 10.0)],
    )

    assert result["contract_version"] == "ci_physical_scenario_review_v6"
    assert (
        result["calculation_revision"]
        == "ci_physical_scenario_planner_limits_primal_simplex_v1"
    )
    assert result["customer_facing_permission"] is False
    assert result["recommendation_permitted"] is False
    assert result["currency_values_permitted"] is True
    assert result["report_preview"]["download_available"] is False
    assert [row["physical_review_rank"] for row in result["scenarios"]] == [1, 2]
    assert all(
        len(row["selected_monthly_thresholds_kw"]) == 12
        for row in result["scenarios"]
    )
    assert all(
        row["selected_monthly_thresholds_kw"]
        == [None] * 8 + [101.0, 102.0, 103.0, 104.0]
        for row in result["scenarios"]
    )
    assert all(
        row["post_dispatch"]["billing_period_peak_effect"]
        in {"increase", "reduction", "unchanged"}
        for row in result["scenarios"]
    )
    assert "capex" not in str(result).lower()
    assert all(
        row["annual_tariff_value"]["first_year_value_ex_gst_aud"] > 0
        for row in result["scenarios"]
    )
    for row in result["scenarios"]:
        annual = row["annual_tariff_value"]
        assert annual["baseline_categories_ex_gst_aud"]["additional_charges"] == 0.0
        assert annual["scenario_categories_ex_gst_aud"]["additional_charges"] == 0.0
        assert annual["category_savings_ex_gst_aud"]["additional_charges"] == 0.0
        assert sum(annual["baseline_categories_ex_gst_aud"].values()) == pytest.approx(
            annual["baseline_cost_ex_gst_aud"], abs=0.05
        )
        assert sum(annual["scenario_categories_ex_gst_aud"].values()) == pytest.approx(
            annual["scenario_cost_ex_gst_aud"], abs=0.05
        )
        for key, saving in annual["category_savings_ex_gst_aud"].items():
            assert saving == pytest.approx(
                annual["baseline_categories_ex_gst_aud"][key]
                - annual["scenario_categories_ex_gst_aud"][key],
                abs=0.01,
            )
    assert all(
        row["post_dispatch"]["authority_source"]
        == CI_PEAK_SHAVING_ROLLING_REPLAY_ID
        for row in result["scenarios"]
    )
    assert all(
        row["optimizer_audit_projection"]["snapshot_sha256"]
        == row["optimizer_run_snapshot"]["snapshot_sha256"]
        for row in result["scenarios"]
    )
    assert all(
        row["optimizer_run_snapshot"]["physical_assumptions"][
            "reactive_support"
        ]
            == {
                "contract_version": "ci_reactive_support_v1",
                "enabled": False,
            "max_reactive_support_kvar": 0.0,
            "inverter_apparent_power_limit_kva": None,
            "capability_curve": "circular_pq",
            "provenance": "analyst_assumption",
            "overcompensation_permitted": False,
        }
        for row in result["scenarios"]
    )
    assert all(
        row["optimizer_run_snapshot"]["calculation_revision"]
        == "ci_optimizer_run_snapshot_planner_limits_primal_simplex_v1"
        for row in result["scenarios"]
    )
    assert all(
        row["optimizer_run_snapshot"]["result_projection"]
        ["planned_demand_limits_kva"]
        == row["planned_demand_limits_kva"]
        for row in result["scenarios"]
    )
    assert all(
        row["planned_demand_limits_kva"][0]
        == {
            "component_id": "annual_rolling_kva",
            "billing_period_id": None,
            "rate_aud_per_kva": 12.0,
            "planner_limit_kva": 100.0,
        }
        for row in result["scenarios"]
    )
    assert all(
        row["dispatch_review_projection"]["contract_version"]
        == "ci_dispatch_review_projection_v2"
        for row in result["scenarios"]
    )
    assert all(
        row["dispatch_review_projection"]["optimizer_snapshot_sha256"]
        == row["optimizer_run_snapshot"]["snapshot_sha256"]
        for row in result["scenarios"]
    )
    assert all(
        row["dispatch_review_projection"]["interval_dispatch_sha256"]
        == row["optimizer_run_snapshot"]["result_projection"][
            "interval_dispatch_sha256"
        ]
        for row in result["scenarios"]
    )
    assert all(
        row["dispatch_review_projection"]["soc_status"] == "available"
        and all(
            point["soc_end_kwh"] is not None
            for point in row["dispatch_review_projection"]["points"]
        )
        for row in result["scenarios"]
    )
    assert all(
        row["dispatch_review_projection"]["peak_interval"][
            "post_dispatch_kva"
        ]
        == pytest.approx(row["post_dispatch"]["raw_rolling_demand_kva"], abs=0.001)
        for row in result["scenarios"]
    )


def test_physical_scenario_review_prices_annual_baseline_once_per_request(
    monkeypatch,
) -> None:
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.execute_ci_peak_shaving_rolling",
        _stub_rolling,
    )
    from solar_battery import ci_scenario_analysis

    real_calculate = ci_scenario_analysis.calculate_ci_tariff_charges
    real_build_pv_profile = ci_scenario_analysis.build_pv_profile
    charge_calls = 0
    pv_profile_calls = 0

    def count_calculate(*args, **kwargs):
        nonlocal charge_calls
        charge_calls += 1
        return real_calculate(*args, **kwargs)

    def count_build_pv_profile(*args, **kwargs):
        nonlocal pv_profile_calls
        pv_profile_calls += 1
        return real_build_pv_profile(*args, **kwargs)

    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.calculate_ci_tariff_charges",
        count_calculate,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.build_pv_profile",
        count_build_pv_profile,
    )

    scenarios = [
        _scenario("small", 10.0, 5.0),
        _scenario("medium", 15.0, 7.5),
        _scenario("large", 20.0, 10.0),
    ]
    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=_profile(),
        scenarios=scenarios,
    )

    assert len(result["scenarios"]) == 3
    assert charge_calls == 4  # one shared baseline plus one price per scenario
    assert pv_profile_calls == 1


def test_selected_battery_scenarios_use_bounded_process_chunks(
    monkeypatch,
) -> None:
    profile = _profile()
    raw_streams = _streams()
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    created_workers: list[int] = []
    submitted_ids: list[list[str]] = []
    result_timeouts: list[float | None] = []
    shutdown_calls: list[tuple[bool, bool]] = []
    compiled_memberships = 0
    real_compile_membership = (
        scenario_module._compile_tariff_row_membership
    )

    def compile_membership(*args, **kwargs):
        nonlocal compiled_memberships
        compiled_memberships += 1
        return real_compile_membership(*args, **kwargs)

    class ImmediateFuture:
        def __init__(self, value):
            self.value = value

        def result(self, timeout=None):
            result_timeouts.append(timeout)
            return self.value

    class ImmediateProcessPool:
        def __init__(self, *, max_workers, **_kwargs):
            created_workers.append(max_workers)

        def submit(self, function, indexed, *args):
            submitted_ids.append(
                [scenario.scenario_id for _index, scenario in indexed]
            )
            assert all(argument is not raw_streams for argument in args)
            assert any(
                isinstance(argument, scenario_module._TariffRowMembership)
                for argument in args
            )
            return ImmediateFuture(function(indexed, *args))

        def shutdown(self, *, wait, cancel_futures=False):
            shutdown_calls.append((wait, cancel_futures))

    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "3")
    monkeypatch.setenv("CI_SCENARIO_PROCESS_TIMEOUT_SECONDS", "120")
    monkeypatch.setattr(
        scenario_module,
        "ProcessPoolExecutor",
        ImmediateProcessPool,
    )
    monkeypatch.setattr(
        scenario_module,
        "analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        scenario_module,
        "validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": raw_streams},
    )
    monkeypatch.setattr(
        scenario_module,
        "_compile_tariff_row_membership",
        compile_membership,
    )
    monkeypatch.setattr(
        scenario_module,
        "_row_in_window",
        lambda *_args, **_kwargs: pytest.fail(
            "tariff windows must not be reparsed inside each scenario"
        ),
    )
    monkeypatch.setattr(
        scenario_module,
        "execute_ci_peak_shaving_rolling",
        _stub_rolling,
    )

    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=profile,
        scenarios=[
            _scenario("battery-a", 10.0, 5.0),
            _scenario("battery-b", 20.0, 10.0),
        ],
    )

    assert created_workers == [2]
    assert len(result_timeouts) == 2
    assert all(
        timeout is not None and 0 < timeout <= 120
        for timeout in result_timeouts
    )
    assert shutdown_calls == [(False, False)]
    assert compiled_memberships == 1
    assert submitted_ids == [["battery-a"], ["battery-b"]]
    assert {row["scenario_id"] for row in result["scenarios"]} == {
        "battery-a",
        "battery-b",
    }


@pytest.mark.parametrize(
    ("configured", "expected"),
    [("1", 1), ("3", 3), ("0", 1), ("4", 1), ("invalid", 1)],
)
def test_scenario_worker_configuration_is_bounded(
    monkeypatch,
    configured,
    expected,
) -> None:
    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", configured)

    assert scenario_module._configured_scenario_process_workers() == expected


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("30", 30.0),
        ("600", 600.0),
        ("3600", 3600.0),
        ("29", 600.0),
        ("3601", 600.0),
        ("nan", 600.0),
        ("invalid", 600.0),
    ],
)
def test_scenario_process_timeout_configuration_is_bounded(
    monkeypatch,
    configured,
    expected,
) -> None:
    monkeypatch.setenv("CI_SCENARIO_PROCESS_TIMEOUT_SECONDS", configured)

    assert (
        scenario_module._configured_scenario_process_timeout_seconds()
        == expected
    )


def test_single_battery_scenario_uses_one_isolated_worker(monkeypatch) -> None:
    authored = _validated_scenarios([_scenario("battery-a", 10.0, 5.0)])
    worker_counts: list[int] = []

    def execute(indexed, *_args, worker_count):
        worker_counts.append(worker_count)
        return {
            index: {"scenario_id": scenario.scenario_id}
            for index, scenario in indexed
        }

    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "3")
    monkeypatch.setattr(
        scenario_module,
        "_SCENARIO_PROCESS_POOL_DISABLED",
        False,
    )
    monkeypatch.setattr(
        scenario_module,
        "_execute_battery_scenarios_in_processes",
        execute,
    )
    monkeypatch.setattr(
        scenario_module,
        "_run_scenario",
        lambda *_args: pytest.fail("a battery scenario must stay isolated"),
    )

    result = scenario_module._execute_authored_scenarios(
        authored,
        (),
        {},
        {},
        {},
        {},
        {},
    )

    assert result == [{"scenario_id": "battery-a"}]
    assert worker_counts == [1]


def test_process_pool_timeout_terminates_children_and_releases_lock(
    monkeypatch,
) -> None:
    authored = _validated_scenarios([_scenario("battery-a", 10.0, 5.0)])
    result_timeouts: list[float] = []
    shutdown_calls: list[tuple[bool, bool]] = []

    class StubbornProcess:
        def __init__(self):
            self.alive = True
            self.terminate_calls = 0
            self.kill_calls = 0
            self.join_calls: list[float] = []

        def is_alive(self):
            return self.alive

        def terminate(self):
            self.terminate_calls += 1

        def kill(self):
            self.kill_calls += 1
            self.alive = False

        def join(self, timeout):
            self.join_calls.append(timeout)

    class TimeoutFuture:
        def __init__(self):
            self.cancel_calls = 0

        def result(self, timeout):
            result_timeouts.append(timeout)
            raise scenario_module.FutureTimeoutError()

        def cancel(self):
            self.cancel_calls += 1
            return False

    process = StubbornProcess()
    future = TimeoutFuture()

    class TimeoutProcessPool:
        def __init__(self, **_kwargs):
            self._processes = {1: process}

        def submit(self, *_args):
            return future

        def shutdown(self, *, wait, cancel_futures=False):
            shutdown_calls.append((wait, cancel_futures))

    monkeypatch.setenv("CI_SCENARIO_PROCESS_TIMEOUT_SECONDS", "30")
    monkeypatch.setattr(
        scenario_module,
        "ProcessPoolExecutor",
        TimeoutProcessPool,
    )

    with pytest.raises(scenario_module._ScenarioProcessPoolTimedOut):
        scenario_module._execute_battery_scenarios_in_processes(
            tuple(enumerate(authored)),
            (),
            {},
            {},
            {},
            worker_count=1,
        )

    assert len(result_timeouts) == 1
    assert 0 < result_timeouts[0] <= 30
    assert future.cancel_calls == 1
    assert shutdown_calls == [(False, True)]
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert len(process.join_calls) == 2
    assert all(0 <= timeout <= 2 for timeout in process.join_calls)
    assert scenario_module._SCENARIO_PROCESS_POOL_LOCK.acquire(blocking=False)
    scenario_module._SCENARIO_PROCESS_POOL_LOCK.release()


def test_process_pool_timeout_fails_closed_without_serial_retry(monkeypatch) -> None:
    authored = _validated_scenarios([_scenario("battery-a", 10.0, 5.0)])
    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "2")
    monkeypatch.setattr(
        scenario_module,
        "_SCENARIO_PROCESS_POOL_DISABLED",
        False,
    )
    monkeypatch.setattr(
        scenario_module,
        "_execute_battery_scenarios_in_processes",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            scenario_module._ScenarioProcessPoolTimedOut("deadline")
        ),
    )
    monkeypatch.setattr(
        scenario_module,
        "_execute_battery_scenarios_serially",
        lambda *_args, **_kwargs: pytest.fail("timeout must not retry serially"),
    )

    with pytest.raises(CiScenarioAnalysisError) as exc_info:
        scenario_module._execute_authored_scenarios(
            authored,
            (),
            {},
            {},
            {},
            {},
            {},
        )

    assert exc_info.value.code == "scenario_execution_failed"


def test_process_capability_failure_falls_back_to_exact_serial_execution(
    monkeypatch,
) -> None:
    authored = _validated_scenarios(
        [
            _scenario("battery-a", 10.0, 5.0),
            _scenario("battery-b", 20.0, 10.0),
        ]
    )
    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "3")
    monkeypatch.setattr(
        scenario_module,
        "_SCENARIO_PROCESS_POOL_DISABLED",
        False,
    )
    monkeypatch.setattr(
        scenario_module,
        "_execute_battery_scenarios_in_processes",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            scenario_module._ScenarioProcessPoolUnavailable("not permitted")
        ),
    )
    monkeypatch.setattr(
        scenario_module,
        "_run_scenario",
        lambda scenario, *_args: {"scenario_id": scenario.scenario_id},
    )

    result = scenario_module._execute_authored_scenarios(
        authored,
        (),
        {},
        {},
        {},
        {},
        {},
    )

    assert [row["scenario_id"] for row in result] == ["battery-a", "battery-b"]


def test_broken_process_pool_retries_once_in_one_isolated_worker(
    monkeypatch,
) -> None:
    authored = _validated_scenarios(
        [
            _scenario("battery-a", 10.0, 5.0),
            _scenario("battery-b", 20.0, 10.0),
        ]
    )
    worker_counts = []

    def execute(indexed, *_args, worker_count):
        worker_counts.append(worker_count)
        if len(worker_counts) == 1:
            raise scenario_module._ScenarioProcessPoolBroken("child exited")
        return {
            index: {"scenario_id": scenario.scenario_id}
            for index, scenario in indexed
        }

    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "3")
    monkeypatch.setattr(
        scenario_module,
        "_SCENARIO_PROCESS_POOL_DISABLED",
        False,
    )
    monkeypatch.setattr(
        scenario_module,
        "_execute_battery_scenarios_in_processes",
        execute,
    )

    result = scenario_module._execute_authored_scenarios(
        authored,
        (),
        {},
        {},
        {},
        {},
        {},
    )

    assert worker_counts == [2, 1]
    assert [row["scenario_id"] for row in result] == ["battery-a", "battery-b"]


def test_unexpected_process_failure_is_reported_fail_closed(monkeypatch) -> None:
    authored = _validated_scenarios(
        [
            _scenario("battery-a", 10.0, 5.0),
            _scenario("battery-b", 20.0, 10.0),
        ]
    )
    monkeypatch.setenv("CI_SCENARIO_PROCESS_WORKERS", "3")
    monkeypatch.setattr(
        scenario_module,
        "_SCENARIO_PROCESS_POOL_DISABLED",
        False,
    )
    monkeypatch.setattr(
        scenario_module,
        "_execute_battery_scenarios_in_processes",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            scenario_module._ScenarioProcessExecutionFailed("unexpected")
        ),
    )

    with pytest.raises(CiScenarioAnalysisError) as exc_info:
        scenario_module._execute_authored_scenarios(
            authored,
            (),
            {},
            {},
            {},
            {},
            {},
        )

    assert exc_info.value.code == "scenario_execution_failed"


def test_zero_priced_demand_components_are_unplanned_and_report_null_limits(
    monkeypatch,
) -> None:
    profile = _profile()
    profile["rates"]["rolling_demand_aud_per_kva_month"] = 0.0
    profile["annual_financial_model"][
        "incentive_demand_aud_per_kva_month"
    ] = 0.0
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    captured_problems = []

    def capture_problem(problem):
        captured_problems.append(problem)
        return _stub_rolling(problem)

    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.execute_ci_peak_shaving_rolling",
        capture_problem,
    )

    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=profile,
        scenarios=[_scenario("zero-demand-rates", 10.0, 5.0)],
    )

    assert len(captured_problems) == 1
    assert captured_problems[0].demand_charges == ()
    row = result["scenarios"][0]
    assert row["selected_monthly_thresholds_kw"] == [None] * 12
    assert len(row["planned_demand_limits_kva"]) == 5
    assert all(
        item["rate_aud_per_kva"] == 0.0
        and item["planner_limit_kva"] is None
        for item in row["planned_demand_limits_kva"]
    )


def test_reactive_scenario_contract_is_explicit_and_fail_closed() -> None:
    enabled = {
        **_scenario("reactive", 20.0, 10.0),
        "reactive_support_enabled": True,
        "reactive_support_max_kvar": 80.0,
        "shared_inverter_apparent_power_limit_kva": 275.0,
    }

    scenario = _validated_scenarios([enabled])[0]

    assert scenario.reactive_support_enabled is True
    assert scenario.reactive_support_max_kvar == 80.0
    assert scenario.shared_inverter_apparent_power_limit_kva == 275.0
    assert scenario.reactive_capability_provenance == "analyst_assumption"
    assert scenario.reactive_overcompensation_permitted is False

    for invalid in (
        {**enabled, "reactive_capability_provenance": "fox_confirmed"},
        {**enabled, "reactive_overcompensation_permitted": True},
        {**enabled, "reactive_support_max_kvar": 0.0},
        {
            **_scenario("disabled", 20.0, 10.0),
            "reactive_support_max_kvar": 80.0,
        },
    ):
        with pytest.raises(CiScenarioAnalysisError):
            _validated_scenarios([invalid])


def test_reactive_support_reduces_kva_and_annual_tariff_cost_when_kva_demand_is_priced(
    monkeypatch,
) -> None:
    profile = _profile()

    scenarios = _run_reactive_pv_only_scenarios(monkeypatch, profile)
    disabled = scenarios["reactive-disabled"]
    enabled = scenarios["reactive-enabled"]

    assert disabled["post_dispatch"]["maximum_reactive_support_kvar"] == 0.0
    assert enabled["post_dispatch"]["maximum_reactive_support_kvar"] > 0.0
    assert (
        enabled["post_dispatch"]["raw_rolling_demand_kva"]
        < disabled["post_dispatch"]["raw_rolling_demand_kva"]
    )
    disabled_value = disabled["annual_tariff_value"]
    enabled_value = enabled["annual_tariff_value"]
    assert (
        enabled_value["scenario_cost_ex_gst_aud"]
        < disabled_value["scenario_cost_ex_gst_aud"]
    )
    assert (
        enabled_value["first_year_value_ex_gst_aud"]
        > disabled_value["first_year_value_ex_gst_aud"]
    )
    assert (
        enabled_value["category_savings_ex_gst_aud"]["network_charges"]
        > disabled_value["category_savings_ex_gst_aud"]["network_charges"]
    )


def test_unpriced_reactive_support_improves_physical_kva_without_dollar_value(
    monkeypatch,
) -> None:
    profile = _profile()
    profile["rates"]["incentive_demand_aud_per_kva_month"] = 0.0
    profile["rates"]["rolling_demand_aud_per_kva_month"] = 0.0
    profile["annual_financial_model"][
        "incentive_demand_aud_per_kva_month"
    ] = 0.0

    scenarios = _run_reactive_pv_only_scenarios(monkeypatch, profile)
    disabled = scenarios["reactive-disabled"]
    enabled = scenarios["reactive-enabled"]

    assert disabled["post_dispatch"]["maximum_reactive_support_kvar"] == 0.0
    assert enabled["post_dispatch"]["maximum_reactive_support_kvar"] > 0.0
    assert (
        enabled["post_dispatch"]["raw_rolling_demand_kva"]
        < disabled["post_dispatch"]["raw_rolling_demand_kva"]
    )
    disabled_value = disabled["annual_tariff_value"]
    enabled_value = enabled["annual_tariff_value"]
    assert enabled_value["scenario_cost_ex_gst_aud"] == disabled_value[
        "scenario_cost_ex_gst_aud"
    ]
    assert enabled_value["first_year_value_ex_gst_aud"] == disabled_value[
        "first_year_value_ex_gst_aud"
    ]
    assert enabled_value["category_savings_ex_gst_aud"][
        "network_charges"
    ] == disabled_value["category_savings_ex_gst_aud"]["network_charges"]


def test_dispatch_review_projection_selects_earliest_equal_post_kva_peak() -> None:
    fixed_aest = timezone(timedelta(hours=10), name="AEST")
    timestamps = tuple(
        datetime(2026, 1, 5, 12, minute, tzinfo=fixed_aest)
        for minute in (0, 15, 30)
    )
    post_kva = (20.0, 30.0, 30.0)
    rows = [
        {
            "meter_start": timestamp,
            "local_start": timestamp,
            "rolling_window": True,
            "baseline_kw": 35.0,
            "post_kw": value - 5.0,
            "baseline_kva": 40.0,
            "post_kva": value,
            "site_import_kvar": 5.0,
            "reactive_support_kvar": 0.0,
            "post_grid_kvar": 5.0,
        }
        for timestamp, value in zip(timestamps, post_kva, strict=True)
    ]
    dispatch = tuple(
        {
            "timestamp": timestamp,
            "grid_charge_kw": 0.0,
            "pv_charge_kw": 1.0,
            "discharge_kw": 2.0,
            "soc_end_kwh": 50.0 - index,
        }
        for index, timestamp in enumerate(timestamps)
    )
    projection = _dispatch_review_projection(
        rows=rows,
        dispatch=dispatch,
        authority_source=CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
        optimizer_snapshot={
            "snapshot_sha256": "a" * 64,
            "result_projection": {"interval_dispatch_sha256": "b" * 64},
        },
    )

    assert projection["selection_basis"] == (
        "maximum_post_dispatch_rolling_kva_earliest_timestamp"
    )
    assert projection["peak_interval"]["interval_timestamp"] == (
        timestamps[1].isoformat()
    )
    assert projection["peak_interval"]["post_dispatch_kva"] == 30.0
    assert projection["coverage"]["interval_count"] == 3
    assert projection["soc_status"] == "available"
    assert projection["optimizer_snapshot_sha256"] == "a" * 64
    assert projection["interval_dispatch_sha256"] == "b" * 64
    assert len(projection["projection_sha256"]) == 64


def test_three_case_comparison_uses_explicit_pair_and_one_aligned_common_day(
    monkeypatch,
) -> None:
    profile = _profile()
    profile.update(
        {
            "profile_id": "synthetic",
            "source_version": "synthetic-v1",
            "expected_nem12_sha256": "d" * 64,
        }
    )
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.execute_ci_peak_shaving_rolling",
        _stub_rolling,
    )
    pv_only = _scenario("pv-only", 0.0, 0.0)
    pv_battery = _scenario("pv-battery", 20.0, 10.0)

    result = analyze_ci_three_case_comparison(
        b"synthetic",
        profile=profile,
        scenarios=[pv_only, pv_battery],
        pv_only_scenario_id="pv-only",
        pv_battery_scenario_id="pv-battery",
    )

    assert result["contract_version"] == "ci_three_case_peak_day_comparison_v2"
    assert result["pairing_basis"] == "explicit_consultant_selected_exact_pv_match"
    assert result["selection_basis"] == (
        "pv_battery_maximum_post_dispatch_rolling_kva_earliest_timestamp"
    )
    assert result["common_local_date"] == "2025-04-01"
    assert result["selected_peak_interval_timestamp"].endswith("06:00:00+10:00")
    assert result["coverage"] == {
        "interval_minutes": 15,
        "interval_count": 92,
        "start_local_timestamp": "2025-04-01T01:00:00+11:00",
        "end_local_timestamp": "2025-04-01T23:45:00+11:00",
        "timestamps_aligned": True,
    }
    assert [case["case_id"] for case in result["cases"]] == [
        "no_system",
        "pv_only",
        "pv_battery",
    ]
    assert result["cases"][0]["scenario_id"] is None
    assert result["cases"][1]["scenario_id"] == "pv-only"
    assert result["cases"][2]["scenario_id"] == "pv-battery"
    assert result["cases"][2]["optimizer_snapshot_sha256"]
    assert result["cases"][2]["interval_dispatch_sha256"]
    assert result["baseline"] == {
        "raw_rolling_demand_kva": 15.0,
        "chargeable_rolling_demand_kva": 15.0,
        "incentive_demand_kva": 15.0,
        "billing_period_max_kva": 15.0,
        "billing_period_max_kw": 12.0,
    }
    assert all(
        point["no_system"]["soc_end_kwh"] is None
        and point["pv_only"]["soc_end_kwh"] is None
        and point["pv_only"]["grid_charge_kw"] == 0
        and point["pv_only"]["pv_charge_kw"] == 0
        and point["pv_only"]["battery_discharge_kw"] == 0
        and point["pv_battery"]["soc_end_kwh"] is not None
        for point in result["points"]
    )
    assert result["provenance"]["source_nem12_sha256"] == "d" * 64
    assert len(result["comparison_sha256"]) == 64
    assert result["customer_facing_permission"] is False
    assert result["recommendation_permitted"] is False
    assert result["eligibility_permitted"] is False
    assert result["report_available"] is False
    assert result["download_available"] is False
    assert result["delivery_permitted"] is False


@pytest.mark.parametrize(
    ("pv_only_update", "battery_update"),
    [
        ({"nominal_capacity_kwh": 10.0, "max_charge_kw": 5.0, "max_discharge_kw": 5.0}, {}),
        ({}, {"pv_system_id": "another-pv"}),
        ({}, {"pv_capacity_kwp_dc": 20.0}),
    ],
)
def test_three_case_comparison_fails_closed_on_ambiguous_or_nonmatching_pair(
    pv_only_update, battery_update
) -> None:
    pv_only = _scenario("pv-only", 0.0, 0.0)
    pv_battery = _scenario("pv-battery", 20.0, 10.0)
    pv_only.update(pv_only_update)
    pv_battery.update(battery_update)

    with pytest.raises(CiScenarioAnalysisError) as error:
        analyze_ci_three_case_comparison(
            b"unused",
            profile={},
            scenarios=[pv_only, pv_battery],
            pv_only_scenario_id="pv-only",
            pv_battery_scenario_id="pv-battery",
        )

    assert error.value.code in {
        "scenario_contract_invalid",
        "comparison_contract_invalid",
        "comparison_pair_invalid",
    }


def test_physical_scenario_marks_disjoint_bill_peak_as_not_evaluated(
    monkeypatch,
) -> None:
    profile = _profile()
    profile["billing_period"] = {
        "start_date": "2027-03-02",
        "end_date": "2027-03-02",
    }
    baseline = {
        "profile": {"profile_id": "synthetic"},
        "demand_evidence": {
            "rolling_demand_kva": 15.0,
            "chargeable_rolling_demand_kva": 15.0,
            "incentive_demand_kva": 15.0,
            "billing_period_max_kva": 15.0,
            "billing_period_max_kw": 12.0,
        },
    }
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: baseline,
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.execute_ci_peak_shaving_rolling",
        _stub_rolling,
    )

    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=profile,
        scenarios=[_scenario("disjoint", 10.0, 5.0)],
    )

    post_dispatch = result["scenarios"][0]["post_dispatch"]
    assert post_dispatch["billing_period_projection_status"] == (
        "not_evaluated_disjoint_analysis_period"
    )
    assert post_dispatch["billing_period_max_kva"] is None
    assert post_dispatch["billing_period_peak_change_kw"] is None


def test_physical_scenario_review_rejects_incomplete_authored_inputs() -> None:
    scenario = _scenario("incomplete", 10.0, 5.0)
    scenario.pop("pv_profile_id")
    with pytest.raises(CiScenarioAnalysisError) as error:
        analyze_ci_physical_scenarios(
            b"unused",
            profile={},
            scenarios=[scenario],
        )
    assert error.value.code == "scenario_contract_invalid"


def test_physical_scenario_review_rejects_soc_outside_optimizer_v1_contract() -> None:
    scenario = _scenario("unsupported-soc", 10.0, 5.0)
    scenario["max_soc_fraction"] = 0.9
    scenario["initial_soc_fraction"] = 0.5
    with pytest.raises(CiScenarioAnalysisError) as error:
        _validated_scenarios([scenario])
    assert error.value.code == "scenario_contract_invalid"


def test_physical_scenario_review_accepts_ten_to_ninety_percent_soc_window() -> None:
    scenario = _scenario("supported-soc", 10.0, 5.0)
    scenario["max_soc_fraction"] = 0.9
    scenario["initial_soc_fraction"] = 0.9

    validated = _validated_scenarios([scenario])

    assert validated[0].min_soc_fraction == 0.1
    assert validated[0].max_soc_fraction == 0.9
    assert validated[0].initial_soc_fraction == 0.9


def test_physical_scenario_periods_use_explicit_analysis_period() -> None:
    profile = _profile()
    profile["analysis_period"] = profile["rolling_period"]
    profile["rolling_period"] = profile["billing_period"]

    periods, _evidence = _build_periods(_streams(), profile)

    assert len(periods) == 12
    assert periods[0].period_id == "2025-04"
    assert periods[-1].period_id == "2026-03"


def test_precompiled_tariff_membership_matches_row_classification() -> None:
    profile = _profile()
    periods, evidence = _build_periods(_streams(), profile)
    membership = scenario_module._compile_tariff_row_membership(
        periods,
        evidence,
        profile,
    )
    rows = [
        evidence[interval.timestamp]
        for period in periods
        for interval in period.intervals
    ]

    for index, row in enumerate(rows):
        assert bool(membership.retail_energy_peak[index]) == (
            scenario_module._row_in_window(
                row,
                profile["retail_energy_window"],
            )
        )
        assert bool(membership.network_energy_peak[index]) == (
            scenario_module._row_in_window(
                row,
                profile["network_energy_window"],
            )
        )
        assert bool(membership.annual_rolling_demand[index]) == (
            scenario_module._row_in_window(
                row,
                profile["rolling_demand_window"],
            )
        )
        assert bool(membership.incentive_demand[index]) == (
            scenario_module._row_in_window(
                row,
                profile["incentive_demand_window"],
            )
        )
        assert membership.optimizer_import_rates[index] == pytest.approx(
            scenario_module._optimizer_import_rate(row, profile)
        )


def test_physical_scenario_periods_support_a_rolling_annual_start_date() -> None:
    profile = _profile()
    profile["rolling_period"] = {
        "start_date": "2025-01-06",
        "end_date": "2026-01-05",
    }
    profile["analysis_period"] = dict(profile["rolling_period"])
    days = [date(2025, month, 6) for month in range(1, 13)]
    streams = {
        register: {day: [value] * 288 for day in days}
        for register, value in {"B1": 0.0, "E1": 1.0, "K1": 0.0, "Q1": 0.75}.items()
    }

    periods, _evidence = _build_periods(streams, profile)

    assert len(periods) == 12
    assert periods[0].period_id == "2025-01"
    assert periods[-1].period_id == "2025-12"


def test_physical_scenario_review_fails_closed_on_noncontiguous_rolling_input(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: {
            "profile": {"profile_id": "synthetic"},
            "demand_evidence": {
                "rolling_demand_kva": 15.0,
                "chargeable_rolling_demand_kva": 15.0,
                "incentive_demand_kva": 15.0,
                "billing_period_max_kva": 15.0,
                "billing_period_max_kw": 12.0,
            },
        },
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )

    with pytest.raises(CiScenarioAnalysisError) as error:
        analyze_ci_physical_scenarios(
            b"synthetic",
            profile=_profile(),
            scenarios=[_scenario("sparse", 10.0, 5.0)],
        )
    assert error.value.code == "scenario_execution_failed"


def test_physical_scenario_review_accepts_large_system_matrix(monkeypatch) -> None:
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: {
            "profile": {"profile_id": "synthetic"},
            "demand_evidence": {
                "rolling_demand_kva": 15.0,
                "chargeable_rolling_demand_kva": 15.0,
                "incentive_demand_kva": 15.0,
                "billing_period_max_kva": 15.0,
                "billing_period_max_kw": 12.0,
            },
        },
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.execute_ci_peak_shaving_rolling",
        _stub_rolling,
    )

    systems = [
        _scenario(f"system-{index:02d}", 50.0 + index * 10.0, 25.0 + index * 5.0)
        for index in range(12)
    ]
    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=_profile(),
        scenarios=systems,
    )

    assert len(result["scenarios"]) == 12
    assert {row["scenario_id"] for row in result["scenarios"]} == {
        item["scenario_id"] for item in systems
    }


def test_physical_scenario_review_accepts_zero_size_component_options(monkeypatch) -> None:
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: {
            "profile": {"profile_id": "synthetic"},
            "demand_evidence": {
                "rolling_demand_kva": 15.0,
                "chargeable_rolling_demand_kva": 15.0,
                "incentive_demand_kva": 15.0,
                "billing_period_max_kva": 15.0,
                "billing_period_max_kw": 12.0,
            },
        },
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": _streams()},
    )
    scenario = _scenario("no-pv-no-battery", 0.0, 0.0)
    scenario |= {
        "pv_capacity_kwp_dc": 0.0,
        "pv_inverter_capacity_kw_ac": 0.0,
    }

    result = analyze_ci_physical_scenarios(
        b"synthetic", profile=_profile(), scenarios=[scenario]
    )

    row = result["scenarios"][0]
    assert row["post_dispatch"]["pv_generation_kwh"] == 0.0
    assert row["selected_monthly_thresholds_kw"] == [None] * 12
    assert row["annual_tariff_value"]["first_year_value_ex_gst_aud"] == 0.0
    projection = row["dispatch_review_projection"]
    assert projection["soc_status"] == "not_applicable_no_battery"
    assert projection["optimizer_snapshot_sha256"] is None
    assert projection["interval_dispatch_sha256"] is None
    assert all(point["soc_end_kwh"] is None for point in projection["points"])
    assert all(
        point["grid_charge_kw"] == 0.0
        and point["pv_charge_kw"] == 0.0
        and point["battery_discharge_kw"] == 0.0
        for point in projection["points"]
    )


def test_solution_matrix_accepts_200_combinations_and_enforces_component_limits() -> None:
    matrix: list[dict[str, object]] = []
    for pv_index in range(20):
        for battery_index in range(10):
            item = _scenario(
                f"pv-{pv_index:02d}__battery-{battery_index:02d}",
                50.0 + battery_index * 10.0,
                25.0 + battery_index * 5.0,
            )
            item |= {
                "battery_system_id": f"battery-{battery_index:02d}",
                "pv_system_id": f"pv-{pv_index:02d}",
                "pv_capacity_kwp_dc": 50.0 + pv_index * 10.0,
                "pv_inverter_capacity_kw_ac": 40.0 + pv_index * 8.0,
            }
            matrix.append(item)

    assert len(_validated_scenarios(matrix)) == 200

    too_many_batteries = []
    for index in range(16):
        item = _scenario(f"battery-{index:02d}", 50.0 + index, 25.0)
        item["pv_system_id"] = "pv-one"
        too_many_batteries.append(item)
    with pytest.raises(CiScenarioAnalysisError):
        _validated_scenarios(too_many_batteries)

    too_many_pv = []
    for index in range(21):
        item = _scenario(f"pv-{index:02d}", 50.0, 25.0)
        item |= {
            "battery_system_id": "battery-one",
            "pv_system_id": f"pv-{index:02d}",
            "pv_capacity_kwp_dc": 50.0 + index,
            "pv_inverter_capacity_kw_ac": 40.0 + index,
        }
        too_many_pv.append(item)
    with pytest.raises(CiScenarioAnalysisError):
        _validated_scenarios(too_many_pv)


def test_physical_scenario_review_dispatches_all_200_solutions(monkeypatch) -> None:
    matrix: list[dict[str, object]] = []
    for pv_index in range(20):
        for battery_index in range(10):
            item = _scenario(
                f"pv-{pv_index:02d}__battery-{battery_index:02d}",
                50.0 + battery_index * 10.0,
                25.0 + battery_index * 5.0,
            )
            item |= {
                "battery_system_id": f"battery-{battery_index:02d}",
                "pv_system_id": f"pv-{pv_index:02d}",
                "pv_capacity_kwp_dc": 50.0 + pv_index * 10.0,
                "pv_inverter_capacity_kw_ac": 40.0 + pv_index * 8.0,
            }
            matrix.append(item)

    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.analyze_ci_nem12",
        lambda *_args, **_kwargs: {
            "profile": {"profile_id": "synthetic"},
            "demand_evidence": {
                "rolling_demand_kva": 15.0,
                "chargeable_rolling_demand_kva": 15.0,
                "incentive_demand_kva": 15.0,
                "billing_period_max_kva": 15.0,
                "billing_period_max_kw": 12.0,
            },
        },
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis.validated_ci_nem12_evidence",
        lambda *_args, **_kwargs: {"streams": {}},
    )
    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis._build_periods",
        lambda *_args, **_kwargs: ((), {}),
    )
    dispatched: list[str] = []

    def fake_run(scenario, *_args):
        dispatched.append(scenario.scenario_id)
        return {
            "scenario_id": scenario.scenario_id,
            "label": scenario.label,
            "physical_review_rank": 0,
            "authored_inputs": {
                "pv_capacity_kwp_dc": scenario.pv_capacity_kwp_dc,
                "nominal_capacity_kwh": scenario.nominal_capacity_kwh,
            },
            "post_dispatch": {"raw_rolling_demand_kva": 10.0},
        }

    monkeypatch.setattr(
        "solar_battery.ci_scenario_analysis._run_scenario",
        fake_run,
    )

    result = analyze_ci_physical_scenarios(
        b"synthetic",
        profile=_profile(),
        scenarios=matrix,
    )

    assert len(dispatched) == 200
    assert len(result["scenarios"]) == 200
    assert {row["scenario_id"] for row in result["scenarios"]} == set(dispatched)


def test_physical_scenario_api_scopes_and_serializes_the_python_contract(
    tmp_path, monkeypatch
) -> None:
    expected = {
        "contract_version": "ci_physical_scenario_review_v6",
        "analysis_status": "ready",
    }
    monkeypatch.setattr("api.ci_routes.load_ci_tariff_profile", lambda: {})
    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_physical_scenarios",
        lambda upload_bytes, *, profile, scenarios: expected,
    )
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-scenarios.sqlite3")) as client:
        response = client.post(
            "/api/commercial-industrial/powercor-llvt2-physical-scenarios",
            files={"file": ("synthetic.csv", b"synthetic", "text/csv")},
            data={"scenarios": "[]"},
        )
    assert response.status_code == 200
    assert response.json() == expected


def test_three_case_comparison_api_serializes_exact_python_contract(
    tmp_path, monkeypatch
) -> None:
    expected = {
        "contract_version": "ci_three_case_peak_day_comparison_v2",
        "status": "ready",
    }
    captured: dict[str, object] = {}
    monkeypatch.setattr("api.ci_routes.load_ci_tariff_profile", lambda: {})

    def compare(upload_bytes, *, profile, scenarios, pv_only_scenario_id, pv_battery_scenario_id):
        captured.update(
            {
                "upload_bytes": upload_bytes,
                "profile": profile,
                "scenarios": scenarios,
                "pv_only_scenario_id": pv_only_scenario_id,
                "pv_battery_scenario_id": pv_battery_scenario_id,
            }
        )
        return expected

    monkeypatch.setattr(
        "api.ci_routes.analyze_ci_three_case_comparison", compare
    )
    with create_test_client(sqlite_url_for_path(tmp_path / "ci-comparison.sqlite3")) as client:
        response = client.post(
            "/api/commercial-industrial/powercor-llvt2-three-case-comparison",
            files={"file": ("synthetic.csv", b"synthetic", "text/csv")},
            data={
                "scenarios": '[{"scenario_id":"pv-only"}]',
                "pv_only_scenario_id": "pv-only",
                "pv_battery_scenario_id": "pv-battery",
            },
        )
    assert response.status_code == 200
    assert response.json() == expected
    assert captured == {
        "upload_bytes": b"synthetic",
        "profile": {},
        "scenarios": [{"scenario_id": "pv-only"}],
        "pv_only_scenario_id": "pv-only",
        "pv_battery_scenario_id": "pv-battery",
    }

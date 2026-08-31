from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
import math
from typing import Literal

import highspy


CI_PEAK_SHAVING_OPTIMIZER_ID = "ci_peak_shaving_highs_v2"
CI_PEAK_SHAVING_ROLLING_REPLAY_ID = "ci_peak_shaving_rolling_replay_v2"
CI_REACTIVE_SUPPORT_CONTRACT_VERSION = "ci_reactive_support_v1"
PRIMARY_OBJECTIVE_TOLERANCE_AUD = 0.01
MATERIALITY_TOLERANCE_AUD = 5.0
SIMULTANEOUS_FLOW_TOLERANCE_KW = 1e-7
PRIMARY_COST_BOUND_BLOCK_NONZEROS = 384
KVA_CUT_BATCH_SIZE = 4
WEAR_SHADOW_COST_AUD_PER_DISCHARGED_KWH = 0.05
DEFAULT_SHARED_AC_HEADROOM_KW = 250.0
PQ_CAPABILITY_SEGMENTS = 16


class CiOptimizerStatus(str, Enum):
    OPTIMAL_LP_EXACT = "optimal_lp_exact"
    OPTIMAL_MILP = "optimal_milp"
    BOUNDED_OPTIMAL = "bounded_optimal"
    INFEASIBLE_PHYSICAL = "infeasible_physical"
    SOLVER_TIMEOUT = "solver_timeout"
    NUMERICAL_FAILURE = "numerical_failure"
    MODEL_FAILURE = "model_failure"
    BILL_RECONCILIATION_FAILED = "bill_reconciliation_failed"


@dataclass(frozen=True)
class CiBatterySpec:
    nominal_capacity_kwh: float
    min_soc_fraction: float
    max_soc_fraction: float
    max_charge_kw: float
    max_discharge_kw: float
    ac_round_trip_efficiency: float
    initial_soc_fraction: float = 1.0
    terminal_soc_fraction: float = 1.0

    def __post_init__(self) -> None:
        for name in (
            "nominal_capacity_kwh",
            "max_charge_kw",
            "max_discharge_kw",
        ):
            _finite_positive(name, getattr(self, name))
        for name in (
            "min_soc_fraction",
            "max_soc_fraction",
            "ac_round_trip_efficiency",
            "initial_soc_fraction",
            "terminal_soc_fraction",
        ):
            _finite(name, getattr(self, name))
        if not 0 <= self.min_soc_fraction < self.max_soc_fraction <= 1:
            raise ValueError("battery SOC fractions must satisfy 0 <= min < max <= 1")
        if self.min_soc_fraction != 0.1 or self.max_soc_fraction != 1.0:
            raise ValueError("V1 battery SOC bounds are fixed at 10% and 100%")
        if not 0 < self.ac_round_trip_efficiency <= 1:
            raise ValueError("ac_round_trip_efficiency must be in (0, 1]")
        for name in ("initial_soc_fraction", "terminal_soc_fraction"):
            value = getattr(self, name)
            if not self.min_soc_fraction <= value <= self.max_soc_fraction:
                raise ValueError(f"{name} must be within the battery SOC bounds")
        if self.initial_soc_fraction != self.terminal_soc_fraction:
            raise ValueError(
                "V1 requires equal initial and terminal SOC so battery_idle remains feasible"
            )
        if self.initial_soc_fraction != 1.0:
            raise ValueError("V1 initial and terminal SOC are fixed at 100%")
        if self.max_charge_kw != self.max_discharge_kw:
            raise ValueError("V1 charge and discharge power limits must be symmetric")

    @property
    def symmetric_efficiency(self) -> float:
        return math.sqrt(self.ac_round_trip_efficiency)


@dataclass(frozen=True)
class CiOptimizerInterval:
    timestamp: datetime
    duration_hours: float
    load_kw: float
    pv_kw: float
    reactive_kvar: float
    import_rate_aud_per_kwh: float
    export_credit_aud_per_kwh: float

    def __post_init__(self) -> None:
        if not isinstance(self.timestamp, datetime):
            raise ValueError("timestamp must be a datetime")
        _finite_positive("duration_hours", self.duration_hours)
        for name in (
            "load_kw",
            "pv_kw",
            "reactive_kvar",
            "import_rate_aud_per_kwh",
            "export_credit_aud_per_kwh",
        ):
            _finite_non_negative(name, getattr(self, name))
        if self.export_credit_aud_per_kwh > self.import_rate_aud_per_kwh:
            raise ValueError("export credit cannot exceed the interval import rate")


@dataclass(frozen=True)
class CiDemandCharge:
    component_id: str
    rate_aud_per_unit: float
    interval_indexes: tuple[int, ...]
    basis: Literal["kw", "kva"] = "kw"
    minimum_chargeable: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.component_id, str) or not self.component_id.strip():
            raise ValueError("component_id must be non-blank text")
        object.__setattr__(self, "component_id", self.component_id.strip())
        _finite_non_negative("rate_aud_per_unit", self.rate_aud_per_unit)
        _finite_non_negative("minimum_chargeable", self.minimum_chargeable)
        if self.basis not in {"kw", "kva"}:
            raise ValueError("demand basis must be kw or kva")
        indexes = tuple(self.interval_indexes)
        if not indexes or any(
            isinstance(index, bool) or not isinstance(index, int) or index < 0
            for index in indexes
        ):
            raise ValueError("interval_indexes must contain non-negative integers")
        if len(set(indexes)) != len(indexes):
            raise ValueError("interval_indexes must be unique")
        object.__setattr__(self, "interval_indexes", indexes)


@dataclass(frozen=True)
class CiBillingPeriod:
    period_id: str
    interval_indexes: tuple[int, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.period_id, str) or not self.period_id.strip():
            raise ValueError("period_id must be non-blank text")
        object.__setattr__(self, "period_id", self.period_id.strip())
        indexes = tuple(self.interval_indexes)
        if not indexes or any(
            isinstance(index, bool) or not isinstance(index, int) or index < 0
            for index in indexes
        ):
            raise ValueError("billing interval_indexes must contain non-negative integers")
        if tuple(range(indexes[0], indexes[-1] + 1)) != indexes:
            raise ValueError("billing interval_indexes must be contiguous and ordered")
        object.__setattr__(self, "interval_indexes", indexes)


@dataclass(frozen=True)
class CiReactiveSupportSpec:
    enabled: bool = False
    max_reactive_support_kvar: float = 0.0
    inverter_apparent_power_limit_kva: float | None = None
    capability_curve: Literal["circular_pq"] = "circular_pq"
    provenance: Literal["analyst_assumption"] = "analyst_assumption"
    overcompensation_permitted: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.enabled, bool):
            raise ValueError("reactive support enabled must be a bool")
        _finite_non_negative(
            "max_reactive_support_kvar", self.max_reactive_support_kvar
        )
        if self.capability_curve != "circular_pq":
            raise ValueError("reactive support capability curve must be circular_pq")
        if self.provenance != "analyst_assumption":
            raise ValueError("reactive support provenance must be analyst_assumption")
        if self.overcompensation_permitted is not False:
            raise ValueError("reactive overcompensation is not permitted")
        if self.enabled:
            if self.max_reactive_support_kvar <= 0:
                raise ValueError("enabled reactive support requires a positive kvar cap")
            if self.inverter_apparent_power_limit_kva is None:
                raise ValueError("enabled reactive support requires an apparent-power limit")
            _finite_positive(
                "inverter_apparent_power_limit_kva",
                self.inverter_apparent_power_limit_kva,
            )
        elif (
            self.max_reactive_support_kvar != 0
            or self.inverter_apparent_power_limit_kva is not None
        ):
            raise ValueError("disabled reactive support must not carry capability values")


@dataclass(frozen=True)
class CiOptimizerConfig:
    allow_grid_charging: bool = True
    wear_cost_aud_per_discharged_kwh: float = (
        WEAR_SHADOW_COST_AUD_PER_DISCHARGED_KWH
    )
    time_limit_seconds: float = 60.0
    primary_objective_tolerance_aud: float = PRIMARY_OBJECTIVE_TOLERANCE_AUD
    materiality_tolerance_aud: float = MATERIALITY_TOLERANCE_AUD
    max_kva_cut_iterations: int = 24

    def __post_init__(self) -> None:
        if not isinstance(self.allow_grid_charging, bool):
            raise ValueError("allow_grid_charging must be a bool")
        for name in (
            "wear_cost_aud_per_discharged_kwh",
            "time_limit_seconds",
            "primary_objective_tolerance_aud",
            "materiality_tolerance_aud",
        ):
            _finite_non_negative(name, getattr(self, name))
        if self.time_limit_seconds == 0:
            raise ValueError("time_limit_seconds must be positive")
        if self.primary_objective_tolerance_aud != PRIMARY_OBJECTIVE_TOLERANCE_AUD:
            raise ValueError("primary objective tolerance is fixed at AUD 0.01")
        if self.materiality_tolerance_aud != MATERIALITY_TOLERANCE_AUD:
            raise ValueError("materiality tolerance is fixed at AUD 5")
        if (
            self.wear_cost_aud_per_discharged_kwh
            != WEAR_SHADOW_COST_AUD_PER_DISCHARGED_KWH
        ):
            raise ValueError("V1 wear shadow cost is fixed at AUD 0.05/kWh")
        if (
            isinstance(self.max_kva_cut_iterations, bool)
            or not isinstance(self.max_kva_cut_iterations, int)
            or self.max_kva_cut_iterations <= 0
        ):
            raise ValueError("max_kva_cut_iterations must be a positive integer")


@dataclass(frozen=True)
class CiOptimizerProblem:
    intervals: tuple[CiOptimizerInterval, ...]
    battery: CiBatterySpec
    demand_charges: tuple[CiDemandCharge, ...]
    billing_periods: tuple[CiBillingPeriod, ...]
    shared_ac_headroom_kw: float = DEFAULT_SHARED_AC_HEADROOM_KW
    reactive_support: CiReactiveSupportSpec = field(
        default_factory=CiReactiveSupportSpec
    )
    config: CiOptimizerConfig = field(default_factory=CiOptimizerConfig)

    def __post_init__(self) -> None:
        intervals = tuple(self.intervals)
        demand_charges = tuple(self.demand_charges)
        billing_periods = tuple(self.billing_periods)
        object.__setattr__(self, "intervals", intervals)
        object.__setattr__(self, "demand_charges", demand_charges)
        object.__setattr__(self, "billing_periods", billing_periods)
        if not intervals:
            raise ValueError("at least one optimizer interval is required")
        if any(not isinstance(row, CiOptimizerInterval) for row in intervals):
            raise ValueError("intervals must contain CiOptimizerInterval values")
        if any(
            current.timestamp <= previous.timestamp
            for previous, current in zip(intervals, intervals[1:], strict=False)
        ):
            raise ValueError("interval timestamps must be strictly increasing")
        if not isinstance(self.battery, CiBatterySpec):
            raise ValueError("battery must be a CiBatterySpec")
        _finite_positive("shared_ac_headroom_kw", self.shared_ac_headroom_kw)
        if not isinstance(self.reactive_support, CiReactiveSupportSpec):
            raise ValueError("reactive_support must be a CiReactiveSupportSpec")
        if not isinstance(self.config, CiOptimizerConfig):
            raise ValueError("config must be a CiOptimizerConfig")
        if any(not isinstance(item, CiDemandCharge) for item in demand_charges):
            raise ValueError("demand_charges must contain CiDemandCharge values")
        if not billing_periods or any(
            not isinstance(item, CiBillingPeriod) for item in billing_periods
        ):
            raise ValueError("billing_periods must contain CiBillingPeriod values")
        if len({item.period_id for item in billing_periods}) != len(billing_periods):
            raise ValueError("billing period IDs must be unique")
        covered_indexes = tuple(
            index for period in billing_periods for index in period.interval_indexes
        )
        if covered_indexes != tuple(range(len(intervals))):
            raise ValueError(
                "billing_periods must be an ordered, non-overlapping partition of intervals"
            )
        if len({item.component_id for item in demand_charges}) != len(demand_charges):
            raise ValueError("demand component IDs must be unique")
        if any(
            index >= len(intervals)
            for item in demand_charges
            for index in item.interval_indexes
        ):
            raise ValueError("demand interval index is outside the optimizer horizon")


@dataclass(frozen=True)
class CiDispatchInterval:
    timestamp: datetime
    grid_import_kw: float
    pv_export_kw: float
    pv_to_ac_kw: float
    shared_ac_port_kw: float
    grid_charge_kw: float
    pv_charge_kw: float
    discharge_kw: float
    soc_start_kwh: float
    soc_end_kwh: float
    dynamic_reserve_soc_kwh: float
    site_reactive_import_kvar: float = 0.0
    inverter_reactive_support_kvar: float = 0.0
    post_grid_reactive_kvar: float = 0.0
    exact_grid_import_kva: float = 0.0
    shared_inverter_apparent_power_kva: float = 0.0


@dataclass(frozen=True)
class CiDemandChargeResult:
    component_id: str
    basis: Literal["kw", "kva"]
    optimized_limit: float
    exact_replay_peak: float
    exact_charge_aud: float


@dataclass(frozen=True)
class CiBillingPeriodResult:
    period_id: str
    candidate_ids: tuple[Literal["battery_idle", "optimized_dispatch"], ...]
    selected_candidate: Literal["battery_idle", "optimized_dispatch"]
    start_soc_kwh: float
    end_soc_kwh: float
    charge_input_kwh: float
    discharge_output_kwh: float


@dataclass(frozen=True)
class _PlannerReferences:
    demand_limits: tuple[tuple[str, float], ...]
    soc_boundaries_kwh: tuple[float, ...]
    idle_billing_period_ids: tuple[str, ...]


@dataclass(frozen=True)
class _PlannerAggregation:
    source_groups: tuple[tuple[int, ...], ...]


@dataclass(frozen=True)
class CiOptimizerResult:
    algorithm_id: str
    status: CiOptimizerStatus
    solver_mode: Literal["lp", "milp"]
    solver_version: str
    customer_facing_permission: bool
    recommendation_permitted: bool
    primary_objective_aud: float | None
    exact_replay_bill_aud: float | None
    idle_baseline_bill_aud: float
    optimization_exactness_gap_aud: float | None
    bill_reconciliation_difference_aud: float | None
    mip_absolute_gap_aud: float | None
    simultaneous_charge_discharge_detected: bool
    kva_cut_iterations: int
    demand_charges: tuple[CiDemandChargeResult, ...]
    billing_periods: tuple[CiBillingPeriodResult, ...]
    intervals: tuple[CiDispatchInterval, ...]
    corrections: tuple[str, ...]
    disclosures: tuple[str, ...]
    _planner_references: _PlannerReferences | None = field(
        default=None,
        repr=False,
        compare=False,
    )


@dataclass(frozen=True)
class CiRollingWindowAudit:
    start_interval_index: int
    horizon_interval_count: int
    committed_interval_count: int
    wrapped_interval_count: int
    status: CiOptimizerStatus
    solver_mode: Literal["lp", "milp"]
    start_soc_kwh: float
    committed_end_soc_kwh: float
    corrections: tuple[str, ...]
    minimum_committed_soc_kwh: float | None = None


@dataclass(frozen=True)
class CiRollingReplayResult:
    algorithm_id: str
    status: CiOptimizerStatus
    planner_status: CiOptimizerStatus
    solver_version: str
    customer_facing_permission: bool
    recommendation_permitted: bool
    exact_replay_bill_aud: float | None
    idle_baseline_bill_aud: float
    optimization_exactness_gap_aud: float | None
    bill_reconciliation_difference_aud: float | None
    demand_charges: tuple[CiDemandChargeResult, ...]
    billing_periods: tuple[CiBillingPeriodResult, ...]
    intervals: tuple[CiDispatchInterval, ...]
    windows: tuple[CiRollingWindowAudit, ...]
    corrections: tuple[str, ...]
    disclosures: tuple[str, ...]


@dataclass
class _ModelArtifacts:
    highs: highspy.Highs
    grid_charge: list[int]
    pv_charge: list[int]
    pv_to_ac: list[int]
    pv_export: list[int]
    discharge: list[int]
    reactive_support: list[int]
    soc: list[int]
    demand_peaks: dict[str, int]
    loads_kw: tuple[float, ...]
    primary_costs: tuple[float, ...]
    secondary_costs: tuple[float, ...]
    primary_cost_block_totals: tuple[int, ...]
    primary_offset: float
    secondary_objective: bool


@dataclass(frozen=True)
class _SolvedDispatch:
    model_status: highspy.HighsModelStatus
    objective: float | None
    mip_gap_aud: float | None
    grid_import: tuple[float, ...]
    pv_export: tuple[float, ...]
    pv_to_ac: tuple[float, ...]
    grid_charge: tuple[float, ...]
    pv_charge: tuple[float, ...]
    discharge: tuple[float, ...]
    reactive_support: tuple[float, ...]
    soc: tuple[float, ...]
    demand_peaks: dict[str, float]


@dataclass(frozen=True)
class _WindowSolveOutcome:
    solved: _SolvedDispatch | None
    demand_results: tuple[CiDemandChargeResult, ...]
    status: CiOptimizerStatus
    solver_mode: Literal["lp", "milp"]
    simultaneous_detected: bool
    kva_iterations: int
    corrections: tuple[str, ...]


def optimize_ci_peak_shaving(problem: CiOptimizerProblem) -> CiOptimizerResult:
    """Optimize one synthetic/internal C&I horizon with HiGHS.

    This repository-owned contract defines the objective and all product
    semantics. HiGHS is a replaceable LP/MILP execution dependency and is not
    tariff, billing, recommendation, permission, or claim authority.
    """

    if not isinstance(problem, CiOptimizerProblem):
        raise ValueError("problem must be a CiOptimizerProblem")
    idle_bill = _idle_bill(problem)
    cuts: dict[str, list[tuple[float, float]]] = {
        item.component_id: [] for item in problem.demand_charges if item.basis == "kva"
    }
    corrections: list[str] = (
        ["reactive_pq_inner_approximation_16_segments_exact_replay"]
        if problem.reactive_support.enabled
        else []
    )
    binary = False
    simultaneous_detected = False
    kva_iterations = 0

    while True:
        solved = _solve_two_stage(problem, cuts=cuts, binary=binary)
        failure = _failure_status(problem, solved, binary=binary)
        if failure is not None:
            return _failed_result(
                problem,
                failure,
                idle_bill=idle_bill,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=corrections,
                mip_gap=solved.mip_gap_aud,
            )
        if _physical_dispatch_violation(problem, solved):
            return _failed_result(
                problem,
                CiOptimizerStatus.MODEL_FAILURE,
                idle_bill=idle_bill,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=corrections + ["shared_ac_physical_replay_failed"],
                mip_gap=solved.mip_gap_aud,
            )

        simultaneous = any(
            (grid + pv) > SIMULTANEOUS_FLOW_TOLERANCE_KW
            and discharge > SIMULTANEOUS_FLOW_TOLERANCE_KW
            for grid, pv, discharge in zip(
                solved.grid_charge,
                solved.pv_charge,
                solved.discharge,
                strict=True,
            )
        )
        if simultaneous and not binary:
            simultaneous_detected = True
            binary = True
            corrections.append("lp_to_milp_simultaneous_charge_discharge")
            continue
        if simultaneous:
            return _failed_result(
                problem,
                CiOptimizerStatus.MODEL_FAILURE,
                idle_bill=idle_bill,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=True,
                kva_iterations=kva_iterations,
                corrections=corrections + ["milp_simultaneous_flow_invariant_failed"],
                mip_gap=solved.mip_gap_aud,
            )

        demand_results = _exact_demand_results(problem, solved)
        model_bill = _model_bill(problem, solved)
        exact_bill = _exact_bill(problem, solved, demand_results)
        optimization_gap = abs(exact_bill - model_bill)
        if optimization_gap > problem.config.materiality_tolerance_aud:
            additions = _new_kva_cuts(problem, solved, demand_results, cuts)
            if additions and kva_iterations < problem.config.max_kva_cut_iterations:
                kva_iterations += 1
                corrections.extend(additions)
                continue
            return _failed_result(
                problem,
                CiOptimizerStatus.BILL_RECONCILIATION_FAILED,
                idle_bill=idle_bill,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=corrections + ["kva_cut_refinement_not_converged"],
                mip_gap=solved.mip_gap_aud,
            )

        if exact_bill >= idle_bill - 0.005:
            solved = _idle_dispatch(problem)
            demand_results = _exact_demand_results(problem, solved)
            model_bill = _model_bill(problem, solved)
            exact_bill = _exact_bill(problem, solved, demand_results)
            optimization_gap = abs(exact_bill - model_bill)
            corrections.append("battery_idle_selected")

        status = (
            CiOptimizerStatus.OPTIMAL_MILP
            if binary
            else CiOptimizerStatus.OPTIMAL_LP_EXACT
        )
        if solved.mip_gap_aud is not None and solved.mip_gap_aud > 0:
            status = CiOptimizerStatus.BOUNDED_OPTIMAL
        elif optimization_gap > problem.config.primary_objective_tolerance_aud:
            status = CiOptimizerStatus.BOUNDED_OPTIMAL
            corrections.append("exact_kva_replay_within_aud_5_materiality")

        reserve = _dynamic_reserve(problem, solved, demand_results)
        dispatch = tuple(
            CiDispatchInterval(
                timestamp=row.timestamp,
                grid_import_kw=_clean(solved.grid_import[index]),
                pv_export_kw=_clean(solved.pv_export[index]),
                pv_to_ac_kw=_clean(solved.pv_to_ac[index]),
                shared_ac_port_kw=_clean(
                    solved.pv_to_ac[index]
                    + solved.discharge[index]
                    - solved.grid_charge[index]
                ),
                grid_charge_kw=_clean(solved.grid_charge[index]),
                pv_charge_kw=_clean(solved.pv_charge[index]),
                discharge_kw=_clean(solved.discharge[index]),
                soc_start_kwh=_clean(solved.soc[index]),
                soc_end_kwh=_clean(solved.soc[index + 1]),
                dynamic_reserve_soc_kwh=_clean(reserve[index]),
                site_reactive_import_kvar=_clean(row.reactive_kvar),
                inverter_reactive_support_kvar=_clean(solved.reactive_support[index]),
                post_grid_reactive_kvar=_clean(
                    row.reactive_kvar - solved.reactive_support[index]
                ),
                exact_grid_import_kva=_clean(
                    math.hypot(
                        solved.grid_import[index],
                        row.reactive_kvar - solved.reactive_support[index],
                    )
                ),
                shared_inverter_apparent_power_kva=_clean(
                    math.hypot(
                        solved.pv_to_ac[index]
                        + solved.discharge[index]
                        - solved.grid_charge[index],
                        solved.reactive_support[index],
                    )
                ),
            )
            for index, row in enumerate(problem.intervals)
        )
        replay_bill = _replay_bill_from_dispatch(problem, dispatch)
        reconciliation = abs(exact_bill - replay_bill)
        if reconciliation > problem.config.primary_objective_tolerance_aud:
            return _failed_result(
                problem,
                CiOptimizerStatus.BILL_RECONCILIATION_FAILED,
                idle_bill=idle_bill,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=corrections
                + ["same_dispatch_bill_reconciliation_failed"],
                mip_gap=solved.mip_gap_aud,
            )
        billing_periods = _billing_period_results(problem, solved)
        corrections.append("billing_period_idle_candidates_evaluated")
        idle_period_ids = tuple(
            item.period_id
            for item in billing_periods
            if item.selected_candidate == "battery_idle"
        )
        corrections.extend(
            f"billing_period_battery_idle_selected:{period_id}"
            for period_id in idle_period_ids
        )
        return CiOptimizerResult(
            algorithm_id=CI_PEAK_SHAVING_OPTIMIZER_ID,
            status=status,
            solver_mode="milp" if binary else "lp",
            solver_version=highspy.Highs().version(),
            customer_facing_permission=False,
            recommendation_permitted=False,
            primary_objective_aud=_money(solved.objective),
            exact_replay_bill_aud=_money(exact_bill),
            idle_baseline_bill_aud=_money(idle_bill),
            optimization_exactness_gap_aud=_money(optimization_gap),
            bill_reconciliation_difference_aud=_money(reconciliation),
            mip_absolute_gap_aud=(
                None if solved.mip_gap_aud is None else _money(solved.mip_gap_aud)
            ),
            simultaneous_charge_discharge_detected=simultaneous_detected,
            kva_cut_iterations=kva_iterations,
            demand_charges=demand_results,
            billing_periods=billing_periods,
            intervals=dispatch,
            _planner_references=_PlannerReferences(
                demand_limits=tuple(
                    (
                        component.component_id,
                        _exact_demand_peak(problem, solved, component),
                    )
                    for component in problem.demand_charges
                ),
                soc_boundaries_kwh=tuple(float(value) for value in solved.soc),
                idle_billing_period_ids=idle_period_ids,
            ),
            corrections=tuple(corrections),
            disclosures=_disclosures(),
        )


def execute_ci_peak_shaving_rolling(
    problem: CiOptimizerProblem,
) -> CiRollingReplayResult:
    """Plan annually, then replay 48-hour perfect-foresight windows.

    Each window commits only its first 24 hours. The December look-ahead wraps
    to the same representative year's January inputs, while only the real
    calendar-year intervals are committed and billed. Window-end SOC is free
    above the physical minimum; the final committed calendar-year boundary is
    fixed to the approved 100% terminal SOC.
    """

    if not isinstance(problem, CiOptimizerProblem):
        raise ValueError("problem must be a CiOptimizerProblem")
    horizon_count, commit_count, cycle_delta = _rolling_shape(problem)
    planner_problem, planner_aggregation = _annual_planner_problem(problem)
    planner = optimize_ci_peak_shaving(planner_problem)
    idle_bill = _idle_bill(problem)
    if planner.status not in {
        CiOptimizerStatus.OPTIMAL_LP_EXACT,
        CiOptimizerStatus.OPTIMAL_MILP,
        CiOptimizerStatus.BOUNDED_OPTIMAL,
    }:
        return _rolling_failed_result(
            planner.status,
            planner_status=planner.status,
            idle_bill=idle_bill,
            windows=(),
            corrections=("annual_planner_failed",),
        )

    planner_references = planner._planner_references
    planner_corrections: tuple[str, ...] = ()
    if planner_references is not None and planner_aggregation is not None:
        planner_references = _expand_planner_references(
            problem,
            planner,
            planner_aggregation,
        )
        planner_corrections = (
            (
                "annual_planner_15_minute_reactive_pq_aggregation_with_exact_source_interval_kva_references"
                if problem.reactive_support.enabled
                else "annual_planner_15_minute_kw_surrogate_with_exact_source_interval_kva_references"
            ),
        )
    if planner_references is None:
        return _rolling_failed_result(
            CiOptimizerStatus.MODEL_FAILURE,
            planner_status=planner.status,
            idle_bill=idle_bill,
            windows=(),
            corrections=("annual_planner_reference_missing",),
        )
    planned_limits = dict(planner_references.demand_limits)
    if set(planned_limits) != {
        item.component_id for item in problem.demand_charges
    }:
        return _rolling_failed_result(
            CiOptimizerStatus.MODEL_FAILURE,
            planner_status=planner.status,
            idle_bill=idle_bill,
            windows=(),
            corrections=("annual_planner_demand_reference_missing",),
        )
    if len(planner_references.soc_boundaries_kwh) != len(problem.intervals) + 1:
        return _rolling_failed_result(
            CiOptimizerStatus.MODEL_FAILURE,
            planner_status=planner.status,
            idle_bill=idle_bill,
            windows=(),
            corrections=("annual_planner_soc_reference_missing",),
        )
    component_indexes = {
        item.component_id: set(item.interval_indexes)
        for item in problem.demand_charges
    }
    annual_kva_component_count = sum(
        item.basis == "kva" for item in problem.demand_charges
    )
    billing_period_by_index = {
        index: period.period_id
        for period in problem.billing_periods
        for index in period.interval_indexes
    }
    committed_rows: list[CiDispatchInterval] = []
    windows: list[CiRollingWindowAudit] = []
    corrections: list[str] = list(planner_corrections)
    any_milp = False
    any_bounded = (
        planner.status is CiOptimizerStatus.BOUNDED_OPTIMAL
        or planner_aggregation is not None
    )
    current_soc = (
        problem.battery.nominal_capacity_kwh
        * problem.battery.initial_soc_fraction
    )
    start = 0
    while start < len(problem.intervals):
        source_indexes = tuple(
            (start + offset) % len(problem.intervals)
            for offset in range(horizon_count)
        )
        wrapped_count = max(0, start + horizon_count - len(problem.intervals))
        window_intervals = tuple(
            _rolling_interval(
                problem.intervals[source_index],
                wrapped=(start + offset >= len(problem.intervals)),
                cycle_delta=cycle_delta,
            )
            for offset, source_index in enumerate(source_indexes)
        )
        window_components = []
        fixed_limits: dict[str, float] = {}
        for component in problem.demand_charges:
            local_indexes = tuple(
                local_index
                for local_index, source_index in enumerate(source_indexes)
                if source_index in component_indexes[component.component_id]
            )
            if not local_indexes:
                continue
            window_components.append(
                CiDemandCharge(
                    component_id=component.component_id,
                    rate_aud_per_unit=component.rate_aud_per_unit,
                    interval_indexes=local_indexes,
                    basis=component.basis,
                    minimum_chargeable=component.minimum_chargeable,
                )
            )
            fixed_limits[component.component_id] = planned_limits[
                component.component_id
            ]
        window_period_indexes: dict[str, list[int]] = {}
        for local_index, source_index in enumerate(source_indexes):
            period_id = billing_period_by_index[source_index]
            window_period_indexes.setdefault(period_id, []).append(local_index)
        window_problem = CiOptimizerProblem(
            intervals=window_intervals,
            battery=problem.battery,
            demand_charges=tuple(window_components),
            billing_periods=tuple(
                CiBillingPeriod(period_id, tuple(indexes))
                for period_id, indexes in window_period_indexes.items()
            ),
            shared_ac_headroom_kw=problem.shared_ac_headroom_kw,
            reactive_support=problem.reactive_support,
            config=problem.config,
        )
        committed_count = min(commit_count, len(problem.intervals) - start)
        minimum_committed_soc = planner_references.soc_boundaries_kwh[
            start + committed_count
        ]
        soc_boundaries = {0: current_soc}
        if start + committed_count == len(problem.intervals):
            soc_boundaries[committed_count] = (
                problem.battery.nominal_capacity_kwh
                * problem.battery.terminal_soc_fraction
            )
        outcome = _solve_fixed_limit_window(
            window_problem,
            fixed_soc_boundaries=soc_boundaries,
            minimum_soc_boundaries={committed_count: minimum_committed_soc},
            fixed_demand_limits=fixed_limits,
            forced_idle_period_ids=set(
                planner_references.idle_billing_period_ids
            ).intersection(window_period_indexes),
            materiality_kva_component_count=annual_kva_component_count,
        )
        if outcome.solved is None:
            windows.append(
                CiRollingWindowAudit(
                    start_interval_index=start,
                    horizon_interval_count=horizon_count,
                    committed_interval_count=0,
                    wrapped_interval_count=wrapped_count,
                    status=outcome.status,
                    solver_mode=outcome.solver_mode,
                    start_soc_kwh=_clean(current_soc),
                    minimum_committed_soc_kwh=_clean(minimum_committed_soc),
                    committed_end_soc_kwh=_clean(current_soc),
                    corrections=outcome.corrections,
                )
            )
            return _rolling_failed_result(
                outcome.status,
                planner_status=planner.status,
                idle_bill=idle_bill,
                windows=tuple(windows),
                corrections=tuple(corrections) + outcome.corrections,
            )
        solved = outcome.solved
        reserve = _dynamic_reserve(
            window_problem,
            solved,
            outcome.demand_results,
        )
        for local_index in range(committed_count):
            source = problem.intervals[start + local_index]
            committed_rows.append(
                CiDispatchInterval(
                    timestamp=source.timestamp,
                    grid_import_kw=_clean(solved.grid_import[local_index]),
                    pv_export_kw=_clean(solved.pv_export[local_index]),
                    pv_to_ac_kw=_clean(solved.pv_to_ac[local_index]),
                    shared_ac_port_kw=_clean(
                        solved.pv_to_ac[local_index]
                        + solved.discharge[local_index]
                        - solved.grid_charge[local_index]
                    ),
                    grid_charge_kw=_clean(solved.grid_charge[local_index]),
                    pv_charge_kw=_clean(solved.pv_charge[local_index]),
                    discharge_kw=_clean(solved.discharge[local_index]),
                    soc_start_kwh=_clean(solved.soc[local_index]),
                    soc_end_kwh=_clean(solved.soc[local_index + 1]),
                    dynamic_reserve_soc_kwh=_clean(reserve[local_index]),
                    site_reactive_import_kvar=_clean(source.reactive_kvar),
                    inverter_reactive_support_kvar=_clean(
                        solved.reactive_support[local_index]
                    ),
                    post_grid_reactive_kvar=_clean(
                        source.reactive_kvar - solved.reactive_support[local_index]
                    ),
                    exact_grid_import_kva=_clean(
                        math.hypot(
                            solved.grid_import[local_index],
                            source.reactive_kvar
                            - solved.reactive_support[local_index],
                        )
                    ),
                    shared_inverter_apparent_power_kva=_clean(
                        math.hypot(
                            solved.pv_to_ac[local_index]
                            + solved.discharge[local_index]
                            - solved.grid_charge[local_index],
                            solved.reactive_support[local_index],
                        )
                    ),
                )
            )
        current_soc = solved.soc[committed_count]
        windows.append(
            CiRollingWindowAudit(
                start_interval_index=start,
                horizon_interval_count=horizon_count,
                committed_interval_count=committed_count,
                wrapped_interval_count=wrapped_count,
                status=outcome.status,
                solver_mode=outcome.solver_mode,
                start_soc_kwh=_clean(solved.soc[0]),
                minimum_committed_soc_kwh=_clean(minimum_committed_soc),
                committed_end_soc_kwh=_clean(current_soc),
                corrections=outcome.corrections,
            )
        )
        corrections.extend(outcome.corrections)
        any_milp = any_milp or outcome.solver_mode == "milp"
        any_bounded = any_bounded or outcome.status is CiOptimizerStatus.BOUNDED_OPTIMAL
        start += committed_count

    full_solved = _solved_from_dispatch_rows(problem, tuple(committed_rows))
    demand_results = _exact_demand_results(problem, full_solved)
    exact_bill = _exact_bill(problem, full_solved, demand_results)
    if exact_bill >= idle_bill - 0.005:
        full_solved = _idle_dispatch(problem)
        demand_results = _exact_demand_results(problem, full_solved)
        exact_bill = _exact_bill(problem, full_solved, demand_results)
        reserve = _dynamic_reserve(problem, full_solved, demand_results)
        committed_rows = [
            CiDispatchInterval(
                timestamp=row.timestamp,
                grid_import_kw=_clean(full_solved.grid_import[index]),
                pv_export_kw=_clean(full_solved.pv_export[index]),
                pv_to_ac_kw=_clean(full_solved.pv_to_ac[index]),
                shared_ac_port_kw=_clean(full_solved.pv_to_ac[index]),
                grid_charge_kw=0.0,
                pv_charge_kw=0.0,
                discharge_kw=0.0,
                soc_start_kwh=_clean(full_solved.soc[index]),
                soc_end_kwh=_clean(full_solved.soc[index + 1]),
                dynamic_reserve_soc_kwh=_clean(reserve[index]),
                site_reactive_import_kvar=_clean(row.reactive_kvar),
                inverter_reactive_support_kvar=_clean(
                    full_solved.reactive_support[index]
                ),
                post_grid_reactive_kvar=_clean(
                    row.reactive_kvar - full_solved.reactive_support[index]
                ),
                exact_grid_import_kva=_clean(
                    math.hypot(
                        full_solved.grid_import[index],
                        row.reactive_kvar - full_solved.reactive_support[index],
                    )
                ),
                shared_inverter_apparent_power_kva=_clean(
                    math.hypot(
                        full_solved.pv_to_ac[index]
                        + full_solved.discharge[index]
                        - full_solved.grid_charge[index],
                        full_solved.reactive_support[index],
                    )
                ),
            )
            for index, row in enumerate(problem.intervals)
        ]
        corrections.append("battery_idle_selected_after_rolling_replay")

    planned_limit_bill = sum(
        full_solved.grid_import[index]
        * row.import_rate_aud_per_kwh
        * row.duration_hours
        - full_solved.pv_export[index]
        * row.export_credit_aud_per_kwh
        * row.duration_hours
        + full_solved.discharge[index]
        * problem.config.wear_cost_aud_per_discharged_kwh
        * row.duration_hours
        for index, row in enumerate(problem.intervals)
    ) + sum(
        planned_limits[item.component_id] * item.rate_aud_per_unit
        for item in problem.demand_charges
    )
    optimization_gap = max(0.0, exact_bill - planned_limit_bill)
    if optimization_gap > problem.config.materiality_tolerance_aud:
        return _rolling_failed_result(
            CiOptimizerStatus.BILL_RECONCILIATION_FAILED,
            planner_status=planner.status,
            idle_bill=idle_bill,
            windows=tuple(windows),
            corrections=tuple(corrections)
            + ("rolling_optimization_exactness_gap_exceeds_aud_5",),
        )
    replay_bill = _replay_bill_from_dispatch(problem, tuple(committed_rows))
    reconciliation = abs(exact_bill - replay_bill)
    if reconciliation > problem.config.primary_objective_tolerance_aud:
        return _rolling_failed_result(
            CiOptimizerStatus.BILL_RECONCILIATION_FAILED,
            planner_status=planner.status,
            idle_bill=idle_bill,
            windows=tuple(windows),
            corrections=tuple(corrections) + ("rolling_bill_reconciliation_failed",),
        )
    status = (
        CiOptimizerStatus.BOUNDED_OPTIMAL
        if any_bounded
        else CiOptimizerStatus.OPTIMAL_MILP
        if any_milp
        else CiOptimizerStatus.OPTIMAL_LP_EXACT
    )
    return CiRollingReplayResult(
        algorithm_id=CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
        status=status,
        planner_status=planner.status,
        solver_version=highspy.Highs().version(),
        customer_facing_permission=False,
        recommendation_permitted=False,
        exact_replay_bill_aud=_money(exact_bill),
        idle_baseline_bill_aud=_money(idle_bill),
        optimization_exactness_gap_aud=_money(optimization_gap),
        bill_reconciliation_difference_aud=_money(reconciliation),
        demand_charges=demand_results,
        billing_periods=_billing_period_results(problem, full_solved),
        intervals=tuple(committed_rows),
        windows=tuple(windows),
        corrections=tuple(corrections),
        disclosures=_rolling_disclosures(),
    )


def _annual_planner_problem(
    problem: CiOptimizerProblem,
) -> tuple[CiOptimizerProblem, _PlannerAggregation | None]:
    source_duration = problem.intervals[0].duration_hours
    target_duration = 0.25
    if (
        problem.config.allow_grid_charging
        or source_duration > target_duration + 1e-12
        or not any(
            component.basis == "kva" for component in problem.demand_charges
        )
    ):
        return problem, None
    group_size = round(target_duration / source_duration)
    if (
        group_size < 1
        or abs(group_size * source_duration - target_duration) > 1e-12
        or len(problem.intervals) % group_size != 0
    ):
        return problem, None
    source_groups = tuple(
        tuple(range(start, start + group_size))
        for start in range(0, len(problem.intervals), group_size)
    )
    component_membership = {
        component.component_id: set(component.interval_indexes)
        for component in problem.demand_charges
    }
    period_by_index = {
        index: period.period_id
        for period in problem.billing_periods
        for index in period.interval_indexes
    }
    aggregate_intervals: list[CiOptimizerInterval] = []
    aggregate_period_indexes: dict[str, list[int]] = {}
    aggregate_component_indexes: dict[str, list[int]] = {
        component.component_id: [] for component in problem.demand_charges
    }
    for aggregate_index, source_indexes in enumerate(source_groups):
        rows = tuple(problem.intervals[index] for index in source_indexes)
        import_rate = rows[0].import_rate_aud_per_kwh
        export_rate = rows[0].export_credit_aud_per_kwh
        if any(
            abs(row.import_rate_aud_per_kwh - import_rate) > 1e-12
            or abs(row.export_credit_aud_per_kwh - export_rate) > 1e-12
            for row in rows[1:]
        ):
            return problem, None
        period_ids = {period_by_index.get(index) for index in source_indexes}
        if len(period_ids) != 1 or None in period_ids:
            return problem, None
        period_id = next(iter(period_ids))
        aggregate_period_indexes.setdefault(period_id, []).append(aggregate_index)
        for component in problem.demand_charges:
            membership = tuple(
                index in component_membership[component.component_id]
                for index in source_indexes
            )
            if any(membership) and not all(membership):
                return problem, None
            if all(membership):
                aggregate_component_indexes[component.component_id].append(
                    aggregate_index
                )
        aggregate_intervals.append(
            CiOptimizerInterval(
                timestamp=rows[0].timestamp,
                duration_hours=target_duration,
                load_kw=sum(row.load_kw for row in rows) / group_size,
                pv_kw=sum(row.pv_kw for row in rows) / group_size,
                reactive_kvar=(
                    sum(row.reactive_kvar for row in rows) / group_size
                ),
                import_rate_aud_per_kwh=import_rate,
                export_credit_aud_per_kwh=export_rate,
            )
        )
    aggregate_problem = CiOptimizerProblem(
        intervals=tuple(aggregate_intervals),
        battery=problem.battery,
        demand_charges=tuple(
            CiDemandCharge(
                component_id=component.component_id,
                rate_aud_per_unit=component.rate_aud_per_unit,
                interval_indexes=tuple(
                    aggregate_component_indexes[component.component_id]
                ),
                basis=(
                    component.basis
                    if problem.reactive_support.enabled
                    else "kw" if component.basis == "kva" else component.basis
                ),
                minimum_chargeable=component.minimum_chargeable,
            )
            for component in problem.demand_charges
        ),
        billing_periods=tuple(
            CiBillingPeriod(period.period_id, tuple(aggregate_period_indexes[period.period_id]))
            for period in problem.billing_periods
        ),
        shared_ac_headroom_kw=problem.shared_ac_headroom_kw,
        reactive_support=problem.reactive_support,
        config=problem.config,
    )
    return aggregate_problem, _PlannerAggregation(source_groups=source_groups)


def _expand_planner_references(
    problem: CiOptimizerProblem,
    planner: CiOptimizerResult,
    aggregation: _PlannerAggregation,
) -> _PlannerReferences | None:
    if (
        planner._planner_references is None
        or len(planner.intervals) != len(aggregation.source_groups)
    ):
        return None
    efficiency = problem.battery.symmetric_efficiency
    minimum_soc = (
        problem.battery.nominal_capacity_kwh * problem.battery.min_soc_fraction
    )
    maximum_soc = (
        problem.battery.nominal_capacity_kwh * problem.battery.max_soc_fraction
    )
    current_soc = (
        problem.battery.nominal_capacity_kwh
        * problem.battery.initial_soc_fraction
    )
    expanded_rows: list[CiDispatchInterval] = []
    for planner_row, source_indexes in zip(
        planner.intervals,
        aggregation.source_groups,
        strict=True,
    ):
        source_rows = tuple(problem.intervals[index] for index in source_indexes)
        group_size = len(source_rows)
        try:
            pv_charge = _bounded_equal_allocation(
                planner_row.pv_charge_kw * group_size,
                tuple(
                    min(row.pv_kw, problem.battery.max_charge_kw)
                    for row in source_rows
                ),
            )
            discharge = _bounded_equal_allocation(
                planner_row.discharge_kw * group_size,
                tuple(
                    min(
                        row.load_kw,
                        problem.battery.max_discharge_kw,
                        problem.shared_ac_headroom_kw,
                    )
                    for row in source_rows
                ),
            )
        except ValueError:
            return None
        if any(
            charge > SIMULTANEOUS_FLOW_TOLERANCE_KW
            and output > SIMULTANEOUS_FLOW_TOLERANCE_KW
            for charge, output in zip(pv_charge, discharge, strict=True)
        ):
            return None
        apparent_limit = problem.reactive_support.inverter_apparent_power_limit_kva
        active_limit = problem.shared_ac_headroom_kw
        if problem.reactive_support.enabled:
            if apparent_limit is None:
                return None
            active_limit = min(
                active_limit,
                apparent_limit
                * math.cos(math.pi / PQ_CAPABILITY_SEGMENTS / 2),
            )
        pv_to_ac = tuple(
            min(
                max(0.0, row.pv_kw - charge),
                max(0.0, active_limit - output),
            )
            for row, charge, output in zip(
                source_rows, pv_charge, discharge, strict=True
            )
        )
        reactive_support = tuple(
            _conservative_reactive_support_bound(
                problem,
                source_index,
                active + output,
            )
            for source_index, active, output in zip(
                source_indexes, pv_to_ac, discharge, strict=True
            )
        )
        for row, charge, output, active, support in zip(
            source_rows,
            pv_charge,
            discharge,
            pv_to_ac,
            reactive_support,
            strict=True,
        ):
            pv_export = max(0.0, active + output - row.load_kw)
            grid_import = max(0.0, row.load_kw - active - output)
            post_kvar = row.reactive_kvar - support
            shared_active = active + output
            next_soc = current_soc + (
                charge * row.duration_hours * efficiency
                - output * row.duration_hours / efficiency
            )
            if next_soc < minimum_soc - 1e-7 or next_soc > maximum_soc + 1e-7:
                return None
            next_soc = min(max(next_soc, minimum_soc), maximum_soc)
            expanded_rows.append(
                CiDispatchInterval(
                    timestamp=row.timestamp,
                    grid_import_kw=_clean(grid_import),
                    pv_export_kw=_clean(pv_export),
                    pv_to_ac_kw=_clean(active),
                    shared_ac_port_kw=_clean(shared_active),
                    grid_charge_kw=0.0,
                    pv_charge_kw=_clean(charge),
                    discharge_kw=_clean(output),
                    soc_start_kwh=_clean(current_soc),
                    soc_end_kwh=_clean(next_soc),
                    dynamic_reserve_soc_kwh=0.0,
                    site_reactive_import_kvar=_clean(row.reactive_kvar),
                    inverter_reactive_support_kvar=_clean(support),
                    post_grid_reactive_kvar=_clean(post_kvar),
                    exact_grid_import_kva=_clean(
                        math.hypot(grid_import, post_kvar)
                    ),
                    shared_inverter_apparent_power_kva=_clean(
                        math.hypot(shared_active, support)
                    ),
                )
            )
            current_soc = next_soc
        if abs(current_soc - planner_row.soc_end_kwh) > 1e-5:
            return None
    solved = _solved_from_dispatch_rows(problem, tuple(expanded_rows))
    return _PlannerReferences(
        demand_limits=tuple(
            (
                component.component_id,
                _exact_demand_peak(problem, solved, component),
            )
            for component in problem.demand_charges
        ),
        soc_boundaries_kwh=tuple(float(value) for value in solved.soc),
        idle_billing_period_ids=(
            planner._planner_references.idle_billing_period_ids
        ),
    )


def _bounded_equal_allocation(
    target_sum: float,
    bounds: tuple[float, ...],
) -> tuple[float, ...]:
    if target_sum < -1e-8 or target_sum > sum(bounds) + 1e-7:
        raise ValueError("aggregate dispatch cannot be mapped to source intervals")
    remaining = max(0.0, target_sum)
    values = [0.0] * len(bounds)
    active = list(range(len(bounds)))
    while active and remaining > 1e-10:
        share = remaining / len(active)
        saturated = [index for index in active if bounds[index] <= share + 1e-12]
        if not saturated:
            for index in active:
                values[index] = share
            remaining = 0.0
            break
        for index in saturated:
            values[index] = bounds[index]
            remaining -= bounds[index]
        active = [index for index in active if index not in saturated]
    if remaining > 1e-7:
        raise ValueError("aggregate dispatch allocation did not converge")
    return tuple(values)


def _reactive_support_bound(
    problem: CiOptimizerProblem,
    index: int,
    shared_active_power_kw: float,
) -> float:
    spec = problem.reactive_support
    if not spec.enabled:
        return 0.0
    apparent_limit = spec.inverter_apparent_power_limit_kva
    if apparent_limit is None or abs(shared_active_power_kw) > apparent_limit + 1e-9:
        raise ValueError("shared active power exceeds the apparent-power limit")
    return min(
        problem.intervals[index].reactive_kvar,
        spec.max_reactive_support_kvar,
        math.sqrt(
            max(
                0.0,
                apparent_limit * apparent_limit - shared_active_power_kw**2,
            )
        ),
    )


def _conservative_reactive_support_bound(
    problem: CiOptimizerProblem,
    index: int,
    shared_active_power_kw: float,
) -> float:
    exact_bound = _reactive_support_bound(
        problem,
        index,
        shared_active_power_kw,
    )
    if exact_bound == 0.0:
        return 0.0
    apparent_limit = problem.reactive_support.inverter_apparent_power_limit_kva
    if apparent_limit is None:
        raise ValueError("reactive apparent-power limit is missing")
    angle_step = math.pi / PQ_CAPABILITY_SEGMENTS
    conservative_radius = apparent_limit * math.cos(angle_step / 2)
    polygon_bound = min(
        (
            conservative_radius - math.cos(angle) * shared_active_power_kw
        )
        / math.sin(angle)
        for segment in range(PQ_CAPABILITY_SEGMENTS)
        for angle in ((segment + 0.5) * angle_step,)
    )
    return min(exact_bound, max(0.0, polygon_bound))


def _rolling_shape(
    problem: CiOptimizerProblem,
) -> tuple[int, int, timedelta]:
    duration = problem.intervals[0].duration_hours
    if any(row.timestamp.utcoffset() is None for row in problem.intervals):
        raise ValueError("rolling replay requires timezone-aware intervals")
    if any(
        abs(row.duration_hours - duration) > 1e-12
        for row in problem.intervals[1:]
    ):
        raise ValueError("rolling replay requires one uniform tariff interval")
    horizon_count = round(48.0 / duration)
    commit_count = round(24.0 / duration)
    if (
        horizon_count <= 0
        or commit_count <= 0
        or abs(horizon_count * duration - 48.0) > 1e-9
        or abs(commit_count * duration - 24.0) > 1e-9
    ):
        raise ValueError("tariff interval must divide both 24 and 48 hours")
    first = problem.intervals[0].timestamp
    expected_elapsed = timedelta(hours=duration)
    if any(
        current.timestamp.astimezone(timezone.utc)
        - previous.timestamp.astimezone(timezone.utc)
        != expected_elapsed
        for previous, current in zip(
            problem.intervals,
            problem.intervals[1:],
            strict=False,
        )
    ):
        raise ValueError("rolling replay requires contiguous elapsed intervals")
    boundary = problem.intervals[-1].timestamp + timedelta(hours=duration)
    if (
        first.month,
        first.day,
        first.hour,
        first.minute,
        first.second,
        first.microsecond,
    ) != (1, 1, 0, 0, 0, 0):
        raise ValueError("rolling replay requires a complete calendar year from Jan 1")
    if (
        boundary.year != first.year + 1
        or (
            boundary.month,
            boundary.day,
            boundary.hour,
            boundary.minute,
            boundary.second,
            boundary.microsecond,
        )
        != (1, 1, 0, 0, 0, 0)
    ):
        raise ValueError("rolling replay requires one complete calendar year")
    if horizon_count > len(problem.intervals):
        raise ValueError("rolling replay horizon exceeds the representative year")
    return horizon_count, commit_count, boundary - first


def _rolling_interval(
    row: CiOptimizerInterval,
    *,
    wrapped: bool,
    cycle_delta: timedelta,
) -> CiOptimizerInterval:
    return CiOptimizerInterval(
        timestamp=row.timestamp + cycle_delta if wrapped else row.timestamp,
        duration_hours=row.duration_hours,
        load_kw=row.load_kw,
        pv_kw=row.pv_kw,
        reactive_kvar=row.reactive_kvar,
        import_rate_aud_per_kwh=row.import_rate_aud_per_kwh,
        export_credit_aud_per_kwh=row.export_credit_aud_per_kwh,
    )


def _solve_fixed_limit_window(
    problem: CiOptimizerProblem,
    *,
    fixed_soc_boundaries: dict[int, float],
    minimum_soc_boundaries: dict[int, float] | None = None,
    fixed_demand_limits: dict[str, float],
    forced_idle_period_ids: set[str] | None = None,
    materiality_kva_component_count: int | None = None,
) -> _WindowSolveOutcome:
    cuts: dict[str, list[tuple[float, float]]] = {
        item.component_id: []
        for item in problem.demand_charges
        if item.basis == "kva"
    }
    corrections: list[str] = (
        ["reactive_pq_inner_approximation_16_segments_exact_replay"]
        if problem.reactive_support.enabled
        else []
    )
    binary = False
    simultaneous_detected = False
    kva_iterations = 0
    while True:
        try:
            solved = _solve_two_stage(
                problem,
                cuts=cuts,
                binary=binary,
                fixed_soc_boundaries=fixed_soc_boundaries,
                minimum_soc_boundaries=minimum_soc_boundaries,
                fixed_demand_limits=fixed_demand_limits,
                forced_idle_period_ids=forced_idle_period_ids,
            )
        except (RuntimeError, ValueError):
            return _WindowSolveOutcome(
                solved=None,
                demand_results=(),
                status=CiOptimizerStatus.MODEL_FAILURE,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=tuple(corrections) + ("rolling_window_model_failure",),
            )
        failure = _failure_status(problem, solved, binary=binary)
        if failure is not None:
            return _WindowSolveOutcome(
                solved=None,
                demand_results=(),
                status=failure,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=tuple(corrections),
            )
        if _physical_dispatch_violation(problem, solved):
            return _WindowSolveOutcome(
                solved=None,
                demand_results=(),
                status=CiOptimizerStatus.MODEL_FAILURE,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=tuple(corrections)
                + ("rolling_shared_ac_physical_replay_failed",),
            )
        simultaneous = any(
            (grid + pv) > SIMULTANEOUS_FLOW_TOLERANCE_KW
            and discharge > SIMULTANEOUS_FLOW_TOLERANCE_KW
            for grid, pv, discharge in zip(
                solved.grid_charge,
                solved.pv_charge,
                solved.discharge,
                strict=True,
            )
        )
        if simultaneous and not binary:
            simultaneous_detected = True
            binary = True
            corrections.append("lp_to_milp_simultaneous_charge_discharge")
            continue
        if simultaneous:
            return _WindowSolveOutcome(
                solved=None,
                demand_results=(),
                status=CiOptimizerStatus.MODEL_FAILURE,
                solver_mode="milp",
                simultaneous_detected=True,
                kva_iterations=kva_iterations,
                corrections=tuple(corrections)
                + ("milp_simultaneous_flow_invariant_failed",),
            )
        demand_results = _exact_demand_results(problem, solved)
        additions = _new_kva_cuts(
            problem,
            solved,
            demand_results,
            cuts,
            materiality_kva_component_count=materiality_kva_component_count,
        )
        if _kva_component_materiality_excess(
            problem,
            demand_results,
            materiality_kva_component_count=materiality_kva_component_count,
        ):
            if additions and kva_iterations < problem.config.max_kva_cut_iterations:
                kva_iterations += 1
                corrections.extend(additions)
                continue
            return _WindowSolveOutcome(
                solved=None,
                demand_results=(),
                status=CiOptimizerStatus.BILL_RECONCILIATION_FAILED,
                solver_mode="milp" if binary else "lp",
                simultaneous_detected=simultaneous_detected,
                kva_iterations=kva_iterations,
                corrections=tuple(corrections)
                + ("rolling_kva_cut_refinement_not_converged",),
            )
        bounded_kva = any(
            item.exact_replay_peak > item.optimized_limit + 1e-9
            for item in demand_results
            if item.basis == "kva"
        )
        status = (
            CiOptimizerStatus.BOUNDED_OPTIMAL
            if bounded_kva or (solved.mip_gap_aud or 0.0) > 0.0
            else CiOptimizerStatus.OPTIMAL_MILP
            if binary
            else CiOptimizerStatus.OPTIMAL_LP_EXACT
        )
        if bounded_kva:
            corrections.append("rolling_exact_kva_replay_within_aud_5_materiality")
        return _WindowSolveOutcome(
            solved=solved,
            demand_results=demand_results,
            status=status,
            solver_mode="milp" if binary else "lp",
            simultaneous_detected=simultaneous_detected,
            kva_iterations=kva_iterations,
            corrections=tuple(corrections),
        )


def _solved_from_dispatch_rows(
    problem: CiOptimizerProblem,
    rows: tuple[CiDispatchInterval, ...],
) -> _SolvedDispatch:
    if len(rows) != len(problem.intervals):
        raise ValueError("rolling dispatch must cover the complete calendar year")
    demand_peaks = {}
    for component in problem.demand_charges:
        exact_peak = max(
            rows[index].grid_import_kw
            if component.basis == "kw"
            else math.hypot(
                rows[index].grid_import_kw,
                rows[index].post_grid_reactive_kvar,
            )
            for index in component.interval_indexes
        )
        demand_peaks[component.component_id] = max(
            exact_peak, component.minimum_chargeable
        )
    return _SolvedDispatch(
        model_status=highspy.HighsModelStatus.kOptimal,
        objective=None,
        mip_gap_aud=0.0,
        grid_import=tuple(row.grid_import_kw for row in rows),
        pv_export=tuple(row.pv_export_kw for row in rows),
        pv_to_ac=tuple(row.pv_to_ac_kw for row in rows),
        grid_charge=tuple(row.grid_charge_kw for row in rows),
        pv_charge=tuple(row.pv_charge_kw for row in rows),
        discharge=tuple(row.discharge_kw for row in rows),
        reactive_support=tuple(
            row.inverter_reactive_support_kvar for row in rows
        ),
        soc=(rows[0].soc_start_kwh,) + tuple(row.soc_end_kwh for row in rows),
        demand_peaks=demand_peaks,
    )


def _rolling_failed_result(
    status: CiOptimizerStatus,
    *,
    planner_status: CiOptimizerStatus,
    idle_bill: float,
    windows: tuple[CiRollingWindowAudit, ...],
    corrections: tuple[str, ...],
) -> CiRollingReplayResult:
    return CiRollingReplayResult(
        algorithm_id=CI_PEAK_SHAVING_ROLLING_REPLAY_ID,
        status=status,
        planner_status=planner_status,
        solver_version=highspy.Highs().version(),
        customer_facing_permission=False,
        recommendation_permitted=False,
        exact_replay_bill_aud=None,
        idle_baseline_bill_aud=_money(idle_bill),
        optimization_exactness_gap_aud=None,
        bill_reconciliation_difference_aud=None,
        demand_charges=(),
        billing_periods=(),
        intervals=(),
        windows=windows,
        corrections=corrections,
        disclosures=_rolling_disclosures(),
    )


def _solve_two_stage(
    problem: CiOptimizerProblem,
    *,
    cuts: dict[str, list[tuple[float, float]]],
    binary: bool,
    fixed_soc_boundaries: dict[int, float] | None = None,
    minimum_soc_boundaries: dict[int, float] | None = None,
    fixed_demand_limits: dict[str, float] | None = None,
    forced_idle_period_ids: set[str] | None = None,
) -> _SolvedDispatch:
    primary_model = _build_model(
        problem,
        cuts=cuts,
        binary=binary,
        fixed_soc_boundaries=fixed_soc_boundaries,
        minimum_soc_boundaries=minimum_soc_boundaries,
        fixed_demand_limits=fixed_demand_limits,
        forced_idle_period_ids=forced_idle_period_ids,
    )
    primary = _run_model(primary_model, binary=binary)
    if primary.objective is None or primary.model_status not in {
        highspy.HighsModelStatus.kOptimal,
        highspy.HighsModelStatus.kTimeLimit,
    }:
        if not binary:
            retry_model = _build_model(
                problem,
                cuts=cuts,
                binary=False,
                fixed_soc_boundaries=fixed_soc_boundaries,
                minimum_soc_boundaries=minimum_soc_boundaries,
                fixed_demand_limits=fixed_demand_limits,
                forced_idle_period_ids=forced_idle_period_ids,
            )
            primary = _run_model(retry_model, binary=False)
            primary_model = retry_model
        if primary.objective is None or primary.model_status not in {
            highspy.HighsModelStatus.kOptimal,
            highspy.HighsModelStatus.kTimeLimit,
        }:
            return primary
    if primary.model_status is highspy.HighsModelStatus.kTimeLimit:
        if (
            not binary
            or primary.mip_gap_aud is None
            or primary.mip_gap_aud > problem.config.materiality_tolerance_aud
        ):
            return primary

    # Exact-kVA tangent refinement is driven by the primary objective.  Running
    # the secondary throughput tie-break on an intermediate outer
    # approximation cannot make that approximation authoritative, and on a
    # reactive annual model it needlessly repeats the expensive secondary
    # solve before the next required tangent is known.  Defer the tie-break
    # until the primary dispatch is already inside the unchanged whole-bill
    # materiality gate.  The final secondary dispatch is still replayed and may
    # require further tangents through the normal fail-closed refinement loop.
    if (
        _whole_bill_kva_underapproximation_aud(problem, primary)
        > problem.config.materiality_tolerance_aud
    ):
        return primary

    secondary_model = _prepare_secondary_model(
        primary_model,
        primary_upper_bound=(
            primary.objective + problem.config.primary_objective_tolerance_aud
        ),
        binary=binary,
        warm_start_simplex=problem.reactive_support.enabled,
    )
    secondary = _run_model(secondary_model, binary=binary)
    if secondary.objective is None or secondary.model_status not in {
        highspy.HighsModelStatus.kOptimal,
        highspy.HighsModelStatus.kTimeLimit,
    }:
        return secondary
    if secondary.model_status is highspy.HighsModelStatus.kTimeLimit:
        return _SolvedDispatch(
            model_status=secondary.model_status,
            objective=secondary.objective,
            mip_gap_aud=None,
            grid_import=secondary.grid_import,
            pv_export=secondary.pv_export,
            pv_to_ac=secondary.pv_to_ac,
            grid_charge=secondary.grid_charge,
            pv_charge=secondary.pv_charge,
            discharge=secondary.discharge,
            reactive_support=secondary.reactive_support,
            soc=secondary.soc,
            demand_peaks=secondary.demand_peaks,
        )
    return _SolvedDispatch(
        model_status=secondary.model_status,
        objective=_model_bill(problem, secondary),
        mip_gap_aud=primary.mip_gap_aud,
        grid_import=secondary.grid_import,
        pv_export=secondary.pv_export,
        pv_to_ac=secondary.pv_to_ac,
        grid_charge=secondary.grid_charge,
        pv_charge=secondary.pv_charge,
        discharge=secondary.discharge,
        reactive_support=secondary.reactive_support,
        soc=secondary.soc,
        demand_peaks=secondary.demand_peaks,
    )


def _build_model(
    problem: CiOptimizerProblem,
    *,
    cuts: dict[str, list[tuple[float, float]]],
    binary: bool,
    primary_upper_bound: float | None = None,
    secondary_objective: bool = False,
    fixed_soc_boundaries: dict[int, float] | None = None,
    minimum_soc_boundaries: dict[int, float] | None = None,
    fixed_demand_limits: dict[str, float] | None = None,
    forced_idle_period_ids: set[str] | None = None,
) -> _ModelArtifacts:
    highs = highspy.Highs()
    highs.setOptionValue("output_flag", False)
    highs.setOptionValue("threads", 1)
    highs.setOptionValue("random_seed", 0)
    highs.setOptionValue("time_limit", problem.config.time_limit_seconds)
    if not binary:
        highs.setOptionValue("solver", "simplex")
    highs.setOptionValue(
        "mip_abs_gap",
        0.0 if secondary_objective else problem.config.materiality_tolerance_aud,
    )

    battery = problem.battery
    count = len(problem.intervals)
    fast_equivalent_pv_allocation = (
        not problem.reactive_support.enabled
        and problem.config.allow_grid_charging
        and battery.max_charge_kw <= problem.shared_ac_headroom_kw
        and all(
            row.pv_kw + battery.max_discharge_kw
            <= problem.shared_ac_headroom_kw
            for row in problem.intervals
        )
    )
    known_period_ids = {period.period_id for period in problem.billing_periods}
    unknown_idle_periods = set(forced_idle_period_ids or ()) - known_period_ids
    if unknown_idle_periods:
        raise ValueError("forced idle billing period is outside the optimizer horizon")
    forced_idle_indexes = {
        index
        for period in problem.billing_periods
        if period.period_id in (forced_idle_period_ids or set())
        for index in period.interval_indexes
    }
    column_lower: list[float] = []
    column_upper: list[float] = []
    primary_costs: list[float] = []
    secondary_costs: list[float] = []
    integrality: list[highspy.HighsVarType] = []

    def add_column(
        *,
        lower: float = 0.0,
        upper: float = highspy.kHighsInf,
        primary_cost: float = 0.0,
        secondary_cost: float = 0.0,
        integer: bool = False,
    ) -> int:
        index = len(column_lower)
        column_lower.append(lower)
        column_upper.append(upper)
        primary_costs.append(primary_cost)
        secondary_costs.append(secondary_cost)
        integrality.append(
            highspy.HighsVarType.kInteger
            if integer
            else highspy.HighsVarType.kContinuous
        )
        return index

    grid_charge: list[int] = []
    pv_charge: list[int] = []
    pv_to_ac: list[int] = []
    pv_export: list[int] = []
    discharge: list[int] = []
    reactive_support: list[int] = []
    modes: list[int] = []
    primary_offset = 0.0
    for index, row in enumerate(problem.intervals):
        primary_offset += (
            row.load_kw * row.import_rate_aud_per_kwh * row.duration_hours
        )
        stable_weight = (index + 1) * 1e-10
        grid_charge.append(
            add_column(
                    upper=(
                        0.0
                        if index in forced_idle_indexes
                        else min(
                            battery.max_charge_kw,
                            problem.shared_ac_headroom_kw,
                        )
                        if problem.config.allow_grid_charging
                        else 0.0
                ),
                primary_cost=row.import_rate_aud_per_kwh * row.duration_hours,
                secondary_cost=row.duration_hours
                * (1.0 + 1e-3 + stable_weight),
            )
        )
        pv_charge.append(
            add_column(
                upper=(
                    0.0
                    if index in forced_idle_indexes
                    else min(
                        (
                            max(0.0, row.pv_kw - row.load_kw)
                            if fast_equivalent_pv_allocation
                            else row.pv_kw
                        ),
                        battery.max_charge_kw,
                    )
                ),
                primary_cost=0.0,
                secondary_cost=row.duration_hours * (1.0 + stable_weight),
            )
        )
        pv_to_ac.append(
            add_column(
                upper=min(row.pv_kw, problem.shared_ac_headroom_kw),
                primary_cost=-row.import_rate_aud_per_kwh * row.duration_hours,
            )
        )
        pv_export.append(
            add_column(
                upper=min(row.pv_kw, problem.shared_ac_headroom_kw),
                primary_cost=(
                    row.import_rate_aud_per_kwh
                    - row.export_credit_aud_per_kwh
                )
                * row.duration_hours,
            )
        )
        discharge.append(
            add_column(
                upper=(
                    0.0
                    if index in forced_idle_indexes
                    else min(row.load_kw, battery.max_discharge_kw)
                ),
                primary_cost=(
                    problem.config.wear_cost_aud_per_discharged_kwh
                    - row.import_rate_aud_per_kwh
                ) * row.duration_hours,
                secondary_cost=row.duration_hours * (1.0 + stable_weight),
            )
        )
        reactive_support.append(
            add_column(
                upper=(
                    min(
                        row.reactive_kvar,
                        problem.reactive_support.max_reactive_support_kvar,
                    )
                    if problem.reactive_support.enabled
                    else 0.0
                ),
                secondary_cost=(
                    -row.duration_hours * 1e-6
                    if problem.reactive_support.enabled
                    else 0.0
                ),
            )
        )
        if binary:
            modes.append(add_column(upper=1.0, integer=True))

    min_soc = battery.nominal_capacity_kwh * battery.min_soc_fraction
    max_soc = battery.nominal_capacity_kwh * battery.max_soc_fraction
    soc = [
        add_column(lower=min_soc, upper=max_soc)
        for index in range(count + 1)
    ]
    soc_boundaries = fixed_soc_boundaries or {
        0: battery.nominal_capacity_kwh * battery.initial_soc_fraction,
        count: battery.nominal_capacity_kwh * battery.terminal_soc_fraction,
    }
    for boundary, value in soc_boundaries.items():
        if boundary < 0 or boundary > count:
            raise ValueError("fixed SOC boundary is outside the optimizer horizon")
        if value < min_soc - 1e-9 or value > max_soc + 1e-9:
            raise ValueError("fixed SOC boundary is outside the battery bounds")
        column_lower[soc[boundary]] = column_upper[soc[boundary]] = value
    for boundary, value in (minimum_soc_boundaries or {}).items():
        if boundary < 0 or boundary > count:
            raise ValueError("minimum SOC boundary is outside the optimizer horizon")
        if value < min_soc - 1e-9 or value > max_soc + 1e-9:
            raise ValueError("minimum SOC boundary is outside the battery bounds")
        if column_upper[soc[boundary]] < value - 1e-9:
            raise ValueError("minimum SOC boundary conflicts with a fixed SOC boundary")
        column_lower[soc[boundary]] = max(column_lower[soc[boundary]], value)

    row_lower: list[float] = []
    row_upper: list[float] = []
    matrix_start: list[int] = [0]
    matrix_index: list[int] = []
    matrix_value: list[float] = []

    def add_row(
        terms: tuple[tuple[int, float], ...],
        *,
        lower: float = -highspy.kHighsInf,
        upper: float = highspy.kHighsInf,
    ) -> None:
        row_lower.append(lower)
        row_upper.append(upper)
        for column, coefficient in terms:
            matrix_index.append(column)
            matrix_value.append(coefficient)
        matrix_start.append(len(matrix_index))

    efficiency = battery.symmetric_efficiency
    for index, row in enumerate(problem.intervals):
        add_row(
            ((grid_charge[index], 1.0), (pv_charge[index], 1.0)),
            upper=battery.max_charge_kw,
        )
        add_row(
            ((pv_to_ac[index], 1.0), (pv_charge[index], 1.0)),
            lower=(
                row.pv_kw
                if fast_equivalent_pv_allocation
                else -highspy.kHighsInf
            ),
            upper=row.pv_kw,
        )
        if fast_equivalent_pv_allocation:
            add_row(
                ((pv_export[index], 1.0), (pv_charge[index], 1.0)),
                lower=max(0.0, row.pv_kw - row.load_kw),
                upper=max(0.0, row.pv_kw - row.load_kw),
            )
        add_row(
            ((pv_export[index], 1.0), (pv_to_ac[index], -1.0)),
            upper=0.0,
        )
        add_row(
            (
                (pv_to_ac[index], 1.0),
                (discharge[index], 1.0),
                (pv_export[index], -1.0),
            ),
            upper=row.load_kw,
        )
        add_row(
            (
                (pv_to_ac[index], 1.0),
                (discharge[index], 1.0),
                (grid_charge[index], -1.0),
            ),
            lower=-problem.shared_ac_headroom_kw,
            upper=problem.shared_ac_headroom_kw,
        )
        if problem.reactive_support.enabled:
            apparent_limit = (
                problem.reactive_support.inverter_apparent_power_limit_kva
            )
            if apparent_limit is None:
                raise ValueError("reactive apparent-power limit is missing")
            angle_step = math.pi / PQ_CAPABILITY_SEGMENTS
            conservative_radius = apparent_limit * math.cos(angle_step / 2)
            for segment in range(PQ_CAPABILITY_SEGMENTS):
                angle = (segment + 0.5) * angle_step
                active_weight = math.cos(angle)
                reactive_weight = math.sin(angle)
                add_row(
                    (
                        (pv_to_ac[index], active_weight),
                        (discharge[index], active_weight),
                        (grid_charge[index], -active_weight),
                        (reactive_support[index], reactive_weight),
                    ),
                    upper=conservative_radius,
                )
        if binary:
            add_row(
                (
                    (grid_charge[index], 1.0),
                    (pv_charge[index], 1.0),
                    (modes[index], -battery.max_charge_kw),
                ),
                upper=0.0,
            )
            add_row(
                (
                    (discharge[index], 1.0),
                    (modes[index], battery.max_discharge_kw),
                ),
                upper=battery.max_discharge_kw,
            )
        add_row(
            (
                (soc[index + 1], 1.0),
                (soc[index], -1.0),
                (grid_charge[index], -row.duration_hours * efficiency),
                (pv_charge[index], -row.duration_hours * efficiency),
                (discharge[index], row.duration_hours / efficiency),
            ),
            lower=0.0,
            upper=0.0,
        )

    demand_peaks: dict[str, int] = {}
    for component in problem.demand_charges:
        fixed_limit = (
            None
            if fixed_demand_limits is None
            else fixed_demand_limits.get(component.component_id)
        )
        if fixed_demand_limits is not None and fixed_limit is None:
            raise ValueError("fixed demand limit is missing for a window component")
        if fixed_limit is not None and fixed_limit + 1e-9 < component.minimum_chargeable:
            raise ValueError("fixed demand limit is below the component minimum")
        peak = add_column(
            lower=(
                component.minimum_chargeable if fixed_limit is None else fixed_limit
            ),
            upper=highspy.kHighsInf if fixed_limit is None else fixed_limit,
            primary_cost=component.rate_aud_per_unit,
        )
        demand_peaks[component.component_id] = peak
        for index in component.interval_indexes:
            if component.basis == "kw":
                add_row(
                    (
                        (grid_charge[index], 1.0),
                        (pv_export[index], 1.0),
                        (pv_to_ac[index], -1.0),
                        (discharge[index], -1.0),
                        (peak, -1.0),
                    ),
                    upper=-problem.intervals[index].load_kw,
                )
            else:
                kvar = problem.intervals[index].reactive_kvar
                if fixed_limit is None or problem.reactive_support.enabled:
                    add_row(
                        (
                            (grid_charge[index], 1.0),
                            (pv_export[index], 1.0),
                            (pv_to_ac[index], -1.0),
                            (discharge[index], -1.0),
                            (peak, -1.0),
                        ),
                        upper=-problem.intervals[index].load_kw,
                    )
                else:
                    exact_active_limit = math.sqrt(
                        max(0.0, fixed_limit * fixed_limit - kvar * kvar)
                    )
                    add_row(
                        (
                            (grid_charge[index], 1.0),
                            (pv_export[index], 1.0),
                            (pv_to_ac[index], -1.0),
                            (discharge[index], -1.0),
                        ),
                        upper=(
                            exact_active_limit
                            - problem.intervals[index].load_kw
                        ),
                    )
                add_row(
                    ((peak, 1.0), (reactive_support[index], 1.0)),
                    lower=kvar,
                )
                for reference_import, reference_post_kvar in cuts.get(
                    component.component_id, []
                ):
                    radius = math.hypot(reference_import, reference_post_kvar)
                    if radius > 0:
                        add_row(
                            (
                                (
                                    grid_charge[index],
                                    reference_import / radius,
                                ),
                                (
                                    pv_export[index],
                                    reference_import / radius,
                                ),
                                (
                                    pv_to_ac[index],
                                    -reference_import / radius,
                                ),
                                (
                                    discharge[index],
                                    -reference_import / radius,
                                ),
                                (
                                    reactive_support[index],
                                    -reference_post_kvar / radius,
                                ),
                                (peak, -1.0),
                            ),
                            upper=-(
                                kvar * reference_post_kvar / radius
                                + problem.intervals[index].load_kw
                                * reference_import
                                / radius
                            ),
                        )

    primary_terms = tuple(
        (index, coefficient)
        for index, coefficient in enumerate(primary_costs)
        if coefficient != 0.0
    )
    primary_cost_block_totals = []
    for start in range(0, len(primary_terms), PRIMARY_COST_BOUND_BLOCK_NONZEROS):
        block_total = add_column(
            lower=-highspy.kHighsInf,
            upper=highspy.kHighsInf,
        )
        primary_cost_block_totals.append(block_total)
        add_row(
            ((block_total, 1.0),)
            + tuple(
                (index, -coefficient)
                for index, coefficient in primary_terms[
                    start : start + PRIMARY_COST_BOUND_BLOCK_NONZEROS
                ]
            ),
            lower=0.0,
            upper=0.0,
        )
    if primary_upper_bound is not None:
        add_row(
            tuple((index, 1.0) for index in primary_cost_block_totals),
            upper=primary_upper_bound - primary_offset,
        )

    lp = highspy.HighsLp()
    lp.num_col_ = len(column_lower)
    lp.num_row_ = len(row_lower)
    lp.col_cost_ = secondary_costs if secondary_objective else primary_costs
    lp.col_lower_ = column_lower
    lp.col_upper_ = column_upper
    lp.offset_ = 0.0 if secondary_objective else primary_offset
    lp.row_lower_ = row_lower
    lp.row_upper_ = row_upper
    lp.integrality_ = integrality
    lp.a_matrix_.format_ = highspy.MatrixFormat.kRowwise
    lp.a_matrix_.num_col_ = lp.num_col_
    lp.a_matrix_.num_row_ = lp.num_row_
    lp.a_matrix_.start_ = matrix_start
    lp.a_matrix_.index_ = matrix_index
    lp.a_matrix_.value_ = matrix_value
    if highs.passModel(lp) != highspy.HighsStatus.kOk:
        raise RuntimeError("HiGHS rejected the sparse optimizer model")
    return _ModelArtifacts(
        highs=highs,
        grid_charge=grid_charge,
        pv_charge=pv_charge,
        pv_to_ac=pv_to_ac,
        pv_export=pv_export,
        discharge=discharge,
        reactive_support=reactive_support,
        soc=soc,
        demand_peaks=demand_peaks,
        loads_kw=tuple(row.load_kw for row in problem.intervals),
        primary_costs=tuple(primary_costs),
        secondary_costs=tuple(secondary_costs),
        primary_cost_block_totals=tuple(primary_cost_block_totals),
        primary_offset=primary_offset,
        secondary_objective=secondary_objective,
    )


def _prepare_secondary_model(
    model: _ModelArtifacts,
    *,
    primary_upper_bound: float,
    binary: bool,
    warm_start_simplex: bool = False,
) -> _ModelArtifacts:
    primary_indexes = list(model.primary_cost_block_totals)
    if model.highs.addRow(
        -highspy.kHighsInf,
        primary_upper_bound - model.primary_offset,
        len(primary_indexes),
        primary_indexes,
        [1.0] * len(primary_indexes),
    ) != highspy.HighsStatus.kOk:
        raise RuntimeError("HiGHS rejected the secondary primary-cost bound")
    all_indexes = list(range(len(model.secondary_costs)))
    if model.highs.changeColsCost(
        len(all_indexes),
        all_indexes,
        list(model.secondary_costs),
    ) != highspy.HighsStatus.kOk:
        raise RuntimeError("HiGHS rejected the secondary objective")
    if model.highs.changeObjectiveOffset(0.0) != highspy.HighsStatus.kOk:
        raise RuntimeError("HiGHS rejected the secondary objective offset")
    if not binary and not warm_start_simplex:
        model.highs.setOptionValue("solver", "ipm")
    model.highs.setOptionValue("mip_abs_gap", 0.0)
    model.secondary_objective = True
    return model


def _run_model(model: _ModelArtifacts, *, binary: bool) -> _SolvedDispatch:
    model.highs.run()
    status = model.highs.getModelStatus()
    solution = model.highs.getSolution()
    has_solution = bool(solution.value_valid)
    column_values = list(solution.col_value) if has_solution else []
    info = model.highs.getInfo()
    objective = model.highs.getObjectiveValue() if has_solution else None
    mip_gap = None
    if (
        binary
        and has_solution
        and not model.secondary_objective
        and objective is not None
        and math.isfinite(info.mip_dual_bound)
    ):
        mip_gap = abs(objective - info.mip_dual_bound)
    return _SolvedDispatch(
        model_status=status,
        objective=objective,
        mip_gap_aud=mip_gap,
        grid_import=(
            tuple(
                model.loads_kw[index]
                + column_values[model.grid_charge[index]]
                + column_values[model.pv_export[index]]
                - column_values[model.pv_to_ac[index]]
                - column_values[model.discharge[index]]
                for index in range(len(model.grid_charge))
            )
            if has_solution
            else ()
        ),
        pv_export=(
            tuple(column_values[item] for item in model.pv_export)
            if has_solution
            else ()
        ),
        pv_to_ac=tuple(column_values[item] for item in model.pv_to_ac)
        if has_solution
        else (),
        grid_charge=tuple(column_values[item] for item in model.grid_charge)
        if has_solution
        else (),
        pv_charge=tuple(column_values[item] for item in model.pv_charge)
        if has_solution
        else (),
        discharge=tuple(column_values[item] for item in model.discharge)
        if has_solution
        else (),
        reactive_support=tuple(
            column_values[item] for item in model.reactive_support
        )
        if has_solution
        else (),
        soc=tuple(column_values[item] for item in model.soc)
        if has_solution
        else (),
        demand_peaks={
            key: column_values[value]
            for key, value in model.demand_peaks.items()
        }
        if has_solution
        else {},
    )


def _physical_dispatch_violation(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
) -> bool:
    tolerance = 1e-6
    for index, row in enumerate(problem.intervals):
        grid_charge = solved.grid_charge[index]
        pv_charge = solved.pv_charge[index]
        pv_to_ac = solved.pv_to_ac[index]
        pv_export = solved.pv_export[index]
        discharge = solved.discharge[index]
        reactive_support = solved.reactive_support[index]
        shared_port = pv_to_ac + discharge - grid_charge
        apparent_power = math.hypot(shared_port, reactive_support)
        apparent_limit = problem.reactive_support.inverter_apparent_power_limit_kva
        if (
            grid_charge + pv_charge > problem.battery.max_charge_kw + tolerance
            or discharge > problem.battery.max_discharge_kw + tolerance
            or pv_to_ac + pv_charge > row.pv_kw + tolerance
            or pv_export > pv_to_ac + tolerance
            or pv_to_ac + discharge - pv_export > row.load_kw + tolerance
            or solved.grid_import[index] < -tolerance
            or abs(shared_port) > problem.shared_ac_headroom_kw + tolerance
            or reactive_support < -tolerance
            or reactive_support > row.reactive_kvar + tolerance
            or reactive_support
            > problem.reactive_support.max_reactive_support_kvar + tolerance
            or (
                problem.reactive_support.enabled
                and (
                    apparent_limit is None
                    or apparent_power > apparent_limit + tolerance
                )
            )
            or (
                not problem.reactive_support.enabled
                and reactive_support > tolerance
            )
        ):
            return True
    return False


def _failure_status(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
    *,
    binary: bool,
) -> CiOptimizerStatus | None:
    if solved.model_status == highspy.HighsModelStatus.kOptimal:
        return None
    if solved.model_status == highspy.HighsModelStatus.kTimeLimit:
        if (
            binary
            and solved.objective is not None
            and solved.mip_gap_aud is not None
            and solved.mip_gap_aud <= problem.config.materiality_tolerance_aud
        ):
            return None
        return CiOptimizerStatus.SOLVER_TIMEOUT
    if solved.model_status == highspy.HighsModelStatus.kInfeasible:
        return CiOptimizerStatus.MODEL_FAILURE
    if solved.model_status in {
        highspy.HighsModelStatus.kSolveError,
        highspy.HighsModelStatus.kPostsolveError,
        highspy.HighsModelStatus.kPresolveError,
    }:
        return CiOptimizerStatus.NUMERICAL_FAILURE
    return CiOptimizerStatus.MODEL_FAILURE


def _exact_demand_results(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
) -> tuple[CiDemandChargeResult, ...]:
    results = []
    for component in problem.demand_charges:
        exact_peak = _exact_demand_peak(problem, solved, component)
        results.append(
            CiDemandChargeResult(
                component_id=component.component_id,
                basis=component.basis,
                optimized_limit=_clean(solved.demand_peaks[component.component_id]),
                exact_replay_peak=_clean(exact_peak),
                exact_charge_aud=_money(exact_peak * component.rate_aud_per_unit),
            )
        )
    return tuple(results)


def _billing_period_results(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
) -> tuple[CiBillingPeriodResult, ...]:
    results = []
    for period in problem.billing_periods:
        first_index = period.interval_indexes[0]
        end_boundary = period.interval_indexes[-1] + 1
        charge_input_kwh = sum(
            (solved.grid_charge[index] + solved.pv_charge[index])
            * problem.intervals[index].duration_hours
            for index in period.interval_indexes
        )
        discharge_output_kwh = sum(
            solved.discharge[index] * problem.intervals[index].duration_hours
            for index in period.interval_indexes
        )
        active = (
            charge_input_kwh > 1e-7
            or discharge_output_kwh > 1e-7
            or abs(solved.soc[end_boundary] - solved.soc[first_index]) > 1e-7
            or any(
                solved.grid_charge[index] > SIMULTANEOUS_FLOW_TOLERANCE_KW
                or solved.pv_charge[index] > SIMULTANEOUS_FLOW_TOLERANCE_KW
                or solved.discharge[index] > SIMULTANEOUS_FLOW_TOLERANCE_KW
                for index in period.interval_indexes
            )
        )
        selected_candidate = (
            "optimized_dispatch" if active else "battery_idle"
        )
        results.append(
            CiBillingPeriodResult(
                period_id=period.period_id,
                candidate_ids=("battery_idle", "optimized_dispatch"),
                selected_candidate=selected_candidate,
                start_soc_kwh=_clean(solved.soc[first_index]),
                end_soc_kwh=_clean(solved.soc[end_boundary]),
                charge_input_kwh=_clean(charge_input_kwh),
                discharge_output_kwh=_clean(discharge_output_kwh),
            )
        )
    return tuple(results)


def _exact_demand_peak(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
    component: CiDemandCharge,
) -> float:
    return max(
        component.minimum_chargeable,
        max(
            solved.grid_import[index]
            if component.basis == "kw"
            else math.hypot(
                solved.grid_import[index],
                problem.intervals[index].reactive_kvar
                - solved.reactive_support[index],
            )
            for index in component.interval_indexes
        ),
    )


def _model_bill(problem: CiOptimizerProblem, solved: _SolvedDispatch) -> float:
    return sum(
        solved.grid_import[index] * row.import_rate_aud_per_kwh * row.duration_hours
        - solved.pv_export[index]
        * row.export_credit_aud_per_kwh
        * row.duration_hours
        + solved.discharge[index]
        * problem.config.wear_cost_aud_per_discharged_kwh
        * row.duration_hours
        for index, row in enumerate(problem.intervals)
    ) + sum(
        solved.demand_peaks[item.component_id] * item.rate_aud_per_unit
        for item in problem.demand_charges
    )


def _exact_bill(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
    demand_results: tuple[CiDemandChargeResult, ...],
) -> float:
    energy_and_wear = sum(
        solved.grid_import[index] * row.import_rate_aud_per_kwh * row.duration_hours
        - solved.pv_export[index]
        * row.export_credit_aud_per_kwh
        * row.duration_hours
        + solved.discharge[index]
        * problem.config.wear_cost_aud_per_discharged_kwh
        * row.duration_hours
        for index, row in enumerate(problem.intervals)
    )
    rate_by_component = {
        item.component_id: item.rate_aud_per_unit
        for item in problem.demand_charges
    }
    return energy_and_wear + sum(
        item.exact_replay_peak * rate_by_component[item.component_id]
        for item in demand_results
    )


def _replay_bill_from_dispatch(
    problem: CiOptimizerProblem,
    dispatch: tuple[CiDispatchInterval, ...],
) -> float:
    """Independently bill a public dispatch without optimizer peak variables."""

    if len(dispatch) != len(problem.intervals):
        raise ValueError("billing replay requires one dispatch row per source interval")
    energy_and_wear = sum(
        dispatch[index].grid_import_kw
        * source.import_rate_aud_per_kwh
        * source.duration_hours
        - dispatch[index].pv_export_kw
        * source.export_credit_aud_per_kwh
        * source.duration_hours
        + dispatch[index].discharge_kw
        * problem.config.wear_cost_aud_per_discharged_kwh
        * source.duration_hours
        for index, source in enumerate(problem.intervals)
    )
    demand = 0.0
    for component in problem.demand_charges:
        peak = max(
            dispatch[index].grid_import_kw
            if component.basis == "kw"
            else math.hypot(
                dispatch[index].grid_import_kw,
                dispatch[index].post_grid_reactive_kvar,
            )
            for index in component.interval_indexes
        )
        demand += (
            max(peak, component.minimum_chargeable) * component.rate_aud_per_unit
        )
    return energy_and_wear + demand


def _idle_bill(problem: CiOptimizerProblem) -> float:
    pv_to_ac = tuple(
        min(
            row.pv_kw,
            problem.shared_ac_headroom_kw,
            (
                problem.reactive_support.inverter_apparent_power_limit_kva
                if problem.reactive_support.enabled
                else problem.shared_ac_headroom_kw
            ),
        )
        for row in problem.intervals
    )
    imports = tuple(
        max(0.0, row.load_kw - pv_to_ac[index])
        for index, row in enumerate(problem.intervals)
    )
    exports = tuple(
        max(0.0, pv_to_ac[index] - row.load_kw)
        for index, row in enumerate(problem.intervals)
    )
    reactive_support = tuple(
        _maximum_reactive_support(problem, index, pv_to_ac[index])
        for index in range(len(problem.intervals))
    )
    energy = sum(
        imports[index] * row.import_rate_aud_per_kwh * row.duration_hours
        - exports[index] * row.export_credit_aud_per_kwh * row.duration_hours
        for index, row in enumerate(problem.intervals)
    )
    demand = 0.0
    for component in problem.demand_charges:
        peak = max(
            imports[index]
            if component.basis == "kw"
            else math.hypot(
                imports[index],
                problem.intervals[index].reactive_kvar - reactive_support[index],
            )
            for index in component.interval_indexes
        )
        demand += max(peak, component.minimum_chargeable) * component.rate_aud_per_unit
    return energy + demand


def _idle_dispatch(problem: CiOptimizerProblem) -> _SolvedDispatch:
    pv_to_ac = tuple(
        min(
            row.pv_kw,
            problem.shared_ac_headroom_kw,
            (
                problem.reactive_support.inverter_apparent_power_limit_kva
                if problem.reactive_support.enabled
                else problem.shared_ac_headroom_kw
            ),
        )
        for row in problem.intervals
    )
    imports = tuple(
        max(0.0, row.load_kw - pv_to_ac[index])
        for index, row in enumerate(problem.intervals)
    )
    exports = tuple(
        max(0.0, pv_to_ac[index] - row.load_kw)
        for index, row in enumerate(problem.intervals)
    )
    reactive_support = tuple(
        _maximum_reactive_support(problem, index, pv_to_ac[index])
        for index in range(len(problem.intervals))
    )
    initial_soc = (
        problem.battery.nominal_capacity_kwh
        * problem.battery.initial_soc_fraction
    )
    demand_peaks = {}
    for component in problem.demand_charges:
        peak = max(
            imports[index]
            if component.basis == "kw"
            else math.hypot(
                imports[index],
                problem.intervals[index].reactive_kvar - reactive_support[index],
            )
            for index in component.interval_indexes
        )
        demand_peaks[component.component_id] = max(
            peak, component.minimum_chargeable
        )
    return _SolvedDispatch(
        model_status=highspy.HighsModelStatus.kOptimal,
        objective=_idle_bill(problem),
        mip_gap_aud=0.0,
        grid_import=imports,
        pv_export=exports,
        pv_to_ac=pv_to_ac,
        grid_charge=(0.0,) * len(problem.intervals),
        pv_charge=(0.0,) * len(problem.intervals),
        discharge=(0.0,) * len(problem.intervals),
        reactive_support=reactive_support,
        soc=(initial_soc,) * (len(problem.intervals) + 1),
        demand_peaks=demand_peaks,
    )


def _new_kva_cuts(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
    demand_results: tuple[CiDemandChargeResult, ...],
    cuts: dict[str, list[tuple[float, float]]],
    *,
    materiality_kva_component_count: int | None = None,
) -> list[str]:
    by_id = {item.component_id: item for item in demand_results}
    additions = []
    kva_component_count = (
        materiality_kva_component_count
        if materiality_kva_component_count is not None
        else sum(
            component.basis == "kva" for component in problem.demand_charges
        )
    )
    # The AUD 5 gate applies to the complete bill, so each component receives
    # an equal share for deciding whether another exact-kVA tangent is needed.
    component_materiality_budget = (
        problem.config.materiality_tolerance_aud / max(1, kva_component_count)
    )
    for component in problem.demand_charges:
        if component.basis != "kva":
            continue
        result = by_id[component.component_id]
        if (
            (result.exact_replay_peak - result.optimized_limit)
            * component.rate_aud_per_unit
            <= component_materiality_budget
        ):
            continue
        candidate_indexes = sorted(
            component.interval_indexes,
            key=lambda item: math.hypot(
                solved.grid_import[item],
                problem.intervals[item].reactive_kvar
                - solved.reactive_support[item],
            ),
            reverse=True,
        )
        component_additions = 0
        for index in candidate_indexes:
            reference_import = solved.grid_import[index]
            reference_post_kvar = (
                problem.intervals[index].reactive_kvar
                - solved.reactive_support[index]
            )
            if _kva_tangent_direction_present(
                cuts[component.component_id],
                reference_import,
                reference_post_kvar,
            ):
                continue
            cuts[component.component_id].append(
                (reference_import, reference_post_kvar)
            )
            additions.append(f"kva_tangent_cut:{component.component_id}:{index}")
            component_additions += 1
            if component_additions >= KVA_CUT_BATCH_SIZE:
                break
    return additions


def _kva_component_materiality_excess(
    problem: CiOptimizerProblem,
    demand_results: tuple[CiDemandChargeResult, ...],
    *,
    materiality_kva_component_count: int | None = None,
) -> bool:
    component_count = (
        materiality_kva_component_count
        if materiality_kva_component_count is not None
        else sum(
            component.basis == "kva" for component in problem.demand_charges
        )
    )
    component_budget = (
        problem.config.materiality_tolerance_aud / max(1, component_count)
    )
    component_rates = {
        component.component_id: component.rate_aud_per_unit
        for component in problem.demand_charges
    }
    return any(
        max(0.0, item.exact_replay_peak - item.optimized_limit)
        * component_rates[item.component_id]
        > component_budget
        for item in demand_results
        if item.basis == "kva"
    )


def _kva_tangent_direction_present(
    cuts: list[tuple[float, float]],
    reference_import: float,
    reference_post_kvar: float,
) -> bool:
    reference_radius = math.hypot(reference_import, reference_post_kvar)
    if reference_radius <= 1e-12:
        return True
    reference_active_weight = reference_import / reference_radius
    reference_reactive_weight = reference_post_kvar / reference_radius
    for active_value, reactive_value in cuts:
        radius = math.hypot(active_value, reactive_value)
        if radius <= 1e-12:
            continue
        if (
            abs(active_value / radius - reference_active_weight) <= 1e-9
            and abs(reactive_value / radius - reference_reactive_weight) <= 1e-9
        ):
            return True
    return False


def _whole_bill_kva_underapproximation_aud(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
) -> float:
    if not any(
        component.basis == "kva" for component in problem.demand_charges
    ):
        return 0.0
    demand_results = _exact_demand_results(problem, solved)
    component_rates = {
        component.component_id: component.rate_aud_per_unit
        for component in problem.demand_charges
    }
    return sum(
        max(0.0, item.exact_replay_peak - item.optimized_limit)
        * component_rates[item.component_id]
        for item in demand_results
        if item.basis == "kva"
    )


def _maximum_reactive_support(
    problem: CiOptimizerProblem,
    index: int,
    shared_active_power_kw: float,
) -> float:
    return _reactive_support_bound(problem, index, shared_active_power_kw)


def _dynamic_reserve(
    problem: CiOptimizerProblem,
    solved: _SolvedDispatch,
    demand_results: tuple[CiDemandChargeResult, ...],
) -> tuple[float, ...]:
    """Return a disclosed 48-hour perfect-foresight reserve trace.

    The reserve is a diagnostic for the later rolling executor. It works
    backwards from each interval's active optimized demand limit, permits
    charging headroom inside the 48-hour look-ahead, and never replaces the
    annual LP constraints.
    """

    limit_by_component = {
        item.component_id: item.optimized_limit for item in demand_results
    }
    kw_limits_by_index: list[list[float]] = [
        [] for _ in problem.intervals
    ]
    for component in problem.demand_charges:
        if component.basis != "kw":
            continue
        limit = limit_by_component[component.component_id]
        for index in component.interval_indexes:
            kw_limits_by_index[index].append(limit)
    min_soc = problem.battery.nominal_capacity_kwh * problem.battery.min_soc_fraction
    max_soc = problem.battery.nominal_capacity_kwh * problem.battery.max_soc_fraction
    efficiency = problem.battery.symmetric_efficiency
    reserves = []
    for start in range(len(problem.intervals)):
        duration = 0.0
        end = start
        while end < len(problem.intervals) and duration < 48.0:
            duration += problem.intervals[end].duration_hours
            end += 1
        required = min_soc
        for index in range(end - 1, start - 1, -1):
            row = problem.intervals[index]
            active_limits = kw_limits_by_index[index]
            limit = min(active_limits) if active_limits else math.inf
            net_load = max(0.0, row.load_kw - row.pv_kw)
            required_discharge = min(
                problem.battery.max_discharge_kw,
                max(0.0, net_load - limit),
            )
            pv_surplus = max(0.0, row.pv_kw - row.load_kw)
            grid_charge_headroom = (
                (
                    problem.battery.max_charge_kw
                    if not math.isfinite(limit)
                    else max(0.0, limit - net_load)
                )
                if problem.config.allow_grid_charging
                else 0.0
            )
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
        reserves.append(min(max_soc, required))
    return tuple(reserves)


def _failed_result(
    problem: CiOptimizerProblem,
    status: CiOptimizerStatus,
    *,
    idle_bill: float,
    solver_mode: Literal["lp", "milp"],
    simultaneous_detected: bool,
    kva_iterations: int,
    corrections: list[str],
    mip_gap: float | None,
) -> CiOptimizerResult:
    return CiOptimizerResult(
        algorithm_id=CI_PEAK_SHAVING_OPTIMIZER_ID,
        status=status,
        solver_mode=solver_mode,
        solver_version=highspy.Highs().version(),
        customer_facing_permission=False,
        recommendation_permitted=False,
        primary_objective_aud=None,
        exact_replay_bill_aud=None,
        idle_baseline_bill_aud=_money(idle_bill),
        optimization_exactness_gap_aud=None,
        bill_reconciliation_difference_aud=None,
        mip_absolute_gap_aud=None if mip_gap is None else _money(mip_gap),
        simultaneous_charge_discharge_detected=simultaneous_detected,
        kva_cut_iterations=kva_iterations,
        demand_charges=(),
        billing_periods=(),
        intervals=(),
        corrections=tuple(corrections),
        disclosures=_disclosures(),
    )


def _disclosures() -> tuple[str, ...]:
    return (
        "Internal-review calculation only; customer-facing permission is false.",
        "The 48-hour reserve diagnostic uses actual future synthetic inputs and is not a forecast-error model.",
        "HiGHS executes the repository-owned LP/MILP; no proprietary evaluator or score semantics are claimed.",
        "Each explicit billing period exposes battery_idle and optimized_dispatch candidates; the annual objective and AUD 0.01 throughput tie-break select zero-flow idle periods without breaking cross-period SOC continuity.",
        "The editable shared AC-port headroom defaults to 250 kW and applies bidirectionally to PV-to-AC plus battery discharge minus grid-to-battery charging; DC-coupled PV-to-battery charging does not consume that AC headroom.",
        "Reactive support is an explicit analyst assumption, is limited by measured site kvar, an authored kvar cap and the shared inverter circular P-Q apparent-power envelope, and cannot overcompensate or export reactive power.",
        "HiGHS uses a conservative 16-segment inner P-Q approximation; independent nonlinear replay checks shared-inverter apparent power, post-grid kvar and exact grid-import kVA.",
        "Battery wear is an AUD 0.05 per discharged kWh dispatch shadow cost and is not a finance or NPV cash flow.",
        "Fixed charges, tariff eligibility, GST, recommendation and customer claims are outside this optimizer contract.",
    )


def _rolling_disclosures() -> tuple[str, ...]:
    return _disclosures() + (
        "Rolling execution uses actual future inputs over 48 hours, commits only the first 24 hours, and is not a forecast-error model.",
        "Each 24-hour commit retains at least the annual planner's feasible SOC at the same boundary; this is a physical viability condition, not a demand-limit margin.",
        "December look-ahead reuses the same representative year's January inputs; wrapped intervals are not billed twice.",
        "Window-end SOC is constrained only by the physical minimum, while the committed calendar year starts and ends at 100% SOC.",
    )


def _finite(name: str, value: float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite")


def _finite_non_negative(name: str, value: float) -> None:
    _finite(name, value)
    if value < 0:
        raise ValueError(f"{name} must be non-negative")


def _finite_positive(name: str, value: float) -> None:
    _finite(name, value)
    if value <= 0:
        raise ValueError(f"{name} must be positive")


def _clean(value: float) -> float:
    return 0.0 if abs(value) < 1e-9 else round(float(value), 9)


def _money(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)

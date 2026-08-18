from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import math

from solar_battery.battery_dispatch import (
    BatteryDispatchEnergyInput,
    build_energy_only_battery_dispatch_result,
)
from solar_battery.battery_strategy import (
    BatteryStrategyConfig,
    BatteryStrategyIdentifier,
    StrategyGateStatus,
)
from solar_battery.models import BatteryPreset, CleanedInterval, WarningMessage


PEAK_SHAVING_ALGORITHM_ID = "internal_peak_shaving_period_v1"
PEAK_SHAVING_CANDIDATE_COUNT = 51
PEAK_SHAVING_UPPER_THRESHOLD_MULTIPLIER = 1.1
PEAK_SHAVING_NUMERICAL_TOLERANCE_KW = 1e-9
PEAK_SHAVING_TERMINAL_SOC_TOLERANCE_KWH = 1e-9


class PeakShavingExecutionStatus(str, Enum):
    INTERNAL_REVIEW_EXECUTED = "internal_review_executed"
    BLOCKED_NOT_EXECUTED = "blocked_not_executed"


@dataclass(frozen=True)
class PeakShavingConfig:
    allow_grid_charging: bool = True
    gate_status: StrategyGateStatus | str = StrategyGateStatus.REVIEW_ONLY

    def __post_init__(self) -> None:
        try:
            gate_status = StrategyGateStatus(self.gate_status)
        except (TypeError, ValueError) as exc:
            raise ValueError("gate_status must be review_only or blocked") from exc
        object.__setattr__(self, "gate_status", gate_status)
        if not isinstance(self.allow_grid_charging, bool):
            raise ValueError("allow_grid_charging must be a bool")


@dataclass(frozen=True)
class PeakShavingCandidateEvaluation:
    index: int
    threshold_kw: float
    feasible: bool
    achieved_peak_kw: float | None
    final_soc_kwh: float | None
    rejection_reasons: tuple[str, ...]


@dataclass(frozen=True)
class PeakShavingDispatchInterval:
    timestamp: datetime
    interval_minutes: int
    demand_window: bool
    input_load_kw: float
    battery_charge_input_kwh: float
    battery_discharge_output_kwh: float
    grid_import_kw: float
    soc_start_kwh: float
    soc_end_kwh: float


@dataclass(frozen=True)
class PeakShavingResult:
    algorithm_id: str
    execution_status: PeakShavingExecutionStatus
    execution_mode: str
    config: PeakShavingConfig
    customer_facing_permission: bool
    baseline_peak_kw: float
    selected_threshold_kw: float | None
    achieved_peak_kw: float | None
    initial_soc_kwh: float
    final_soc_kwh: float
    candidate_evaluations: tuple[PeakShavingCandidateEvaluation, ...]
    intervals: tuple[PeakShavingDispatchInterval, ...]
    assumptions: tuple[str, ...]
    warnings: tuple[WarningMessage, ...]


@dataclass(frozen=True)
class PeakShavingPeriodInput:
    period_id: str
    intervals: tuple[CleanedInterval, ...]
    demand_window: tuple[bool, ...] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.period_id, str) or not self.period_id.strip():
            raise ValueError("period_id must be non-blank text")
        object.__setattr__(self, "period_id", self.period_id.strip())
        object.__setattr__(self, "intervals", tuple(self.intervals))
        if self.demand_window is not None:
            object.__setattr__(self, "demand_window", tuple(self.demand_window))


@dataclass(frozen=True)
class PeakShavingPeriodResult:
    period_id: str
    result: PeakShavingResult


@dataclass(frozen=True)
class PeakShavingHorizonResult:
    algorithm_id: str
    execution_status: PeakShavingExecutionStatus
    customer_facing_permission: bool
    initial_soc_kwh: float
    final_soc_kwh: float
    selected_thresholds_kw: tuple[float | None, ...]
    periods: tuple[PeakShavingPeriodResult, ...]


@dataclass(frozen=True)
class _IntentEnvelope:
    charge_available_kwh: float
    discharge_required_kwh: float


def _finite_non_negative(name: str, value: float) -> None:
    try:
        valid = not isinstance(value, bool) and math.isfinite(value) and value >= 0
    except TypeError:
        valid = False
    if not valid:
        raise ValueError(f"{name} must be finite and non-negative")


def _validated_inputs(
    intervals: Sequence[CleanedInterval],
    demand_window: Sequence[bool] | None,
) -> tuple[tuple[CleanedInterval, ...], tuple[bool, ...]]:
    rows = tuple(intervals)
    if not rows:
        raise ValueError("At least one cleaned interval is required")
    if any(not isinstance(row, CleanedInterval) for row in rows):
        raise ValueError("intervals must contain CleanedInterval values")
    for row in rows:
        _finite_non_negative("interval load_kwh", row.load_kwh)
        if not isinstance(row.timestamp, datetime):
            raise ValueError("interval timestamp must be a datetime")
        if (
            isinstance(row.interval_minutes, bool)
            or not isinstance(row.interval_minutes, int)
            or row.interval_minutes <= 0
        ):
            raise ValueError("interval_minutes must be a positive integer")
        try:
            load_kw_avg_is_finite = math.isfinite(row.load_kw_avg)
        except (OverflowError, TypeError, ZeroDivisionError):
            load_kw_avg_is_finite = False
        if not load_kw_avg_is_finite:
            raise ValueError("interval average load_kw must be finite")
    if any(
        current.timestamp <= previous.timestamp
        for previous, current in zip(rows, rows[1:], strict=False)
    ):
        raise ValueError("interval timestamps must be strictly increasing")

    windows = (
        tuple(True for _ in rows)
        if demand_window is None
        else tuple(demand_window)
    )
    if len(windows) != len(rows):
        raise ValueError("demand_window must match the interval count")
    if any(not isinstance(value, bool) for value in windows):
        raise ValueError("demand_window must contain bool values")
    if not any(windows):
        raise ValueError("demand_window must include at least one interval")
    return rows, windows


def _thresholds(
    baseline_peak_kw: float,
) -> tuple[float, ...]:
    upper = baseline_peak_kw * PEAK_SHAVING_UPPER_THRESHOLD_MULTIPLIER
    if not math.isfinite(upper):
        raise ValueError("peak-shaving threshold upper bound must be finite")
    step = upper / (PEAK_SHAVING_CANDIDATE_COUNT - 1)
    if not math.isfinite(step):
        raise ValueError("peak-shaving threshold step must be finite")
    thresholds = tuple(
        index * step for index in range(PEAK_SHAVING_CANDIDATE_COUNT)
    )
    if any(not math.isfinite(value) for value in thresholds):
        raise ValueError("peak-shaving thresholds must be finite")
    return thresholds


def _intent_envelopes(
    intervals: tuple[CleanedInterval, ...],
    windows: tuple[bool, ...],
    threshold_kw: float,
    battery: BatteryPreset,
    config: PeakShavingConfig,
) -> tuple[_IntentEnvelope, ...]:
    envelopes: list[_IntentEnvelope] = []
    for interval, in_window in zip(intervals, windows, strict=True):
        interval_hours = interval.interval_minutes / 60
        load_kw = interval.load_kw_avg
        discharge_required_kwh = (
            max(0.0, load_kw - threshold_kw) * interval_hours
            if in_window
            else 0.0
        )
        if config.allow_grid_charging:
            charge_headroom_kw = (
                max(0.0, threshold_kw - load_kw)
                if in_window
                else battery.max_charge_kw
            )
            charge_available_kwh = min(
                charge_headroom_kw,
                battery.max_charge_kw,
            ) * interval_hours
        else:
            charge_available_kwh = 0.0
        envelopes.append(
            _IntentEnvelope(
                charge_available_kwh=charge_available_kwh,
                discharge_required_kwh=discharge_required_kwh,
            )
        )
    return tuple(envelopes)


def _planned_energy_inputs(
    intervals: tuple[CleanedInterval, ...],
    envelopes: tuple[_IntentEnvelope, ...],
    battery: BatteryPreset,
    initial_soc_kwh: float,
    config: PeakShavingConfig,
) -> tuple[tuple[BatteryDispatchEnergyInput, ...] | None, tuple[str, ...]]:
    min_soc_kwh = battery.nominal_capacity_kwh * battery.min_soc_fraction
    max_soc_kwh = battery.nominal_capacity_kwh * battery.max_soc_fraction
    requirements = [0.0] * (len(intervals) + 1)
    requirements[-1] = initial_soc_kwh
    reasons: list[str] = []

    for index in range(len(intervals) - 1, -1, -1):
        interval = intervals[index]
        envelope = envelopes[index]
        power_discharge_limit_kwh = (
            battery.max_discharge_kw * interval.interval_minutes / 60
        )
        if (
            envelope.discharge_required_kwh
            > power_discharge_limit_kwh
            + PEAK_SHAVING_NUMERICAL_TOLERANCE_KW
            * interval.interval_minutes
            / 60
        ):
            reasons.append("discharge_power_limit")
        if envelope.discharge_required_kwh > 0:
            required = (
                requirements[index + 1]
                + envelope.discharge_required_kwh
                / battery.discharge_efficiency
            )
        else:
            required = max(
                min_soc_kwh,
                requirements[index + 1]
                - envelope.charge_available_kwh * battery.charge_efficiency,
            )
        requirements[index] = required
        if required > max_soc_kwh + PEAK_SHAVING_TERMINAL_SOC_TOLERANCE_KWH:
            reasons.append("energy_capacity_limit")

    if (
        initial_soc_kwh + PEAK_SHAVING_TERMINAL_SOC_TOLERANCE_KWH
        < requirements[0]
    ):
        reasons.append("insufficient_initial_soc_or_charge_opportunity")
    if reasons:
        return None, tuple(dict.fromkeys(reasons))

    soc_kwh = initial_soc_kwh
    energy_inputs: list[BatteryDispatchEnergyInput] = []
    for index, (interval, envelope) in enumerate(
        zip(intervals, envelopes, strict=True)
    ):
        charge_input_kwh = 0.0
        discharge_output_kwh = envelope.discharge_required_kwh
        if discharge_output_kwh > 0:
            soc_kwh -= discharge_output_kwh / battery.discharge_efficiency
        else:
            charge_input_kwh = min(
                envelope.charge_available_kwh,
                max(
                    0.0,
                    (requirements[index + 1] - soc_kwh)
                    / battery.charge_efficiency,
                ),
            )
            soc_kwh += charge_input_kwh * battery.charge_efficiency
        energy_inputs.append(
            BatteryDispatchEnergyInput(
                source_interval=interval,
                charge_available_kwh=charge_input_kwh,
                discharge_demand_kwh=discharge_output_kwh,
            )
        )
    return tuple(energy_inputs), ()


def _simulate_candidate(
    index: int,
    threshold_kw: float,
    intervals: tuple[CleanedInterval, ...],
    windows: tuple[bool, ...],
    battery: BatteryPreset,
    initial_soc_kwh: float,
    config: PeakShavingConfig,
) -> tuple[
    PeakShavingCandidateEvaluation,
    tuple[PeakShavingDispatchInterval, ...],
]:
    envelopes = _intent_envelopes(
        intervals,
        windows,
        threshold_kw,
        battery,
        config,
    )
    energy_inputs, reasons = _planned_energy_inputs(
        intervals,
        envelopes,
        battery,
        initial_soc_kwh,
        config,
    )
    if energy_inputs is None:
        return (
            PeakShavingCandidateEvaluation(
                index=index,
                threshold_kw=threshold_kw,
                feasible=False,
                achieved_peak_kw=None,
                final_soc_kwh=None,
                rejection_reasons=reasons,
            ),
            (),
        )

    dispatch = build_energy_only_battery_dispatch_result(
        energy_inputs,
        BatteryStrategyConfig(
            strategy_id=BatteryStrategyIdentifier.SELF_CONSUMPTION,
            allow_grid_charging=config.allow_grid_charging,
            assumptions=(
                "Synthetic/internal peak-shaving energy intents.",
                "No tariff, billing, kVA, PF or customer claim semantics.",
            ),
        ),
        battery,
        initial_soc_kwh=initial_soc_kwh,
    )
    rows = tuple(
        PeakShavingDispatchInterval(
            timestamp=source.timestamp,
            interval_minutes=source.interval_minutes,
            demand_window=in_window,
            input_load_kw=source.load_kw_avg,
            battery_charge_input_kwh=dispatched.battery_charge_input_kwh,
            battery_discharge_output_kwh=(
                dispatched.battery_discharge_output_kwh
            ),
            grid_import_kw=(
                source.load_kwh
                + dispatched.battery_charge_input_kwh
                - dispatched.battery_discharge_output_kwh
            )
            / (source.interval_minutes / 60),
            soc_start_kwh=dispatched.soc_start_kwh,
            soc_end_kwh=dispatched.soc_end_kwh,
        )
        for source, in_window, dispatched in zip(
            intervals,
            windows,
            dispatch.intervals,
            strict=True,
        )
    )
    achieved_peak_kw = max(
        row.grid_import_kw for row in rows if row.demand_window
    )
    rejection_reasons: list[str] = []
    if (
        achieved_peak_kw
        > threshold_kw + PEAK_SHAVING_NUMERICAL_TOLERANCE_KW
    ):
        rejection_reasons.append("demand_threshold_not_met")
    if (
        dispatch.final_soc_kwh
        < initial_soc_kwh - PEAK_SHAVING_TERMINAL_SOC_TOLERANCE_KWH
    ):
        rejection_reasons.append("terminal_soc_below_initial")
    return (
        PeakShavingCandidateEvaluation(
            index=index,
            threshold_kw=threshold_kw,
            feasible=not rejection_reasons,
            achieved_peak_kw=achieved_peak_kw,
            final_soc_kwh=dispatch.final_soc_kwh,
            rejection_reasons=tuple(rejection_reasons),
        ),
        rows,
    )


def run_internal_peak_shaving_period(
    intervals: Sequence[CleanedInterval],
    battery: BatteryPreset,
    *,
    initial_soc_kwh: float,
    demand_window: Sequence[bool] | None = None,
    config: PeakShavingConfig | None = None,
) -> PeakShavingResult:
    """Run one deterministic, internal-review demand period.

    The product objective is independently defined as the smallest candidate
    threshold that respects battery physics and returns to at least the initial
    SOC. This is not a commercial-target equivalence claim.
    """

    if not isinstance(battery, BatteryPreset):
        raise ValueError("battery must be a BatteryPreset")
    _finite_non_negative("initial_soc_kwh", initial_soc_kwh)
    min_soc_kwh = battery.nominal_capacity_kwh * battery.min_soc_fraction
    max_soc_kwh = battery.nominal_capacity_kwh * battery.max_soc_fraction
    if not min_soc_kwh <= initial_soc_kwh <= max_soc_kwh:
        raise ValueError("initial_soc_kwh must be within battery SOC bounds")
    resolved_config = PeakShavingConfig() if config is None else config
    if not isinstance(resolved_config, PeakShavingConfig):
        raise ValueError("config must be a PeakShavingConfig")
    rows, windows = _validated_inputs(intervals, demand_window)
    baseline_peak_kw = max(
        row.load_kw_avg
        for row, in_window in zip(rows, windows, strict=True)
        if in_window
    )
    assumptions = (
        "Average interval kW is interval kWh divided by interval duration.",
        "The objective is the smallest feasible sampled demand threshold.",
        "Terminal SOC must not be below initial SOC.",
        "Grid charging is explicit and no tariff or dollar value is calculated.",
        "Customer-facing permission is fixed to false.",
    )
    if resolved_config.gate_status is StrategyGateStatus.BLOCKED:
        return PeakShavingResult(
            algorithm_id=PEAK_SHAVING_ALGORITHM_ID,
            execution_status=PeakShavingExecutionStatus.BLOCKED_NOT_EXECUTED,
            execution_mode="blocked_no_peak_shaving_dispatch",
            config=resolved_config,
            customer_facing_permission=False,
            baseline_peak_kw=baseline_peak_kw,
            selected_threshold_kw=None,
            achieved_peak_kw=None,
            initial_soc_kwh=initial_soc_kwh,
            final_soc_kwh=initial_soc_kwh,
            candidate_evaluations=(),
            intervals=(),
            assumptions=assumptions,
            warnings=(
                WarningMessage(
                    code="peak_shaving_blocked",
                    severity="block",
                    message=(
                        "Internal peak-shaving execution is blocked; no "
                        "candidate or dispatch result was produced."
                    ),
                ),
            ),
        )

    evaluations: list[PeakShavingCandidateEvaluation] = []
    selected: PeakShavingCandidateEvaluation | None = None
    selected_rows: tuple[PeakShavingDispatchInterval, ...] = ()
    for index, threshold_kw in enumerate(
        _thresholds(baseline_peak_kw)
    ):
        evaluation, candidate_rows = _simulate_candidate(
            index,
            threshold_kw,
            rows,
            windows,
            battery,
            initial_soc_kwh,
            resolved_config,
        )
        evaluations.append(evaluation)
        if selected is None and evaluation.feasible:
            selected = evaluation
            selected_rows = candidate_rows

    if selected is None:
        raise RuntimeError("candidate envelope unexpectedly produced no feasible result")

    return PeakShavingResult(
        algorithm_id=PEAK_SHAVING_ALGORITHM_ID,
        execution_status=PeakShavingExecutionStatus.INTERNAL_REVIEW_EXECUTED,
        execution_mode="internal_review_peak_shaving_period",
        config=resolved_config,
        customer_facing_permission=False,
        baseline_peak_kw=baseline_peak_kw,
        selected_threshold_kw=selected.threshold_kw,
        achieved_peak_kw=selected.achieved_peak_kw,
        initial_soc_kwh=initial_soc_kwh,
        final_soc_kwh=(
            selected.final_soc_kwh
            if selected.final_soc_kwh is not None
            else initial_soc_kwh
        ),
        candidate_evaluations=tuple(evaluations),
        intervals=selected_rows,
        assumptions=assumptions,
        warnings=(
            WarningMessage(
                code="peak_shaving_internal_review_only",
                severity="warning",
                message=(
                    "Independent internal-review physical algorithm; not a "
                    "target-equivalence, tariff, savings or customer claim."
                ),
            ),
        ),
    )


def run_internal_peak_shaving_horizon(
    periods: Sequence[PeakShavingPeriodInput],
    battery: BatteryPreset,
    *,
    initial_soc_kwh: float,
    config: PeakShavingConfig | None = None,
) -> PeakShavingHorizonResult:
    """Run exactly 12 explicit demand periods in chronological order."""

    period_inputs = tuple(periods)
    if len(period_inputs) != 12:
        raise ValueError("peak-shaving horizon must contain exactly 12 periods")
    if any(
        not isinstance(period, PeakShavingPeriodInput)
        for period in period_inputs
    ):
        raise ValueError("periods must contain PeakShavingPeriodInput values")
    period_ids = tuple(period.period_id for period in period_inputs)
    if len(set(period_ids)) != len(period_ids):
        raise ValueError("period_id values must be unique")
    for previous, current in zip(period_inputs, period_inputs[1:], strict=False):
        if previous.intervals and current.intervals:
            if current.intervals[0].timestamp <= previous.intervals[-1].timestamp:
                raise ValueError("period intervals must be chronologically ordered")

    resolved_config = PeakShavingConfig() if config is None else config
    if not isinstance(resolved_config, PeakShavingConfig):
        raise ValueError("config must be a PeakShavingConfig")
    soc_kwh = initial_soc_kwh
    results: list[PeakShavingPeriodResult] = []
    for period in period_inputs:
        result = run_internal_peak_shaving_period(
            period.intervals,
            battery,
            initial_soc_kwh=soc_kwh,
            demand_window=period.demand_window,
            config=resolved_config,
        )
        results.append(
            PeakShavingPeriodResult(
                period_id=period.period_id,
                result=result,
            )
        )
        soc_kwh = result.final_soc_kwh

    execution_status = (
        PeakShavingExecutionStatus.BLOCKED_NOT_EXECUTED
        if resolved_config.gate_status is StrategyGateStatus.BLOCKED
        else PeakShavingExecutionStatus.INTERNAL_REVIEW_EXECUTED
    )
    return PeakShavingHorizonResult(
        algorithm_id=PEAK_SHAVING_ALGORITHM_ID,
        execution_status=execution_status,
        customer_facing_permission=False,
        initial_soc_kwh=initial_soc_kwh,
        final_soc_kwh=soc_kwh,
        selected_thresholds_kw=tuple(
            item.result.selected_threshold_kw for item in results
        ),
        periods=tuple(results),
    )

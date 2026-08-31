from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from enum import Enum
import math

from solar_battery.battery_strategy import (
    BatteryStrategyConfig,
    BatteryStrategySummary,
    StrategyGateStatus,
)
from solar_battery.models import (
    BatteryPreset,
    CleanedInterval,
    SourceStatus,
    WarningMessage,
)


class BatteryDispatchExecutionStatus(str, Enum):
    REVIEW_ONLY_NOT_EXECUTED = "review_only_not_executed"
    REVIEW_ONLY_ENERGY_DISPATCH = "review_only_energy_dispatch"
    BLOCKED_NOT_EXECUTED = "blocked_not_executed"


@dataclass(frozen=True)
class BatteryDispatchIntervalMetadata:
    timestamp: datetime
    interval_minutes: int
    input_load_kwh: float
    source_status: SourceStatus
    source_date: date


@dataclass(frozen=True)
class BatteryDispatchResult:
    strategy: BatteryStrategySummary
    execution_status: BatteryDispatchExecutionStatus
    execution_mode: str
    interval_count: int
    total_input_load_kwh: float
    intervals: tuple[BatteryDispatchIntervalMetadata, ...]


def _finite_non_negative_energy(field_name: str, value: float) -> None:
    try:
        valid = (
            not isinstance(value, bool)
            and math.isfinite(value)
            and value >= 0
        )
    except TypeError:
        valid = False
    if not valid:
        raise ValueError(f"{field_name} must be finite and non-negative")


@dataclass(frozen=True)
class BatteryDispatchEnergyInput:
    source_interval: CleanedInterval
    charge_available_kwh: float = 0.0
    discharge_demand_kwh: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.source_interval, CleanedInterval):
            raise ValueError("source_interval must be a CleanedInterval")
        _finite_non_negative_energy(
            "source load",
            self.source_interval.load_kwh,
        )
        if (
            isinstance(self.source_interval.interval_minutes, bool)
            or not isinstance(self.source_interval.interval_minutes, int)
            or self.source_interval.interval_minutes <= 0
        ):
            raise ValueError("source interval_minutes must be a positive integer")
        _finite_non_negative_energy(
            "charge_available_kwh",
            self.charge_available_kwh,
        )
        _finite_non_negative_energy(
            "discharge_demand_kwh",
            self.discharge_demand_kwh,
        )
        if self.charge_available_kwh > 0 and self.discharge_demand_kwh > 0:
            raise ValueError(
                "simultaneous charge and discharge intents are not supported"
            )


@dataclass(frozen=True)
class BatteryEnergyDispatchInterval:
    timestamp: datetime
    interval_minutes: int
    input_load_kwh: float
    source_stream_id: str
    source_status: SourceStatus
    source_date: date
    charge_available_kwh: float
    discharge_demand_kwh: float
    max_charge_input_kwh: float
    max_discharge_output_kwh: float
    battery_charge_input_kwh: float
    battery_discharge_output_kwh: float
    soc_start_kwh: float
    soc_end_kwh: float


@dataclass(frozen=True)
class BatteryEnergyDispatchResult:
    strategy: BatteryStrategySummary
    execution_status: BatteryDispatchExecutionStatus
    execution_mode: str
    interval_count: int
    initial_soc_kwh: float
    final_soc_kwh: float
    min_soc_kwh: float
    max_soc_kwh: float
    total_charge_available_kwh: float
    total_discharge_demand_kwh: float
    total_battery_charge_input_kwh: float
    total_battery_discharge_output_kwh: float
    intervals: tuple[BatteryEnergyDispatchInterval, ...]


def build_battery_dispatch_result(
    intervals: Sequence[CleanedInterval],
    config: BatteryStrategyConfig,
) -> BatteryDispatchResult:
    cleaned_intervals = tuple(intervals)
    if not cleaned_intervals:
        raise ValueError("At least one cleaned interval is required")
    for interval in cleaned_intervals:
        if not isinstance(interval, CleanedInterval):
            raise ValueError("intervals must contain CleanedInterval values")
        if (
            isinstance(interval.load_kwh, bool)
            or not math.isfinite(interval.load_kwh)
            or interval.load_kwh < 0
        ):
            raise ValueError("input load metadata must be finite and non-negative")

    rows = tuple(
        BatteryDispatchIntervalMetadata(
            timestamp=interval.timestamp,
            interval_minutes=interval.interval_minutes,
            input_load_kwh=interval.load_kwh,
            source_status=interval.source_status,
            source_date=interval.source_date,
        )
        for interval in cleaned_intervals
    )
    blocked = config.gate_status is StrategyGateStatus.BLOCKED
    warning = WarningMessage(
        code="battery_dispatch_not_implemented",
        severity="block" if blocked else "warning",
        message="Battery dispatch is not implemented; result contains input metadata only.",
    )
    strategy = BatteryStrategySummary(
        strategy_id=config.strategy_id,
        gate_status=config.gate_status,
        assumptions=config.assumptions,
        warnings=(warning,),
    )
    return BatteryDispatchResult(
        strategy=strategy,
        execution_status=(
            BatteryDispatchExecutionStatus.BLOCKED_NOT_EXECUTED
            if blocked
            else BatteryDispatchExecutionStatus.REVIEW_ONLY_NOT_EXECUTED
        ),
        execution_mode="metadata_only_no_dispatch",
        interval_count=len(rows),
        total_input_load_kwh=math.fsum(row.input_load_kwh for row in rows),
        intervals=rows,
    )


def build_energy_only_battery_dispatch_result(
    energy_inputs: Sequence[BatteryDispatchEnergyInput],
    config: BatteryStrategyConfig,
    battery: BatteryPreset,
    *,
    initial_soc_kwh: float,
) -> BatteryEnergyDispatchResult:
    inputs = tuple(energy_inputs)
    if not inputs:
        raise ValueError("At least one energy input is required")
    if any(not isinstance(value, BatteryDispatchEnergyInput) for value in inputs):
        raise ValueError(
            "energy_inputs must contain BatteryDispatchEnergyInput values"
        )
    if not isinstance(config, BatteryStrategyConfig):
        raise ValueError("config must be a BatteryStrategyConfig")
    if not isinstance(battery, BatteryPreset):
        raise ValueError("battery must be a BatteryPreset")

    _finite_non_negative_energy("initial_soc_kwh", initial_soc_kwh)
    if config.reserve_soc_fraction > battery.max_soc_fraction:
        raise ValueError(
            "reserve_soc_fraction must not exceed battery maximum SOC"
        )

    min_soc_fraction = max(
        battery.min_soc_fraction,
        config.reserve_soc_fraction,
    )
    min_soc_kwh = battery.nominal_capacity_kwh * min_soc_fraction
    max_soc_kwh = (
        battery.nominal_capacity_kwh * battery.max_soc_fraction
    )
    if not min_soc_kwh <= initial_soc_kwh <= max_soc_kwh:
        raise ValueError("initial_soc_kwh must be within usable SOC bounds")

    blocked = config.gate_status is StrategyGateStatus.BLOCKED
    warning = WarningMessage(
        code=(
            "battery_energy_dispatch_blocked"
            if blocked
            else "battery_energy_dispatch_review_only"
        ),
        severity="block" if blocked else "warning",
        message=(
            "Internal energy-only battery dispatch is blocked and was not "
            "executed; metadata is retained for review."
            if blocked
            else "Internal review-only energy dispatch; outputs are not "
            "customer-facing savings or tariff calculations."
        ),
    )
    strategy = BatteryStrategySummary(
        strategy_id=config.strategy_id,
        gate_status=config.gate_status,
        assumptions=(
            *config.assumptions,
            "Charge availability and discharge demand are caller-provided "
            "energy intents.",
            "SOC is stored battery energy in kWh and uses configured battery "
            "efficiencies and limits.",
        ),
        warnings=(warning,),
    )

    soc_kwh = initial_soc_kwh
    rows: list[BatteryEnergyDispatchInterval] = []
    for energy_input in inputs:
        interval = energy_input.source_interval
        interval_hours = interval.interval_minutes / 60
        charge_power_limit_kwh = battery.max_charge_kw * interval_hours
        discharge_power_limit_kwh = battery.max_discharge_kw * interval_hours
        charge_capacity_limit_kwh = (
            max_soc_kwh - soc_kwh
        ) / battery.charge_efficiency
        discharge_capacity_limit_kwh = (
            soc_kwh - min_soc_kwh
        ) * battery.discharge_efficiency
        max_charge_input_kwh = max(
            0.0,
            min(charge_power_limit_kwh, charge_capacity_limit_kwh),
        )
        max_discharge_output_kwh = max(
            0.0,
            min(discharge_power_limit_kwh, discharge_capacity_limit_kwh),
        )

        soc_start_kwh = soc_kwh
        battery_charge_input_kwh = 0.0
        battery_discharge_output_kwh = 0.0
        if not blocked:
            battery_charge_input_kwh = min(
                energy_input.charge_available_kwh,
                max_charge_input_kwh,
            )
            battery_discharge_output_kwh = min(
                energy_input.discharge_demand_kwh,
                max_discharge_output_kwh,
            )
            soc_kwh += (
                battery_charge_input_kwh * battery.charge_efficiency
            )
            soc_kwh -= (
                battery_discharge_output_kwh
                / battery.discharge_efficiency
            )
            soc_kwh = min(max_soc_kwh, max(min_soc_kwh, soc_kwh))

        rows.append(
            BatteryEnergyDispatchInterval(
                timestamp=interval.timestamp,
                interval_minutes=interval.interval_minutes,
                input_load_kwh=interval.load_kwh,
                source_stream_id=interval.source_stream_id,
                source_status=interval.source_status,
                source_date=interval.source_date,
                charge_available_kwh=energy_input.charge_available_kwh,
                discharge_demand_kwh=energy_input.discharge_demand_kwh,
                max_charge_input_kwh=max_charge_input_kwh,
                max_discharge_output_kwh=max_discharge_output_kwh,
                battery_charge_input_kwh=battery_charge_input_kwh,
                battery_discharge_output_kwh=battery_discharge_output_kwh,
                soc_start_kwh=soc_start_kwh,
                soc_end_kwh=soc_kwh,
            )
        )

    return BatteryEnergyDispatchResult(
        strategy=strategy,
        execution_status=(
            BatteryDispatchExecutionStatus.BLOCKED_NOT_EXECUTED
            if blocked
            else BatteryDispatchExecutionStatus.REVIEW_ONLY_ENERGY_DISPATCH
        ),
        execution_mode=(
            "energy_only_blocked_no_dispatch"
            if blocked
            else "internal_review_energy_only"
        ),
        interval_count=len(rows),
        initial_soc_kwh=initial_soc_kwh,
        final_soc_kwh=soc_kwh,
        min_soc_kwh=min_soc_kwh,
        max_soc_kwh=max_soc_kwh,
        total_charge_available_kwh=math.fsum(
            row.charge_available_kwh for row in rows
        ),
        total_discharge_demand_kwh=math.fsum(
            row.discharge_demand_kwh for row in rows
        ),
        total_battery_charge_input_kwh=math.fsum(
            row.battery_charge_input_kwh for row in rows
        ),
        total_battery_discharge_output_kwh=math.fsum(
            row.battery_discharge_output_kwh for row in rows
        ),
        intervals=tuple(rows),
    )

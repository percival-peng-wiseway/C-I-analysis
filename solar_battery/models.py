from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal


SourceStatus = Literal[
    "measured",
    "generated",
    "same_date_other_year",
    "interpolated",
    "zero_fill",
]


@dataclass(frozen=True)
class WarningMessage:
    code: str
    severity: Literal["info", "warning", "block"]
    message: str


@dataclass(frozen=True)
class CleanedInterval:
    timestamp: datetime
    interval_minutes: int
    load_kwh: float
    source_status: SourceStatus
    source_stream_id: str
    source_date: date

    @property
    def date(self) -> date:
        return self.timestamp.date()

    @property
    def load_kw_avg(self) -> float:
        return self.load_kwh / (self.interval_minutes / 60)


def _positive(name: str, value: float) -> None:
    _finite(name, value)
    if value <= 0:
        raise ValueError(f"{name} must be positive")


def _fraction(name: str, value: float) -> None:
    _finite(name, value)
    if not 0 < value <= 1:
        raise ValueError(f"{name} must be greater than 0 and at most 1")


def _finite(name: str, value: float) -> None:
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")


def _non_negative(name: str, value: float) -> None:
    _finite(name, value)
    if value < 0:
        raise ValueError(f"{name} must not be negative")


@dataclass(frozen=True)
class BatteryPreset:
    name: str
    nominal_capacity_kwh: float
    min_soc_fraction: float
    max_soc_fraction: float
    max_charge_kw: float
    max_discharge_kw: float
    charge_efficiency: float
    discharge_efficiency: float
    capex_aud: float
    source_date: date

    def __post_init__(self) -> None:
        _positive("nominal_capacity_kwh", self.nominal_capacity_kwh)
        _positive("max_charge_kw", self.max_charge_kw)
        _positive("max_discharge_kw", self.max_discharge_kw)
        _fraction("charge_efficiency", self.charge_efficiency)
        _fraction("discharge_efficiency", self.discharge_efficiency)
        _finite("min_soc_fraction", self.min_soc_fraction)
        _finite("max_soc_fraction", self.max_soc_fraction)
        if not 0 <= self.min_soc_fraction < self.max_soc_fraction <= 1:
            raise ValueError(
                "Battery SOC limits must satisfy 0 <= min < max <= 1"
            )
        _non_negative("capex_aud", self.capex_aud)

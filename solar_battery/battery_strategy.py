from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

from solar_battery.models import WarningMessage


class BatteryStrategyIdentifier(str, Enum):
    SELF_CONSUMPTION = "self_consumption"
    TIME_OF_USE = "time_of_use"
    BACKUP_RESERVE = "backup_reserve"


class StrategyGateStatus(str, Enum):
    REVIEW_ONLY = "review_only"
    BLOCKED = "blocked"


def _strategy_identifier(
    value: BatteryStrategyIdentifier | str,
) -> BatteryStrategyIdentifier:
    try:
        return BatteryStrategyIdentifier(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"unsupported strategy_id {value!r}") from exc


def _gate_status(value: StrategyGateStatus | str) -> StrategyGateStatus:
    try:
        return StrategyGateStatus(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"unsupported gate_status {value!r}") from exc


def _assumptions(values: tuple[str, ...]) -> tuple[str, ...]:
    try:
        assumptions = tuple(values)
    except TypeError as exc:
        raise ValueError("assumptions must contain non-blank text") from exc
    if any(
        not isinstance(value, str) or not value.strip()
        for value in assumptions
    ):
        raise ValueError("assumptions must contain non-blank text")
    return tuple(value.strip() for value in assumptions)


def _warnings(values: tuple[WarningMessage, ...]) -> tuple[WarningMessage, ...]:
    normalized = tuple(values)
    if any(
        not isinstance(warning, WarningMessage)
        or not isinstance(warning.code, str)
        or not isinstance(warning.message, str)
        or not warning.code.strip()
        or not warning.message.strip()
        or warning.severity not in {"info", "warning", "block"}
        for warning in normalized
    ):
        raise ValueError("warnings must contain populated WarningMessage values")
    return normalized


@dataclass(frozen=True)
class BatteryStrategyConfig:
    strategy_id: BatteryStrategyIdentifier | str
    reserve_soc_fraction: float = 0.0
    allow_grid_charging: bool = False
    allow_battery_export: bool = False
    assumptions: tuple[str, ...] = ()
    gate_status: StrategyGateStatus | str = StrategyGateStatus.REVIEW_ONLY

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "strategy_id",
            _strategy_identifier(self.strategy_id),
        )
        object.__setattr__(self, "gate_status", _gate_status(self.gate_status))
        object.__setattr__(self, "assumptions", _assumptions(self.assumptions))
        try:
            valid_reserve_soc = (
                not isinstance(self.reserve_soc_fraction, bool)
                and math.isfinite(self.reserve_soc_fraction)
                and 0 <= self.reserve_soc_fraction <= 1
            )
        except TypeError:
            valid_reserve_soc = False
        if not valid_reserve_soc:
            raise ValueError(
                "reserve_soc_fraction must be finite and between 0 and 1"
            )
        for field_name in ("allow_grid_charging", "allow_battery_export"):
            if not isinstance(getattr(self, field_name), bool):
                raise ValueError(f"{field_name} must be a bool")


@dataclass(frozen=True)
class BatteryStrategySummary:
    strategy_id: BatteryStrategyIdentifier | str
    gate_status: StrategyGateStatus | str = StrategyGateStatus.REVIEW_ONLY
    assumptions: tuple[str, ...] = ()
    warnings: tuple[WarningMessage, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "strategy_id",
            _strategy_identifier(self.strategy_id),
        )
        object.__setattr__(self, "gate_status", _gate_status(self.gate_status))
        object.__setattr__(self, "assumptions", _assumptions(self.assumptions))
        object.__setattr__(self, "warnings", _warnings(self.warnings))
        if (
            self.gate_status is StrategyGateStatus.REVIEW_ONLY
            and any(warning.severity == "block" for warning in self.warnings)
        ):
            raise ValueError(
                "gate_status must be blocked when warnings contain a block"
            )

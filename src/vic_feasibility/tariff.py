from __future__ import annotations

from dataclasses import dataclass
from typing import List, Literal
import pandas as pd


TimeType = Literal["weekday", "weekend", "all"]


@dataclass
class TimeOfUseRate:
    """One TOU block in a day.

    Hours are integer hours on [0, 24). For example 16->18 means 16:00-18:00.
    """

    label: str
    start_hour: int
    end_hour: int
    rate_aud_per_kwh: float
    day_type: TimeType = "all"

    def applies(self, ts: pd.Timestamp) -> bool:
        h = ts.hour
        is_weekend = ts.dayofweek >= 5
        if self.day_type == "weekday" and is_weekend:
            return False
        if self.day_type == "weekend" and not is_weekend:
            return False

        if self.start_hour < self.end_hour:
            return self.start_hour <= h < self.end_hour
        # not used now, but keep support for overnight blocks
        return h >= self.start_hour or h < self.end_hour


@dataclass
class TariffConfig:
    """Commercial VIC electricity bill configuration (simpl化模型）。"""

    name: str
    rates: List[TimeOfUseRate]
    demand_charge_per_kw_per_month: float = 0.0
    fixed_daily_charge_aud: float = 0.0
    export_rate_aud_per_kwh: float = 0.0
    annual_escalation: float = 0.0
    pv_generation_loss: float = 0.0
    opex_rate_pct: float = 0.01

    def energy_rate(self, ts: pd.Timestamp) -> float:
        for r in self.rates:
            if r.applies(ts):
                return r.rate_aud_per_kwh
        # fallback
        return self.rates[-1].rate_aud_per_kwh

    def annual_fixed_charge(self, n_points: int) -> float:
        # n_points is hourly rows after hourly resampling.
        if n_points == 0:
            return 0.0
        days = n_points / 24.0
        return self.fixed_daily_charge_aud * days


def default_vic_commercial_tou() -> TariffConfig:
    """示例参数：按周内/周末分时段，非官方报价，仅用于演示。"""
    rates = [
        TimeOfUseRate("peak", 7, 22, 0.278, "weekday"),
        TimeOfUseRate("off_peak", 0, 7, 0.178, "weekday"),
        TimeOfUseRate("off_peak", 22, 24, 0.178, "weekday"),
        TimeOfUseRate("off_peak_weekend", 0, 24, 0.178, "weekend"),
    ]
    return TariffConfig(
        name="VIC Commercial (示例TOU)",
        rates=rates,
        demand_charge_per_kw_per_month=9.5,
        fixed_daily_charge_aud=6.4,
        export_rate_aud_per_kwh=0.05,
    )


TARIFF_PRESETS = {
    "VIC_工商业示例TOU": default_vic_commercial_tou(),
}

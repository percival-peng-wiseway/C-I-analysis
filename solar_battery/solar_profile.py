from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime, timezone


def solar_shape(hour: float, day_of_year: int) -> float:
    seasonal = 0.72 + 0.28 * math.cos(
        2 * math.pi * (day_of_year - 15) / 365
    )
    daylight = max(0.0, math.sin(math.pi * (hour - 6) / 12))
    return seasonal * daylight**1.45


def build_pv_profile(
    timestamps: Sequence[datetime],
    annual_yield_per_kw: float,
) -> tuple[float, ...]:
    stamps = tuple(timestamps)
    if not stamps:
        raise ValueError("At least one timestamp is required")
    if any(stamp.tzinfo is None for stamp in stamps):
        raise ValueError("PV profile timestamps must be timezone-aware")
    if not math.isfinite(annual_yield_per_kw) or annual_yield_per_kw <= 0:
        raise ValueError("annual_yield_per_kw must be finite and positive")
    raw = tuple(
        solar_shape(
            stamp.hour + stamp.minute / 60 + stamp.second / 3600,
            stamp.timetuple().tm_yday,
        )
        for stamp in stamps
    )
    hours = tuple(
        _profile_interval_hours(stamps, index) for index in range(len(stamps))
    )
    raw_energy = math.fsum(
        shape * interval_hours
        for shape, interval_hours in zip(raw, hours, strict=True)
    )
    scale = annual_yield_per_kw / raw_energy if raw_energy > 0 else 0.0
    return tuple(
        shape * interval_hours * scale
        for shape, interval_hours in zip(raw, hours, strict=True)
    )


def _profile_interval_hours(
    stamps: tuple[datetime, ...],
    index: int,
) -> float:
    if len(stamps) < 2:
        return 0.5
    previous_index = index if index < len(stamps) - 1 else index - 1
    current_index = previous_index + 1
    previous_utc = stamps[previous_index].astimezone(timezone.utc)
    current_utc = stamps[current_index].astimezone(timezone.utc)
    seconds = (current_utc - previous_utc).total_seconds()
    if seconds <= 0:
        local_seconds = (
            stamps[current_index].replace(tzinfo=None)
            - stamps[previous_index].replace(tzinfo=None)
        ).total_seconds()
        if (
            local_seconds > 0
            and stamps[current_index].utcoffset()
            != stamps[previous_index].utcoffset()
        ):
            seconds = local_seconds
    if seconds <= 0:
        raise ValueError("timestamps must be strictly increasing")
    return seconds / 3600

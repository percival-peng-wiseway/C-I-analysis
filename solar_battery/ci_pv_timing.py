"""Location-aware, geometry-only PV timing, not a weather/irradiance forecast.

Sun position uses NOAA's published fractional-year equations:
https://gml.noaa.gov/grad/solcalc/solareqns.PDF

The dimensionless timing proxy is positive solar elevation times the positive
projection onto the authored array plane. It has no inferred weather, diffuse
irradiance, horizon or temperature information. The analyst's annual specific
yield remains the energy authority; array orientation changes *timing*, not
that separately authored annual yield. Actual inverter clipping/site losses
are applied by the caller, exactly once.
"""
from __future__ import annotations

import calendar
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone, tzinfo
from functools import lru_cache
import math


SOLAR_GEOMETRY_PROFILE_ID = "solar_geometry_screening_v1"
PV_GEOMETRY_SCREENING_DISCLOSURE = (
    "Solar geometry screening uses confirmed location, array orientation and "
    "interval-midpoint sun position; it is not measured or weather-derived PV. "
    "Each full calendar year is normalized to the authored specific yield "
    "before site losses and inverter clipping."
)


def normalize_pv_geometry(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or value.get("location_confirmed") is not True:
        raise ValueError("Solar geometry requires an explicitly confirmed location.")
    source = value.get("location_source_label")
    if not isinstance(source, str) or not 1 <= len(source.strip()) <= 240:
        raise ValueError("Solar geometry requires a location source label.")
    return {
        "latitude_degrees": _bounded(value, "latitude_degrees", -90, 90),
        "longitude_degrees": _bounded(value, "longitude_degrees", -180, 180),
        "array_tilt_degrees": _bounded(value, "array_tilt_degrees", 0, 90),
        "array_azimuth_degrees": _bounded(value, "array_azimuth_degrees", 0, 360),
        "location_source_label": source.strip(),
        "location_confirmed": True,
    }


def pv_geometry_cache_key(geometry: object) -> tuple[float, ...]:
    if geometry is None:
        return ()
    normalized = normalize_pv_geometry(geometry)
    return tuple(float(normalized[key]) for key in (
        "latitude_degrees", "longitude_degrees", "array_tilt_degrees",
        "array_azimuth_degrees",
    ))


def build_geometry_pv_profile(
    timestamps: Sequence[datetime],
    annual_yield_per_kw: float,
    *,
    interval_minutes: int,
    geometry: object,
) -> tuple[float, ...]:
    """Return interval kWh/kWp; partial input coverage never gets a full year.

    Input timestamps are interval *starts*. Normalization covers the full
    calendar year in the meter's timezone, including leap days. Sampling the
    midpoint avoids a systematic one-interval daylight shift. A geometry-only
    result does not grant customer-facing or recommendation permission.
    """
    key = pv_geometry_cache_key(geometry)
    if not key:
        raise ValueError("Solar geometry is required for this PV timing model.")
    stamps = tuple(timestamps)
    if not stamps or any(stamp.tzinfo is None or stamp.utcoffset() is None for stamp in stamps):
        raise ValueError("PV profile timestamps must be nonempty and timezone-aware.")
    if (
        isinstance(interval_minutes, bool)
        or not isinstance(interval_minutes, int)
        or interval_minutes <= 0
        or interval_minutes > 60
        or 60 % interval_minutes
    ):
        raise ValueError("PV timing requires a uniform whole-minute interval dividing one hour.")
    if (
        isinstance(annual_yield_per_kw, bool)
        or not isinstance(annual_yield_per_kw, (int, float))
        or not math.isfinite(annual_yield_per_kw)
        or annual_yield_per_kw <= 0
    ):
        raise ValueError("annual_yield_per_kw must be finite and positive.")
    utc_stamps = tuple(stamp.astimezone(timezone.utc) for stamp in stamps)
    step = timedelta(minutes=interval_minutes)
    if any(right - left != step for left, right in zip(utc_stamps, utc_stamps[1:])):
        raise ValueError("PV timestamps must be contiguous at the declared interval.")
    meter_tz = stamps[0].tzinfo
    assert meter_tz is not None
    norms = {
        year: _annual_geometry_energy(year, interval_minutes, meter_tz, key)
        for year in {stamp.astimezone(meter_tz).year for stamp in stamps}
    }
    hours = interval_minutes / 60
    return tuple(
        _solar_geometry_weight(stamp + step / 2, key)
        * hours * annual_yield_per_kw
        / norms[stamp.astimezone(meter_tz).year]
        for stamp in utc_stamps
    )


@lru_cache(maxsize=64)
def _annual_geometry_energy(
    year: int,
    minutes: int,
    meter_tz: tzinfo,
    geometry_key: tuple[float, ...],
) -> float:
    start = datetime(year, 1, 1, tzinfo=meter_tz).astimezone(timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=meter_tz).astimezone(timezone.utc)
    step = timedelta(minutes=minutes)
    count = int((end - start) / step)
    energy = math.fsum(
        _solar_geometry_weight(start + (index + 0.5) * step, geometry_key)
        * minutes / 60
        for index in range(count)
    )
    if not math.isfinite(energy) or energy <= 0:
        raise ValueError("The array geometry has no positive annual solar projection.")
    return energy


def _solar_geometry_weight(
    stamp: datetime, geometry_key: tuple[float, ...]
) -> float:
    """NOAA solar vector in east/north/up coordinates, azimuth north=0/east=90."""
    utc = stamp.astimezone(timezone.utc)
    latitude, longitude, tilt, azimuth = map(math.radians, geometry_key)
    hour = utc.hour + utc.minute / 60 + utc.second / 3600
    gamma = 2 * math.pi / (366 if calendar.isleap(utc.year) else 365) * (
        utc.timetuple().tm_yday - 1 + (hour - 12) / 24
    )
    equation_minutes = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma)
    )
    declination = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma)
    )
    solar_minutes = hour * 60 + equation_minutes + 4 * math.degrees(longitude)
    hour_angle = math.radians(solar_minutes / 4 - 180)
    sin_lat, cos_lat = math.sin(latitude), math.cos(latitude)
    sin_dec, cos_dec = math.sin(declination), math.cos(declination)
    cos_ha = math.cos(hour_angle)
    up = sin_lat * sin_dec + cos_lat * cos_dec * cos_ha
    if up <= 0:
        return 0.0
    east = -cos_dec * math.sin(hour_angle)
    north = cos_lat * sin_dec - sin_lat * cos_dec * cos_ha
    projection = (
        east * math.sin(tilt) * math.sin(azimuth)
        + north * math.sin(tilt) * math.cos(azimuth)
        + up * math.cos(tilt)
    )
    return up * max(0.0, projection)


def _bounded(value: dict[str, object], key: str, low: float, high: float) -> float:
    number = value.get(key)
    if (
        isinstance(number, bool)
        or not isinstance(number, (int, float))
        or not math.isfinite(number)
        or not low <= number <= high
    ):
        raise ValueError(f"{key} must be a finite number from {low} to {high}.")
    return float(number)

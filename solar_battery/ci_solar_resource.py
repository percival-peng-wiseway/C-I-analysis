"""Optional, server-side resource enrichment; never approves customer-dollar claims."""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SPECIFIC_YIELD = 1000.0
PVGIS_URL = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc"
GEOAPIFY_URL = "https://api.geoapify.com/v1/geocode/search"


def _get_json(url: str, parameters: dict) -> dict:
    # Only fixed provider hosts, bounded responses/timeouts; never log a URL/key.
    request = Request(f"{url}?{urlencode(parameters)}", headers={"Accept": "application/json"})
    with urlopen(request, timeout=12) as response:
        body = response.read(1_000_001)
    if len(body) > 1_000_000:
        raise ValueError("Provider response too large")
    result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError("Invalid provider response")
    return result


def _number(value: object, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Invalid provider number")
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        raise ValueError("Provider number outside supported range")
    return number


def lookup_solar_resource(address: str | None, *, tilt: float = 0, azimuth: float = 0,
                          previous: dict | None = None) -> dict:
    """1 kWp model output is specific yield, NOT a multiplier for the 1000 fallback.

    PVGIS loss=0 still includes temperature, incidence and terrain-horizon effects.
    Downstream temperature loss must therefore be zero when applying this source.
    """
    tilt = _number(tilt, 0, 90)
    azimuth = _number(azimuth, 0, 360) % 360
    address = (address or "").strip()
    now = datetime.now(timezone.utc)
    snapshot = {
        "version": "ci_solar_resource_v1", "status": "fallback",
        "message": "No bill site address detected. Using the 1000 kWh/kWp screening assumption.",
        "address": address, "queried_at": now.isoformat(),
        "annual_specific_yield_kwh_per_kw": DEFAULT_SPECIFIC_YIELD,
        "tilt_degrees": tilt, "azimuth_degrees": azimuth,
        "latitude": None, "longitude": None, "matched_address": None,
        "monthly_kwh_per_kwp": [], "source": "analyst_assumption",
        "customer_facing_permission": False,
    }
    if not address:
        return snapshot
    # Reuse a project-owned snapshot for 30 days, never a shared address cache.
    fresh = False
    if isinstance(previous, dict) and previous.get("address") == address:
        try:
            age = (now - datetime.fromisoformat(previous["queried_at"])).total_seconds()
            fresh = previous.get("status") == "ready" and 0 <= age < 30 * 86400
        except (ValueError, TypeError, KeyError):
            pass
    if fresh and previous.get("tilt_degrees") == tilt and previous.get("azimuth_degrees") == azimuth:
        return dict(previous)
    key = os.getenv("GEOAPIFY_API_KEY", "").strip()
    if not key and not fresh:
        snapshot.update(status="missing_key", message="Configure GEOAPIFY_API_KEY on the backend, then retry. Using 1000 kWh/kWp.")
        return snapshot
    stage = "Geoapify"
    try:
        if fresh:
            lat, lon = previous["latitude"], previous["longitude"]
            matched_address = previous["matched_address"]
        else:
            data = _get_json(GEOAPIFY_URL, {"text": address, "filter": "countrycode:au",
                             "format": "json", "limit": 3, "apiKey": key})
            candidates = [item for item in data["results"]
                          if item.get("country_code") == "au"
                          and item.get("result_type") == "building"
                          and _number(item.get("rank", {}).get("confidence", 0), 0, 1) >= 0.8]
            locations = {(item["lat"], item["lon"]) for item in candidates}
            if len(locations) != 1:
                snapshot.update(status="location_review", message="No unambiguous building-level address match. Check the bill address; using 1000 kWh/kWp.")
                return snapshot
            match = candidates[0]
            lat, lon = match["lat"], match["lon"]
            matched_address = str(match["formatted"])[:500]
        lat, lon = _number(lat, -90, 90), _number(lon, -180, 180)
        snapshot.update(latitude=lat, longitude=lon, matched_address=matched_address)
        stage = "PVGIS"
        data = _get_json(PVGIS_URL, {"lat": lat, "lon": lon, "peakpower": 1, "loss": 0,
                         "angle": tilt, "aspect": azimuth - 180, "pvtechchoice": "crystSi",
                         "mountingplace": "free", "raddatabase": "PVGIS-ERA5",
                         "usehorizon": 1, "outputformat": "json"})
        # Keep within the existing generator's supported specific-yield range.
        annual = _number(data["outputs"]["totals"]["fixed"]["E_y"], 500, 3000)
        months = sorted(data["outputs"]["monthly"]["fixed"], key=lambda row: row["month"])
        if [row["month"] for row in months] != list(range(1, 13)):
            raise ValueError("Incomplete monthly model")
        monthly = [_number(row["E_m"], 0, 1000) for row in months]
        if abs(sum(monthly) - annual) > max(2, annual * 0.01):
            raise ValueError("Monthly/annual mismatch")
        snapshot.update(status="ready", source="PVGIS 5.3 / ERA5", annual_specific_yield_kwh_per_kw=annual,
                        monthly_kwh_per_kwp=monthly,
                        message="PVGIS climate-based estimate, not measured generation. Temperature is included; extra site losses apply separately.")
    except Exception:
        # Failure of this optional enrichment must not discard uploaded evidence.
        # Do not return provider exception strings: these can contain API keys.
        snapshot.update(status="service_unavailable", message=f"{stage} lookup unavailable or invalid. Using 1000 kWh/kWp; retry later.")
    return snapshot

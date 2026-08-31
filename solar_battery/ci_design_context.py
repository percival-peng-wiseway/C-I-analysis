from __future__ import annotations

import math
from typing import Literal

from solar_battery.ci_projects import CiProjectError


CI_DESIGN_CONTEXT_CONTRACT_VERSION = "ci_design_context_v1"
_OPERATING_STATUSES = {"operational", "limited", "offline", "unknown"}


def legacy_ci_design_context(scenarios: list[dict[str, object]]) -> dict[str, object]:
    if not scenarios:
        raise CiProjectError(
            "ci_design_context_invalid", "The design context could not be restored."
        )
    first = scenarios[0]
    battery = next(
        (
            item
            for item in scenarios
            if float(item.get("nominal_capacity_kwh", 0)) > 0
            and float(item.get("max_discharge_kw", 0)) > 0
        ),
        None,
    )
    pv_capacity = float(first["pv_capacity_kwp_dc"])
    inverter_capacity = float(first["pv_inverter_capacity_kw_ac"])
    derating = float(first["pv_derating_factor"])
    legacy_dc_ac_ratio = (
        pv_capacity / inverter_capacity
        if pv_capacity > 0 and inverter_capacity > 0
        else 1.15
    )
    return {
        "existing_solar": _empty_existing_solar(),
        "existing_battery": _empty_existing_battery(),
        "technical_options": {
            "annual_specific_yield_kwh_per_kw": first[
                "pv_annual_specific_yield_kwh_per_kw"
            ],
            "shading_loss_percent": 0,
            "soiling_loss_percent": 0,
            "temperature_loss_percent": 0,
            "wiring_mismatch_loss_percent": 0,
            "other_system_loss_percent": max(0, (1 - derating) * 100),
            "system_availability_percent": 100,
            "target_dc_ac_ratio": min(2.0, max(0.8, legacy_dc_ac_ratio)),
            "inverter_block_size_kw": 1,
            "site_ac_headroom_kw": first["shared_ac_headroom_kw"],
            "battery_duration_hours": (
                float(battery["nominal_capacity_kwh"])
                / float(battery["max_discharge_kw"])
                if battery is not None
                else 2
            ),
            "charge_efficiency_percent": float(first["charge_efficiency"]) * 100,
            "discharge_efficiency_percent": float(first["discharge_efficiency"])
            * 100,
            "minimum_soc_percent": float(first["min_soc_fraction"]) * 100,
            "maximum_soc_percent": float(first["max_soc_fraction"]) * 100,
            "allow_grid_charging": first["allow_grid_charging"],
            "reactive_support_enabled": first["reactive_support_enabled"],
            "reactive_support_max_kvar": first["reactive_support_max_kvar"],
            "grid_emissions_factor_kg_co2e_per_kwh": first.get(
                "grid_emissions_factor_kg_co2e_per_kwh", 0.79
            ),
        },
    }


def validate_ci_design_context(value: object) -> dict[str, object]:
    try:
        if not isinstance(value, dict):
            raise ValueError
        solar = _validate_existing_solar(value.get("existing_solar"))
        battery = _validate_existing_battery(value.get("existing_battery"))
        options = _validate_technical_options(value.get("technical_options"))
    except (KeyError, TypeError, ValueError) as exc:
        raise CiProjectError(
            "ci_design_context_invalid",
            "Complete the existing-system details and technical options before running the search space.",
        ) from exc
    return {
        "contract_version": CI_DESIGN_CONTEXT_CONTRACT_VERSION,
        "existing_solar": solar,
        "existing_battery": battery,
        "technical_options": options,
    }


def _empty_existing_solar() -> dict[str, object]:
    return {
        "installed": False,
        "brand": "",
        "model": "",
        "panel_count": 0,
        "panel_rating_w": 0,
        "installed_capacity_kwp_dc": 0,
        "inverter_brand": "",
        "inverter_model": "",
        "inverter_capacity_kw_ac": 0,
        "installation_year": None,
        "operating_status": "unknown",
        "included_in_interval_baseline": False,
    }


def _empty_existing_battery() -> dict[str, object]:
    return {
        "installed": False,
        "brand": "",
        "model": "",
        "nominal_capacity_kwh": 0,
        "usable_capacity_kwh": 0,
        "power_kw": 0,
        "installation_year": None,
        "operating_status": "unknown",
        "included_in_interval_baseline": False,
    }


def _validate_existing_solar(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError
    installed = _boolean(value, "installed")
    result = {
        "installed": installed,
        "brand": _text(value, "brand", required=installed),
        "model": _text(value, "model", required=installed),
        "panel_count": _integer(value, "panel_count", positive=installed),
        "panel_rating_w": _number(value, "panel_rating_w", positive=installed),
        "installed_capacity_kwp_dc": _number(
            value, "installed_capacity_kwp_dc", positive=installed
        ),
        "inverter_brand": _text(value, "inverter_brand", required=False),
        "inverter_model": _text(value, "inverter_model", required=False),
        "inverter_capacity_kw_ac": _number(
            value, "inverter_capacity_kw_ac", positive=False
        ),
        "installation_year": _year(value.get("installation_year")),
        "operating_status": _status(value, installed=installed),
        "included_in_interval_baseline": _boolean(
            value, "included_in_interval_baseline"
        ),
    }
    if not installed and any(
        result[key] not in {"", 0, None, "unknown", False}
        for key in (
            "brand",
            "model",
            "panel_count",
            "panel_rating_w",
            "installed_capacity_kwp_dc",
            "inverter_brand",
            "inverter_model",
            "inverter_capacity_kw_ac",
            "installation_year",
            "operating_status",
            "included_in_interval_baseline",
        )
    ):
        raise ValueError
    return result


def _validate_existing_battery(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError
    installed = _boolean(value, "installed")
    nominal = _number(value, "nominal_capacity_kwh", positive=installed)
    usable = _number(value, "usable_capacity_kwh", positive=installed)
    if usable > nominal:
        raise ValueError
    result = {
        "installed": installed,
        "brand": _text(value, "brand", required=installed),
        "model": _text(value, "model", required=installed),
        "nominal_capacity_kwh": nominal,
        "usable_capacity_kwh": usable,
        "power_kw": _number(value, "power_kw", positive=installed),
        "installation_year": _year(value.get("installation_year")),
        "operating_status": _status(value, installed=installed),
        "included_in_interval_baseline": _boolean(
            value, "included_in_interval_baseline"
        ),
    }
    if not installed and any(
        result[key] not in {"", 0, None, "unknown", False}
        for key in (
            "brand",
            "model",
            "nominal_capacity_kwh",
            "usable_capacity_kwh",
            "power_kw",
            "installation_year",
            "operating_status",
            "included_in_interval_baseline",
        )
    ):
        raise ValueError
    return result


def _validate_technical_options(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError
    annual_yield = _bounded_number(value, "annual_specific_yield_kwh_per_kw", 500, 3000)
    losses = {
        key: _bounded_number(value, key, 0, 99)
        for key in (
            "shading_loss_percent",
            "soiling_loss_percent",
            "temperature_loss_percent",
            "wiring_mismatch_loss_percent",
            "other_system_loss_percent",
        )
    }
    availability = _bounded_number(value, "system_availability_percent", 1, 100)
    effective_derating = availability / 100
    for loss in losses.values():
        effective_derating *= 1 - loss / 100
    if effective_derating <= 0:
        raise ValueError
    min_soc = _bounded_number(value, "minimum_soc_percent", 0, 99)
    max_soc = _bounded_number(value, "maximum_soc_percent", 1, 100)
    if min_soc >= max_soc:
        raise ValueError
    reactive_enabled = _boolean(value, "reactive_support_enabled")
    reactive_cap = _number(value, "reactive_support_max_kvar", positive=reactive_enabled)
    return {
        "annual_specific_yield_kwh_per_kw": annual_yield,
        **losses,
        "system_availability_percent": availability,
        "effective_derating_percent": round(effective_derating * 100, 8),
        "target_dc_ac_ratio": _bounded_number(value, "target_dc_ac_ratio", 0.8, 2.0),
        "inverter_block_size_kw": _bounded_number(value, "inverter_block_size_kw", 0.1, 1000),
        "site_ac_headroom_kw": _bounded_number(value, "site_ac_headroom_kw", 0.1, 1_000_000),
        "battery_duration_hours": _bounded_number(value, "battery_duration_hours", 0.25, 24),
        "charge_efficiency_percent": _bounded_number(value, "charge_efficiency_percent", 1, 100),
        "discharge_efficiency_percent": _bounded_number(value, "discharge_efficiency_percent", 1, 100),
        "minimum_soc_percent": min_soc,
        "maximum_soc_percent": max_soc,
        "allow_grid_charging": _boolean(value, "allow_grid_charging"),
        "reactive_support_enabled": reactive_enabled,
        "reactive_support_max_kvar": reactive_cap,
        "grid_emissions_factor_kg_co2e_per_kwh": _bounded_number(
            value,
            "grid_emissions_factor_kg_co2e_per_kwh",
            0,
            5,
        ) if "grid_emissions_factor_kg_co2e_per_kwh" in value else 0.79,
    }


def _text(value: dict[str, object], key: str, *, required: bool) -> str:
    raw = value.get(key)
    if not isinstance(raw, str):
        raise ValueError
    normalized = raw.strip()
    if (required and not normalized) or len(normalized) > 120:
        raise ValueError
    return normalized


def _number(value: dict[str, object], key: str, *, positive: bool) -> float:
    raw = value.get(key)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError
    parsed = float(raw)
    if not math.isfinite(parsed) or parsed < 0 or (positive and parsed <= 0):
        raise ValueError
    return parsed


def _integer(value: dict[str, object], key: str, *, positive: bool) -> int:
    parsed = _number(value, key, positive=positive)
    if not parsed.is_integer() or parsed > 1_000_000:
        raise ValueError
    return int(parsed)


def _bounded_number(
    value: dict[str, object], key: str, minimum: float, maximum: float
) -> float:
    parsed = _number(value, key, positive=False)
    if not minimum <= parsed <= maximum:
        raise ValueError
    return parsed


def _boolean(value: dict[str, object], key: str) -> bool:
    raw = value.get(key)
    if not isinstance(raw, bool):
        raise ValueError
    return raw


def _year(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1980 <= value <= 2100:
        raise ValueError
    return value


def _status(
    value: dict[str, object], *, installed: bool
) -> Literal["operational", "limited", "offline", "unknown"]:
    raw = value.get("operating_status")
    if not isinstance(raw, str) or raw not in _OPERATING_STATUSES:
        raise ValueError
    if not installed and raw != "unknown":
        raise ValueError
    return raw  # type: ignore[return-value]

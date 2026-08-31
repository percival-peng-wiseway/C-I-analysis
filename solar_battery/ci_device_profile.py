from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
from uuid import uuid4

from sqlalchemy import select

from solar_battery.ci_projects import CiProjectError
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import CiDeviceProfileModel


CI_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v2"
CI_LEGACY_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v1"
CI_DEVICE_PROFILE_STATE_CONTRACT_VERSION = "ci_device_profile_state_v1"

CI_PV_PRODUCT_ID = "astronergy_astro_n7_600_630w"
CI_BATTERY_PRODUCT_ID = "fox_ess_cq7_ci"
CI_INVERTER_PRODUCT_ID = "fox_ess_h3_plus_125kw"


def suggested_ci_device_profile() -> dict[str, object]:
    """Non-authoritative form defaults; finance remains locked until saved."""
    return {
        "contract_version": CI_DEVICE_PROFILE_CONTRACT_VERSION,
        "profile_id": "workspace_device_profile",
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "pv_cost_aud_per_kwp_dc": 530.0,
        "battery_cost_aud_per_kwh": 413.0,
        "inverter_cost_aud_per_kw_ac": 80.0,
        "equipment_catalog": {
            "pv_products": [
                {
                    "product_id": CI_PV_PRODUCT_ID,
                    "manufacturer": "Astronergy",
                    "model": "ASTRO N7 600–630W",
                    "rated_power_min_w": 600.0,
                    "rated_power_max_w": 630.0,
                    "capital_cost_aud_per_kwp_dc": 530.0,
                    "replacement_cost_aud_per_kwp_dc": 530.0,
                    "annual_om_aud": 0.0,
                }
            ],
            "battery_products": [
                {
                    "product_id": CI_BATTERY_PRODUCT_ID,
                    "manufacturer": "Fox ESS",
                    "model": "CQ7 C&I",
                    "chemistry": "LFP",
                    "module_capacity_kwh": 7.0,
                    "cost_curve": [
                        {"quantity": 30, "capital_cost_aud": 77578.0, "replacement_cost_aud": 57456.0, "annual_om_aud": 0.0},
                        {"quantity": 36, "capital_cost_aud": 91866.0, "replacement_cost_aud": 69660.0, "annual_om_aud": 0.0},
                        {"quantity": 42, "capital_cost_aud": 106154.0, "replacement_cost_aud": 81864.0, "annual_om_aud": 0.0},
                    ],
                }
            ],
            "inverter_products": [
                {
                    "product_id": CI_INVERTER_PRODUCT_ID,
                    "manufacturer": "Fox ESS",
                    "model": "H3 Plus Hybrid Inverter",
                    "sizing_unit_kw_ac": 125.0,
                    "cost_curve": [
                        {"capacity_kw_ac": 80.0, "capital_cost_aud": 9000.0, "replacement_cost_aud": 9000.0, "annual_om_aud": 0.0},
                        {"capacity_kw_ac": 100.0, "capital_cost_aud": 9500.0, "replacement_cost_aud": 9500.0, "annual_om_aud": 0.0},
                        {"capacity_kw_ac": 125.0, "capital_cost_aud": 10000.0, "replacement_cost_aud": 10000.0, "annual_om_aud": 0.0},
                    ],
                }
            ],
        },
        "default_equipment_selection": {
            "pv_product_id": CI_PV_PRODUCT_ID,
            "battery_product_id": CI_BATTERY_PRODUCT_ID,
            "inverter_product_id": CI_INVERTER_PRODUCT_ID,
        },
        "discount_rate": 0.08,
        "annual_value_escalation_rate": 0.025,
        "annual_value_degradation_rate": 0.005,
        "annual_om_fraction_of_capex": 0.015,
        "analysis_term_years": 15,
    }


def ci_device_profile_state(
    session, *, actor: LocalActorContext
) -> dict[str, object]:
    row = session.scalar(
        select(CiDeviceProfileModel).where(
            CiDeviceProfileModel.workspace_id == actor.workspace_id,
            CiDeviceProfileModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        return {
            "contract_version": CI_DEVICE_PROFILE_STATE_CONTRACT_VERSION,
            "status": "not_configured",
            "updated_at": None,
            "profile_sha256": None,
            "profile": None,
            "suggested_profile": suggested_ci_device_profile(),
        }
    stored_digest = device_profile_sha256(row.profile_json)
    if (
        row.profile_contract_version not in {
            CI_DEVICE_PROFILE_CONTRACT_VERSION,
            CI_LEGACY_DEVICE_PROFILE_CONTRACT_VERSION,
        }
        or row.profile_sha256 != stored_digest
    ):
        raise CiProjectError(
            "ci_device_profile_integrity_failed",
            "The saved device price profile failed its integrity check.",
        )
    normalized = validate_ci_device_profile(row.profile_json)
    digest = device_profile_sha256(normalized)
    return {
        "contract_version": CI_DEVICE_PROFILE_STATE_CONTRACT_VERSION,
        "status": "ready",
        "updated_at": row.updated_at.isoformat(),
        "profile_sha256": digest,
        "profile": json.loads(json.dumps(normalized)),
        "suggested_profile": suggested_ci_device_profile(),
    }


def save_ci_device_profile(
    session,
    *,
    actor: LocalActorContext,
    profile: dict[str, object],
) -> dict[str, object]:
    normalized = validate_ci_device_profile(profile)
    digest = device_profile_sha256(normalized)
    now = datetime.now(timezone.utc)
    row = session.scalar(
        select(CiDeviceProfileModel).where(
            CiDeviceProfileModel.workspace_id == actor.workspace_id,
            CiDeviceProfileModel.owner_id == actor.owner_id,
        )
    )
    if row is None:
        row = CiDeviceProfileModel(
            id=uuid4(),
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            profile_contract_version=CI_DEVICE_PROFILE_CONTRACT_VERSION,
            profile_sha256=digest,
            profile_json=normalized,
            created_by_actor_id=actor.actor_id,
            updated_by_actor_id=actor.actor_id,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        row.profile_contract_version = CI_DEVICE_PROFILE_CONTRACT_VERSION
        row.profile_sha256 = digest
        row.profile_json = normalized
        row.updated_by_actor_id = actor.actor_id
        row.updated_at = now
    session.flush()
    return {
        "contract_version": CI_DEVICE_PROFILE_STATE_CONTRACT_VERSION,
        "status": "ready",
        "updated_at": row.updated_at.isoformat(),
        "profile_sha256": digest,
        "profile": json.loads(json.dumps(normalized)),
        "suggested_profile": suggested_ci_device_profile(),
    }


def device_profile_sha256(profile: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(
            profile,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


def validate_ci_device_profile(profile: dict[str, object]) -> dict[str, object]:
    if isinstance(profile, dict) and profile.get("contract_version") == CI_LEGACY_DEVICE_PROFILE_CONTRACT_VERSION:
        return _upgrade_legacy_profile(profile)
    if (
        not isinstance(profile, dict)
        or profile.get("contract_version") != CI_DEVICE_PROFILE_CONTRACT_VERSION
        or profile.get("profile_id") != "workspace_device_profile"
        or profile.get("currency") != "AUD"
        or profile.get("tax_basis") != "gst_exclusive"
    ):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The device price profile is not a supported AUD ex-GST profile.",
        )
    defaults = suggested_ci_device_profile()
    catalog = profile.get("equipment_catalog")
    if not isinstance(catalog, dict):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The supported equipment catalog is required.",
        )
    default_catalog = defaults["equipment_catalog"]
    assert isinstance(default_catalog, dict)
    pv_products = _supported_products(
        catalog.get("pv_products"),
        default_catalog["pv_products"],
        product_id=CI_PV_PRODUCT_ID,
        price_fields=("capital_cost_aud_per_kwp_dc", "replacement_cost_aud_per_kwp_dc", "annual_om_aud"),
    )
    battery_products = _supported_products(
        catalog.get("battery_products"),
        default_catalog["battery_products"],
        product_id=CI_BATTERY_PRODUCT_ID,
        curve_axis="quantity",
    )
    inverter_products = _supported_products(
        catalog.get("inverter_products"),
        default_catalog["inverter_products"],
        product_id=CI_INVERTER_PRODUCT_ID,
        curve_axis="capacity_kw_ac",
    )
    selection = profile.get("default_equipment_selection")
    expected_selection = defaults["default_equipment_selection"]
    if selection != expected_selection:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Only the supported PV, battery and inverter products can be selected.",
        )
    normalized = {
        "contract_version": CI_DEVICE_PROFILE_CONTRACT_VERSION,
        "profile_id": "workspace_device_profile",
        "currency": "AUD",
        "tax_basis": "gst_exclusive",
        "pv_cost_aud_per_kwp_dc": _positive_price(
            profile.get("pv_cost_aud_per_kwp_dc"), "PV price"
        ),
        "battery_cost_aud_per_kwh": _positive_price(
            profile.get("battery_cost_aud_per_kwh"), "Battery price"
        ),
        "inverter_cost_aud_per_kw_ac": _positive_price(
            profile.get("inverter_cost_aud_per_kw_ac"), "Inverter price"
        ),
        "equipment_catalog": {
            "pv_products": pv_products,
            "battery_products": battery_products,
            "inverter_products": inverter_products,
        },
        "default_equipment_selection": dict(expected_selection),
        "discount_rate": _rate(profile.get("discount_rate"), "Discount rate"),
        "annual_value_escalation_rate": _rate(
            profile.get("annual_value_escalation_rate"), "Value escalation"
        ),
        "annual_value_degradation_rate": _rate(
            profile.get("annual_value_degradation_rate"), "Value degradation"
        ),
        "annual_om_fraction_of_capex": _rate(
            profile.get("annual_om_fraction_of_capex"),
            "Annual O&M",
            maximum=0.201,
        ),
        "analysis_term_years": _term(profile.get("analysis_term_years")),
    }
    return normalized


def _upgrade_legacy_profile(profile: dict[str, object]) -> dict[str, object]:
    if (
        profile.get("profile_id") != "workspace_device_profile"
        or profile.get("currency") != "AUD"
        or profile.get("tax_basis") != "gst_exclusive"
    ):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The legacy device price profile is invalid.",
        )
    upgraded = suggested_ci_device_profile()
    for key in (
        "pv_cost_aud_per_kwp_dc",
        "battery_cost_aud_per_kwh",
        "inverter_cost_aud_per_kw_ac",
        "discount_rate",
        "annual_value_escalation_rate",
        "annual_value_degradation_rate",
        "annual_om_fraction_of_capex",
        "analysis_term_years",
    ):
        if key in profile:
            upgraded[key] = profile[key]
    catalog = upgraded["equipment_catalog"]
    assert isinstance(catalog, dict)
    pv_product = catalog["pv_products"][0]
    pv_product["capital_cost_aud_per_kwp_dc"] = upgraded["pv_cost_aud_per_kwp_dc"]
    pv_product["replacement_cost_aud_per_kwp_dc"] = upgraded["pv_cost_aud_per_kwp_dc"]
    return validate_ci_device_profile(upgraded)


def _supported_products(
    value: object,
    defaults: object,
    *,
    product_id: str,
    price_fields: tuple[str, ...] = (),
    curve_axis: str | None = None,
) -> list[dict[str, object]]:
    if (
        not isinstance(value, list)
        or len(value) != 1
        or not isinstance(value[0], dict)
        or value[0].get("product_id") != product_id
        or not isinstance(defaults, list)
        or len(defaults) != 1
        or not isinstance(defaults[0], dict)
    ):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The device profile contains an unsupported equipment product.",
        )
    source = value[0]
    normalized = json.loads(json.dumps(defaults[0]))
    for field in price_fields:
        normalized[field] = _non_negative_price(source.get(field), field)
    if curve_axis is not None:
        source_curve = source.get("cost_curve")
        default_curve = defaults[0].get("cost_curve")
        if (
            not isinstance(source_curve, list)
            or not isinstance(default_curve, list)
            or len(source_curve) != len(default_curve)
        ):
            raise CiProjectError(
                "ci_device_profile_invalid", "The equipment cost curve is invalid."
            )
        normalized_curve: list[dict[str, object]] = []
        for source_point, default_point in zip(source_curve, default_curve, strict=True):
            if (
                not isinstance(source_point, dict)
                or not isinstance(default_point, dict)
                or float(source_point.get(curve_axis, -1)) != float(default_point[curve_axis])
            ):
                raise CiProjectError(
                    "ci_device_profile_invalid",
                    "The equipment cost curve sizing points cannot be changed.",
                )
            normalized_curve.append(
                {
                    curve_axis: default_point[curve_axis],
                    "capital_cost_aud": _positive_price(source_point.get("capital_cost_aud"), "Capital cost"),
                    "replacement_cost_aud": _non_negative_price(source_point.get("replacement_cost_aud"), "Replacement cost"),
                    "annual_om_aud": _non_negative_price(source_point.get("annual_om_aud"), "Annual O&M"),
                }
            )
        normalized["cost_curve"] = normalized_curve
    return [normalized]


def _non_negative_price(value: object, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise CiProjectError(
            "ci_device_profile_invalid", f"{label} must be a valid amount."
        ) from exc
    if not math.isfinite(result) or result < 0 or result > 1_000_000_000:
        raise CiProjectError(
            "ci_device_profile_invalid", f"{label} must be a valid amount."
        )
    return round(result, 4)


def _positive_price(value: object, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise CiProjectError(
            "ci_device_profile_invalid", f"{label} must be a positive amount."
        ) from exc
    if not math.isfinite(result) or result <= 0 or result > 1_000_000:
        raise CiProjectError(
            "ci_device_profile_invalid", f"{label} must be a positive amount."
        )
    return round(result, 4)


def _rate(value: object, label: str, *, maximum: float = 1.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise CiProjectError(
            "ci_device_profile_invalid", f"{label} must be a valid percentage."
        ) from exc
    if not math.isfinite(result) or result < 0 or result >= maximum:
        raise CiProjectError(
            "ci_device_profile_invalid", f"{label} must be a valid percentage."
        )
    return result


def _term(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 50:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The analysis term must be an integer from 1 to 50 years.",
        )
    return value

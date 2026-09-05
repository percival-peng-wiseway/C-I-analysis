from __future__ import annotations

from datetime import date, datetime, timezone
import hashlib
import json
import math
import re
from uuid import uuid4

from sqlalchemy import select

from solar_battery.ci_projects import CiProjectError
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import CiDeviceProfileModel


CI_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v5"
CI_V4_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v4"
CI_V3_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v3"
CI_V2_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v2"
CI_LEGACY_DEVICE_PROFILE_CONTRACT_VERSION = "ci_device_profile_v1"
CI_DEVICE_PROFILE_STATE_CONTRACT_VERSION = "ci_device_profile_state_v1"

CI_PV_PRODUCT_ID = "astronergy_astro_n7_600_630w"
CI_BATTERY_PRODUCT_ID = "fox_ess_cq7_ci"
CI_INVERTER_PRODUCT_ID = "fox_ess_h3_plus_125kw"

CI_DEFAULT_SOLAR_PROFILE_ID = "generic_crystalline_pv_v1"
CI_DEFAULT_BATTERY_PROFILE_ID = "generic_lfp_ac_2h_v1"

_PROFILE_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,118}[a-z0-9])?$")
_PROFILE_STATUSES = {"draft", "published", "retired"}
_SOURCE_TYPES = {
    "manufacturer_datasheet",
    "supplier_data",
    "analyst_assumption",
}
_SOLAR_MODULE_TECHNOLOGIES = {
    "monocrystalline",
    "polycrystalline",
    "thin_film",
    "other",
}
_BATTERY_COUPLINGS = {"ac", "dc"}

_SOLAR_PROFILE_KEYS = {
    "profile_id",
    "version",
    "status",
    "name",
    "manufacturer",
    "model",
    "module_technology",
    "rated_power_w",
    "module_efficiency_percent",
    "temperature_coefficient_percent_per_c",
    "annual_degradation_percent",
    "default_dc_ac_ratio",
    "source_type",
    "source_label",
    "source_date",
}
_BATTERY_PROFILE_KEYS = {
    "profile_id",
    "version",
    "status",
    "name",
    "manufacturer",
    "model",
    "chemistry",
    "coupling",
    "nominal_capacity_kwh_per_unit",
    "continuous_power_kw_per_unit",
    "round_trip_efficiency_percent",
    "power_conversion_efficiency_percent",
    "usable_depth_of_discharge_percent",
    "standby_loss_percent_per_month",
    "annual_capacity_degradation_percent",
    "minimum_units",
    "maximum_units",
    "source_type",
    "source_label",
    "source_date",
}
_INVERTER_PROFILE_KEYS = {
    "profile_id",
    "version",
    "status",
    "name",
    "manufacturer",
    "model",
    "rated_active_power_kw",
    "rated_apparent_power_kva",
    "reactive_support_enabled",
    "maximum_reactive_power_kvar",
    "power_factor_leading_limit",
    "power_factor_lagging_limit",
    "pq_capability_curve_available",
    "reactive_power_at_zero_active_power",
    "night_reactive_capability",
    "european_efficiency_percent",
    "maximum_efficiency_percent",
    "source_type",
    "source_label",
    "source_date",
}


def _fox_h3_plus_profile(
    active_power_kw: float,
    apparent_power_kva: float,
    reactive_power_kvar: float,
) -> dict[str, object]:
    size = int(active_power_kw)
    return {
        "profile_id": f"fox_ess_h3_{size}_plus_v1",
        "version": 1,
        "status": "draft",
        "name": f"Fox ESS H3-{size}-Plus reactive evidence draft",
        "manufacturer": "Fox ESS",
        "model": f"H3-{size}-Plus",
        "rated_active_power_kw": active_power_kw,
        "rated_apparent_power_kva": apparent_power_kva,
        "reactive_support_enabled": True,
        "maximum_reactive_power_kvar": reactive_power_kvar,
        "power_factor_leading_limit": 0.8,
        "power_factor_lagging_limit": 0.8,
        "pq_capability_curve_available": False,
        "reactive_power_at_zero_active_power": True,
        "night_reactive_capability": True,
        "european_efficiency_percent": 98.1,
        "maximum_efficiency_percent": 98.5,
        "source_type": "supplier_data",
        "source_label": "Fox ESS H3 Plus datasheet V2.7 + supplied C&I device workbook",
        "source_date": "2025-12-04",
    }


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
        "solution_profiles": {
            "solar_profiles": [
                {
                    "profile_id": CI_DEFAULT_SOLAR_PROFILE_ID,
                    "version": 1,
                    "status": "published",
                    "name": "Generic crystalline PV screening profile",
                    "manufacturer": "Generic",
                    "model": "Screening assumption",
                    "module_technology": "monocrystalline",
                    "rated_power_w": 600.0,
                    "module_efficiency_percent": 22.0,
                    "temperature_coefficient_percent_per_c": -0.35,
                    "annual_degradation_percent": 0.5,
                    "default_dc_ac_ratio": 1.15,
                    "source_type": "analyst_assumption",
                    "source_label": "Generic screening assumption",
                    "source_date": None,
                },
                {
                    "profile_id": "longi_hi_mo_x10_lr7_72hvh_650m_v1",
                    "version": 1,
                    "status": "published",
                    "name": "LONGi Hi-MO X10 LR7-72HVH-650M",
                    "manufacturer": "LONGi",
                    "model": "LR7-72HVH-650M",
                    "module_technology": "monocrystalline",
                    "rated_power_w": 650.0,
                    "module_efficiency_percent": 24.1,
                    "temperature_coefficient_percent_per_c": -0.26,
                    "annual_degradation_percent": 0.35,
                    "default_dc_ac_ratio": 1.2,
                    "source_type": "manufacturer_datasheet",
                    "source_label": "LONGi LR7-72HVH 640–670M datasheet BGV02",
                    "source_date": "2025-03-13",
                },
            ],
            "battery_profiles": [
                {
                    "profile_id": CI_DEFAULT_BATTERY_PROFILE_ID,
                    "version": 1,
                    "status": "published",
                    "name": "Generic LFP AC 2-hour screening profile",
                    "manufacturer": "Generic",
                    "model": "Screening assumption",
                    "chemistry": "LFP",
                    "coupling": "ac",
                    "nominal_capacity_kwh_per_unit": 100.0,
                    "continuous_power_kw_per_unit": 50.0,
                    "round_trip_efficiency_percent": 90.0,
                    "power_conversion_efficiency_percent": 95.0,
                    "usable_depth_of_discharge_percent": 90.0,
                    "standby_loss_percent_per_month": 1.0,
                    "annual_capacity_degradation_percent": 2.0,
                    "minimum_units": 1,
                    "maximum_units": 10_000,
                    "source_type": "analyst_assumption",
                    "source_label": "Generic screening assumption",
                    "source_date": None,
                },
                {
                    "profile_id": "fox_ess_cq7_l14_v1",
                    "version": 1,
                    "status": "draft",
                    "name": "Fox ESS CQ7-L14 evidence draft",
                    "manufacturer": "Fox ESS",
                    "model": "CQ7-L14",
                    "chemistry": "LFP",
                    "coupling": None,
                    "nominal_capacity_kwh_per_unit": 97.44,
                    "continuous_power_kw_per_unit": 64.51,
                    "round_trip_efficiency_percent": 95.0,
                    "power_conversion_efficiency_percent": None,
                    "usable_depth_of_discharge_percent": 100.0,
                    "standby_loss_percent_per_month": None,
                    "annual_capacity_degradation_percent": None,
                    "minimum_units": 1,
                    "maximum_units": 30,
                    "source_type": "supplier_data",
                    "source_label": "Fox ESS CQ7 datasheet V1.2 + supplied C&I device workbook",
                    "source_date": "2026-05-14",
                },
            ],
            "inverter_profiles": [
                _fox_h3_plus_profile(50.0, 55.0, 33.0),
                _fox_h3_plus_profile(60.0, 66.0, 39.6),
                _fox_h3_plus_profile(75.0, 82.5, 49.5),
                _fox_h3_plus_profile(80.0, 88.0, 52.8),
                _fox_h3_plus_profile(100.0, 110.0, 66.0),
                _fox_h3_plus_profile(125.0, 137.5, 82.5),
            ],
        },
        "default_solution_profile_selection": {
            "solar_profile_id": CI_DEFAULT_SOLAR_PROFILE_ID,
            "battery_profile_id": CI_DEFAULT_BATTERY_PROFILE_ID,
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
            CI_V4_DEVICE_PROFILE_CONTRACT_VERSION,
            CI_V3_DEVICE_PROFILE_CONTRACT_VERSION,
            CI_V2_DEVICE_PROFILE_CONTRACT_VERSION,
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


def compatible_device_profile_sha256s(
    profile: dict[str, object],
) -> frozenset[str]:
    """Return only hashes proven equivalent across a known schema migration.

    The v5 contract adds an inverter reactive-support policy but does not alter
    the equipment-price operands used by an already saved design-price
    preview.  A v4 predecessor is compatible only when removing that one field
    and round-tripping through the authoritative v4->v5 migration reproduces
    the current normalized profile exactly.  Any other edit remains stale.
    """

    normalized = validate_ci_device_profile(profile)
    compatible = {device_profile_sha256(normalized)}
    predecessor = json.loads(json.dumps(normalized, allow_nan=False))
    predecessor["contract_version"] = CI_V4_DEVICE_PROFILE_CONTRACT_VERSION
    solution_profiles = predecessor.get("solution_profiles")
    inverter_profiles = (
        solution_profiles.get("inverter_profiles")
        if isinstance(solution_profiles, dict)
        else None
    )
    if not isinstance(inverter_profiles, list):
        return frozenset(compatible)
    for inverter in inverter_profiles:
        if not isinstance(inverter, dict):
            return frozenset(compatible)
        inverter.pop("reactive_support_enabled", None)
    try:
        round_tripped = validate_ci_device_profile(predecessor)
    except CiProjectError:
        return frozenset(compatible)
    if round_tripped == normalized:
        compatible.add(device_profile_sha256(predecessor))
    return frozenset(compatible)


def validate_ci_device_profile(profile: dict[str, object]) -> dict[str, object]:
    if isinstance(profile, dict) and profile.get("contract_version") == CI_LEGACY_DEVICE_PROFILE_CONTRACT_VERSION:
        return _upgrade_legacy_profile(profile)
    if isinstance(profile, dict) and profile.get("contract_version") == CI_V2_DEVICE_PROFILE_CONTRACT_VERSION:
        return _upgrade_v2_profile(profile)
    if isinstance(profile, dict) and profile.get("contract_version") == CI_V3_DEVICE_PROFILE_CONTRACT_VERSION:
        return _upgrade_v3_profile(profile)
    if isinstance(profile, dict) and profile.get("contract_version") == CI_V4_DEVICE_PROFILE_CONTRACT_VERSION:
        return _upgrade_v4_profile(profile)
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
    solution_profiles = _solution_profiles(profile.get("solution_profiles"))
    solution_profile_selection = _solution_profile_selection(
        profile.get("default_solution_profile_selection"),
        solution_profiles=solution_profiles,
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
        "solution_profiles": solution_profiles,
        "default_solution_profile_selection": solution_profile_selection,
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


def _upgrade_v2_profile(profile: dict[str, object]) -> dict[str, object]:
    upgraded = json.loads(json.dumps(profile))
    defaults = suggested_ci_device_profile()
    upgraded["contract_version"] = CI_DEVICE_PROFILE_CONTRACT_VERSION
    upgraded["solution_profiles"] = defaults["solution_profiles"]
    upgraded["default_solution_profile_selection"] = defaults[
        "default_solution_profile_selection"
    ]
    return validate_ci_device_profile(upgraded)


def _upgrade_v3_profile(profile: dict[str, object]) -> dict[str, object]:
    upgraded = json.loads(json.dumps(profile))
    defaults = suggested_ci_device_profile()
    default_profiles = defaults["solution_profiles"]
    assert isinstance(default_profiles, dict)
    existing_profiles = upgraded.get("solution_profiles")
    if not isinstance(existing_profiles, dict):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The v3 device solution profiles are unavailable.",
        )
    upgraded["contract_version"] = CI_DEVICE_PROFILE_CONTRACT_VERSION
    merged_profiles: dict[str, list[object]] = {}
    for group in ("solar_profiles", "battery_profiles"):
        existing = existing_profiles.get(group)
        if not isinstance(existing, list):
            raise CiProjectError(
                "ci_device_profile_invalid",
                f"The v3 {group.replace('_', ' ')} are unavailable.",
            )
        existing_ids = {
            item.get("profile_id")
            for item in existing
            if isinstance(item, dict)
        }
        additions = [
            item
            for item in default_profiles[group]
            if isinstance(item, dict) and item.get("profile_id") not in existing_ids
        ]
        merged_profiles[group] = [*existing, *additions]
    merged_profiles["inverter_profiles"] = list(default_profiles["inverter_profiles"])
    upgraded["solution_profiles"] = merged_profiles
    return validate_ci_device_profile(upgraded)


def _upgrade_v4_profile(profile: dict[str, object]) -> dict[str, object]:
    """Add an explicit reactive-control policy without inventing custom capability.

    The six bundled Fox profiles were authored with reactive capability evidence
    and are enabled by this contract migration when their saved kvar capability
    remains positive.  Older user-created profiles are preserved byte-for-byte
    apart from the new switch, which defaults closed until the user explicitly
    enables and saves it.
    """

    upgraded = json.loads(json.dumps(profile))
    solution_profiles = upgraded.get("solution_profiles")
    if not isinstance(solution_profiles, dict):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The v4 device solution profiles are unavailable.",
        )
    inverter_profiles = solution_profiles.get("inverter_profiles")
    if not isinstance(inverter_profiles, list):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "The v4 inverter profiles are unavailable.",
        )
    bundled_profile_ids = {
        f"fox_ess_h3_{size}_plus_v1" for size in (50, 60, 75, 80, 100, 125)
    }
    for inverter in inverter_profiles:
        if not isinstance(inverter, dict):
            raise CiProjectError(
                "ci_device_profile_invalid",
                "The v4 inverter profiles are invalid.",
            )
        maximum_kvar = inverter.get("maximum_reactive_power_kvar")
        inverter["reactive_support_enabled"] = bool(
            inverter.get("profile_id") in bundled_profile_ids
            and isinstance(maximum_kvar, (int, float))
            and not isinstance(maximum_kvar, bool)
            and math.isfinite(maximum_kvar)
            and maximum_kvar > 0
        )
    upgraded["contract_version"] = CI_DEVICE_PROFILE_CONTRACT_VERSION
    return validate_ci_device_profile(upgraded)


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


def _solution_profiles(value: object) -> dict[str, list[dict[str, object]]]:
    if not isinstance(value, dict) or set(value) != {
        "solar_profiles",
        "battery_profiles",
        "inverter_profiles",
    }:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Solar, battery and inverter solution profiles are required.",
        )
    solar_profiles = _profile_list(
        value.get("solar_profiles"),
        label="Solar",
        normalize=_solar_profile,
    )
    battery_profiles = _profile_list(
        value.get("battery_profiles"),
        label="Battery",
        normalize=_battery_profile,
    )
    inverter_profiles = _profile_list(
        value.get("inverter_profiles"),
        label="Inverter",
        normalize=_inverter_profile,
    )
    profile_ids = [
        str(item["profile_id"])
        for item in [*solar_profiles, *battery_profiles, *inverter_profiles]
    ]
    if len(set(profile_ids)) != len(profile_ids):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Solution profile IDs must be globally unique.",
        )
    return {
        "solar_profiles": solar_profiles,
        "battery_profiles": battery_profiles,
        "inverter_profiles": inverter_profiles,
    }


def _profile_list(
    value: object,
    *,
    label: str,
    normalize,
) -> list[dict[str, object]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 50:
        raise CiProjectError(
            "ci_device_profile_invalid",
            f"{label} solution profiles must contain 1 to 50 entries.",
        )
    return [normalize(item) for item in value]


def _solar_profile(value: object) -> dict[str, object]:
    source = _profile_mapping(value, _SOLAR_PROFILE_KEYS, "Solar")
    return {
        "profile_id": _profile_id(source.get("profile_id")),
        "version": _profile_version(source.get("version")),
        "status": _profile_choice(source.get("status"), _PROFILE_STATUSES, "status"),
        "name": _profile_text(source.get("name"), "name"),
        "manufacturer": _profile_text(source.get("manufacturer"), "manufacturer"),
        "model": _profile_text(source.get("model"), "model"),
        "module_technology": _profile_choice(
            source.get("module_technology"),
            _SOLAR_MODULE_TECHNOLOGIES,
            "module technology",
        ),
        "rated_power_w": _profile_number(
            source.get("rated_power_w"), "rated power", minimum=100, maximum=2_000
        ),
        "module_efficiency_percent": _profile_number(
            source.get("module_efficiency_percent"),
            "module efficiency",
            minimum=1,
            maximum=40,
        ),
        "temperature_coefficient_percent_per_c": _profile_number(
            source.get("temperature_coefficient_percent_per_c"),
            "temperature coefficient",
            minimum=-2,
            maximum=0,
        ),
        "annual_degradation_percent": _profile_number(
            source.get("annual_degradation_percent"),
            "annual degradation",
            minimum=0,
            maximum=10,
        ),
        "default_dc_ac_ratio": _profile_number(
            source.get("default_dc_ac_ratio"),
            "default DC/AC ratio",
            minimum=0.8,
            maximum=2,
        ),
        **_profile_source(source),
    }


def _battery_profile(value: object) -> dict[str, object]:
    source = _profile_mapping(value, _BATTERY_PROFILE_KEYS, "Battery")
    status = _profile_choice(source.get("status"), _PROFILE_STATUSES, "status")
    allow_missing = status == "draft"
    minimum_units = _draftable_profile_units(
        source.get("minimum_units"), "minimum units", allow_missing=allow_missing
    )
    maximum_units = _draftable_profile_units(
        source.get("maximum_units"), "maximum units", allow_missing=allow_missing
    )
    if (
        minimum_units is not None
        and maximum_units is not None
        and maximum_units < minimum_units
    ):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Battery maximum units must be greater than or equal to minimum units.",
        )
    return {
        "profile_id": _profile_id(source.get("profile_id")),
        "version": _profile_version(source.get("version")),
        "status": status,
        "name": _profile_text(source.get("name"), "name"),
        "manufacturer": _profile_text(source.get("manufacturer"), "manufacturer"),
        "model": _profile_text(source.get("model"), "model"),
        "chemistry": _profile_text(source.get("chemistry"), "chemistry"),
        "coupling": _draftable_profile_choice(
            source.get("coupling"),
            _BATTERY_COUPLINGS,
            "coupling",
            allow_missing=allow_missing,
        ),
        "nominal_capacity_kwh_per_unit": _draftable_profile_number(
            source.get("nominal_capacity_kwh_per_unit"),
            "nominal capacity per unit",
            allow_missing=allow_missing,
            minimum=0,
            minimum_inclusive=False,
        ),
        "continuous_power_kw_per_unit": _draftable_profile_number(
            source.get("continuous_power_kw_per_unit"),
            "continuous power per unit",
            allow_missing=allow_missing,
            minimum=0,
            minimum_inclusive=False,
        ),
        "round_trip_efficiency_percent": _draftable_profile_number(
            source.get("round_trip_efficiency_percent"),
            "round-trip efficiency",
            allow_missing=allow_missing,
            minimum=1,
            maximum=100,
        ),
        "power_conversion_efficiency_percent": _draftable_profile_number(
            source.get("power_conversion_efficiency_percent"),
            "power conversion efficiency",
            allow_missing=allow_missing,
            minimum=1,
            maximum=100,
        ),
        "usable_depth_of_discharge_percent": _draftable_profile_number(
            source.get("usable_depth_of_discharge_percent"),
            "usable depth of discharge",
            allow_missing=allow_missing,
            minimum=1,
            maximum=100,
        ),
        "standby_loss_percent_per_month": _draftable_profile_number(
            source.get("standby_loss_percent_per_month"),
            "standby loss",
            allow_missing=allow_missing,
            minimum=0,
            maximum=100,
            maximum_inclusive=False,
        ),
        "annual_capacity_degradation_percent": _draftable_profile_number(
            source.get("annual_capacity_degradation_percent"),
            "annual capacity degradation",
            allow_missing=allow_missing,
            minimum=0,
            maximum=100,
            maximum_inclusive=False,
        ),
        "minimum_units": minimum_units,
        "maximum_units": maximum_units,
        **_profile_source(source),
    }


def _inverter_profile(value: object) -> dict[str, object]:
    source = _profile_mapping(value, _INVERTER_PROFILE_KEYS, "Inverter")
    normalized = {
        "profile_id": _profile_id(source.get("profile_id")),
        "version": _profile_version(source.get("version")),
        "status": _profile_choice(source.get("status"), _PROFILE_STATUSES, "status"),
        "name": _profile_text(source.get("name"), "name"),
        "manufacturer": _profile_text(source.get("manufacturer"), "manufacturer"),
        "model": _profile_text(source.get("model"), "model"),
        "rated_active_power_kw": _profile_number(
            source.get("rated_active_power_kw"), "rated active power", minimum=0, minimum_inclusive=False
        ),
        "rated_apparent_power_kva": _profile_number(
            source.get("rated_apparent_power_kva"), "rated apparent power", minimum=0, minimum_inclusive=False
        ),
        "reactive_support_enabled": _profile_boolean(
            source.get("reactive_support_enabled"), "reactive support enabled"
        ),
        "maximum_reactive_power_kvar": _profile_number(
            source.get("maximum_reactive_power_kvar"), "maximum reactive power", minimum=0
        ),
        "power_factor_leading_limit": _profile_number(
            source.get("power_factor_leading_limit"), "leading power factor limit", minimum=0, maximum=1
        ),
        "power_factor_lagging_limit": _profile_number(
            source.get("power_factor_lagging_limit"), "lagging power factor limit", minimum=0, maximum=1
        ),
        "pq_capability_curve_available": _profile_boolean(
            source.get("pq_capability_curve_available"), "P-Q capability curve availability"
        ),
        "reactive_power_at_zero_active_power": _profile_boolean(
            source.get("reactive_power_at_zero_active_power"), "zero-active-power reactive capability"
        ),
        "night_reactive_capability": _profile_boolean(
            source.get("night_reactive_capability"), "night reactive capability"
        ),
        "european_efficiency_percent": _profile_number(
            source.get("european_efficiency_percent"), "European efficiency", minimum=1, maximum=100
        ),
        "maximum_efficiency_percent": _profile_number(
            source.get("maximum_efficiency_percent"), "maximum efficiency", minimum=1, maximum=100
        ),
        **_profile_source(source),
    }
    if normalized["rated_apparent_power_kva"] < normalized["rated_active_power_kw"]:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Inverter apparent power must be at least its active power rating.",
        )
    if normalized["maximum_reactive_power_kvar"] > normalized["rated_apparent_power_kva"]:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Inverter reactive power cannot exceed its apparent power rating.",
        )
    if (
        normalized["reactive_support_enabled"]
        and normalized["maximum_reactive_power_kvar"] <= 0
    ):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Enabled inverter reactive support requires a positive reactive power rating.",
        )
    if normalized["european_efficiency_percent"] > normalized["maximum_efficiency_percent"]:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Inverter European efficiency cannot exceed maximum efficiency.",
        )
    return normalized


def _solution_profile_selection(
    value: object,
    *,
    solution_profiles: dict[str, list[dict[str, object]]],
) -> dict[str, str]:
    expected_keys = {"solar_profile_id", "battery_profile_id"}
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Default solar and battery solution profile IDs are required.",
        )
    selection = {
        key: _profile_id(value.get(key))
        for key in ("solar_profile_id", "battery_profile_id")
    }
    published_solar = {
        str(item["profile_id"])
        for item in solution_profiles["solar_profiles"]
        if item["status"] == "published"
    }
    published_battery = {
        str(item["profile_id"])
        for item in solution_profiles["battery_profiles"]
        if item["status"] == "published"
    }
    if (
        selection["solar_profile_id"] not in published_solar
        or selection["battery_profile_id"] not in published_battery
    ):
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Default solution profile IDs must reference published profiles.",
        )
    return selection


def _profile_mapping(
    value: object, expected_keys: set[str], label: str
) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise CiProjectError(
            "ci_device_profile_invalid",
            f"{label} solution profile fields are invalid.",
        )
    return value


def _profile_id(value: object) -> str:
    if not isinstance(value, str) or _PROFILE_ID_PATTERN.fullmatch(value) is None:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Solution profile IDs must be stable lowercase slugs.",
        )
    return value


def _profile_version(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10_000:
        raise CiProjectError(
            "ci_device_profile_invalid",
            "Solution profile versions must be integers from 1 to 10000.",
        )
    return value


def _profile_units(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10_000:
        raise CiProjectError(
            "ci_device_profile_invalid",
            f"Battery {label} must be an integer from 1 to 10000.",
        )
    return value


def _draftable_profile_units(
    value: object, label: str, *, allow_missing: bool
) -> int | None:
    if value is None and allow_missing:
        return None
    return _profile_units(value, label)


def _profile_text(value: object, label: str, *, maximum: int = 240) -> str:
    if not isinstance(value, str):
        raise CiProjectError(
            "ci_device_profile_invalid", f"Solution profile {label} is invalid."
        )
    normalized = value.strip()
    if not normalized or len(normalized) > maximum:
        raise CiProjectError(
            "ci_device_profile_invalid", f"Solution profile {label} is invalid."
        )
    return normalized


def _profile_choice(value: object, allowed: set[str], label: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise CiProjectError(
            "ci_device_profile_invalid", f"Solution profile {label} is invalid."
        )
    return value


def _draftable_profile_choice(
    value: object,
    allowed: set[str],
    label: str,
    *,
    allow_missing: bool,
) -> str | None:
    if value is None and allow_missing:
        return None
    return _profile_choice(value, allowed, label)


def _profile_number(
    value: object,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    minimum_inclusive: bool = True,
    maximum_inclusive: bool = True,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CiProjectError(
            "ci_device_profile_invalid", f"Solution profile {label} is invalid."
        )
    result = float(value)
    below_minimum = minimum is not None and (
        result < minimum if minimum_inclusive else result <= minimum
    )
    above_maximum = maximum is not None and (
        result > maximum if maximum_inclusive else result >= maximum
    )
    if not math.isfinite(result) or below_minimum or above_maximum:
        raise CiProjectError(
            "ci_device_profile_invalid", f"Solution profile {label} is invalid."
        )
    return result


def _draftable_profile_number(
    value: object,
    label: str,
    *,
    allow_missing: bool,
    minimum: float | None = None,
    maximum: float | None = None,
    minimum_inclusive: bool = True,
    maximum_inclusive: bool = True,
) -> float | None:
    if value is None and allow_missing:
        return None
    return _profile_number(
        value,
        label,
        minimum=minimum,
        maximum=maximum,
        minimum_inclusive=minimum_inclusive,
        maximum_inclusive=maximum_inclusive,
    )


def _profile_boolean(value: object, label: str) -> bool:
    if not isinstance(value, bool):
        raise CiProjectError(
            "ci_device_profile_invalid", f"Solution profile {label} is invalid."
        )
    return value


def _profile_source(source: dict[str, object]) -> dict[str, object]:
    return {
        "source_type": _profile_choice(
            source.get("source_type"), _SOURCE_TYPES, "source type"
        ),
        "source_label": _profile_text(source.get("source_label"), "source label"),
        "source_date": _profile_date(source.get("source_date")),
    }


def _profile_date(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise CiProjectError(
            "ci_device_profile_invalid", "Solution profile source date is invalid."
        )
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise CiProjectError(
            "ci_device_profile_invalid", "Solution profile source date is invalid."
        ) from exc
    if parsed.isoformat() != value:
        raise CiProjectError(
            "ci_device_profile_invalid", "Solution profile source date is invalid."
        )
    return value


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

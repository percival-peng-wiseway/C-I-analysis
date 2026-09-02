from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, ROUND_FLOOR
import math
from typing import Any
from zoneinfo import ZoneInfo

from solar_battery.ci_projects import CiProjectError
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_rebate_rules import (
    CI_BATTERY_STC_RULE_ID,
    CI_REBATE_RULESET_ID,
    CI_SOLAR_STC_RULE_ID,
    CI_VIC_DEEMED_VEEC_RULE_ID,
    battery_stc_factor,
    ci_rebate_ruleset_sha256,
    solar_stc_deeming_years,
    vic_deemed_veec_rules_available,
)
from solar_battery.ci_project_rebate_profile import (
    CI_PROJECT_REBATE_CALCULATION_PROFILE_CONTRACT_VERSION,
    CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION,
    validate_ci_project_rebate_profile,
)


CI_SCENARIO_REBATE_CALCULATION_CONTRACT_VERSION = (
    "ci_scenario_rebate_calculation_v1"
)

_PROGRAM_LABELS = {
    "solar_stc": "Solar STCs",
    "battery_stc": "Battery STCs",
    "vic_deemed_veec": "Victorian deemed VEECs",
}

_CALCULATION_PROFILE_KEYS = {
    "contract_version",
    "source_profile_sha256",
    "ruleset_id",
    "ruleset_sha256",
    "design_candidates_sha256",
    "design_context_sha256",
    "device_profile_sha256",
    "target_certificate_date",
    "site_state_code",
    "site_postcode",
    "site_location_source_label",
    "stacking_confirmed",
    "programs",
}
_BINDING_KEYS = (
    "design_candidates_sha256",
    "design_context_sha256",
    "device_profile_sha256",
)


def calculate_ci_scenario_rebate(
    scenario: dict[str, Any],
    *,
    rebate_profile: dict[str, Any] | None,
) -> dict[str, object]:
    scenario_id, authored = _scenario_inputs(scenario)
    if rebate_profile is None:
        programs = {
            program_id: _program_result(
                program_id,
                status="disabled",
                reason_codes=["rebate_program_not_configured"],
                reason_messages=["No approved project rebate program is active."],
                quantity=0,
                unit_price=None,
                rebate=0,
                rule_id=rule_id,
                operands={},
                rounding="not_applicable",
            )
            for program_id, rule_id in _rule_ids().items()
        }
        return _result(scenario_id, programs=programs, target_date=None)

    _validate_calculation_profile(rebate_profile)
    target = date.fromisoformat(str(rebate_profile["target_certificate_date"]))
    configured = rebate_profile["programs"]
    programs = {
        "solar_stc": _solar_stc(
            authored, program=configured["solar_stc"], target=target
        ),
        "battery_stc": _battery_stc(
            authored, program=configured["battery_stc"], target=target
        ),
        "vic_deemed_veec": _vic_deemed_veec(
            authored,
            program=configured["vic_deemed_veec"],
            target=target,
            site_state_code=str(rebate_profile["site_state_code"]),
        ),
    }
    return _result(scenario_id, programs=programs, target_date=target.isoformat())


def calculate_ci_scenario_rebates(
    scenarios: list[dict[str, Any]],
    *,
    rebate_profile: dict[str, Any] | None,
) -> dict[str, dict[str, object]]:
    return {
        str(scenario["scenario_id"]): calculate_ci_scenario_rebate(
            scenario, rebate_profile=rebate_profile
        )
        for scenario in scenarios
    }


def _solar_stc(
    authored: dict[str, Any],
    *,
    program: dict[str, Any],
    target: date,
) -> dict[str, object]:
    if program["enabled"] is not True:
        return _disabled("solar_stc", program, CI_SOLAR_STC_RULE_ID)
    capacity = _number(authored, "pv_capacity_kwp_dc")
    annual_specific_yield = _number(
        authored, "pv_annual_specific_yield_kwh_per_kw"
    )
    derating = _number(authored, "pv_derating_factor")
    annual_output = capacity * annual_specific_yield * derating
    reasons: list[tuple[str, str]] = []
    if capacity <= 0 or capacity > 100:
        reasons.append(
            (
                "solar_stc_capacity_out_of_range",
                "Solar STCs require a positive system capacity no greater than 100 kW under the active rule set.",
            )
        )
    if annual_output > 250_000:
        reasons.append(
            (
                "solar_stc_annual_output_above_250mwh",
                "Solar STCs require expected annual output no greater than 250 MWh under the active rule set.",
            )
        )
    deeming_years = solar_stc_deeming_years(target)
    if deeming_years is None:
        raise _invalid("The approved Solar STC target date is outside the active rule set.")
    zone_rating = _finite(program.get("postcode_zone_rating"), "Solar STC zone rating")
    operands = {
        "system_capacity_kwp_dc": capacity,
        "annual_specific_yield_kwh_per_kw": annual_specific_yield,
        "pv_derating_factor": derating,
        "expected_annual_output_kwh": round(annual_output, 6),
        "postcode_zone_rating": zone_rating,
        "deeming_years": deeming_years,
    }
    if reasons:
        return _ineligible(
            "solar_stc",
            program,
            CI_SOLAR_STC_RULE_ID,
            reasons=reasons,
            operands=operands,
            rounding="floor_after_multiplication",
        )
    quantity = _floor_product(capacity, zone_rating, deeming_years)
    return _applied(
        "solar_stc",
        program,
        CI_SOLAR_STC_RULE_ID,
        quantity=quantity,
        operands=operands,
        rounding="floor_after_multiplication",
    )


def _battery_stc(
    authored: dict[str, Any],
    *,
    program: dict[str, Any],
    target: date,
) -> dict[str, object]:
    if program["enabled"] is not True:
        return _disabled("battery_stc", program, CI_BATTERY_STC_RULE_ID)
    nominal = _number(authored, "nominal_capacity_kwh")
    linked_solar = _number(authored, "pv_capacity_kwp_dc")
    usable_fraction = _finite(
        program.get("certified_usable_capacity_fraction"),
        "Battery certified usable capacity fraction",
    )
    usable = nominal * usable_fraction
    claimable = min(max(usable, 0.0), 50.0)
    reasons: list[tuple[str, str]] = []
    if nominal < 5 or nominal > 100:
        reasons.append(
            (
                "battery_stc_nominal_capacity_out_of_range",
                "Battery STCs require total nominal capacity from 5 kWh through 100 kWh.",
            )
        )
    if linked_solar <= 0 or linked_solar > 100:
        reasons.append(
            (
                "battery_stc_linked_solar_out_of_range",
                "Battery STCs require a linked solar PV system with capacity no greater than 100 kW.",
            )
        )
    factor_method = battery_stc_factor(target)
    if factor_method is None:
        raise _invalid("The approved Battery STC target date is outside the active rule set.")
    factor, method = factor_method
    weighted_usable = claimable
    tiers = {
        "tier_1_usable_kwh": claimable,
        "tier_2_usable_kwh": 0.0,
        "tier_3_usable_kwh": 0.0,
    }
    if method == "tiered_14_28_50":
        tier_1 = min(claimable, 14.0)
        tier_2 = min(max(claimable - 14.0, 0.0), 14.0)
        tier_3 = min(max(claimable - 28.0, 0.0), 22.0)
        weighted_usable = tier_1 + tier_2 * 0.6 + tier_3 * 0.15
        tiers = {
            "tier_1_usable_kwh": tier_1,
            "tier_2_usable_kwh": tier_2,
            "tier_3_usable_kwh": tier_3,
        }
    operands = {
        "nominal_capacity_kwh": nominal,
        "certified_usable_capacity_fraction": usable_fraction,
        "certified_usable_capacity_kwh": round(usable, 6),
        "claimable_usable_capacity_kwh": round(claimable, 6),
        **{key: round(value, 6) for key, value in tiers.items()},
        "weighted_usable_capacity_kwh": round(weighted_usable, 6),
        "linked_solar_capacity_kwp_dc": linked_solar,
        "stc_factor": factor,
        "factor_method": method,
    }
    if reasons:
        return _ineligible(
            "battery_stc",
            program,
            CI_BATTERY_STC_RULE_ID,
            reasons=reasons,
            operands=operands,
            rounding="floor_after_all_tiers_summed",
        )
    quantity = _floor_product(weighted_usable, factor)
    return _applied(
        "battery_stc",
        program,
        CI_BATTERY_STC_RULE_ID,
        quantity=quantity,
        operands=operands,
        rounding="floor_after_all_tiers_summed",
    )


def _vic_deemed_veec(
    authored: dict[str, Any],
    *,
    program: dict[str, Any],
    target: date,
    site_state_code: str,
) -> dict[str, object]:
    if program["enabled"] is not True:
        return _disabled(
            "vic_deemed_veec", program, CI_VIC_DEEMED_VEEC_RULE_ID
        )
    if not vic_deemed_veec_rules_available(target):
        raise _invalid("The approved deemed VEEC target date is outside the active rule set.")
    capacity = _number(authored, "pv_capacity_kwp_dc")
    inverter_capacity_kw_ac = _number(authored, "pv_inverter_capacity_kw_ac")
    inverter_kva_per_kw_ac = _finite(
        program.get("inverter_apparent_power_kva_per_kw_ac"),
        "VEEC inverter apparent-power kVA per kW AC ratio",
    )
    inverter_capacity_kva = inverter_capacity_kw_ac * inverter_kva_per_kw_ac
    region = program.get("victoria_region")
    regional_factor = 0.98 if region == "metropolitan" else 1.04
    input_factor = 0.133 if capacity <= 100 else 0.25
    reasons: list[tuple[str, str]] = []
    if site_state_code != "VIC":
        reasons.append(
            (
                "vic_deemed_veec_site_outside_victoria",
                "Victorian deemed VEECs only apply to a confirmed Victorian site.",
            )
        )
    if capacity < 30 or capacity > 200:
        reasons.append(
            (
                "vic_deemed_veec_capacity_out_of_range",
                "Part 47 deemed VEECs require solar module capacity from 30 kW through 200 kW.",
            )
        )
    if inverter_capacity_kva < 30:
        reasons.append(
            (
                "vic_deemed_veec_inverter_below_30kva",
                "Part 47 deemed VEECs require at least 30 kVA of connected inverter capacity.",
            )
        )
    operands = {
        "system_capacity_kwp_dc": capacity,
        "connected_inverter_capacity_kw_ac": inverter_capacity_kw_ac,
        "inverter_apparent_power_kva_per_kw_ac": inverter_kva_per_kw_ac,
        "connected_inverter_capacity_kva": round(inverter_capacity_kva, 6),
        "input_factor": input_factor,
        "lifetime_years": 10.0,
        "victoria_region": region,
        "regional_factor": regional_factor,
    }
    if reasons:
        return _ineligible(
            "vic_deemed_veec",
            program,
            CI_VIC_DEEMED_VEEC_RULE_ID,
            reasons=reasons,
            operands=operands,
            rounding="floor_after_multiplication",
        )
    quantity = _floor_product(capacity, input_factor, 10, regional_factor)
    return _applied(
        "vic_deemed_veec",
        program,
        CI_VIC_DEEMED_VEEC_RULE_ID,
        quantity=quantity,
        operands=operands,
        rounding="floor_after_multiplication",
    )


def _disabled(
    program_id: str, program: dict[str, Any], rule_id: str
) -> dict[str, object]:
    return _program_result(
        program_id,
        status="disabled",
        reason_codes=["rebate_program_disabled"],
        reason_messages=["This rebate program is disabled in the approved project profile."],
        quantity=0,
        unit_price=float(program["certificate_price_aud_ex_gst"]),
        rebate=0,
        rule_id=rule_id,
        operands={},
        rounding="not_applicable",
        sources=_program_sources(program_id, program),
    )


def _ineligible(
    program_id: str,
    program: dict[str, Any],
    rule_id: str,
    *,
    reasons: list[tuple[str, str]],
    operands: dict[str, object],
    rounding: str,
) -> dict[str, object]:
    return _program_result(
        program_id,
        status="ineligible",
        reason_codes=[code for code, _message in reasons],
        reason_messages=[message for _code, message in reasons],
        quantity=0,
        unit_price=float(program["certificate_price_aud_ex_gst"]),
        rebate=0,
        rule_id=rule_id,
        operands=operands,
        rounding=rounding,
        sources=_program_sources(program_id, program),
    )


def _applied(
    program_id: str,
    program: dict[str, Any],
    rule_id: str,
    *,
    quantity: int,
    operands: dict[str, object],
    rounding: str,
) -> dict[str, object]:
    price = float(program["certificate_price_aud_ex_gst"])
    rebate = round(quantity * price, 2)
    return _program_result(
        program_id,
        status="applied",
        reason_codes=[],
        reason_messages=[],
        quantity=quantity,
        unit_price=price,
        rebate=rebate,
        rule_id=rule_id,
        operands=operands,
        rounding=rounding,
        sources=_program_sources(program_id, program),
    )


def _program_result(
    program_id: str,
    *,
    status: str,
    reason_codes: list[str],
    reason_messages: list[str],
    quantity: int,
    unit_price: float | None,
    rebate: float,
    rule_id: str,
    operands: dict[str, object],
    rounding: str,
    sources: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "program_id": program_id,
        "label": _PROGRAM_LABELS[program_id],
        "status": status,
        "reason_codes": reason_codes,
        "reason_messages": reason_messages,
        "certificate_quantity": quantity,
        "unit_price_aud_ex_gst": unit_price,
        "rebate_aud_ex_gst": rebate,
        "formula": {
            "rule_id": rule_id,
            "operands": operands,
            "rounding": rounding,
        },
        "sources": sources
        or {
            "eligibility_source_label": None,
            "price_source_label": None,
            "price_as_of_date": None,
        },
    }


def _program_sources(
    program_id: str, program: dict[str, Any]
) -> dict[str, object]:
    sources: dict[str, object] = {
        "eligibility_source_label": program["eligibility_source_label"],
        "price_source_label": program["price_source_label"],
        "price_as_of_date": program["price_as_of_date"],
    }
    if program_id == "solar_stc":
        sources["zone_source_label"] = program["zone_source_label"]
    elif program_id == "battery_stc":
        sources["capacity_source_label"] = program["capacity_source_label"]
    elif program_id == "vic_deemed_veec":
        sources["inverter_apparent_power_source_label"] = program[
            "inverter_apparent_power_source_label"
        ]
    return sources


def _result(
    scenario_id: str,
    *,
    programs: dict[str, dict[str, object]],
    target_date: str | None,
) -> dict[str, object]:
    return {
        "contract_version": CI_SCENARIO_REBATE_CALCULATION_CONTRACT_VERSION,
        "scenario_id": scenario_id,
        "ruleset_id": CI_REBATE_RULESET_ID,
        "ruleset_sha256": ci_rebate_ruleset_sha256(),
        "target_certificate_date": target_date,
        "programs": programs,
        "total_rebate_aud_ex_gst": round(
            sum(float(item["rebate_aud_ex_gst"]) for item in programs.values()),
            2,
        ),
        "eligibility_guaranteed": False,
        "customer_facing_permission": False,
    }


def _scenario_inputs(
    scenario: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    if not isinstance(scenario, dict) or not isinstance(
        scenario.get("scenario_id"), str
    ):
        raise _invalid("A rebate scenario identity is unavailable.")
    authored = scenario.get("authored_inputs")
    if not isinstance(authored, dict):
        authored = scenario
    return str(scenario["scenario_id"]), authored


def _validate_calculation_profile(profile: dict[str, Any]) -> None:
    if not isinstance(profile, dict) or set(profile) != _CALCULATION_PROFILE_KEYS:
        raise _invalid("The approved rebate calculation profile is unavailable or stale.")
    if (
        profile.get("contract_version")
        != CI_PROJECT_REBATE_CALCULATION_PROFILE_CONTRACT_VERSION
        or not _sha256(profile.get("source_profile_sha256"))
        or profile.get("ruleset_id") != CI_REBATE_RULESET_ID
        or profile.get("ruleset_sha256") != ci_rebate_ruleset_sha256()
    ):
        raise _invalid("The approved rebate calculation profile is unavailable or stale.")

    editable_profile = {
        "contract_version": CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION,
        "target_certificate_date": profile.get("target_certificate_date"),
        "site_state_code": profile.get("site_state_code"),
        "site_postcode": profile.get("site_postcode"),
        "site_location_confirmed": True,
        "site_location_source_label": profile.get("site_location_source_label"),
        "stacking_confirmed": profile.get("stacking_confirmed"),
        "programs": profile.get("programs"),
    }
    try:
        normalized = validate_ci_project_rebate_profile(editable_profile)
    except CiProjectError as exc:
        raise _invalid(
            "The approved rebate calculation profile contains invalid project evidence."
        ) from exc
    if (
        profile.get("target_certificate_date")
        != normalized["target_certificate_date"]
        or profile.get("site_state_code") != normalized["site_state_code"]
        or profile.get("site_postcode") != normalized["site_postcode"]
        or profile.get("site_location_source_label")
        != normalized["site_location_source_label"]
        or profile.get("stacking_confirmed") != normalized["stacking_confirmed"]
        or profile.get("programs") != normalized["programs"]
    ):
        raise _invalid(
            "The approved rebate calculation profile is not a canonical evidence snapshot."
        )

    programs = normalized["programs"]
    assert isinstance(programs, dict)
    enabled = {
        program_id: program
        for program_id, program in programs.items()
        if isinstance(program, dict) and program.get("enabled") is True
    }
    for key in _BINDING_KEYS:
        value = profile.get(key)
        if value is not None and not _sha256(value):
            raise _invalid("The approved rebate calculation binding is invalid.")
        if enabled and value is None:
            raise _invalid("The approved rebate calculation binding is incomplete.")

    if not enabled:
        return
    if (
        canonical_sha256(normalized) != profile["source_profile_sha256"]
        or not normalized["site_state_code"]
        or not normalized["site_postcode"]
        or not _non_empty_label(normalized["site_location_source_label"])
        or (len(enabled) > 1 and normalized["stacking_confirmed"] is not True)
    ):
        raise _invalid("The approved rebate calculation source evidence is invalid.")

    target = date.fromisoformat(str(normalized["target_certificate_date"]))
    sydney_today = datetime.now(ZoneInfo("Australia/Sydney")).date()
    for program_id, program in enabled.items():
        if (
            program.get("eligibility_confirmed") is not True
            or not _non_empty_label(program.get("eligibility_source_label"))
            or _finite(program.get("certificate_price_aud_ex_gst"), "Certificate price")
            <= 0
            or not _non_empty_label(program.get("price_source_label"))
            or date.fromisoformat(str(program.get("price_as_of_date")))
            > sydney_today
        ):
            raise _invalid("The approved rebate calculation source evidence is incomplete.")
        if program_id == "solar_stc":
            if (
                solar_stc_deeming_years(target) is None
                or program.get("postcode_zone_rating") is None
                or not _non_empty_label(program.get("zone_source_label"))
            ):
                raise _invalid("The approved Solar STC evidence is incomplete or stale.")
        elif program_id == "battery_stc":
            if (
                battery_stc_factor(target) is None
                or program.get("certified_usable_capacity_fraction") is None
                or not _non_empty_label(program.get("capacity_source_label"))
            ):
                raise _invalid("The approved battery STC evidence is incomplete or stale.")
        elif (
            normalized["site_state_code"] != "VIC"
            or not vic_deemed_veec_rules_available(target)
            or program.get("victoria_region") not in {"metropolitan", "regional"}
            or program.get("inverter_apparent_power_kva_per_kw_ac") is None
            or not _non_empty_label(
                program.get("inverter_apparent_power_source_label")
            )
        ):
            raise _invalid("The approved Victorian deemed VEEC evidence is incomplete or stale.")


def _sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _non_empty_label(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _rule_ids() -> dict[str, str]:
    return {
        "solar_stc": CI_SOLAR_STC_RULE_ID,
        "battery_stc": CI_BATTERY_STC_RULE_ID,
        "vic_deemed_veec": CI_VIC_DEEMED_VEEC_RULE_ID,
    }


def _number(value: dict[str, Any], key: str) -> float:
    return _finite(value.get(key), f"Scenario {key}")


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise _invalid(f"{label} is invalid.")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise _invalid(f"{label} is invalid.") from exc
    if not math.isfinite(result):
        raise _invalid(f"{label} is invalid.")
    return result


def _floor_product(*values: float | int) -> int:
    product = Decimal("1")
    for value in values:
        product *= Decimal(str(value))
    return int(product.to_integral_value(rounding=ROUND_FLOOR))


def _invalid(message: str) -> CiProjectError:
    return CiProjectError("ci_rebate_calculation_invalid", message)

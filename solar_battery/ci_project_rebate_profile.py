from __future__ import annotations

from datetime import date, datetime, timezone
import json
import math
import re
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select

from solar_battery.ci_device_profile import (
    ci_device_profile_state,
    compatible_device_profile_sha256s,
    device_profile_sha256,
)
from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_projects import CiProjectError, require_ci_project
from solar_battery.ci_rebate_rules import (
    CI_REBATE_RULESET_ID,
    CI_SOLAR_STC_ZONE_RATINGS,
    battery_stc_factor,
    ci_rebate_ruleset_metadata,
    ci_rebate_ruleset_sha256,
    solar_stc_deeming_years,
    vic_deemed_veec_rules_available,
)
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import (
    CiProjectEvidenceModel,
    CiProjectModel,
    CiProjectRebateProfileModel,
)


CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION = "ci_project_rebate_profile_v1"
CI_PROJECT_REBATE_PROFILE_STATE_CONTRACT_VERSION = (
    "ci_project_rebate_profile_state_v1"
)
CI_PROJECT_REBATE_CALCULATION_PROFILE_CONTRACT_VERSION = (
    "ci_project_rebate_calculation_profile_v1"
)

_ROOT_KEYS = {
    "contract_version",
    "target_certificate_date",
    "site_state_code",
    "site_postcode",
    "site_location_confirmed",
    "site_location_source_label",
    "stacking_confirmed",
    "programs",
}
_PROGRAM_KEYS = {"solar_stc", "battery_stc", "vic_deemed_veec"}
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
_COMMON_PROGRAM_KEYS = {
    "enabled",
    "eligibility_confirmed",
    "eligibility_source_label",
    "certificate_price_aud_ex_gst",
    "price_source_label",
    "price_as_of_date",
}
_PROGRAM_EXTRA_KEYS = {
    "solar_stc": {"postcode_zone_rating", "zone_source_label"},
    "battery_stc": {
        "certified_usable_capacity_fraction",
        "capacity_source_label",
    },
    "vic_deemed_veec": {
        "victoria_region",
        "inverter_apparent_power_kva_per_kw_ac",
        "inverter_apparent_power_source_label",
    },
}
_STATE_CODES = {"NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"}
_ADDRESS_STATE_POSTCODE = re.compile(
    r"\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b[\s,]+(\d{4})\b", re.IGNORECASE
)


def ci_project_rebate_profile_state(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
) -> dict[str, object]:
    project = require_ci_project(session, project_id=project_id, actor=actor)
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    binding = _current_rebate_binding(session, project=project, actor=actor)
    suggestion = _suggested_profile(evidence)
    row = _profile_row(session, project_id=project_id, actor=actor)
    if row is None:
        return _state(
            status="not_configured",
            row=None,
            profile=None,
            suggested_profile=suggestion,
            site_evidence=_site_evidence(evidence),
            blockers=[],
        )

    _verify_row_integrity(row)
    profile = json.loads(json.dumps(row.profile_json))
    stale = (
        row.site_evidence_sha256 != _site_evidence_sha256(evidence)
        or row.ruleset_id != CI_REBATE_RULESET_ID
        or row.ruleset_sha256 != ci_rebate_ruleset_sha256()
        or (
            row.approval_status == "approved"
            and rebate_profile_has_enabled_program(profile)
            and not _calculation_profile_matches_binding(
                row.calculation_profile_json, binding
            )
        )
    )
    status = "stale" if stale else row.approval_status
    blockers: list[dict[str, str]] = []
    if rebate_profile_has_enabled_program(profile):
        if stale:
            blockers.append(
                _blocker(
                    "rebate_profile_stale",
                    "The saved rebate profile belongs to changed site, design, equipment or rebate-rule evidence. Review and approve it again.",
                )
            )
        elif row.approval_status != "approved":
            blockers.extend(
                _approval_blockers(profile, evidence=evidence, binding=binding)
            )
            blockers.append(
                _blocker(
                    "rebate_profile_approval_required",
                    "Review and approve the enabled rebate programs before running Finance Analysis.",
                )
            )
    return _state(
        status=status,
        row=row,
        profile=profile,
        suggested_profile=suggestion,
        site_evidence=_site_evidence(evidence),
        blockers=_deduplicated_blockers(blockers),
    )


def save_ci_project_rebate_profile(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    profile: dict[str, object],
    approve_for_calculation: bool,
) -> dict[str, object]:
    project = _lock_rebate_scope(
        session, project_id=project_id, actor=actor
    )
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    binding = _current_rebate_binding(session, project=project, actor=actor)
    normalized = validate_ci_project_rebate_profile(profile)
    calculation_profile: dict[str, object] | None = None
    calculation_digest: str | None = None
    if approve_for_calculation:
        blockers = _approval_blockers(
            normalized, evidence=evidence, binding=binding
        )
        if blockers:
            first = blockers[0]
            raise CiProjectError(str(first["code"]), str(first["message"]))
        calculation_profile = _calculation_profile(normalized, binding=binding)
        calculation_digest = canonical_sha256(calculation_profile)

    now = datetime.now(timezone.utc)
    profile_digest = canonical_sha256(normalized)
    site_digest = _site_evidence_sha256(evidence)
    row = _profile_row(session, project_id=project_id, actor=actor)
    if row is None:
        row = CiProjectRebateProfileModel(
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            profile_contract_version=CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION,
            approval_status="approved" if approve_for_calculation else "draft",
            site_evidence_sha256=site_digest,
            ruleset_id=CI_REBATE_RULESET_ID,
            ruleset_sha256=ci_rebate_ruleset_sha256(),
            profile_sha256=profile_digest,
            profile_json=normalized,
            calculation_profile_sha256=calculation_digest,
            calculation_profile_json=calculation_profile,
            approved_by_actor_id=actor.actor_id if approve_for_calculation else None,
            approved_at=now if approve_for_calculation else None,
            created_by_actor_id=actor.actor_id,
            updated_by_actor_id=actor.actor_id,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        row.profile_contract_version = CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION
        row.approval_status = "approved" if approve_for_calculation else "draft"
        row.site_evidence_sha256 = site_digest
        row.ruleset_id = CI_REBATE_RULESET_ID
        row.ruleset_sha256 = ci_rebate_ruleset_sha256()
        row.profile_sha256 = profile_digest
        row.profile_json = normalized
        row.calculation_profile_sha256 = calculation_digest
        row.calculation_profile_json = calculation_profile
        row.approved_by_actor_id = actor.actor_id if approve_for_calculation else None
        row.approved_at = now if approve_for_calculation else None
        row.updated_by_actor_id = actor.actor_id
        row.updated_at = now
    session.flush()
    blockers = []
    if not approve_for_calculation and rebate_profile_has_enabled_program(normalized):
        blockers = _approval_blockers(
            normalized, evidence=evidence, binding=binding
        )
        blockers.append(
            _blocker(
                "rebate_profile_approval_required",
                "Review and approve the enabled rebate programs before running Finance Analysis.",
            )
        )
    return _state(
        status=row.approval_status,
        row=row,
        profile=json.loads(json.dumps(normalized)),
        suggested_profile=_suggested_profile(evidence),
        site_evidence=_site_evidence(evidence),
        blockers=_deduplicated_blockers(blockers),
    )


def save_ci_project_stc_settings(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    solar_stc_enabled: bool,
    solar_stc_price_aud_ex_gst: float,
    battery_stc_enabled: bool,
    battery_stc_price_aud_ex_gst: float,
) -> dict[str, object]:
    """Persist the compact STC UI as a complete, auditable calculation profile.

    The UI intentionally exposes only inclusion and price. Python supplies the
    calculation-only operands from current project evidence and the selected
    device profile, and keeps VEEC outside this simplified workflow.
    """
    project = require_ci_project(session, project_id=project_id, actor=actor)
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    row = _profile_row(session, project_id=project_id, actor=actor)
    if row is not None:
        _verify_row_integrity(row)
        profile = json.loads(json.dumps(row.profile_json))
    else:
        profile = _suggested_profile(evidence)
    saved_site_matches = (
        row is not None
        and row.site_evidence_sha256 == _site_evidence_sha256(evidence)
    )

    today = _sydney_today().isoformat()
    state_code, postcode = _state_postcode(_site_address(evidence))
    has_site_evidence = state_code is not None and postcode is not None
    profile.update(
        {
            "target_certificate_date": today,
            "site_state_code": state_code or "",
            "site_postcode": postcode or "",
            "site_location_confirmed": has_site_evidence,
            "site_location_source_label": (
                "Detected supply/site address in current bill Evidence"
                if has_site_evidence
                else ""
            ),
            "stacking_confirmed": solar_stc_enabled and battery_stc_enabled,
        }
    )

    programs = profile["programs"]
    assert isinstance(programs, dict)
    solar = programs["solar_stc"]
    battery = programs["battery_stc"]
    veec = programs["vic_deemed_veec"]
    assert isinstance(solar, dict)
    assert isinstance(battery, dict)
    assert isinstance(veec, dict)
    analyst_source = "Analyst-confirmed in simplified STC settings"
    price_source = "Analyst-entered certificate price in simplified STC settings"

    solar.update(
        {
            "enabled": solar_stc_enabled,
            "eligibility_confirmed": solar_stc_enabled,
            "eligibility_source_label": analyst_source if solar_stc_enabled else "",
            "certificate_price_aud_ex_gst": solar_stc_price_aud_ex_gst,
            "price_source_label": price_source if solar_stc_enabled else "",
            "price_as_of_date": today,
            # The compact workflow uses the lowest STC zone multiplier when no
            # previously reviewed zone is available. This understates rather
            # than overstates the screening deduction.
            "postcode_zone_rating": (
                solar.get("postcode_zone_rating")
                if saved_site_matches
                and solar.get("postcode_zone_rating") is not None
                else min(CI_SOLAR_STC_ZONE_RATINGS)
            ),
            "zone_source_label": (
                str(solar.get("zone_source_label") or "")
                if saved_site_matches and solar.get("zone_source_label")
                else "Conservative Zone 4 screening assumption"
            ),
        }
    )
    battery_fraction, battery_source = _selected_battery_usable_fraction(
        session,
        project=project,
        actor=actor,
    )
    battery.update(
        {
            "enabled": battery_stc_enabled,
            "eligibility_confirmed": battery_stc_enabled,
            "eligibility_source_label": analyst_source if battery_stc_enabled else "",
            "certificate_price_aud_ex_gst": battery_stc_price_aud_ex_gst,
            "price_source_label": price_source if battery_stc_enabled else "",
            "price_as_of_date": today,
            "certified_usable_capacity_fraction": (
                battery_fraction
                if battery_fraction is not None
                else battery.get("certified_usable_capacity_fraction")
            ),
            "capacity_source_label": (
                battery_source
                or str(battery.get("capacity_source_label") or "")
            ),
        }
    )
    veec["enabled"] = False
    veec["eligibility_confirmed"] = False
    veec["eligibility_source_label"] = ""

    return save_ci_project_rebate_profile(
        session,
        project_id=project_id,
        actor=actor,
        profile=profile,
        approve_for_calculation=True,
    )


def approved_ci_project_rebate_calculation_profile(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    for_update: bool = False,
) -> dict[str, object] | None:
    project = (
        _lock_rebate_scope(session, project_id=project_id, actor=actor)
        if for_update
        else require_ci_project(session, project_id=project_id, actor=actor)
    )
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    binding = _current_rebate_binding(session, project=project, actor=actor)
    row = _profile_row(
        session,
        project_id=project_id,
        actor=actor,
        for_update=for_update,
    )
    if (
        row is None
        or row.approval_status != "approved"
        or row.site_evidence_sha256 != _site_evidence_sha256(evidence)
        or row.ruleset_id != CI_REBATE_RULESET_ID
        or row.ruleset_sha256 != ci_rebate_ruleset_sha256()
        or (
            rebate_profile_has_enabled_program(row.profile_json)
            and not _calculation_profile_matches_binding(
                row.calculation_profile_json, binding
            )
        )
    ):
        return None
    _verify_row_integrity(row)
    if row.calculation_profile_json is None or row.calculation_profile_sha256 is None:
        return None
    return json.loads(json.dumps(row.calculation_profile_json))


def rebate_calculation_profile_sha256(profile: dict[str, object]) -> str:
    return canonical_sha256(profile)


def rebate_profile_has_enabled_program(profile: object) -> bool:
    if not isinstance(profile, dict):
        return False
    programs = profile.get("programs")
    return isinstance(programs, dict) and any(
        isinstance(programs.get(program_id), dict)
        and programs[program_id].get("enabled") is True
        for program_id in _PROGRAM_KEYS
    )


def validate_ci_project_rebate_profile(
    profile: dict[str, object],
) -> dict[str, object]:
    if not isinstance(profile, dict) or set(profile) != _ROOT_KEYS:
        raise _invalid("The project rebate profile has unsupported or missing fields.")
    if profile.get("contract_version") != CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION:
        raise _invalid("The project rebate profile contract is not supported.")
    target = _iso_date(profile.get("target_certificate_date"), "target certificate date")
    state_code = profile.get("site_state_code")
    postcode = profile.get("site_postcode")
    if not isinstance(state_code, str) or (
        state_code != "" and state_code not in _STATE_CODES
    ):
        raise _invalid("The site state must be a supported Australian state code.")
    if not isinstance(postcode, str) or (
        postcode != "" and re.fullmatch(r"\d{4}", postcode) is None
    ):
        raise _invalid("The site postcode must contain exactly four digits.")
    if not isinstance(profile.get("site_location_confirmed"), bool) or not isinstance(
        profile.get("stacking_confirmed"), bool
    ):
        raise _invalid("The project rebate confirmations must be true or false.")
    programs = profile.get("programs")
    if not isinstance(programs, dict) or set(programs) != _PROGRAM_KEYS:
        raise _invalid("Solar STC, battery STC and Victorian deemed VEEC settings are required.")
    normalized_programs = {
        program_id: _program(program_id, programs.get(program_id))
        for program_id in sorted(_PROGRAM_KEYS)
    }
    return {
        "contract_version": CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION,
        "target_certificate_date": target.isoformat(),
        "site_state_code": state_code,
        "site_postcode": postcode,
        "site_location_confirmed": profile["site_location_confirmed"],
        "site_location_source_label": _label(
            profile.get("site_location_source_label"), allow_empty=True
        ),
        "stacking_confirmed": profile["stacking_confirmed"],
        "programs": normalized_programs,
    }


def _program(program_id: str, value: object) -> dict[str, object]:
    expected = _COMMON_PROGRAM_KEYS | _PROGRAM_EXTRA_KEYS[program_id]
    if not isinstance(value, dict) or set(value) != expected:
        raise _invalid(f"The {program_id} profile has unsupported or missing fields.")
    if not isinstance(value.get("enabled"), bool) or not isinstance(
        value.get("eligibility_confirmed"), bool
    ):
        raise _invalid(f"The {program_id} switches must be true or false.")
    normalized: dict[str, object] = {
        "enabled": value["enabled"],
        "eligibility_confirmed": value["eligibility_confirmed"],
        "eligibility_source_label": _label(
            value.get("eligibility_source_label"), allow_empty=True
        ),
        "certificate_price_aud_ex_gst": _bounded_number(
            value.get("certificate_price_aud_ex_gst"),
            minimum=0,
            maximum=1_000_000,
            label=f"{program_id} certificate price",
        ),
        "price_source_label": _label(
            value.get("price_source_label"), allow_empty=True
        ),
        "price_as_of_date": _iso_date(
            value.get("price_as_of_date"), f"{program_id} price date"
        ).isoformat(),
    }
    if program_id == "solar_stc":
        rating = value.get("postcode_zone_rating")
        if rating is not None:
            rating = _bounded_number(
                rating,
                minimum=min(CI_SOLAR_STC_ZONE_RATINGS),
                maximum=max(CI_SOLAR_STC_ZONE_RATINGS),
                label="solar STC postcode zone rating",
            )
            if not any(
                math.isclose(rating, allowed, rel_tol=0, abs_tol=1e-9)
                for allowed in CI_SOLAR_STC_ZONE_RATINGS
            ):
                raise _invalid("The solar STC postcode zone rating is not supported.")
        normalized.update(
            {
                "postcode_zone_rating": rating,
                "zone_source_label": _label(
                    value.get("zone_source_label"), allow_empty=True
                ),
            }
        )
    elif program_id == "battery_stc":
        fraction = value.get("certified_usable_capacity_fraction")
        if fraction is not None:
            fraction = _bounded_number(
                fraction,
                minimum=1e-12,
                maximum=1,
                label="certified usable capacity fraction",
            )
        normalized.update(
            {
                "certified_usable_capacity_fraction": fraction,
                "capacity_source_label": _label(
                    value.get("capacity_source_label"), allow_empty=True
                ),
            }
        )
    else:
        region = value.get("victoria_region")
        if region not in {None, "metropolitan", "regional"}:
            raise _invalid("The Victorian location must be metropolitan or regional.")
        kva_ratio = value.get("inverter_apparent_power_kva_per_kw_ac")
        if kva_ratio is not None:
            kva_ratio = _bounded_number(
                kva_ratio,
                minimum=1,
                maximum=10,
                label="inverter apparent-power kVA per kW AC ratio",
            )
        normalized.update(
            {
                "victoria_region": region,
                "inverter_apparent_power_kva_per_kw_ac": kva_ratio,
                "inverter_apparent_power_source_label": _label(
                    value.get("inverter_apparent_power_source_label"),
                    allow_empty=True,
                ),
            }
        )
    return normalized


def _approval_blockers(
    profile: dict[str, Any],
    *,
    evidence: CiProjectEvidenceModel | None,
    binding: dict[str, str | None],
) -> list[dict[str, str]]:
    enabled_count = sum(
        1 for item in profile["programs"].values() if item["enabled"] is True
    )
    if enabled_count == 0:
        return []
    blockers: list[dict[str, str]] = []
    if binding["design_candidates_sha256"] is None or binding[
        "design_context_sha256"
    ] is None:
        blockers.append(
            _blocker(
                "rebate_design_evidence_required",
                "Generate and save the current solution space before approving rebate assumptions.",
            )
        )
    if binding["device_profile_sha256"] is None:
        blockers.append(
            _blocker(
                "rebate_device_profile_required",
                "Save the current workspace Device profile before approving rebate assumptions.",
            )
        )
    evidence_state, evidence_postcode = _state_postcode(_site_address(evidence))
    if evidence_state is None or evidence_postcode is None:
        blockers.append(
            _blocker(
                "rebate_site_evidence_required",
                "A labelled Australian site address with state and postcode is required in the current bill Evidence.",
            )
        )
    elif (
        profile["site_state_code"] != evidence_state
        or profile["site_postcode"] != evidence_postcode
    ):
        blockers.append(
            _blocker(
                "rebate_site_evidence_mismatch",
                "The rebate site state and postcode must match the current bill Evidence.",
            )
        )
    if profile.get("site_location_confirmed") is not True or not profile.get(
        "site_location_source_label"
    ):
        blockers.append(
            _blocker(
                "rebate_site_confirmation_required",
                "Confirm the rebate site location and record its evidence source.",
            )
        )

    target = date.fromisoformat(str(profile["target_certificate_date"]))
    if enabled_count > 1 and profile.get("stacking_confirmed") is not True:
        blockers.append(
            _blocker(
                "rebate_stacking_confirmation_required",
                "Confirm the enabled rebate combination can be claimed together before applying a combined upfront deduction.",
            )
        )
    for program_id, program in profile["programs"].items():
        if program["enabled"] is not True:
            continue
        if program["eligibility_confirmed"] is not True or not program[
            "eligibility_source_label"
        ]:
            blockers.append(
                _blocker(
                    f"{program_id}_eligibility_confirmation_required",
                    f"Confirm {program_id.replace('_', ' ')} eligibility and record its source.",
                )
            )
        if program["certificate_price_aud_ex_gst"] <= 0 or not program[
            "price_source_label"
        ]:
            blockers.append(
                _blocker(
                    f"{program_id}_price_source_required",
                    f"Enter a positive ex-GST certificate price for {program_id.replace('_', ' ')} and record its source.",
                )
            )
        if date.fromisoformat(str(program["price_as_of_date"])) > _sydney_today():
            blockers.append(
                _blocker(
                    f"{program_id}_price_date_invalid",
                    f"The {program_id.replace('_', ' ')} price date cannot be in the future.",
                )
            )
        if program_id == "solar_stc":
            if solar_stc_deeming_years(target) is None:
                blockers.append(
                    _blocker(
                        "solar_stc_rules_unavailable",
                        "The active Solar STC rule set supports target dates from 2026 through 2030 only.",
                    )
                )
            if program["postcode_zone_rating"] is None or not program[
                "zone_source_label"
            ]:
                blockers.append(
                    _blocker(
                        "solar_stc_zone_evidence_required",
                        "Select the official CER postcode zone rating and record its source.",
                    )
                )
        elif program_id == "battery_stc":
            if battery_stc_factor(target) is None:
                blockers.append(
                    _blocker(
                        "battery_stc_rules_unavailable",
                        "The active battery STC rule set supports target dates from 1 July 2025 through 2030 only.",
                    )
                )
            if program["certified_usable_capacity_fraction"] is None or not program[
                "capacity_source_label"
            ]:
                blockers.append(
                    _blocker(
                        "battery_stc_capacity_evidence_required",
                        "Enter the certified usable-to-nominal capacity fraction and record its product evidence source.",
                    )
                )
        else:
            if profile["site_state_code"] != "VIC":
                blockers.append(
                    _blocker(
                        "vic_deemed_veec_site_ineligible",
                        "Victorian deemed VEECs can only be modelled for a confirmed Victorian site.",
                    )
                )
            if not vic_deemed_veec_rules_available(target):
                blockers.append(
                    _blocker(
                        "vic_deemed_veec_rules_unavailable",
                        "The current Part 47 V25 rule snapshot supports target dates from 21 July through 31 December 2026 only.",
                    )
                )
            if program["victoria_region"] not in {"metropolitan", "regional"}:
                blockers.append(
                    _blocker(
                        "vic_deemed_veec_region_required",
                        "Select the official Victorian metropolitan or regional postcode classification.",
                    )
                )
            if (
                program["inverter_apparent_power_kva_per_kw_ac"] is None
                or not program["inverter_apparent_power_source_label"]
            ):
                blockers.append(
                    _blocker(
                        "vic_deemed_veec_inverter_kva_evidence_required",
                        "Enter the approved inverter apparent-power kVA per kW AC ratio and record its datasheet or connection-contract source.",
                    )
                )
    return _deduplicated_blockers(blockers)


def _calculation_profile(
    profile: dict[str, object], *, binding: dict[str, str | None]
) -> dict[str, object]:
    return {
        "contract_version": CI_PROJECT_REBATE_CALCULATION_PROFILE_CONTRACT_VERSION,
        "source_profile_sha256": canonical_sha256(profile),
        "ruleset_id": CI_REBATE_RULESET_ID,
        "ruleset_sha256": ci_rebate_ruleset_sha256(),
        **binding,
        "target_certificate_date": profile["target_certificate_date"],
        "site_state_code": profile["site_state_code"],
        "site_postcode": profile["site_postcode"],
        "site_location_source_label": profile["site_location_source_label"],
        "stacking_confirmed": profile["stacking_confirmed"],
        "programs": json.loads(json.dumps(profile["programs"])),
    }


def _suggested_profile(
    evidence: CiProjectEvidenceModel | None,
) -> dict[str, object]:
    state_code, postcode = _state_postcode(_site_address(evidence))
    today = _sydney_today().isoformat()
    common_stc = {
        "enabled": False,
        "eligibility_confirmed": False,
        "eligibility_source_label": "",
        "certificate_price_aud_ex_gst": 39.0,
        "price_source_label": "",
        "price_as_of_date": today,
    }
    return {
        "contract_version": CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION,
        "target_certificate_date": today,
        "site_state_code": state_code or "",
        "site_postcode": postcode or "",
        "site_location_confirmed": False,
        "site_location_source_label": (
            "Detected supply/site address in current bill Evidence"
            if state_code is not None and postcode is not None
            else ""
        ),
        "stacking_confirmed": False,
        "programs": {
            "solar_stc": {
                **common_stc,
                "postcode_zone_rating": None,
                "zone_source_label": "",
            },
            "battery_stc": {
                **common_stc,
                "certified_usable_capacity_fraction": None,
                "capacity_source_label": "",
            },
            "vic_deemed_veec": {
                "enabled": False,
                "eligibility_confirmed": False,
                "eligibility_source_label": "",
                "certificate_price_aud_ex_gst": 70.0,
                "price_source_label": "",
                "price_as_of_date": today,
                "victoria_region": None,
                "inverter_apparent_power_kva_per_kw_ac": None,
                "inverter_apparent_power_source_label": "",
            },
        },
    }


def _state(
    *,
    status: str,
    row: CiProjectRebateProfileModel | None,
    profile: dict[str, object] | None,
    suggested_profile: dict[str, object],
    site_evidence: dict[str, object],
    blockers: list[dict[str, str]],
) -> dict[str, object]:
    return {
        "contract_version": CI_PROJECT_REBATE_PROFILE_STATE_CONTRACT_VERSION,
        "status": status,
        "updated_at": row.updated_at.isoformat() if row is not None else None,
        "approved_at": (
            row.approved_at.isoformat()
            if row is not None and row.approved_at is not None
            else None
        ),
        "profile_sha256": row.profile_sha256 if row is not None else None,
        "profile": profile,
        "suggested_profile": suggested_profile,
        "site_evidence": site_evidence,
        "blockers": blockers,
        "ruleset": ci_rebate_ruleset_metadata(),
    }


def _verify_row_integrity(row: CiProjectRebateProfileModel) -> None:
    normalized_profile = validate_ci_project_rebate_profile(row.profile_json)
    valid = (
        row.profile_contract_version == CI_PROJECT_REBATE_PROFILE_CONTRACT_VERSION
        and row.approval_status in {"draft", "approved"}
        and normalized_profile == row.profile_json
        and canonical_sha256(normalized_profile) == row.profile_sha256
        and isinstance(row.ruleset_id, str)
        and bool(row.ruleset_id)
        and _sha256(row.ruleset_sha256)
    )
    if row.approval_status == "approved":
        calculation = row.calculation_profile_json
        binding = _binding_from_calculation_profile(calculation)
        valid = bool(
            valid
            and isinstance(calculation, dict)
            and set(calculation) == _CALCULATION_PROFILE_KEYS
            and row.calculation_profile_sha256 is not None
            and calculation.get("contract_version")
            == CI_PROJECT_REBATE_CALCULATION_PROFILE_CONTRACT_VERSION
            and calculation.get("source_profile_sha256") == row.profile_sha256
            and calculation.get("ruleset_id") == row.ruleset_id
            and calculation.get("ruleset_sha256") == row.ruleset_sha256
            and calculation.get("target_certificate_date")
            == normalized_profile["target_certificate_date"]
            and calculation.get("site_state_code")
            == normalized_profile["site_state_code"]
            and calculation.get("site_postcode")
            == normalized_profile["site_postcode"]
            and calculation.get("site_location_source_label")
            == normalized_profile["site_location_source_label"]
            and calculation.get("stacking_confirmed")
            == normalized_profile["stacking_confirmed"]
            and calculation.get("programs") == normalized_profile["programs"]
            and binding is not None
            and canonical_sha256(calculation)
            == row.calculation_profile_sha256
            and (
                not rebate_profile_has_enabled_program(normalized_profile)
                or all(value is not None for value in binding.values())
            )
        )
    if not valid:
        raise CiProjectError(
            "ci_project_rebate_profile_integrity_failed",
            "The saved project rebate profile failed its integrity check.",
        )


def _profile_row(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    for_update: bool = False,
):
    statement = select(CiProjectRebateProfileModel).where(
            CiProjectRebateProfileModel.project_id == project_id,
            CiProjectRebateProfileModel.workspace_id == actor.workspace_id,
            CiProjectRebateProfileModel.owner_id == actor.owner_id,
        )
    if for_update:
        statement = statement.with_for_update()
    return session.scalar(statement)


def _lock_rebate_scope(
    session, *, project_id: UUID, actor: LocalActorContext
) -> CiProjectModel:
    project = session.scalar(
        select(CiProjectModel)
        .where(
            CiProjectModel.id == project_id,
            CiProjectModel.workspace_id == actor.workspace_id,
            CiProjectModel.owner_id == actor.owner_id,
        )
        .with_for_update()
    )
    if project is None:
        raise CiProjectError(
            "ci_project_not_found",
            "The requested C&I project does not exist in this workspace.",
        )
    return project


def _current_rebate_binding(
    session, *, project: CiProjectModel, actor: LocalActorContext
) -> dict[str, str | None]:
    candidates = project.design_candidates_json
    context = project.design_context_json
    device_state = ci_device_profile_state(session, actor=actor)
    device_profile = (
        device_state.get("profile")
        if device_state.get("status") == "ready"
        else None
    )
    current_device_digest = (
        device_profile_sha256(device_profile)
        if isinstance(device_profile, dict)
        else None
    )
    try:
        compatible_device_digests = (
            compatible_device_profile_sha256s(device_profile)
            if isinstance(device_profile, dict)
            else frozenset()
        )
    except CiProjectError:
        # The real device-profile state is already validated.  Preserve the
        # historical exact-digest behavior for isolated callers/test doubles,
        # but never grant them predecessor compatibility.
        compatible_device_digests = (
            frozenset({current_device_digest})
            if current_device_digest is not None
            else frozenset()
        )
    context_selection = (
        context.get("profile_selection")
        if isinstance(context, dict)
        and context.get("contract_version") == "ci_design_context_v2"
        else None
    )
    context_device_digest = (
        context_selection.get("device_profile_sha256")
        if isinstance(context_selection, dict)
        else None
    )
    context_matches_device = (
        isinstance(context_selection, dict)
        and current_device_digest is not None
        and isinstance(context_device_digest, str)
        and context_device_digest in compatible_device_digests
    )
    return {
        "design_candidates_sha256": (
            canonical_sha256(list(candidates))
            if isinstance(candidates, list) and candidates
            else None
        ),
        "design_context_sha256": (
            canonical_sha256(dict(context))
            if isinstance(context, dict) and context and context_matches_device
            else None
        ),
        "device_profile_sha256": (
            str(context_device_digest)
            if context_matches_device
            else current_device_digest
        ),
    }


def _selected_battery_usable_fraction(
    session,
    *,
    project: CiProjectModel,
    actor: LocalActorContext,
) -> tuple[float | None, str]:
    state = ci_device_profile_state(session, actor=actor)
    device_profile = state.get("profile") if state.get("status") == "ready" else None
    context = project.design_context_json
    selection = (
        context.get("profile_selection")
        if isinstance(context, dict)
        else None
    )
    solution_profiles = (
        device_profile.get("solution_profiles")
        if isinstance(device_profile, dict)
        else None
    )
    battery_profiles = (
        solution_profiles.get("battery_profiles")
        if isinstance(solution_profiles, dict)
        else None
    )
    selected_id = (
        selection.get("battery_profile_id")
        if isinstance(selection, dict)
        else None
    )
    if not isinstance(battery_profiles, list) or not isinstance(selected_id, str):
        return None, ""
    selected = next(
        (
            item
            for item in battery_profiles
            if isinstance(item, dict) and item.get("profile_id") == selected_id
        ),
        None,
    )
    if not isinstance(selected, dict):
        return None, ""
    depth = selected.get("usable_depth_of_discharge_percent")
    if not isinstance(depth, (int, float)) or isinstance(depth, bool):
        return None, ""
    source = str(selected.get("source_label") or selected.get("name") or "").strip()
    if not source:
        return None, ""
    return float(depth) / 100.0, f"Selected battery profile: {source}"


def _binding_from_calculation_profile(
    value: object,
) -> dict[str, str | None] | None:
    if not isinstance(value, dict):
        return None
    binding: dict[str, str | None] = {}
    for key in (
        "design_candidates_sha256",
        "design_context_sha256",
        "device_profile_sha256",
    ):
        item = value.get(key)
        if item is not None and not _sha256(item):
            return None
        binding[key] = item
    return binding


def _calculation_profile_matches_binding(
    value: object, binding: dict[str, str | None]
) -> bool:
    stored = _binding_from_calculation_profile(value)
    return stored is not None and stored == binding


def _sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _evidence_row(session, *, project_id: UUID, actor: LocalActorContext):
    return session.scalar(
        select(CiProjectEvidenceModel).where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
        )
    )


def _site_address(evidence: CiProjectEvidenceModel | None) -> str | None:
    inspection = evidence.inspection_result_json if evidence is not None else None
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    address = bill.get("site_address") if isinstance(bill, dict) else None
    return address.strip() if isinstance(address, str) and address.strip() else None


def _state_postcode(address: str | None) -> tuple[str | None, str | None]:
    match = _ADDRESS_STATE_POSTCODE.search(address or "")
    return (
        (match.group(1).upper(), match.group(2))
        if match is not None
        else (None, None)
    )


def _site_evidence_sha256(evidence: CiProjectEvidenceModel | None) -> str:
    """Bind approval to current evidence without exposing site identifiers."""
    address = _site_address(evidence)
    normalized_address = re.sub(r"\s+", " ", address or "").strip().upper()
    return canonical_sha256(
        {
            "site_address": normalized_address or None,
            "bill_sha256": (
                evidence.bill_sha256 if evidence is not None else None
            ),
            "interval_sha256": (
                evidence.interval_sha256 if evidence is not None else None
            ),
        }
    )


def _site_evidence(evidence: CiProjectEvidenceModel | None) -> dict[str, object]:
    address = _site_address(evidence)
    state_code, postcode = _state_postcode(address)
    return {
        "detected_site_address": address,
        "state_code": state_code,
        "postcode": postcode,
    }


def _iso_date(value: object, label: str) -> date:
    if not isinstance(value, str):
        raise _invalid(f"The {label} must be an ISO date.")
    try:
        result = date.fromisoformat(value)
    except ValueError as exc:
        raise _invalid(f"The {label} must be an ISO date.") from exc
    if not date(2000, 1, 1) <= result <= date(2100, 12, 31):
        raise _invalid(f"The {label} is outside the supported date range.")
    return result


def _label(value: object, *, allow_empty: bool) -> str:
    if not isinstance(value, str):
        raise _invalid("Rebate evidence and price source labels must be text.")
    normalized = " ".join(value.split())
    if (not allow_empty and not normalized) or len(normalized) > 240:
        raise _invalid("Rebate evidence and price source labels must be at most 240 characters.")
    return normalized


def _bounded_number(
    value: object,
    *,
    minimum: float,
    maximum: float,
    label: str,
) -> float:
    if isinstance(value, bool):
        raise _invalid(f"The {label} must be a valid number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise _invalid(f"The {label} must be a valid number.") from exc
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise _invalid(f"The {label} is outside the supported range.")
    return number


def _blocker(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _deduplicated_blockers(
    blockers: list[dict[str, str]],
) -> list[dict[str, str]]:
    seen: set[str] = set()
    return [
        blocker
        for blocker in blockers
        if str(blocker["code"]) not in seen
        and not seen.add(str(blocker["code"]))
    ]


def _invalid(message: str) -> CiProjectError:
    return CiProjectError("ci_project_rebate_profile_invalid", message)


def _sydney_today() -> date:
    return datetime.now(ZoneInfo("Australia/Sydney")).date()

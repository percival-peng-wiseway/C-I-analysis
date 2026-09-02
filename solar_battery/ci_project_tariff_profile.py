from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
from typing import Any
from uuid import UUID

from sqlalchemy import select

from solar_battery.ci_project_feasibility import canonical_sha256
from solar_battery.ci_projects import CiProjectError, require_ci_project
from solar_battery.ci_tariff_analysis import (
    CI_TARIFF_PROFILE_CONTRACT_VERSION,
    CiTariffAnalysisError,
    bind_ci_tariff_profile_to_nem12,
)
from solar_battery.durable_cockpit.identity import LocalActorContext
from solar_battery.durable_cockpit.orm import (
    CiProjectEvidenceModel,
    CiProjectTariffProfileModel,
)


CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION = "ci_project_tariff_profile_v1"
CI_PROJECT_TARIFF_PROFILE_STATE_CONTRACT_VERSION = (
    "ci_project_tariff_profile_state_v1"
)
_ANNUAL_INTERVAL_DAYS = 365
_ANNUAL_ESTIMATE_METHOD = "bill_derived_interval_scaled_v1"

_RATE_KEYS = {
    "retail_peak_c_per_kwh",
    "retail_off_peak_c_per_kwh",
    "incentive_demand_aud_per_kva_month",
    "rolling_demand_aud_per_kva_month",
    "network_peak_c_per_kwh",
    "network_off_peak_c_per_kwh",
    "aemo_ancillary_c_per_kwh",
    "aemo_participant_c_per_kwh",
    "aemo_frc_c_per_day",
    "environmental_c_per_kwh",
    "environmental_certificate_fraction",
    "metering_aud_per_day",
    "value_added_c_per_day",
}
_WINDOWS = {
    "retail_energy": "meter_aest",
    "network_energy": "local",
    "rolling_demand": "local",
    "incentive_demand": "local",
}
_EXPECTED_RECONCILIATION_KEYS = {
    "import_kwh",
    "export_kwh",
    "retail_peak_kwh",
    "retail_off_peak_kwh",
    "network_peak_kwh",
    "network_off_peak_kwh",
    "rolling_demand_kva",
    "incentive_demand_kva",
    "billing_period_max_kva",
    "billing_period_max_power_factor",
    "category_energy_charges_aud",
    "category_network_charges_aud",
    "category_regulated_charges_aud",
    "category_environmental_charges_aud",
    "category_metering_charges_aud",
    "category_additional_charges_aud",
    "subtotal_ex_gst_aud",
    "gst_aud",
    "total_inc_gst_aud",
}


def ci_project_tariff_profile_state(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
) -> dict[str, object]:
    require_ci_project(session, project_id=project_id, actor=actor)
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    suggestion = _suggested_profile(evidence)
    basis = _evidence_basis(evidence)
    annual_period = _annual_meter_date_period(evidence)
    row = _profile_row(session, project_id=project_id, actor=actor)
    if row is None:
        blockers = (
            []
            if suggestion is not None
            else [_blocker("tariff_evidence_required", "Upload and confirm a bill with detected tariff charge categories.")]
        )
        if suggestion is not None:
            if annual_period is None:
                blockers.append(_annual_interval_blocker())
            blockers.append(
                _blocker(
                    "tariff_profile_approval_required",
                    "Review the bill-derived tariff table and approve it for internal calculation.",
                )
            )
        return _state(
            status="not_available",
            row=None,
            profile=None,
            suggested_profile=suggestion,
            evidence_basis=basis,
            blockers=blockers,
        )

    _verify_row_integrity(row)
    stale = bool(
        evidence is None
        or row.source_bill_sha256 != evidence.bill_sha256
        or row.source_interval_sha256 != evidence.interval_sha256
        or row.source_tariff_facts_sha256 != _tariff_facts_sha256(evidence)
        or (row.approval_status == "approved" and annual_period is None)
    )
    status = "stale" if stale else row.approval_status
    blockers: list[dict[str, str]] = []
    if stale and annual_period is None:
        blockers.append(_annual_interval_blocker())
    elif stale:
        blockers.append(
            _blocker(
                "tariff_profile_stale",
                "The saved tariff table belongs to replaced bill or NEM12 evidence. Review and approve a new working copy.",
            )
        )
    elif row.approval_status != "approved":
        blockers.append(
            _blocker(
                "tariff_profile_approval_required",
                "Approve the saved tariff table before running Finance Analysis.",
            )
        )
    return _state(
        status=status,
        row=row,
        profile=dict(row.profile_json),
        suggested_profile=suggestion,
        evidence_basis=basis,
        blockers=blockers,
    )


def save_ci_project_tariff_profile(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
    profile: dict[str, object],
    approve_for_calculation: bool,
    bill_bytes: bytes | None,
    interval_bytes: bytes | None,
) -> dict[str, object]:
    require_ci_project(session, project_id=project_id, actor=actor)
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    if evidence is None or _suggested_profile(evidence) is None:
        raise CiProjectError(
            "ci_project_tariff_evidence_required",
            "Upload and confirm a bill with detected tariff charge categories before saving a tariff table.",
        )
    normalized = validate_ci_project_tariff_profile(profile)
    tariff_facts_digest = _tariff_facts_sha256(evidence)
    calculation_profile: dict[str, Any] | None = None
    calculation_digest: str | None = None
    if approve_for_calculation:
        _require_approvable_evidence(evidence)
        evidence_bill = evidence.inspection_result_json.get("bill")
        detected_code = (
            evidence_bill.get("network_tariff_code")
            if isinstance(evidence_bill, dict)
            else None
        )
        if normalized["network_tariff_code"] != detected_code:
            raise CiProjectError(
                "ci_project_tariff_profile_reconciliation_failed",
                "The approved tariff code must match the current bill evidence. Save code changes as a draft until supporting evidence is uploaded.",
            )
        if (
            bill_bytes is None
            or hashlib.sha256(bill_bytes).hexdigest() != evidence.bill_sha256
            or interval_bytes is None
            or hashlib.sha256(interval_bytes).hexdigest() != evidence.interval_sha256
        ):
            raise CiProjectError(
                "ci_project_evidence_inputs_changed",
                "The project evidence changed while the tariff table was being approved. Review it again.",
            )
        unbound = _calculation_profile(
            project_id=project_id,
            editable=normalized,
            evidence=evidence,
        )
        try:
            calculation_profile = bind_ci_tariff_profile_to_nem12(
                interval_bytes,
                profile=unbound,
            )
        except CiTariffAnalysisError as exc:
            raise CiProjectError(
                "ci_project_tariff_profile_reconciliation_failed",
                "The tariff table could not be bound to the current aligned NEM12 evidence.",
            ) from exc
        _require_bill_reconciliation(calculation_profile, evidence)
        calculation_digest = canonical_sha256(calculation_profile)

    profile_digest = canonical_sha256(normalized)
    now = datetime.now(timezone.utc)
    row = _profile_row(session, project_id=project_id, actor=actor)
    if row is None:
        row = CiProjectTariffProfileModel(
            project_id=project_id,
            workspace_id=actor.workspace_id,
            owner_id=actor.owner_id,
            profile_contract_version=CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION,
            approval_status="approved" if approve_for_calculation else "draft",
            source_bill_sha256=evidence.bill_sha256,
            source_interval_sha256=evidence.interval_sha256,
            source_tariff_facts_sha256=tariff_facts_digest,
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
        row.profile_contract_version = CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION
        row.approval_status = "approved" if approve_for_calculation else "draft"
        row.source_bill_sha256 = evidence.bill_sha256
        row.source_interval_sha256 = evidence.interval_sha256
        row.source_tariff_facts_sha256 = tariff_facts_digest
        row.profile_sha256 = profile_digest
        row.profile_json = normalized
        row.calculation_profile_sha256 = calculation_digest
        row.calculation_profile_json = calculation_profile
        row.approved_by_actor_id = actor.actor_id if approve_for_calculation else None
        row.approved_at = now if approve_for_calculation else None
        row.updated_by_actor_id = actor.actor_id
        row.updated_at = now
    session.flush()
    return _state(
        status=row.approval_status,
        row=row,
        profile=dict(row.profile_json),
        suggested_profile=_suggested_profile(evidence),
        evidence_basis=_evidence_basis(evidence),
        blockers=(
            []
            if approve_for_calculation
            else (
                (
                    []
                    if _annual_meter_date_period(evidence) is not None
                    else [_annual_interval_blocker()]
                )
                + [
                    _blocker(
                        "tariff_profile_approval_required",
                        "Approve the saved tariff table before running Finance Analysis.",
                    )
                ]
            )
        ),
    )


def approved_ci_project_tariff_calculation_profile(
    session,
    *,
    project_id: UUID,
    actor: LocalActorContext,
) -> dict[str, object] | None:
    require_ci_project(session, project_id=project_id, actor=actor)
    evidence = _evidence_row(session, project_id=project_id, actor=actor)
    row = _profile_row(session, project_id=project_id, actor=actor)
    if (
        row is None
        or evidence is None
        or _annual_meter_date_period(evidence) is None
        or row.approval_status != "approved"
        or row.source_bill_sha256 != evidence.bill_sha256
        or row.source_interval_sha256 != evidence.interval_sha256
        or row.source_tariff_facts_sha256 != _tariff_facts_sha256(evidence)
    ):
        return None
    _verify_row_integrity(row)
    if row.calculation_profile_json is None or row.calculation_profile_sha256 is None:
        return None
    return json.loads(json.dumps(row.calculation_profile_json))


def validate_ci_project_tariff_profile(
    profile: dict[str, object],
) -> dict[str, object]:
    required_keys = {
        "contract_version",
        "display_label",
        "network_tariff_code",
        "rates",
        "factors",
        "windows",
        "minimum_chargeable_rolling_kva",
    }
    optional_keys = {"additional_bill_adjustment_aud"}
    if (
        not isinstance(profile, dict)
        or not required_keys <= set(profile)
        or set(profile) - required_keys - optional_keys
    ):
        raise _invalid("The tariff working-copy fields are invalid.")
    if profile.get("contract_version") != CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION:
        raise _invalid("The tariff working-copy version is unsupported.")
    display_label = _text(profile.get("display_label"), "Tariff label", 160)
    network_tariff_code = _text(profile.get("network_tariff_code"), "Tariff code", 64)
    rates = profile.get("rates")
    if not isinstance(rates, dict) or set(rates) != _RATE_KEYS:
        raise _invalid("The tariff rate table is incomplete.")
    normalized_rates = {
        key: _number(
            rates.get(key),
            key.replace("_", " "),
            maximum=(1.0 if key == "environmental_certificate_fraction" else 1_000_000.0),
        )
        for key in sorted(_RATE_KEYS)
    }
    factors = profile.get("factors")
    if not isinstance(factors, dict) or set(factors) != {"mlf", "dlf"}:
        raise _invalid("MLF and DLF are required.")
    normalized_factors = {
        "mlf": _number(factors.get("mlf"), "MLF", minimum=0.01, maximum=5.0),
        "dlf": _number(factors.get("dlf"), "DLF", minimum=0.01, maximum=5.0),
    }
    windows = profile.get("windows")
    if not isinstance(windows, dict) or set(windows) != set(_WINDOWS):
        raise _invalid("All tariff and demand windows are required.")
    normalized_windows = {
        key: _window(windows.get(key), label=key.replace("_", " "))
        for key in _WINDOWS
    }
    minimum_kva = _number(
        profile.get("minimum_chargeable_rolling_kva"),
        "Minimum chargeable rolling kVA",
        maximum=1_000_000,
    )
    normalized: dict[str, object] = {
        "contract_version": CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION,
        "display_label": display_label,
        "network_tariff_code": network_tariff_code,
        "rates": normalized_rates,
        "factors": normalized_factors,
        "windows": normalized_windows,
        "minimum_chargeable_rolling_kva": minimum_kva,
    }
    if "additional_bill_adjustment_aud" in profile:
        normalized["additional_bill_adjustment_aud"] = _number(
            profile.get("additional_bill_adjustment_aud"),
            "Additional bill adjustment",
            minimum=-1_000_000,
            maximum=1_000_000,
        )
    return json.loads(
        json.dumps(
            normalized,
            sort_keys=True,
            allow_nan=False,
        )
    )


def _suggested_profile(
    evidence: CiProjectEvidenceModel | None,
) -> dict[str, object] | None:
    inspection = evidence.inspection_result_json if evidence is not None else None
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    categories = bill.get("charge_categories_ex_gst_aud") if isinstance(bill, dict) else None
    consumption = _positive(bill.get("consumption_kwh")) if isinstance(bill, dict) else None
    billing_days = _positive(bill.get("billing_days")) if isinstance(bill, dict) else None
    tariff_code = bill.get("network_tariff_code") if isinstance(bill, dict) else None
    required_categories = {
        "energy_charges",
        "network_charges",
        "regulated_charges",
        "environmental_charges",
        "metering_charges",
        "additional_charges",
    }
    if (
        not isinstance(categories, dict)
        or not required_categories <= set(categories)
        or consumption is None
        or billing_days is None
        or not isinstance(tariff_code, str)
        or not tariff_code.strip()
        or any(
            not _finite(categories.get(key)) or float(categories[key]) < 0
            for key in required_categories - {"additional_charges"}
        )
        or not _finite(categories.get("additional_charges"))
        or abs(float(categories["additional_charges"])) > 1_000_000
    ):
        return None
    energy_rate = float(categories["energy_charges"]) / consumption * 100
    network_rate = float(categories["network_charges"]) / consumption * 100
    regulated_rate = float(categories["regulated_charges"]) / consumption * 100
    environmental_rate = float(categories["environmental_charges"]) / consumption * 100
    return validate_ci_project_tariff_profile(
        {
            "contract_version": CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION,
            "display_label": f"{tariff_code.strip()} · bill-derived working copy",
            "network_tariff_code": tariff_code.strip(),
            "additional_bill_adjustment_aud": float(
                categories["additional_charges"]
            ),
            "rates": {
                "retail_peak_c_per_kwh": energy_rate,
                "retail_off_peak_c_per_kwh": energy_rate,
                "incentive_demand_aud_per_kva_month": 0.0,
                "rolling_demand_aud_per_kva_month": 0.0,
                "network_peak_c_per_kwh": network_rate,
                "network_off_peak_c_per_kwh": network_rate,
                "aemo_ancillary_c_per_kwh": regulated_rate,
                "aemo_participant_c_per_kwh": 0.0,
                "aemo_frc_c_per_day": 0.0,
                "environmental_c_per_kwh": environmental_rate,
                "environmental_certificate_fraction": 1.0,
                "metering_aud_per_day": float(categories["metering_charges"]) / billing_days,
                "value_added_c_per_day": 0.0,
            },
            "factors": {"mlf": 1.0, "dlf": 1.0},
            "windows": {
                "retail_energy": {"start": "07:00", "end": "22:00"},
                "network_energy": {"start": "07:00", "end": "22:00"},
                "rolling_demand": {"start": "07:00", "end": "22:00"},
                "incentive_demand": {"start": "07:00", "end": "22:00"},
            },
            "minimum_chargeable_rolling_kva": 0.0,
        }
    )


def _calculation_profile(
    *,
    project_id: UUID,
    editable: dict[str, object],
    evidence: CiProjectEvidenceModel,
) -> dict[str, Any]:
    inspection = evidence.inspection_result_json
    bill = inspection.get("bill")
    nem12 = inspection.get("nem12")
    if not isinstance(bill, dict) or not isinstance(nem12, dict):
        raise CiProjectError(
            "ci_project_tariff_evidence_required",
            "The saved tariff evidence is incomplete.",
        )
    billing_start = _iso_date(bill.get("billing_period_start"), "billing start")
    billing_end = _iso_date(bill.get("billing_period_end"), "billing end")
    annual_period = _annual_meter_date_period(evidence)
    if annual_period is None:
        raise _annual_interval_error()
    analysis_start, analysis_end = annual_period
    rates = editable["rates"]
    factors = editable["factors"]
    windows = editable["windows"]
    profile: dict[str, Any] = {
        "contract_version": CI_TARIFF_PROFILE_CONTRACT_VERSION,
        "profile_id": f"project-{project_id}",
        "display_label": editable["display_label"],
        "network_tariff_code": editable["network_tariff_code"],
        "source_version": "project_working_tariff_v1",
        "source_bill_sha256": evidence.bill_sha256,
        "expected_nem12_sha256": evidence.interval_sha256,
        "timezone_name": "Australia/Sydney",
        "meter_time_basis": "fixed_aest_interval_records",
        "gst_basis": "exclusive_then_10_percent_invoice_gst",
        "gst_rate": 0.10,
        "additional_bill_adjustment_aud": editable.get(
            "additional_bill_adjustment_aud", 0.0
        ),
        "billing_period": {"start_date": billing_start, "end_date": billing_end},
        "rolling_period": {"start_date": analysis_start, "end_date": analysis_end},
        "analysis_period": {"start_date": analysis_start, "end_date": analysis_end},
        "minimum_chargeable_rolling_kva": editable["minimum_chargeable_rolling_kva"],
        "factors": dict(factors),
        "rates": {
            "retail_peak_c_per_kwh": rates["retail_peak_c_per_kwh"],
            "retail_off_peak_c_per_kwh": rates["retail_off_peak_c_per_kwh"],
            "incentive_demand_aud_per_kva_month": rates["incentive_demand_aud_per_kva_month"],
            "rolling_demand_aud_per_kva_month": rates["rolling_demand_aud_per_kva_month"],
            "network_peak_c_per_kwh": rates["network_peak_c_per_kwh"],
            "network_off_peak_c_per_kwh": rates["network_off_peak_c_per_kwh"],
            "aemo_ancillary_c_per_kwh": rates["aemo_ancillary_c_per_kwh"],
            "aemo_participant_c_per_kwh": rates["aemo_participant_c_per_kwh"],
            "aemo_frc_c_per_day": rates["aemo_frc_c_per_day"],
            "environmental": [
                {
                    "label": "Bill-derived environmental charge",
                    "rate_c_per_kwh": rates["environmental_c_per_kwh"],
                    "certificate_fraction": rates["environmental_certificate_fraction"],
                }
            ],
            "metering_aud_per_day": rates["metering_aud_per_day"],
            "value_added_c_per_day": rates["value_added_c_per_day"],
        },
        "annual_financial_model": {
            "method": "representative_year_repeat_v1",
            "incentive_demand_months": list(range(1, 13)),
            "incentive_demand_aud_per_kva_month": rates[
                "incentive_demand_aud_per_kva_month"
            ],
        },
        "expected_reconciliation": {
            key: 0.0 for key in _EXPECTED_RECONCILIATION_KEYS
        },
    }
    for editable_key, internal_key in (
        ("retail_energy", "retail_energy_window"),
        ("network_energy", "network_energy_window"),
        ("rolling_demand", "rolling_demand_window"),
        ("incentive_demand", "incentive_demand_window"),
    ):
        profile[internal_key] = {
            **windows[editable_key],
            "time_basis": _WINDOWS[editable_key],
            "excluded_dates": [],
        }
    return profile


def _require_approvable_evidence(evidence: CiProjectEvidenceModel) -> None:
    inspection = evidence.inspection_result_json
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    nem12 = inspection.get("nem12") if isinstance(inspection, dict) else None
    annual = (
        inspection.get("annual_bill_estimate")
        if isinstance(inspection, dict)
        else None
    )
    pair_checks = inspection.get("pair_checks") if isinstance(inspection, dict) else None
    required_checks = {
        "site_identity_match",
        "bill_period_covered",
        "invoice_arithmetic",
        "bill_review_confirmed",
        "supported_current_tariff",
    }
    passed_checks = {
        item.get("code")
        for item in (pair_checks if isinstance(pair_checks, list) else [])
        if isinstance(item, dict) and item.get("passed") is True
    }
    if (
        not isinstance(bill, dict)
        or bill.get("review_status") not in {"not_required", "analyst_confirmed"}
        or bill.get("invoice_arithmetic_scope") != "charge_categories_and_totals"
        or not isinstance(nem12, dict)
        or nem12.get("full_tariff_analysis_ready") is not True
        or not required_checks <= passed_checks
    ):
        raise CiProjectError(
            "ci_project_tariff_evidence_required",
            "Approval requires a confirmed bill and aligned E1, B1, Q1 and K1 NEM12 streams.",
        )
    if _annual_meter_date_period(evidence) is None:
        raise _annual_interval_error()


def _require_bill_reconciliation(
    calculation_profile: dict[str, Any],
    evidence: CiProjectEvidenceModel,
) -> None:
    inspection = evidence.inspection_result_json
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    categories = bill.get("charge_categories_ex_gst_aud") if isinstance(bill, dict) else None
    expected = calculation_profile.get("expected_reconciliation")
    if not isinstance(categories, dict) or not isinstance(expected, dict):
        raise CiProjectError(
            "ci_project_tariff_profile_reconciliation_failed",
            "The approved bill category totals are unavailable for tariff reconciliation.",
        )
    comparisons = {
        "Energy charges": (expected.get("category_energy_charges_aud"), categories.get("energy_charges")),
        "Network charges": (expected.get("category_network_charges_aud"), categories.get("network_charges")),
        "Regulated charges": (expected.get("category_regulated_charges_aud"), categories.get("regulated_charges")),
        "Environmental charges": (expected.get("category_environmental_charges_aud"), categories.get("environmental_charges")),
        "Metering charges": (expected.get("category_metering_charges_aud"), categories.get("metering_charges")),
        "Additional charges": (expected.get("category_additional_charges_aud"), categories.get("additional_charges")),
        "Subtotal ex GST": (expected.get("subtotal_ex_gst_aud"), bill.get("subtotal_ex_gst_aud")),
        "GST": (expected.get("gst_aud"), bill.get("gst_aud")),
        "Total inc GST": (expected.get("total_inc_gst_aud"), bill.get("total_inc_gst_aud")),
    }
    for label, (calculated, source) in comparisons.items():
        if not _finite(calculated) or not _finite(source):
            raise CiProjectError(
                "ci_project_tariff_profile_reconciliation_failed",
                f"{label} is unavailable for tariff reconciliation.",
            )
        tolerance = max(2.0, abs(float(source)) * 0.02)
        if abs(float(calculated) - float(source)) > tolerance:
            raise CiProjectError(
                "ci_project_tariff_profile_reconciliation_failed",
                f"{label} does not reconcile to the approved bill within 2%. Save the table as a draft or correct its rates and windows.",
            )


def _state(
    *,
    status: str,
    row: CiProjectTariffProfileModel | None,
    profile: dict[str, object] | None,
    suggested_profile: dict[str, object] | None,
    evidence_basis: dict[str, object] | None,
    blockers: list[dict[str, str]],
) -> dict[str, object]:
    return {
        "contract_version": CI_PROJECT_TARIFF_PROFILE_STATE_CONTRACT_VERSION,
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
        "evidence_basis": evidence_basis,
        "blockers": blockers,
    }


def _evidence_basis(
    evidence: CiProjectEvidenceModel | None,
) -> dict[str, object] | None:
    inspection = evidence.inspection_result_json if evidence is not None else None
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    if not isinstance(bill, dict):
        return None
    categories = bill.get("charge_categories_ex_gst_aud")
    return {
        "network_tariff_code": bill.get("network_tariff_code"),
        "billing_period_start": bill.get("billing_period_start"),
        "billing_period_end": bill.get("billing_period_end"),
        "billing_days": bill.get("billing_days"),
        "billed_consumption_kwh": bill.get("consumption_kwh"),
        "charge_categories_ex_gst_aud": (
            dict(categories) if isinstance(categories, dict) else None
        ),
        "derivation_notice": (
            "Starting rates are category-average equivalents derived from the saved bill. "
            "They are a calculation working copy, not detected contractual line items."
        ),
    }


def _annual_meter_date_period(
    evidence: CiProjectEvidenceModel | None,
) -> tuple[str, str] | None:
    """Return the evidence-selected representative year on fixed-AEST meter dates."""

    inspection = evidence.inspection_result_json if evidence is not None else None
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    nem12 = inspection.get("nem12") if isinstance(inspection, dict) else None
    annual = (
        inspection.get("annual_bill_estimate")
        if isinstance(inspection, dict)
        else None
    )
    reconciliation = (
        annual.get("bill_period_reconciliation")
        if isinstance(annual, dict)
        else None
    )
    if (
        not isinstance(bill, dict)
        or not isinstance(nem12, dict)
        or not isinstance(annual, dict)
        or annual.get("status") != "estimated"
        or annual.get("method") != _ANNUAL_ESTIMATE_METHOD
        or not _positive(annual.get("annual_import_kwh"))
        or not isinstance(reconciliation, dict)
        or reconciliation.get("status") != "pass"
        or nem12.get("input_format") != "nem12_standard"
        or nem12.get("interval_minutes") != 5
    ):
        return None
    try:
        annual_start = date.fromisoformat(str(annual["coverage_start"]))
        annual_end = date.fromisoformat(str(annual["coverage_end"]))
        nem12_start = date.fromisoformat(str(nem12["coverage_start"]))
        nem12_end = date.fromisoformat(str(nem12["coverage_end"]))
        bill_start = date.fromisoformat(str(bill["billing_period_start"]))
        bill_end = date.fromisoformat(str(bill["billing_period_end"]))
    except (KeyError, TypeError, ValueError):
        return None
    if (
        annual_end - annual_start
        != timedelta(days=_ANNUAL_INTERVAL_DAYS - 1)
        or not nem12_start <= annual_start <= annual_end <= nem12_end
        or not annual_start <= bill_start <= bill_end <= annual_end
    ):
        return None
    return annual_start.isoformat(), annual_end.isoformat()


def _tariff_facts_sha256(evidence: CiProjectEvidenceModel) -> str:
    inspection = evidence.inspection_result_json
    bill = inspection.get("bill") if isinstance(inspection, dict) else None
    nem12 = inspection.get("nem12") if isinstance(inspection, dict) else None
    annual = (
        inspection.get("annual_bill_estimate")
        if isinstance(inspection, dict)
        else None
    )
    pair_checks = inspection.get("pair_checks") if isinstance(inspection, dict) else None
    bill_fields = (
        "review_status",
        "extraction_method",
        "invoice_arithmetic_scope",
        "billing_period_start",
        "billing_period_end",
        "billing_days",
        "network_tariff_code",
        "consumption_kwh",
        "highest_metered_demand_kva",
        "power_factor_at_highest_demand",
        "charge_categories_ex_gst_aud",
        "subtotal_ex_gst_aud",
        "gst_aud",
        "total_inc_gst_aud",
    )
    nem12_fields = (
        "input_format",
        "coverage_start",
        "coverage_end",
        "interval_minutes",
        "aligned_stream_ids",
        "full_tariff_analysis_ready",
    )
    annual_fields = (
        "status",
        "method",
        "coverage_start",
        "coverage_end",
        "annual_import_kwh",
    )
    relevant_checks = {
        "site_identity_match",
        "bill_period_covered",
        "invoice_arithmetic",
        "bill_review_confirmed",
        "supported_current_tariff",
    }
    projection = {
        "bill": {
            key: bill.get(key) if isinstance(bill, dict) else None
            for key in bill_fields
        },
        "nem12": {
            key: nem12.get(key) if isinstance(nem12, dict) else None
            for key in nem12_fields
        },
        "annual_bill_estimate": {
            key: annual.get(key) if isinstance(annual, dict) else None
            for key in annual_fields
        },
        "pair_checks": sorted(
            (
                {
                    "code": item.get("code"),
                    "passed": item.get("passed"),
                }
                for item in (pair_checks if isinstance(pair_checks, list) else [])
                if isinstance(item, dict) and item.get("code") in relevant_checks
            ),
            key=lambda item: str(item["code"]),
        ),
    }
    return canonical_sha256(projection)


def _profile_row(
    session, *, project_id: UUID, actor: LocalActorContext
) -> CiProjectTariffProfileModel | None:
    return session.scalar(
        select(CiProjectTariffProfileModel).where(
            CiProjectTariffProfileModel.project_id == project_id,
            CiProjectTariffProfileModel.workspace_id == actor.workspace_id,
            CiProjectTariffProfileModel.owner_id == actor.owner_id,
        )
    )


def _evidence_row(
    session, *, project_id: UUID, actor: LocalActorContext
) -> CiProjectEvidenceModel | None:
    return session.scalar(
        select(CiProjectEvidenceModel).where(
            CiProjectEvidenceModel.project_id == project_id,
            CiProjectEvidenceModel.workspace_id == actor.workspace_id,
            CiProjectEvidenceModel.owner_id == actor.owner_id,
        )
    )


def _verify_row_integrity(row: CiProjectTariffProfileModel) -> None:
    profile_ok = (
        row.profile_contract_version == CI_PROJECT_TARIFF_PROFILE_CONTRACT_VERSION
        and canonical_sha256(row.profile_json) == row.profile_sha256
    )
    calculation_ok = (
        row.approval_status != "approved"
        or (
            row.calculation_profile_json is not None
            and row.calculation_profile_sha256 is not None
            and canonical_sha256(row.calculation_profile_json)
            == row.calculation_profile_sha256
        )
    )
    if not profile_ok or not calculation_ok:
        raise CiProjectError(
            "ci_project_tariff_profile_integrity_failed",
            "The saved tariff working copy failed its integrity check.",
        )
    validate_ci_project_tariff_profile(row.profile_json)


def _blocker(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _annual_interval_blocker() -> dict[str, str]:
    return _blocker(
        "tariff_annual_interval_required",
        "Upload NEM12 with a most-recent complete 365 consecutive fixed-AEST "
        "meter-date period before running Finance Analysis.",
    )


def _annual_interval_error() -> CiProjectError:
    blocker = _annual_interval_blocker()
    return CiProjectError(str(blocker["code"]), str(blocker["message"]))


def _invalid(message: str) -> CiProjectError:
    return CiProjectError("ci_project_tariff_profile_invalid", message)


def _text(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise _invalid(f"{label} is required and must be at most {maximum} characters.")
    return value.strip()


def _number(
    value: object,
    label: str,
    *,
    minimum: float = 0.0,
    maximum: float,
) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _invalid(f"{label} must be a valid number.")
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise _invalid(f"{label} must be between {minimum:g} and {maximum:g}.")
    return result


def _window(value: object, *, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"start", "end"}:
        raise _invalid(f"The {label} window is invalid.")
    start = _clock(value.get("start"), f"{label} start")
    end = _clock(value.get("end"), f"{label} end")
    if start >= end:
        raise _invalid(f"The {label} start must be earlier than its end.")
    return {"start": start, "end": end}


def _clock(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise _invalid(f"{label} is invalid.")
    try:
        parsed = datetime.strptime(value, "%H:%M").time()
    except ValueError as exc:
        raise _invalid(f"{label} must use HH:MM 24-hour time.") from exc
    return parsed.strftime("%H:%M")


def _iso_date(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise CiProjectError("ci_project_tariff_evidence_required", f"The {label} is missing.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise CiProjectError("ci_project_tariff_evidence_required", f"The {label} is invalid.") from exc
    return parsed.isoformat()


def _finite(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(float(value))


def _positive(value: object) -> float | None:
    return float(value) if _finite(value) and float(value) > 0 else None

from __future__ import annotations

import csv
import hashlib
import io
import math
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from pypdf import PdfReader

from solar_battery.ci_tariff_analysis import (
    MAX_CI_NEM12_UPLOAD_BYTES,
    CiTariffAnalysisError,
    _parse_ci_nem12,
)
from solar_battery.models import CleanedInterval


CI_EVIDENCE_INTAKE_CONTRACT_VERSION = "ci_evidence_intake_v9"
MAX_CI_BILL_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_CI_BILL_PAGES = 20


@dataclass(frozen=True, slots=True)
class CiActiveIntervalSeries:
    input_format: str
    interval_minutes: int
    time_basis: str
    intervals: tuple[CleanedInterval, ...]
    reported_kva: tuple[float | None, ...]


def parse_ci_active_interval_series(upload_bytes: bytes) -> CiActiveIntervalSeries:
    """Return a regular active-power series for pre-tariff physical review.

    Standard NEM12 E1 energy is aggregated to 15 minutes. Wide exports retain
    their reported 30-minute kW values. Missing intervals and kVA-only wide
    exports fail closed because neither is safe input to battery dispatch.
    """
    try:
        text = upload_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CiEvidenceIntakeError(
            "interval_upload_invalid",
            "The interval file must be a readable UTF-8 CSV or tab-delimited export.",
        ) from exc
    first_nonempty = next(
        (line.strip() for line in text.splitlines() if line.strip()), ""
    )
    fixed_aest = timezone(timedelta(hours=10), name="AEST")
    if first_nonempty.upper().startswith("100,NEM12"):
        try:
            parsed = _parse_ci_nem12(
                upload_bytes, require_complete_stream_set=False
            )
        except CiTariffAnalysisError as exc:
            raise CiEvidenceIntakeError(exc.code, str(exc)) from exc
        active_rows = parsed["streams"]["E1"]
        rows: list[CleanedInterval] = []
        for meter_day in sorted(active_rows):
            values = active_rows[meter_day]
            for index in range(0, len(values), 3):
                stamp = datetime.combine(
                    meter_day, time.min, tzinfo=fixed_aest
                ) + timedelta(minutes=index * 5)
                rows.append(
                    CleanedInterval(
                        timestamp=stamp,
                        interval_minutes=15,
                        load_kwh=math.fsum(values[index : index + 3]),
                        source_status="measured",
                        source_stream_id="E1",
                        source_date=meter_day,
                    )
                )
        _require_regular_intervals(rows, interval_minutes=15)
        return CiActiveIntervalSeries(
            input_format="nem12_standard",
            interval_minutes=15,
            time_basis="fixed_aest_meter_time",
            intervals=tuple(rows),
            reported_kva=tuple(None for _ in rows),
        )

    _, readings, _, _ = _read_wide_interval_rows(text)
    timestamps = sorted(readings)
    if any(readings[stamp]["kw"] is None for stamp in timestamps):
        raise CiEvidenceIntakeError(
            "interval_active_demand_unavailable",
            "System design feasibility requires a complete reported kW column. kVA-only data remains available for Setup visualization only.",
        )
    rows = [
        CleanedInterval(
            timestamp=stamp.replace(tzinfo=fixed_aest),
            interval_minutes=30,
            load_kwh=float(readings[stamp]["kw"]) * 0.5,
            source_status="measured",
            source_stream_id="reported_kW",
            source_date=stamp.date(),
        )
        for stamp in timestamps
    ]
    _require_regular_intervals(rows, interval_minutes=30)
    return CiActiveIntervalSeries(
        input_format="wide_interval_30_minute",
        interval_minutes=30,
        time_basis="source_local_time_assumed_fixed_aest_for_pv_shape",
        intervals=tuple(rows),
        reported_kva=tuple(readings[stamp]["kva"] for stamp in timestamps),
    )


def _require_regular_intervals(
    rows: list[CleanedInterval], *, interval_minutes: int
) -> None:
    if len(rows) < 2 or any(
        current.timestamp - previous.timestamp
        != timedelta(minutes=interval_minutes)
        for previous, current in zip(rows, rows[1:], strict=False)
    ):
        raise CiEvidenceIntakeError(
            "interval_series_incomplete",
            "System design feasibility requires a complete regular interval series. Missing intervals are not filled or inferred.",
        )


class CiEvidenceIntakeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def inspect_ci_evidence_pair(
    bill_pdf_bytes: bytes,
    nem12_bytes: bytes,
    *,
    bill_review: dict[str, object] | None = None,
    files_persisted: bool = False,
) -> dict[str, object]:
    if not bill_pdf_bytes or len(bill_pdf_bytes) > MAX_CI_BILL_UPLOAD_BYTES:
        raise CiEvidenceIntakeError(
            "bill_upload_invalid",
            "The electricity bill PDF is empty or larger than the 10 MB intake limit.",
        )
    if not nem12_bytes or len(nem12_bytes) > MAX_CI_NEM12_UPLOAD_BYTES:
        raise CiEvidenceIntakeError(
            "nem12_upload_invalid",
            "The interval CSV/NEM12 file is empty or larger than the 25 MB intake limit.",
        )

    bill = _parse_invoice_text(
        _extract_pdf_text(bill_pdf_bytes), bill_review=bill_review
    )
    interval_data = _parse_ci_setup_interval_data(nem12_bytes)
    coverage_start = date.fromisoformat(str(interval_data["coverage_start"]))
    coverage_end = date.fromisoformat(str(interval_data["coverage_end"]))
    billing_start = (
        date.fromisoformat(str(bill["billing_period_start"]))
        if bill["billing_period_start"] is not None
        else None
    )
    billing_end = (
        date.fromisoformat(str(bill["billing_period_end"]))
        if bill["billing_period_end"] is not None
        else None
    )
    complete_stream_set = bool(interval_data["full_tariff_analysis_ready"])
    bill_period_covered = bool(
        billing_start
        and billing_end
        and coverage_start <= billing_start <= billing_end <= coverage_end
    )
    pair_checks = [
        _check(
            "site_identity_match",
            bill["nmi"] is not None
            and str(interval_data["nmi"]).upper() == str(bill["nmi"]).upper(),
            "The bill and NEM12 identify the same site.",
            (
                "Confirm the bill NMI to complete the private site-identity check."
                if bill["nmi"] is None
                else "The bill and NEM12 site identities do not match."
            ),
        ),
        _check(
            "bill_period_covered",
            bill_period_covered,
            "The NEM12 fully covers the invoice period.",
            "The NEM12 does not fully cover the invoice period.",
        ),
        _check(
            "stream_capability",
            True,
            (
                "Aligned E1, B1, Q1 and K1 streams are present."
                if complete_stream_set
                else str(interval_data["capability_message"])
            ),
            "The interval upload does not contain usable measured demand data.",
            severity="pass" if complete_stream_set else "warning",
        ),
        _check(
            "supported_interval_width",
            True,
            str(interval_data["interval_message"]),
            "The interval width is not supported.",
            severity=(
                "pass"
                if interval_data["input_format"] == "nem12_standard"
                else "warning"
            ),
        ),
        _check(
            "supported_current_tariff",
            bill["network_tariff_code"] == "LLVT2",
            "The detected network tariff matches the current evidence-limited workflow.",
            (
                "Confirm the network tariff code before continuing."
                if bill["network_tariff_code"] is None
                else "This network tariff is not supported by the current evidence-limited workflow."
            ),
        ),
        _check(
            "invoice_arithmetic",
            bool(bill["invoice_arithmetic_reconciled"]),
            (
                "Invoice categories, subtotal, GST and total reconcile."
                if bill["invoice_arithmetic_scope"] == "charge_categories_and_totals"
                else "The confirmed invoice subtotal, GST and total reconcile."
            ),
            "Confirm or correct the invoice subtotal, GST and total; the amounts must reconcile.",
        ),
        _check(
            "bill_review_confirmed",
            bill["review_status"] in {"not_required", "analyst_confirmed"},
            (
                "The verified invoice template was parsed without manual review."
                if bill["review_status"] == "not_required"
                else "The retailer-neutral bill fields were confirmed for this request."
            ),
            "Review and confirm the retailer-neutral bill fields before continuing.",
        ),
    ]
    ready = all(bool(item["passed"]) for item in pair_checks)
    quality_counts = interval_data["quality_method_counts"]
    site_address = bill.get("site_address")
    evidence_checks = {str(item["code"]): bool(item["passed"]) for item in pair_checks}
    detected_tariff = _detected_tariff_summary(bill)
    annual_bill_estimate = _annual_bill_estimate(
        bill,
        interval_data,
        evidence_ready=all(
            evidence_checks.get(code, False)
            for code in (
                "site_identity_match",
                "bill_period_covered",
                "invoice_arithmetic",
                "bill_review_confirmed",
            )
        ),
    )
    return {
        "contract_version": CI_EVIDENCE_INTAKE_CONTRACT_VERSION,
        "intake_status": "ready_for_profile_review" if ready else "action_required",
        "bill": {
            key: value
            for key, value in bill.items()
            if key not in {"nmi", "invoice_arithmetic_reconciled"}
        }
        | {
            "fingerprint": hashlib.sha256(bill_pdf_bytes).hexdigest()[:12],
            "site_identity_status": (
                "extracted" if bill["nmi"] is not None else "missing"
            ),
        },
        "nem12": {
            "fingerprint": hashlib.sha256(nem12_bytes).hexdigest()[:12],
            "input_format": interval_data["input_format"],
            "coverage_start": interval_data["coverage_start"],
            "coverage_end": interval_data["coverage_end"],
            "interval_minutes": interval_data["interval_minutes"],
            "stream_ids": interval_data["stream_ids"],
            "aligned_stream_ids": interval_data["aligned_stream_ids"],
            "missing_stream_ids": interval_data["missing_stream_ids"],
            "unaligned_stream_ids": interval_data["unaligned_stream_ids"],
            "capability_status": interval_data["capability_status"],
            "full_tariff_analysis_ready": complete_stream_set,
            "days_per_stream": interval_data["day_count"],
            "quality_method_counts": dict(sorted(quality_counts.items())),
            "quality_override_count": interval_data["quality_override_count"],
        },
        "pair_checks": pair_checks,
        "annual_demand_heatmap": interval_data["annual_demand_heatmap"],
        "detected_tariff": detected_tariff,
        "annual_bill_estimate": annual_bill_estimate,
        "next_steps": [
            "Review the extracted invoice and interval-data checks.",
            (
                "The complete aligned E1/B1/Q1/K1 set is available for later evidence-bound tariff analysis."
                if complete_stream_set
                else "Setup may continue with the measured-demand data, but later formal kVA/PF, export, tariff and financial analysis requires a complete aligned five-minute E1/B1/Q1/K1 NEM12 export."
            ),
            "Confirm tariff time windows, time bases, exclusions and minimum chargeable demand from approved tariff evidence.",
            "Prepare or approve the private active tariff profile before running tariff, optimisation or financial calculations.",
        ],
        "privacy": {
            "files_persisted": files_persisted,
            "customer_identifiers_returned": site_address is not None,
            "customer_facing_permission": False,
        },
    }


def enrich_ci_evidence_tariff_summary(
    inspection_result: dict[str, object], nem12_bytes: bytes
) -> dict[str, object]:
    """Upgrade a saved v7/v8 inspection without re-parsing its private bill.

    Analyst-confirmed generic invoices must not be silently reinterpreted on read.
    This enrichment therefore preserves the saved bill fields and only derives the
    new tariff-category presentation and annual-usage summary from those fields and
    the already-saved interval source.
    """
    bill = inspection_result.get("bill")
    if not isinstance(bill, dict):
        raise CiEvidenceIntakeError(
            "saved_evidence_incomplete",
            "The saved evidence result does not contain a bill summary.",
        )
    interval_data = _parse_ci_setup_interval_data(nem12_bytes)
    checks = {
        str(item.get("code")): bool(item.get("passed"))
        for item in inspection_result.get("pair_checks", [])
        if isinstance(item, dict)
    }
    upgraded = dict(inspection_result)
    upgraded["contract_version"] = CI_EVIDENCE_INTAKE_CONTRACT_VERSION
    upgraded["detected_tariff"] = _detected_tariff_summary(bill)
    upgraded["annual_bill_estimate"] = _annual_bill_estimate(
        bill,
        interval_data,
        evidence_ready=all(
            checks.get(code, False)
            for code in (
                "site_identity_match",
                "bill_period_covered",
                "invoice_arithmetic",
                "bill_review_confirmed",
            )
        ),
    )
    return upgraded


_TARIFF_CATEGORY_SPECS = {
    "fixed": (
        ("metering_charges", "Metering charges", "days"),
    ),
    "other_usage": (
        ("network_charges", "Network charges", "days"),
        ("regulated_charges", "Regulated charges", "import_kwh"),
        ("environmental_charges", "Environmental charges", "import_kwh"),
        (
            "additional_charges",
            "Additional charges, credits & adjustments",
            "days",
        ),
    ),
    "energy_import": (
        ("energy_charges", "Energy charges", "import_kwh"),
    ),
}

_TARIFF_GROUP_LABELS = {
    "fixed": "Fixed",
    "other_usage": "Other usage",
    "energy_import": "Energy (Import)",
}


def _detected_tariff_summary(bill: dict[str, Any]) -> dict[str, object]:
    categories = bill.get("charge_categories_ex_gst_aud")
    required = {
        item_key
        for specs in _TARIFF_CATEGORY_SPECS.values()
        for item_key, _, _ in specs
    }
    category_detail_available = bool(
        isinstance(categories, dict)
        and required <= set(categories)
        and bill.get("invoice_arithmetic_scope") == "charge_categories_and_totals"
        and all(_is_finite_number(categories.get(item)) for item in required)
    )
    tariff_code = (
        str(bill["network_tariff_code"])
        if bill.get("network_tariff_code") is not None
        else None
    )
    if not category_detail_available:
        return {
            "status": "review_required",
            "tariff_code": tariff_code,
            "tax_basis": "ex_gst",
            "warning": (
                "The bill identifies a tariff code, but auditable charge-category totals were not detected. "
                "Rates and line items will remain unavailable until bill evidence is reviewed."
            ),
            "groups": [],
        }

    billing_days = _positive_number(bill.get("billing_days"))
    consumption_kwh = _positive_number(bill.get("consumption_kwh"))
    groups: list[dict[str, object]] = []
    for group_key, specs in _TARIFF_CATEGORY_SPECS.items():
        items = []
        for item_key, label, scale_basis in specs:
            source_amount = float(categories[item_key])
            items.append(
                {
                    "key": item_key,
                    "label": label,
                    "source_amount_ex_gst_aud": _round_money(source_amount),
                    "basis_label": (
                        f"Observed total for the {int(billing_days)}-day invoice"
                        if billing_days is not None
                        else "Observed invoice category total"
                    ),
                    "rate_label": _derived_rate_label(
                        source_amount,
                        scale_basis=scale_basis,
                        billing_days=billing_days,
                        consumption_kwh=consumption_kwh,
                    ),
                }
            )
        groups.append(
            {
                "key": group_key,
                "label": _TARIFF_GROUP_LABELS[group_key],
                "items": items,
            }
        )
    return {
        "status": "category_totals_detected",
        "tariff_code": tariff_code,
        "tax_basis": "ex_gst",
        "warning": (
            "The tabs show verified invoice category totals. Daily and kWh figures are derived equivalents "
            "for review, not detected contractual tariff rates or demand rules."
        ),
        "groups": groups,
    }


def _annual_bill_estimate(
    bill: dict[str, Any],
    interval_data: dict[str, Any],
    *,
    evidence_ready: bool,
) -> dict[str, object]:
    detected = _detected_tariff_summary(bill)
    annual_profile = interval_data.get("annual_import_profile")
    billing_days = _positive_number(bill.get("billing_days"))
    consumption_kwh = _positive_number(bill.get("consumption_kwh"))
    tariff_code = detected["tariff_code"]

    unavailable_reason = None
    if detected["status"] != "category_totals_detected":
        unavailable_reason = (
            "A category-level bill breakdown is required before an annual bill can be estimated."
        )
    elif not evidence_ready:
        unavailable_reason = (
            "The bill/site match, invoice arithmetic, review and bill-period coverage checks must pass first."
        )
    elif not isinstance(annual_profile, dict):
        unavailable_reason = (
            "Upload at least 365 consecutive complete days of active-import interval data."
        )
    elif billing_days is None or consumption_kwh is None:
        unavailable_reason = (
            "The bill must contain a positive billing-day count and import consumption."
        )

    if unavailable_reason is not None:
        return {
            "status": "unavailable",
            "method": "unavailable",
            "confidence": "unavailable",
            "tariff_code": tariff_code,
            "coverage_start": None,
            "coverage_end": None,
            "annual_import_kwh": None,
            "total_ex_gst_aud": None,
            "customer_facing_permission": False,
            "warning": unavailable_reason,
            "assumptions": [],
            "groups": [],
        }

    annual_import_kwh = float(annual_profile["import_kwh"])
    return {
        "status": "unavailable",
        "method": "approved_tariff_replay_required",
        "confidence": "unavailable",
        "tariff_code": tariff_code,
        "coverage_start": annual_profile["coverage_start"],
        "coverage_end": annual_profile["coverage_end"],
        "annual_import_kwh": round(annual_import_kwh, 3),
        "total_ex_gst_aud": None,
        "customer_facing_permission": False,
        "warning": (
            "A complete annual import profile is available, but an annual dollar bill is withheld until "
            "approved retail and network tariff line items, demand rules and bill-period import "
            "reconciliation are available for a formal interval replay."
        ),
        "assumptions": [
            "The most recent complete 365 consecutive days establish annual import quantity only.",
            "The network tariff code does not prove the customer's complete retail contract.",
            "Demand charges require approved monthly windows, ratchets, minimums and kW/kVA rules.",
            "The interval import for the invoice period must reconcile to billed consumption before replay.",
            "Public regional or neighbouring-load data cannot authorize a site-specific dollar claim.",
        ],
        "groups": [],
    }


def _latest_complete_annual_import_profile(
    daily_import_kwh: dict[date, float],
) -> dict[str, object] | None:
    valid_days = sorted(
        meter_day
        for meter_day, amount in daily_import_kwh.items()
        if _is_finite_number(amount) and float(amount) >= 0
    )
    consecutive: list[date] = []
    latest_window: list[date] | None = None
    for meter_day in valid_days:
        if consecutive and meter_day != consecutive[-1] + timedelta(days=1):
            consecutive = []
        consecutive.append(meter_day)
        if len(consecutive) >= 365:
            latest_window = consecutive[-365:]
    if latest_window is None:
        return None
    return {
        "method": "latest_complete_365_consecutive_days_v1",
        "coverage_start": latest_window[0].isoformat(),
        "coverage_end": latest_window[-1].isoformat(),
        "day_count": 365,
        "import_kwh": round(
            math.fsum(float(daily_import_kwh[item]) for item in latest_window), 6
        ),
    }


def _derived_rate_label(
    source_amount: float,
    *,
    scale_basis: str,
    billing_days: float | None,
    consumption_kwh: float | None,
) -> str:
    if scale_basis == "import_kwh" and consumption_kwh is not None:
        return (
            f"{source_amount / consumption_kwh * 100:.4f} c/kWh derived category average"
        )
    if billing_days is not None:
        return f"${source_amount / billing_days:,.4f}/day invoice equivalent"
    return "Rate unavailable from source bill"


def _is_finite_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(float(value))


def _positive_number(value: object) -> float | None:
    return float(value) if _is_finite_number(value) and float(value) > 0 else None


def _round_money(value: float) -> float:
    return float(
        Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    )


def extract_ci_site_address(bill_pdf_bytes: bytes) -> str | None:
    """Extract only a labelled Australian supply/site address from a saved bill."""
    if not bill_pdf_bytes or len(bill_pdf_bytes) > MAX_CI_BILL_UPLOAD_BYTES:
        raise CiEvidenceIntakeError(
            "bill_upload_invalid",
            "The electricity bill PDF is empty or larger than the 10 MB intake limit.",
        )
    return _site_address(_extract_pdf_text(bill_pdf_bytes))


def _parse_ci_setup_interval_data(upload_bytes: bytes) -> dict[str, Any]:
    try:
        text = upload_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CiEvidenceIntakeError(
            "interval_upload_invalid",
            "The interval file must be a readable UTF-8 CSV or tab-delimited export.",
        ) from exc

    first_nonempty = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if first_nonempty.upper().startswith("100,NEM12"):
        try:
            parsed_nem12 = _parse_ci_nem12(
                upload_bytes, require_complete_stream_set=False
            )
        except CiTariffAnalysisError as exc:
            if exc.code == "stream_contract_mismatch":
                raise CiEvidenceIntakeError(
                    "nem12_active_import_unavailable",
                    "Standard NEM12 Input check requires one valid five-minute E1 active-import stream. B1, Q1 and K1 may be added later for full tariff analysis.",
                ) from exc
            raise CiEvidenceIntakeError(exc.code, str(exc)) from exc
        streams: dict[str, dict[date, list[float]]] = parsed_nem12["streams"]
        aligned_stream_ids = set(parsed_nem12["aligned_stream_ids"])
        complete_stream_set = aligned_stream_ids == {"E1", "B1", "Q1", "K1"}
        annual_import_profile = _latest_complete_annual_import_profile(
            {
                meter_day: math.fsum(values)
                for meter_day, values in streams["E1"].items()
                if len(values) == 288
            }
        )
        return {
            "input_format": "nem12_standard",
            "nmi": parsed_nem12["nmi"],
            "coverage_start": min(streams["E1"]).isoformat(),
            "coverage_end": max(streams["E1"]).isoformat(),
            "interval_minutes": 5,
            "stream_ids": sorted(streams),
            "aligned_stream_ids": sorted(aligned_stream_ids),
            "missing_stream_ids": parsed_nem12["missing_stream_ids"],
            "unaligned_stream_ids": parsed_nem12["unaligned_stream_ids"],
            "capability_status": _stream_capability(aligned_stream_ids),
            "full_tariff_analysis_ready": complete_stream_set,
            "day_count": len(streams["E1"]),
            "quality_method_counts": parsed_nem12["quality_method_counts"],
            "quality_override_count": parsed_nem12["quality_override_count"],
            "capability_message": (
                "Aligned E1, B1, Q1 and K1 streams are present."
                if complete_stream_set
                else "E1 active import is available for Setup and the active-demand heatmap; missing or unaligned optional streams limit later analysis."
            ),
            "interval_message": "Five-minute intervals can be aggregated to the 15-minute measured-demand basis.",
            "annual_demand_heatmap": _annual_demand_heatmap(
                streams["E1"],
                streams["Q1"] if "Q1" in aligned_stream_ids else None,
            ),
            "annual_import_profile": annual_import_profile,
        }
    return _parse_wide_interval_csv(text)


def _parse_wide_interval_csv(text: str) -> dict[str, Any]:
    nmis, readings, quality_counts, headings = _read_wide_interval_rows(text)
    timestamps = sorted(readings)
    use_kva = all(readings[item]["kva"] is not None for item in timestamps)
    demand_key = "kva" if use_kva else "kw"
    if not any(readings[item][demand_key] is not None for item in timestamps):
        raise CiEvidenceIntakeError(
            "interval_demand_unavailable",
            "The wide interval export does not contain usable kW or kVA demand values.",
        )
    if not quality_counts:
        quality_counts["not_supplied"] = len(readings)
    heatmap = _wide_interval_heatmap(
        {item: readings[item][demand_key] for item in timestamps},
        unit="kVA" if use_kva else "kW",
    )
    source_columns = [
        label
        for label in ("E", "B", "Q", "K", "kWh", "kW", "kVA", "PowerFactor")
        if label.lower() in headings
    ]
    rows_by_day: dict[date, list[datetime]] = {}
    for timestamp in timestamps:
        rows_by_day.setdefault(timestamp.date(), []).append(timestamp)
    daily_import_kwh: dict[date, float] = {}
    for meter_day, day_rows in sorted(rows_by_day.items()):
        day_kw = [readings[item]["kw"] for item in day_rows]
        if len(day_rows) == 48 and all(value is not None for value in day_kw):
            daily_import_kwh[meter_day] = math.fsum(
                float(value) * 0.5 for value in day_kw if value is not None
            )
    return {
        "input_format": "wide_interval_30_minute",
        "nmi": next(iter(nmis)),
        "coverage_start": timestamps[0].date().isoformat(),
        "coverage_end": timestamps[-1].date().isoformat(),
        "interval_minutes": 30,
        "stream_ids": source_columns,
        "aligned_stream_ids": ["kVA" if use_kva else "kW"],
        "missing_stream_ids": ["E1", "B1", "Q1", "K1"],
        "unaligned_stream_ids": [],
        "capability_status": (
            "measured_apparent_demand" if use_kva else "measured_active_demand"
        ),
        "full_tariff_analysis_ready": False,
        "day_count": len({item.date() for item in timestamps}),
        "quality_method_counts": quality_counts,
        "quality_override_count": 0,
        "capability_message": (
            "The 30-minute wide export provides reported kVA for Setup and measured-demand visualization."
            if use_kva
            else "The 30-minute wide export provides reported kW for Setup and measured-demand visualization."
        ),
        "interval_message": "Thirty-minute measurements are preserved at their source resolution; they are not upsampled into 15-minute billing demand.",
        "annual_demand_heatmap": heatmap,
        "annual_import_profile": _latest_complete_annual_import_profile(
            daily_import_kwh
        ),
    }


def _read_wide_interval_rows(
    text: str,
) -> tuple[
    set[str],
    dict[datetime, dict[str, float | None]],
    Counter[str],
    dict[str, str],
]:
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",\t;")
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    except csv.Error as exc:
        raise CiEvidenceIntakeError(
            "interval_upload_invalid",
            "The interval file delimiter or header could not be recognized.",
        ) from exc
    if reader.fieldnames is None:
        raise CiEvidenceIntakeError(
            "interval_upload_invalid", "The interval file header is missing."
        )
    headings = {name.strip().lower(): name for name in reader.fieldnames if name}
    required = {"nmi", "readingdatetime"}
    if not required <= set(headings) or not ({"kw", "kva"} & set(headings)):
        raise CiEvidenceIntakeError(
            "interval_header_unsupported",
            "The wide interval export must contain NMI, ReadingDateTime and at least one of kW or kVA.",
        )

    nmis: set[str] = set()
    readings: dict[datetime, dict[str, float | None]] = {}
    quality_counts: Counter[str] = Counter()
    for row_number, row in enumerate(reader, start=2):
        if not any(str(value or "").strip() for value in row.values()):
            continue
        nmi = str(row.get(headings["nmi"], "") or "").strip()
        timestamp_raw = str(
            row.get(headings["readingdatetime"], "") or ""
        ).strip()
        if not nmi or not timestamp_raw:
            raise CiEvidenceIntakeError(
                "interval_row_invalid",
                f"The wide interval export has a missing NMI or ReadingDateTime at row {row_number}.",
            )
        timestamp = _wide_interval_datetime(timestamp_raw)
        if timestamp in readings:
            raise CiEvidenceIntakeError(
                "interval_row_ambiguous",
                "The wide interval export contains more than one row for the same timestamp. Export one site-total row per interval before upload.",
            )
        nmis.add(nmi.upper())
        readings[timestamp] = {
            "kw": _optional_interval_number(row, headings.get("kw"), row_number),
            "kva": _optional_interval_number(row, headings.get("kva"), row_number),
        }
        if "quality" in headings:
            quality = str(row.get(headings["quality"], "") or "").strip()
            quality_counts[quality or "unknown"] += 1

    if len(nmis) != 1 or len(readings) < 2:
        raise CiEvidenceIntakeError(
            "interval_upload_invalid",
            "The wide interval export must contain at least two readings for exactly one NMI.",
        )
    timestamps = sorted(readings)
    intervals = {
        int((right - left).total_seconds() // 60)
        for left, right in zip(timestamps, timestamps[1:])
        if left.date() == right.date()
    }
    if (
        not intervals
        or any(value <= 0 or value % 30 != 0 for value in intervals)
        or any(item.minute not in {0, 30} for item in timestamps)
    ):
        raise CiEvidenceIntakeError(
            "interval_width_unsupported",
            "This wide interval format currently requires a consistent 30-minute ReadingDateTime step.",
        )
    return nmis, readings, quality_counts, headings


def _wide_interval_datetime(value: str) -> datetime:
    normalized = re.sub(
        r"\s+(?:AEST|AEDT)$", "", value.strip(), flags=re.IGNORECASE
    ).replace("T", " ").removesuffix("Z")
    try:
        parsed = datetime.fromisoformat(normalized)
        return parsed.replace(tzinfo=None)
    except ValueError:
        pass
    for pattern in (
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y %I:%M:%S %p",
        "%d/%m/%Y %I:%M %p",
        "%d-%m-%Y %H:%M:%S",
        "%d-%m-%Y %H:%M",
    ):
        try:
            return datetime.strptime(normalized, pattern)
        except ValueError:
            continue
    raise CiEvidenceIntakeError(
        "interval_datetime_invalid",
        "ReadingDateTime must use an ISO or Australian day/month/year date-time format.",
    )


def _optional_interval_number(
    row: dict[str, str | None], heading: str | None, row_number: int
) -> float | None:
    if heading is None:
        return None
    raw = str(row.get(heading, "") or "").strip().replace(",", "")
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError as exc:
        raise CiEvidenceIntakeError(
            "interval_row_invalid",
            f"The {heading} value at row {row_number} is not numeric.",
        ) from exc
    if not math.isfinite(value) or value < 0:
        raise CiEvidenceIntakeError(
            "interval_row_invalid",
            f"The {heading} value at row {row_number} must be a finite non-negative number.",
        )
    return value


def _wide_interval_heatmap(
    readings: dict[datetime, float | None], *, unit: str
) -> dict[str, object]:
    rows_by_day: dict[date, list[float | None]] = {}
    for timestamp, amount in readings.items():
        values = rows_by_day.setdefault(timestamp.date(), [None] * 48)
        slot = timestamp.hour * 2 + timestamp.minute // 30
        values[slot] = round(amount, 6) if amount is not None else None
    return _annual_heatmap_contract(
        rows_by_day,
        interval_minutes=30,
        metric=(
            "measured_apparent_demand" if unit == "kVA" else "measured_active_demand"
        ),
        source_streams=[unit],
        unit=unit,
        reactive_data_status=(
            "reported_apparent_demand" if unit == "kVA" else "unavailable_active_only"
        ),
        time_basis="source_local_time_unverified",
    )


def _annual_demand_heatmap(
    active_rows: dict[date, list[float]],
    reactive_rows: dict[date, list[float]] | None = None,
) -> dict[str, object]:
    """Aggregate fixed-AEST E1 and optional Q1 into 15-minute demand rows."""
    rows_by_day: dict[date, list[float | None]] = {}
    for meter_day in sorted(active_rows):
        rows_by_day[meter_day] = [
            (
                math.hypot(
                    sum(active_rows[meter_day][index : index + 3]) * 4,
                    sum(reactive_rows[meter_day][index : index + 3]) * 4,
                )
                if reactive_rows is not None
                else sum(active_rows[meter_day][index : index + 3]) * 4
            )
            for index in range(0, 288, 3)
        ]
    return _annual_heatmap_contract(
        rows_by_day,
        interval_minutes=15,
        metric=(
            "measured_apparent_demand"
            if reactive_rows is not None
            else "measured_active_demand"
        ),
        source_streams=["E1", "Q1"] if reactive_rows is not None else ["E1"],
        unit="kVA" if reactive_rows is not None else "kW",
        reactive_data_status=(
            "available" if reactive_rows is not None else "unavailable_active_only"
        ),
        time_basis="fixed_aest_meter_time",
    )


def _annual_heatmap_contract(
    rows_by_day: dict[date, list[float | None]],
    *,
    interval_minutes: int,
    metric: str,
    source_streams: list[str],
    unit: str,
    reactive_data_status: str,
    time_basis: str,
) -> dict[str, object]:
    rows_by_year: dict[int, list[dict[str, object]]] = {}
    values_by_year: dict[int, list[float]] = {}
    intervals_per_day = 1440 // interval_minutes
    for meter_day in sorted(rows_by_day):
        row = rows_by_day[meter_day]
        if len(row) != intervals_per_day:
            raise CiEvidenceIntakeError(
                "interval_upload_invalid",
                "The interval rows do not match the declared time step.",
            )
        rounded = [round(value, 6) if value is not None else None for value in row]
        rows_by_year.setdefault(meter_day.year, []).append(
            {"date": meter_day.isoformat(), "interval_demand": rounded}
        )
        values_by_year.setdefault(meter_day.year, []).extend(
            value for value in row if value is not None
        )

    years = []
    for year, days in sorted(rows_by_year.items()):
        measured = values_by_year[year]
        if not measured:
            continue
        first_day = date.fromisoformat(str(days[0]["date"]))
        last_day = date.fromisoformat(str(days[-1]["date"]))
        calendar_start = date(year, 1, 1)
        calendar_end = date(year, 12, 31)
        expected_day_count = (calendar_end - calendar_start).days + 1
        years.append(
            {
                "year": year,
                "coverage_start": first_day.isoformat(),
                "coverage_end": last_day.isoformat(),
                "day_count": len(days),
                "complete_calendar_year": (
                    first_day == calendar_start
                    and last_day == calendar_end
                    and len(days) == expected_day_count
                    and len(measured) == len(days) * intervals_per_day
                ),
                "interval_count": len(measured),
                "expected_interval_count": len(days) * intervals_per_day,
                "missing_interval_count": len(days) * intervals_per_day
                - len(measured),
                "maximum_interval_demand": round(max(measured), 6),
                "average_interval_demand": round(sum(measured) / len(measured), 6),
                "days": days,
            }
        )

    return {
        "metric": metric,
        "source_streams": source_streams,
        "unit": unit,
        "reactive_data_status": reactive_data_status,
        "interval_minutes": interval_minutes,
        "time_basis": time_basis,
        "tariff_window_status": "not_applied_pre_tariff",
        "shared_scale_maximum_demand": round(
            max(max(values) for values in values_by_year.values() if values), 6
        ),
        "years": years,
    }


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if not reader.pages or len(reader.pages) > MAX_CI_BILL_PAGES:
            raise ValueError("unsupported page count")
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:
        raise CiEvidenceIntakeError(
            "bill_pdf_unreadable",
            "The electricity bill PDF could not be read safely.",
        ) from exc
    if len(text) > 250_000:
        raise CiEvidenceIntakeError(
            "bill_pdf_unreadable",
            "The electricity bill PDF contains too much extracted text.",
        )
    return text


def _parse_invoice_text(
    raw_text: str, *, bill_review: dict[str, object] | None
) -> dict[str, Any]:
    try:
        bill = _parse_origin_invoice_text(raw_text)
        if bill_review is None:
            return bill
    except CiEvidenceIntakeError:
        bill = _parse_generic_invoice_text(raw_text)
    return _apply_bill_review(bill, bill_review)


def _parse_origin_invoice_text(raw_text: str) -> dict[str, Any]:
    text = _normalise_invoice_text(raw_text)
    if "Business Electricity Tax Invoice" not in text or "originenergy.com.au" not in text:
        raise CiEvidenceIntakeError(
            "bill_format_unsupported",
            "The current intake parser supports readable Origin business electricity tax invoices only.",
        )

    nmi = _required_match(text, r"\bNMI\s*:?\s*([A-Z0-9]{10,11})\b", "bill site identity")
    period_match = re.search(
        r"Business Electricity Tax Invoice\s+(\d{2}\s+[A-Za-z]{3}\s+\d{2})\s*[-–]\s*(\d{2}\s+[A-Za-z]{3}\s+\d{2})",
        text,
    ) or re.search(
        r"Charge Period\s+(\d{2}\s+[A-Za-z]{3}\s+\d{2})\s+to\s+(\d{2}\s+[A-Za-z]{3}\s+\d{2})",
        text,
    )
    if period_match is None:
        raise CiEvidenceIntakeError("bill_parse_incomplete", "The invoice period could not be extracted.")
    billing_start = _bill_date(period_match.group(1))
    billing_end = _bill_date(period_match.group(2))
    days = int(_required_match(text, r"No\. of Days\s+(\d+)", "invoice day count"))
    network_tariff_code = _required_match(text, r"Tariff:\s*([A-Z0-9-]+)", "network tariff code")

    summary_match = re.search(r"INVOICE SUMMARY\s+(.*?)\s+INVOICE CHARGE SUMMARY", text)
    if summary_match is None:
        raise CiEvidenceIntakeError("bill_parse_incomplete", "The invoice summary could not be extracted.")
    summary = summary_match.group(1)
    categories = {
        "energy_charges": _money_match(summary, "Energy Charges"),
        "network_charges": _money_match(summary, "Network Charges"),
        "regulated_charges": _money_match(summary, "Regulated Charges"),
        "environmental_charges": _money_match(summary, "Environmental Charges"),
        "metering_charges": _money_match(summary, "Metering Charges"),
        "additional_charges": _money_match(summary, "Additional Charges, Credits & Adjustments"),
    }
    subtotal = _money_match(summary, "Sub-Total")
    gst = _money_match(summary, "GST")
    total = _money_match(summary, "Total")
    category_total = round(sum(categories.values()), 2)
    invoice_arithmetic_reconciled = (
        abs(category_total - subtotal) <= 0.02
        and abs(round(subtotal + gst, 2) - total) <= 0.02
        and (billing_end - billing_start).days + 1 == days
    )

    return {
        "retailer": "Origin Energy",
        "invoice_kind": "Business Electricity Tax Invoice",
        "extraction_method": "verified_origin_template",
        "review_status": "not_required",
        "missing_fields": [],
        "invoice_arithmetic_scope": "charge_categories_and_totals",
        "nmi": nmi,
        "site_address": _site_address(raw_text),
        "billing_period_start": billing_start.isoformat(),
        "billing_period_end": billing_end.isoformat(),
        "billing_days": days,
        "network_tariff_code": network_tariff_code,
        "consumption_kwh": _number_match(text, r"Consumption this period:\s*([\d,]+(?:\.\d+)?)\s*kWh", "consumption"),
        "highest_metered_demand_kva": _number_match(text, r"Highest metered demand this period is\s*([\d,]+(?:\.\d+)?)\s*kVA", "highest demand"),
        "power_factor_at_highest_demand": _number_match(text, r"Power Factor at highest demand\s*([\d.]+)", "power factor"),
        "charge_categories_ex_gst_aud": categories,
        "subtotal_ex_gst_aud": subtotal,
        "gst_aud": gst,
        "total_inc_gst_aud": total,
        "invoice_arithmetic_reconciled": invoice_arithmetic_reconciled,
    }


_DATE_TOKEN = (
    r"(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}"
    r"|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"
    r"|\d{4}-\d{2}-\d{2})"
)


def _parse_generic_invoice_text(raw_text: str) -> dict[str, Any]:
    text = _normalise_invoice_text(raw_text)
    period = _generic_period(text)
    billing_start = period[0] if period else None
    billing_end = period[1] if period else None
    subtotal = _optional_money(
        text,
        r"(?:sub\s*-?\s*total|total\s+(?:excluding|ex)\s+GST)",
    )
    gst = _optional_money(text, r"(?:total\s+GST|GST(?:\s+amount)?)")
    total = _optional_money(
        text,
        r"(?:amount\s+due|invoice\s+total|total\s+(?:including|incl?\.?|inc)\s+GST|total)",
        prefer_last=True,
    )
    bill: dict[str, Any] = {
        "retailer": _generic_retailer(raw_text),
        "invoice_kind": _optional_match(
            text,
            r"\b((?:Business\s+)?Electricity\s+(?:Tax\s+)?Invoice|Tax\s+Invoice|Electricity\s+Bill)\b",
        )
        or "Electricity invoice",
        "extraction_method": (
            "generic_pdf_text" if text else "manual_review_only"
        ),
        "review_status": "confirmation_required",
        "invoice_arithmetic_scope": "invoice_totals_only",
        "nmi": _optional_match(
            text,
            r"\b(?:NMI|National\s+Meter(?:ing)?\s+Identifier)\s*[:#-]?\s*([A-Z0-9]{10,11})\b",
        ),
        "site_address": _site_address(raw_text),
        "billing_period_start": billing_start.isoformat() if billing_start else None,
        "billing_period_end": billing_end.isoformat() if billing_end else None,
        "billing_days": (
            (billing_end - billing_start).days + 1
            if billing_start and billing_end and billing_end >= billing_start
            else None
        ),
        "network_tariff_code": _optional_match(
            text,
            r"\b(?:Network\s+Tariff(?:\s+Code)?|Tariff\s+Code|Tariff)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{1,39})\b",
        ),
        "consumption_kwh": _optional_number(
            text,
            r"(?:Consumption(?:\s+this\s+period)?|Total\s+(?:electricity\s+)?(?:usage|consumption)|Usage\s+this\s+period)\s*[:#-]?\s*([\d,]+(?:\.\d+)?)\s*kWh",
        ),
        "highest_metered_demand_kva": _optional_number(
            text,
            r"(?:Highest\s+metered\s+demand(?:\s+this\s+period\s+is)?|Maximum\s+demand|Peak\s+demand)\s*[:#-]?\s*([\d,]+(?:\.\d+)?)\s*kVA",
        ),
        "power_factor_at_highest_demand": _optional_number(
            text,
            r"(?:Power\s+Factor(?:\s+at\s+(?:highest|maximum)\s+demand)?|PF)\s*[:#-]?\s*([\d.]+)",
        ),
        "charge_categories_ex_gst_aud": {},
        "subtotal_ex_gst_aud": subtotal,
        "gst_aud": gst,
        "total_inc_gst_aud": total,
        "invoice_arithmetic_reconciled": _totals_reconcile(
            subtotal, gst, total, billing_start, billing_end
        ),
    }
    bill["missing_fields"] = _missing_bill_fields(bill)
    return bill


def _apply_bill_review(
    bill: dict[str, Any], bill_review: dict[str, object] | None
) -> dict[str, Any]:
    if bill_review is None:
        bill["missing_fields"] = _missing_bill_fields(bill)
        return bill
    reviewed = dict(bill)
    for key in (
        "retailer",
        "invoice_kind",
        "billing_period_start",
        "billing_period_end",
        "network_tariff_code",
        "consumption_kwh",
        "highest_metered_demand_kva",
        "power_factor_at_highest_demand",
        "subtotal_ex_gst_aud",
        "gst_aud",
        "total_inc_gst_aud",
    ):
        reviewed[key] = bill_review[key]
    if bill_review.get("nmi") is not None:
        reviewed["nmi"] = str(bill_review["nmi"]).upper()
    billing_start = date.fromisoformat(str(reviewed["billing_period_start"]))
    billing_end = date.fromisoformat(str(reviewed["billing_period_end"]))
    if billing_end < billing_start:
        raise CiEvidenceIntakeError(
            "bill_review_invalid",
            "The confirmed invoice period end must not be before its start.",
        )
    reviewed["billing_days"] = (billing_end - billing_start).days + 1
    reviewed["invoice_arithmetic_scope"] = "invoice_totals_only"
    reviewed["invoice_arithmetic_reconciled"] = _totals_reconcile(
        reviewed["subtotal_ex_gst_aud"],
        reviewed["gst_aud"],
        reviewed["total_inc_gst_aud"],
        billing_start,
        billing_end,
    )
    reviewed["extraction_method"] = (
        f"{bill['extraction_method']}_with_analyst_confirmation"
    )
    reviewed["missing_fields"] = _missing_bill_fields(reviewed)
    reviewed["review_status"] = (
        "analyst_confirmed" if not reviewed["missing_fields"] else "confirmation_required"
    )
    return reviewed


def _generic_period(text: str) -> tuple[date, date] | None:
    patterns = (
        rf"(?:Billing|Bill|Charge|Supply|Invoice)\s+Period\s*[:#-]?\s*({_DATE_TOKEN})\s*(?:to|[-–])\s*({_DATE_TOKEN})",
        rf"(?:Billing|Bill|Charge|Supply)\s+(?:from\s+)?({_DATE_TOKEN})\s*(?:to|[-–])\s*({_DATE_TOKEN})",
        rf"\bFrom\s+({_DATE_TOKEN})\s+to\s+({_DATE_TOKEN})",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match is None:
            continue
        try:
            return _parse_generic_date(match.group(1)), _parse_generic_date(
                match.group(2)
            )
        except ValueError:
            continue
    return None


def _parse_generic_date(value: str) -> date:
    clean = re.sub(r"\s+", " ", value.strip())
    for format_string in (
        "%d %b %y",
        "%d %b %Y",
        "%d %B %y",
        "%d %B %Y",
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d.%m.%Y",
        "%d/%m/%y",
        "%d-%m-%y",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(clean, format_string).date()
        except ValueError:
            continue
    raise ValueError("unsupported bill date")


def _generic_retailer(raw_text: str) -> str:
    text = _normalise_invoice_text(raw_text)
    known = (
        "AGL",
        "Alinta Energy",
        "Blue NRG",
        "Dodo Power & Gas",
        "EnergyAustralia",
        "Energy Locals",
        "ENGIE",
        "Lumo Energy",
        "Momentum Energy",
        "Origin Energy",
        "Powershop",
        "Red Energy",
        "Shell Energy",
        "Simply Energy",
    )
    for retailer in known:
        if re.search(rf"\b{re.escape(retailer)}\b", text, flags=re.IGNORECASE):
            return retailer
    return "Electricity retailer — confirm name"


_SITE_ADDRESS_LABEL = re.compile(
    r"\b(?:electricity\s+)?(?:supply|service|site|premises|property|metering)\s+address\b\s*[:#-]?\s*",
    flags=re.IGNORECASE,
)
_AUSTRALIAN_SITE_ADDRESS = re.compile(
    r"(?P<address>"
    r"(?:(?:UNIT|SHOP|LOT|LEVEL|SUITE|FACTORY|TENANCY)\s+[A-Z0-9-]+\s*[,/-]?\s*)?"
    r"(?:\d{1,6}[A-Z]?(?:\s*[/,-]\s*\d{1,6}[A-Z]?)?)\s+"
    r"[A-Z0-9][A-Z0-9&'()./\-\s]{1,120}?\s+"
    r"(?:STREET|ST|ROAD|RD|AVENUE|AVE|DRIVE|DR|COURT|CT|HIGHWAY|HWY|PLACE|PL|"
    r"LANE|LN|CRESCENT|CRES|BOULEVARD|BLVD|PARADE|PDE|WAY|TERRACE|TCE|CLOSE|CL|"
    r"CIRCUIT|CCT|ESPLANADE|ESP|GROVE|GR|RISE|SQUARE|SQ)\b"
    r"[A-Z0-9&'()./\-,\s]{0,80}?\b"
    r"(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}\b"
    r")",
    flags=re.IGNORECASE,
)


def _site_address(raw_text: str) -> str | None:
    """Return a labelled street address and reject mailing-address guesswork."""
    if not raw_text:
        return None
    text = re.sub(r"[\t\r\n]+", " ", raw_text)
    text = re.sub(r"\s+", " ", text).strip()
    for label in _SITE_ADDRESS_LABEL.finditer(text):
        candidate = _AUSTRALIAN_SITE_ADDRESS.match(text, label.end())
        if candidate is None:
            continue
        address = re.sub(r"\s+", " ", candidate.group("address")).strip(" ,.-")
        if "PO BOX" not in address.upper() and len(address) <= 240:
            return address
    return None


def _optional_match(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    return match.group(1).strip() if match else None


def _optional_number(text: str, pattern: str) -> float | None:
    raw = _optional_match(text, pattern)
    if raw is None:
        return None
    value = float(raw.replace(",", ""))
    return value if math.isfinite(value) and value >= 0 else None


def _optional_money(
    text: str, label_pattern: str, *, prefer_last: bool = False
) -> float | None:
    matches = list(
        re.finditer(
            rf"\b{label_pattern}\b\s*[:#-]?\s*(?:AUD\s*)?\$?\s*([\d,]+(?:\.\d{{2}})?)",
            text,
            flags=re.IGNORECASE,
        )
    )
    if not matches:
        return None
    raw = matches[-1 if prefer_last else 0].group(1)
    value = float(raw.replace(",", ""))
    return value if math.isfinite(value) and value >= 0 else None


def _totals_reconcile(
    subtotal: object,
    gst: object,
    total: object,
    billing_start: date | None,
    billing_end: date | None,
) -> bool:
    if (
        not isinstance(subtotal, (int, float))
        or not isinstance(gst, (int, float))
        or not isinstance(total, (int, float))
        or billing_start is None
        or billing_end is None
        or billing_end < billing_start
    ):
        return False
    return abs(round(float(subtotal) + float(gst), 2) - float(total)) <= 0.02


def _missing_bill_fields(bill: dict[str, Any]) -> list[str]:
    fields = {
        "nmi": "site_identity",
        "billing_period_start": "billing_period_start",
        "billing_period_end": "billing_period_end",
        "network_tariff_code": "network_tariff_code",
        "consumption_kwh": "consumption_kwh",
        "highest_metered_demand_kva": "highest_metered_demand_kva",
        "power_factor_at_highest_demand": "power_factor_at_highest_demand",
        "subtotal_ex_gst_aud": "subtotal_ex_gst_aud",
        "gst_aud": "gst_aud",
        "total_inc_gst_aud": "total_inc_gst_aud",
    }
    return [label for key, label in fields.items() if bill.get(key) is None]


def _normalise_invoice_text(value: str) -> str:
    replacements = {
        "AC COUNT": "ACCOUNT",
        "Ac count": "Account",
        "Networ k": "Network",
        "Char ges": "Charges",
        "char ges": "charges",
        "Adjustmen ts": "Adjustments",
        "F actor": "Factor",
        "Amoun t": "Amount",
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    return re.sub(r"\s+", " ", value).strip()


def _required_match(text: str, pattern: str, label: str) -> str:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    if match is None:
        raise CiEvidenceIntakeError("bill_parse_incomplete", f"The {label} could not be extracted.")
    return match.group(1).strip()


def _number_match(text: str, pattern: str, label: str) -> float:
    raw = _required_match(text, pattern, label)
    value = float(raw.replace(",", ""))
    if not math.isfinite(value) or value < 0:
        raise CiEvidenceIntakeError("bill_parse_incomplete", f"The {label} is invalid.")
    return value


def _money_match(text: str, label: str) -> float:
    pattern = rf"(?<![\w-]){re.escape(label)}\s*\$([\d,]+(?:\.\d{{2}})?)"
    return _number_match(text, pattern, label)


def _bill_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%d %b %y").date()
    except ValueError as exc:
        raise CiEvidenceIntakeError("bill_parse_incomplete", "The invoice date is invalid.") from exc


def _stream_capability(aligned_stream_ids: set[str]) -> str:
    if {"E1", "B1", "Q1", "K1"} <= aligned_stream_ids:
        return "full_active_reactive_import_export"
    if {"E1", "Q1"} <= aligned_stream_ids:
        return "active_reactive_import"
    if {"E1", "B1"} <= aligned_stream_ids:
        return "active_import_export"
    return "active_import_only"


def _check(
    code: str,
    passed: bool,
    success: str,
    failure: str,
    *,
    severity: str | None = None,
) -> dict[str, object]:
    return {
        "code": code,
        "passed": passed,
        "severity": severity or ("pass" if passed else "error"),
        "message": success if passed else failure,
    }

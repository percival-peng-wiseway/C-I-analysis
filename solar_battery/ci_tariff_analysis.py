from __future__ import annotations

import csv
import io
import json
import math
import os
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


CI_TARIFF_PROFILE_CONTRACT_VERSION = "ci_tariff_profile_v1"
CI_ANALYSIS_CONTRACT_VERSION = "ci_interval_tariff_analysis_v1"
DEFAULT_CI_TARIFF_PROFILE_PATH = Path(".local/ci/active-tariff-profile.json")
MAX_CI_NEM12_UPLOAD_BYTES = 25 * 1024 * 1024

_REQUIRED_STREAMS = {
    "E1": "KWH",
    "B1": "KWH",
    "Q1": "KVARH",
    "K1": "KVARH",
}
_SAFE_MESSAGES = {
    "profile_unavailable": "The local C&I tariff evidence profile is unavailable.",
    "profile_invalid": "The local C&I tariff evidence profile is invalid.",
    "upload_invalid": "The uploaded C&I NEM12 file could not be validated safely.",
    "stream_contract_mismatch": (
        "The uploaded C&I NEM12 file does not contain the required aligned "
        "E1, B1, Q1 and K1 interval streams."
    ),
    "evidence_identity_mismatch": (
        "The uploaded C&I NEM12 file does not match the active local evidence profile."
    ),
    "coverage_incomplete": (
        "The uploaded C&I NEM12 file does not cover the complete bill and rolling-demand periods."
    ),
    "bill_reconciliation_failed": (
        "The uploaded C&I data did not reconcile to the evidence-bound bill checks."
    ),
}


class CiTariffAnalysisError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(_SAFE_MESSAGES[code])
        self.code = code


def active_ci_tariff_profile_path() -> Path:
    return Path(os.getenv("CI_TARIFF_PROFILE_PATH", DEFAULT_CI_TARIFF_PROFILE_PATH))


def load_ci_tariff_profile(
    path: str | Path | None = None,
) -> dict[str, Any]:
    profile_path = active_ci_tariff_profile_path() if path is None else Path(path)
    if not profile_path.is_file():
        raise CiTariffAnalysisError("profile_unavailable")
    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
        _validate_profile(payload)
    except CiTariffAnalysisError:
        raise
    except Exception as exc:
        raise CiTariffAnalysisError("profile_invalid") from exc
    return payload


def ci_analysis_availability(
    path: str | Path | None = None,
) -> dict[str, object]:
    try:
        profile = load_ci_tariff_profile(path)
    except CiTariffAnalysisError:
        return {
            "availability": "unavailable",
            "profile_id": None,
            "profile_label": None,
        }
    return {
        "availability": "evidence_limited",
        "profile_id": profile["profile_id"],
        "profile_label": profile["display_label"],
    }


def analyze_ci_nem12(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    _validated_evidence: dict[str, Any] | None = None,
) -> dict[str, object]:
    parsed = (
        validated_ci_nem12_evidence(upload_bytes, profile=profile)
        if _validated_evidence is None
        else _revalidate_ci_nem12_evidence(
            upload_bytes,
            profile=profile,
            parsed=_validated_evidence,
        )
    )
    facts = _ci_tariff_metered_facts(parsed, profile)
    streams = facts["streams"]
    bill_start = facts["bill_start"]
    bill_end = facts["bill_end"]
    rolling_peak = facts["rolling_peak"]
    incentive_peak = facts["incentive_peak"]
    bill_peak = facts["bill_peak"]
    quantities = facts["quantities"]
    chargeable_rolling_kva = quantities["rolling_demand_kva"]
    charges = calculate_ci_tariff_charges(quantities, profile)
    checks = _reconciliation_checks(quantities, charges, profile)
    if not all(check["passed"] for check in checks):
        raise CiTariffAnalysisError("bill_reconciliation_failed")

    coverage_start = min(streams["E1"])
    coverage_end = max(streams["E1"])
    quality_method_counts: Counter[str] = parsed["quality_method_counts"]
    warning_codes = []
    if any(method != "A" for method in quality_method_counts):
        warning_codes.append("nem12_quality_method_review")
    if parsed["quality_override_count"]:
        warning_codes.append("nem12_quality_overrides_present")

    return {
        "contract_version": CI_ANALYSIS_CONTRACT_VERSION,
        "analysis_status": "ready",
        "analysis_mode": "evidence_limited_internal_review",
        "customer_facing_permission": False,
        "profile": {
            "profile_id": profile["profile_id"],
            "display_label": profile["display_label"],
            "network_tariff_code": profile["network_tariff_code"],
            "billing_period_start": bill_start.isoformat(),
            "billing_period_end": bill_end.isoformat(),
            "source_version": profile["source_version"],
        },
        "data_quality": {
            "status": "review" if warning_codes else "pass",
            "coverage_start": coverage_start.isoformat(),
            "coverage_end": coverage_end.isoformat(),
            "interval_minutes": 5,
            "interval_count_per_required_stream": len(streams["E1"]) * 288,
            "required_streams_present": True,
            "quality_method_counts": dict(sorted(quality_method_counts.items())),
            "quality_override_count": parsed["quality_override_count"],
            "warning_codes": warning_codes,
        },
        "tariff_mapping": {
            "meter_time_basis": profile["meter_time_basis"],
            "local_timezone": profile["timezone_name"],
            "demand_interval_minutes": 15,
            "rolling_demand_months": 12,
            "minimum_chargeable_rolling_kva": profile[
                "minimum_chargeable_rolling_kva"
            ],
            "network_peak_window": _window_label(profile["network_energy_window"]),
            "incentive_window": _window_label(profile["incentive_demand_window"]),
            "gst_basis": profile["gst_basis"],
        },
        "demand_evidence": {
            "rolling_demand_kva": _round(rolling_peak["kva"], 3),
            "chargeable_rolling_demand_kva": _round(chargeable_rolling_kva, 3),
            "rolling_demand_timestamp": rolling_peak["local_end"].isoformat(),
            "incentive_demand_kva": _round(incentive_peak["kva"], 3),
            "incentive_demand_timestamp": incentive_peak["local_end"].isoformat(),
            "billing_period_max_kva": _round(bill_peak["kva"], 3),
            "billing_period_max_kw": _round(bill_peak["kw"], 3),
            "billing_period_max_kvar": _round(bill_peak["kvar"], 3),
            "billing_period_max_power_factor": _round(
                bill_peak["power_factor"], 3
            ),
            "billing_period_max_timestamp": bill_peak["local_end"].isoformat(),
        },
        "bill_reconciliation": {
            "status": "pass",
            "checks": checks,
            "calculated_subtotal_ex_gst_aud": charges["subtotal_ex_gst_aud"],
            "calculated_gst_aud": charges["gst_aud"],
            "calculated_total_inc_gst_aud": charges["total_inc_gst_aud"],
            "charge_categories": charges["categories"],
        },
        "assumptions": [
            "The active local profile is bound to one approved bill and NEM12 evidence pair.",
            "Network local-time windows are converted from fixed AEST meter intervals.",
            "Reactive import Q1 is paired with active import E1 for 15-minute kVA.",
            "Results are internal review only and do not grant tariff eligibility or customer-facing permission.",
        ],
    }


def bind_ci_tariff_profile_to_nem12(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
) -> dict[str, Any]:
    """Return a server-reconciled calculation profile for one evidence pair.

    The editable project tariff never owns source hashes, metered quantities or
    expected reconciliation.  Those fields are rebuilt here from the current
    saved NEM12 immediately before an analyst-approved profile can be used.
    """
    parsed = validated_ci_nem12_evidence(upload_bytes, profile=profile)
    facts = _ci_tariff_metered_facts(parsed, profile)
    quantities = facts["quantities"]
    charges = calculate_ci_tariff_charges(quantities, profile)
    bound = json.loads(json.dumps(profile, sort_keys=True, allow_nan=False))
    bound["expected_reconciliation"] = {
        **quantities,
        **{
            f"category_{key}_aud": value
            for key, value in charges["categories"].items()
        },
        "subtotal_ex_gst_aud": charges["subtotal_ex_gst_aud"],
        "gst_aud": charges["gst_aud"],
        "total_inc_gst_aud": charges["total_inc_gst_aud"],
    }
    _validate_profile(bound)
    return bound


def _ci_tariff_metered_facts(
    parsed: dict[str, Any], profile: dict[str, Any]
) -> dict[str, Any]:
    streams: dict[str, dict[date, list[float]]] = parsed["streams"]
    bill_start = date.fromisoformat(profile["billing_period"]["start_date"])
    bill_end = date.fromisoformat(profile["billing_period"]["end_date"])
    rolling_start = date.fromisoformat(profile["rolling_period"]["start_date"])
    rolling_end = date.fromisoformat(profile["rolling_period"]["end_date"])
    required_dates = _date_range(rolling_start, rolling_end)
    analysis_period = profile.get("analysis_period", profile["rolling_period"])
    analysis_dates = _date_range(
        date.fromisoformat(analysis_period["start_date"]),
        date.fromisoformat(analysis_period["end_date"]),
    )
    bill_dates = _date_range(bill_start, bill_end)
    if any(
        day not in streams[stream_id]
        for day in set(required_dates + bill_dates + analysis_dates)
        for stream_id in _REQUIRED_STREAMS
    ):
        raise CiTariffAnalysisError("coverage_incomplete")

    import_kwh = sum(sum(streams["E1"][day]) for day in bill_dates)
    export_kwh = sum(sum(streams["B1"][day]) for day in bill_dates)
    retail_peak_kwh = _energy_in_window(
        streams["E1"],
        bill_dates,
        profile["retail_energy_window"],
        timezone_name=profile["timezone_name"],
    )
    network_peak_kwh = _energy_in_window(
        streams["E1"],
        bill_dates,
        profile["network_energy_window"],
        timezone_name=profile["timezone_name"],
    )
    demand_intervals = _build_demand_intervals(
        streams["E1"], streams["Q1"], timezone_name=profile["timezone_name"]
    )
    rolling_candidates = _demand_in_window(
        demand_intervals, required_dates, profile["rolling_demand_window"]
    )
    incentive_candidates = _demand_in_window(
        demand_intervals, bill_dates, profile["incentive_demand_window"]
    )
    bill_candidates = [
        row for row in demand_intervals if bill_start <= row["meter_date"] <= bill_end
    ]
    if not rolling_candidates or not incentive_candidates or not bill_candidates:
        raise CiTariffAnalysisError("coverage_incomplete")
    rolling_peak = max(rolling_candidates, key=lambda row: row["kva"])
    incentive_peak = max(incentive_candidates, key=lambda row: row["kva"])
    bill_peak = max(bill_candidates, key=lambda row: row["kva"])
    quantities = {
        "import_kwh": import_kwh,
        "export_kwh": export_kwh,
        "retail_peak_kwh": retail_peak_kwh,
        "retail_off_peak_kwh": import_kwh - retail_peak_kwh,
        "network_peak_kwh": network_peak_kwh,
        "network_off_peak_kwh": import_kwh - network_peak_kwh,
        "rolling_demand_kva": max(
            rolling_peak["kva"], float(profile["minimum_chargeable_rolling_kva"])
        ),
        "incentive_demand_kva": incentive_peak["kva"],
        "billing_period_max_kva": bill_peak["kva"],
        "billing_period_max_power_factor": bill_peak["power_factor"],
    }
    return {
        "streams": streams,
        "bill_start": bill_start,
        "bill_end": bill_end,
        "rolling_peak": rolling_peak,
        "incentive_peak": incentive_peak,
        "bill_peak": bill_peak,
        "quantities": quantities,
    }


def validated_ci_nem12_evidence(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
) -> dict[str, Any]:
    """Return parsed streams only after the evidence identity is proven."""
    _validate_profile(profile)
    if not upload_bytes or len(upload_bytes) > MAX_CI_NEM12_UPLOAD_BYTES:
        raise CiTariffAnalysisError("upload_invalid")
    parsed = _parse_ci_nem12(upload_bytes)
    return _revalidate_ci_nem12_evidence(
        upload_bytes,
        profile=profile,
        parsed=parsed,
        upload_identity_already_proven=True,
    )


def _revalidate_ci_nem12_evidence(
    upload_bytes: bytes,
    *,
    profile: dict[str, Any],
    parsed: dict[str, Any],
    upload_identity_already_proven: bool = False,
) -> dict[str, Any]:
    """Cheaply re-check an already parsed payload before request-local reuse."""

    import hashlib

    _validate_profile(profile)
    if not upload_bytes or len(upload_bytes) > MAX_CI_NEM12_UPLOAD_BYTES:
        raise CiTariffAnalysisError("upload_invalid")
    if (
        not isinstance(parsed, dict)
        or (
            not upload_identity_already_proven
            and parsed.get("identity_sha256")
            != hashlib.sha256(upload_bytes).hexdigest()
        )
    ):
        raise CiTariffAnalysisError("evidence_identity_mismatch")
    if parsed["identity_sha256"] != profile["expected_nem12_sha256"]:
        raise CiTariffAnalysisError("evidence_identity_mismatch")
    try:
        streams: dict[str, dict[date, list[float]]] = parsed["streams"]
        if set(streams) != set(_REQUIRED_STREAMS):
            raise CiTariffAnalysisError("stream_contract_mismatch")
    except (AttributeError, KeyError, TypeError) as exc:
        raise CiTariffAnalysisError("stream_contract_mismatch") from exc
    rolling_start = date.fromisoformat(profile["rolling_period"]["start_date"])
    rolling_end = date.fromisoformat(profile["rolling_period"]["end_date"])
    required_dates = _date_range(rolling_start, rolling_end)
    if any(
        day not in streams[register]
        for register in _REQUIRED_STREAMS
        for day in required_dates
    ):
        raise CiTariffAnalysisError("coverage_incomplete")
    return parsed


def _parse_ci_nem12(
    upload_bytes: bytes, *, require_complete_stream_set: bool = True
) -> dict[str, Any]:
    import hashlib

    try:
        text = upload_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CiTariffAnalysisError("upload_invalid") from exc

    streams: dict[str, dict[date, list[float]]] = {}
    stream_units: dict[str, str] = {}
    stream_nmis: set[str] = set()
    quality_method_counts: Counter[str] = Counter()
    quality_override_count = 0
    current_register: str | None = None
    current_supported = False
    try:
        for row in csv.reader(io.StringIO(text)):
            if not row:
                continue
            record_type = row[0].strip()
            if record_type == "200":
                if len(row) < 9:
                    raise ValueError("short 200")
                register = row[3].strip().upper()
                unit = row[7].strip().upper()
                interval_minutes = int(row[8])
                current_supported = register in _REQUIRED_STREAMS
                current_register = register if current_supported else None
                if not current_supported:
                    continue
                if register in streams or unit != _REQUIRED_STREAMS[register]:
                    raise CiTariffAnalysisError("stream_contract_mismatch")
                if interval_minutes != 5:
                    raise CiTariffAnalysisError("stream_contract_mismatch")
                streams[register] = {}
                stream_units[register] = unit
                stream_nmis.add(row[1].strip())
            elif record_type == "300" and current_supported:
                if current_register is None or len(row) < 291:
                    raise ValueError("invalid 300")
                day = datetime.strptime(row[1].strip(), "%Y%m%d").date()
                if day in streams[current_register]:
                    raise ValueError("duplicate day")
                values = [float(value) for value in row[2:290]]
                if len(values) != 288 or any(
                    not math.isfinite(value) or value < 0 for value in values
                ):
                    raise ValueError("invalid values")
                streams[current_register][day] = values
                quality_method_counts[row[290].strip() or "unknown"] += 1
            elif record_type == "400" and current_supported:
                quality_override_count += 1
    except CiTariffAnalysisError:
        raise
    except Exception as exc:
        raise CiTariffAnalysisError("upload_invalid") from exc

    if "E1" not in streams or not streams["E1"] or len(stream_nmis) != 1:
        raise CiTariffAnalysisError("stream_contract_mismatch")
    active_dates = set(streams["E1"])
    aligned_stream_ids = sorted(
        register for register, rows in streams.items() if set(rows) == active_dates
    )
    if require_complete_stream_set and (
        set(streams) != set(_REQUIRED_STREAMS)
        or set(aligned_stream_ids) != set(_REQUIRED_STREAMS)
    ):
        raise CiTariffAnalysisError("stream_contract_mismatch")
    return {
        "identity_sha256": hashlib.sha256(upload_bytes).hexdigest(),
        "nmi": next(iter(stream_nmis)),
        "streams": streams,
        "aligned_stream_ids": aligned_stream_ids,
        "missing_stream_ids": sorted(set(_REQUIRED_STREAMS) - set(streams)),
        "unaligned_stream_ids": sorted(set(streams) - set(aligned_stream_ids)),
        "quality_method_counts": quality_method_counts,
        "quality_override_count": quality_override_count,
    }


def _energy_in_window(
    rows: dict[date, list[float]],
    dates: list[date],
    window: dict[str, Any],
    *,
    timezone_name: str,
) -> float:
    start = time.fromisoformat(window["start"])
    end = time.fromisoformat(window["end"])
    excluded = {date.fromisoformat(value) for value in window["excluded_dates"]}
    local_timezone = ZoneInfo(timezone_name)
    fixed_aest = timezone(timedelta(hours=10))
    total = 0.0
    for meter_day in dates:
        for index, value in enumerate(rows[meter_day]):
            meter_start = datetime.combine(meter_day, time.min, fixed_aest) + timedelta(
                minutes=index * 5
            )
            local_start = meter_start.astimezone(local_timezone)
            if window["time_basis"] == "meter_aest":
                classified_day = meter_day
                classified_time = meter_start.timetz().replace(tzinfo=None)
            else:
                classified_day = local_start.date()
                classified_time = local_start.timetz().replace(tzinfo=None)
            if (
                classified_day.weekday() < 5
                and classified_day not in excluded
                and start <= classified_time < end
            ):
                total += value
    return total


def _build_demand_intervals(
    active_rows: dict[date, list[float]],
    reactive_rows: dict[date, list[float]],
    *,
    timezone_name: str,
) -> list[dict[str, Any]]:
    local_timezone = ZoneInfo(timezone_name)
    fixed_aest = timezone(timedelta(hours=10))
    intervals: list[dict[str, Any]] = []
    for meter_day in sorted(active_rows):
        active = active_rows[meter_day]
        reactive = reactive_rows[meter_day]
        for index in range(0, 288, 3):
            kw = sum(active[index : index + 3]) * 4
            kvar = sum(reactive[index : index + 3]) * 4
            kva = math.hypot(kw, kvar)
            meter_end = datetime.combine(meter_day, time.min, fixed_aest) + timedelta(
                minutes=(index + 3) * 5
            )
            local_end = meter_end.astimezone(local_timezone)
            intervals.append(
                {
                    "meter_date": meter_day,
                    "local_end": local_end,
                    "kw": kw,
                    "kvar": kvar,
                    "kva": kva,
                    "power_factor": kw / kva if kva else 1.0,
                }
            )
    return intervals


def _demand_in_window(
    rows: list[dict[str, Any]],
    meter_dates: list[date],
    window: dict[str, Any],
) -> list[dict[str, Any]]:
    meter_date_set = set(meter_dates)
    start = time.fromisoformat(window["start"])
    end = time.fromisoformat(window["end"])
    excluded = {date.fromisoformat(value) for value in window["excluded_dates"]}
    candidates = []
    for row in rows:
        if row["meter_date"] not in meter_date_set:
            continue
        local_end = row["local_end"]
        local_start = local_end - timedelta(minutes=15)
        if (
            local_start.date().weekday() < 5
            and local_start.date() not in excluded
            and start <= local_start.timetz().replace(tzinfo=None) < end
        ):
            candidates.append(row)
    return candidates


def calculate_ci_tariff_charges(
    quantities: dict[str, float],
    profile: dict[str, Any],
    *,
    days: int | None = None,
    rate_overrides: dict[str, float] | None = None,
    include_bill_adjustment: bool = True,
) -> dict[str, Any]:
    rates = {**profile["rates"], **(rate_overrides or {})}
    factors = profile["factors"]
    if days is None:
        days = len(
            _date_range(
                date.fromisoformat(profile["billing_period"]["start_date"]),
                date.fromisoformat(profile["billing_period"]["end_date"]),
            )
        )
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        raise CiTariffAnalysisError("profile_invalid")
    dlf = Decimal(str(factors["dlf"]))
    mlf = Decimal(str(factors["mlf"]))
    import_kwh = Decimal(str(quantities["import_kwh"]))

    raw_lines = {
        "energy_charges": [
            Decimal(str(quantities["retail_peak_kwh"]))
            * Decimal(str(rates["retail_peak_c_per_kwh"]))
            / 100
            * mlf
            * dlf,
            Decimal(str(quantities["retail_off_peak_kwh"]))
            * Decimal(str(rates["retail_off_peak_c_per_kwh"]))
            / 100
            * mlf
            * dlf,
        ],
        "network_charges": [
            _quantity_2dp(quantities["incentive_demand_kva"])
            * Decimal(str(rates["incentive_demand_aud_per_kva_month"])),
            _quantity_2dp(quantities["rolling_demand_kva"])
            * Decimal(str(rates["rolling_demand_aud_per_kva_month"])),
            Decimal(str(quantities["network_peak_kwh"]))
            * Decimal(str(rates["network_peak_c_per_kwh"]))
            / 100,
            Decimal(str(quantities["network_off_peak_kwh"]))
            * Decimal(str(rates["network_off_peak_c_per_kwh"]))
            / 100,
        ],
        "regulated_charges": [
            import_kwh
            * Decimal(str(rates["aemo_ancillary_c_per_kwh"]))
            / 100
            * dlf,
            import_kwh
            * Decimal(str(rates["aemo_participant_c_per_kwh"]))
            / 100
            * dlf,
            Decimal(days) * Decimal(str(rates["aemo_frc_c_per_day"])) / 100,
        ],
        "environmental_charges": [
            import_kwh
            * Decimal(str(item["rate_c_per_kwh"]))
            / 100
            * Decimal(str(item["certificate_fraction"]))
            * dlf
            for item in rates["environmental"]
        ],
        "metering_charges": [
            Decimal(days) * Decimal(str(rates["metering_aud_per_day"])),
            Decimal(days) * Decimal(str(rates["value_added_c_per_day"])) / 100,
        ],
        "additional_charges": (
            [Decimal(str(profile.get("additional_bill_adjustment_aud", 0.0)))]
            if include_bill_adjustment
            else []
        ),
    }
    categories = {
        category: sum((_money(value) for value in lines), Decimal("0.00"))
        for category, lines in raw_lines.items()
    }
    subtotal = sum(categories.values(), Decimal("0.00"))
    gst_rate = Decimal(str(profile["gst_rate"]))
    gst = sum(
        (
            _money(value * gst_rate)
            for lines in raw_lines.values()
            for value in lines
        ),
        Decimal("0.00"),
    )
    return {
        "categories": {
            key: float(value) for key, value in categories.items()
        },
        "subtotal_ex_gst_aud": float(subtotal),
        "gst_aud": float(gst),
        "total_inc_gst_aud": float(subtotal + gst),
    }


def _reconciliation_checks(
    quantities: dict[str, float],
    charges: dict[str, Any],
    profile: dict[str, Any],
) -> list[dict[str, object]]:
    expected = profile["expected_reconciliation"]
    actual = {
        **quantities,
        "subtotal_ex_gst_aud": charges["subtotal_ex_gst_aud"],
        "gst_aud": charges["gst_aud"],
        "total_inc_gst_aud": charges["total_inc_gst_aud"],
        **{
            f"category_{key}_aud": value
            for key, value in charges["categories"].items()
        },
    }
    checks = []
    for key, expected_value in expected.items():
        actual_value = actual[key]
        tolerance = (
            0.0005
            if key.endswith("power_factor")
            else 0.015
            if key.endswith("_aud")
            else 0.015
        )
        checks.append(
            {
                "code": key,
                "passed": abs(actual_value - expected_value) <= tolerance,
                "calculated": _round(actual_value, 3),
                "expected": expected_value,
            }
        )
    return checks


def _validate_profile(payload: dict[str, Any]) -> None:
    try:
        if payload["contract_version"] != CI_TARIFF_PROFILE_CONTRACT_VERSION:
            raise ValueError("contract version")
        for key in (
            "profile_id",
            "display_label",
            "network_tariff_code",
            "source_version",
            "source_bill_sha256",
            "expected_nem12_sha256",
        ):
            if not isinstance(payload[key], str) or not payload[key].strip():
                raise ValueError(key)
        if len(payload["network_tariff_code"]) > 64:
            raise ValueError("network tariff code")
        for hash_key in ("source_bill_sha256", "expected_nem12_sha256"):
            if len(payload[hash_key]) != 64:
                raise ValueError(hash_key)
            int(payload[hash_key], 16)
        ZoneInfo(payload["timezone_name"])
        if payload["meter_time_basis"] != "fixed_aest_interval_records":
            raise ValueError("meter time basis")
        if payload["gst_basis"] != "exclusive_then_10_percent_invoice_gst":
            raise ValueError("gst basis")
        for section in (
            "billing_period",
            "rolling_period",
            "retail_energy_window",
            "network_energy_window",
            "rolling_demand_window",
            "incentive_demand_window",
            "rates",
            "factors",
            "expected_reconciliation",
        ):
            if not isinstance(payload[section], dict):
                raise ValueError(section)
        billing_start = date.fromisoformat(payload["billing_period"]["start_date"])
        billing_end = date.fromisoformat(payload["billing_period"]["end_date"])
        rolling_start = date.fromisoformat(payload["rolling_period"]["start_date"])
        rolling_end = date.fromisoformat(payload["rolling_period"]["end_date"])
        if not rolling_start <= billing_start <= billing_end <= rolling_end:
            raise ValueError("periods")
        analysis_period = payload.get("analysis_period")
        if analysis_period is not None:
            if not isinstance(analysis_period, dict):
                raise ValueError("analysis period")
            analysis_start = date.fromisoformat(analysis_period["start_date"])
            analysis_end = date.fromisoformat(analysis_period["end_date"])
            if analysis_end < analysis_start:
                raise ValueError("analysis period")
        for window_name in (
            "retail_energy_window",
            "network_energy_window",
            "rolling_demand_window",
            "incentive_demand_window",
        ):
            window = payload[window_name]
            time.fromisoformat(window["start"])
            time.fromisoformat(window["end"])
            if window["start"] == window["end"]:
                raise ValueError(window_name)
            if not isinstance(window["excluded_dates"], list):
                raise ValueError(window_name)
            for excluded in window["excluded_dates"]:
                date.fromisoformat(excluded)
        if payload["retail_energy_window"]["time_basis"] != "meter_aest":
            raise ValueError("retail time basis")
        if payload["network_energy_window"]["time_basis"] != "local":
            raise ValueError("network time basis")
        if any(
            payload[name]["time_basis"] != "local"
            for name in ("rolling_demand_window", "incentive_demand_window")
        ):
            raise ValueError("demand time basis")
        numeric_values = [
            payload["gst_rate"],
            payload["minimum_chargeable_rolling_kva"],
            payload["factors"]["mlf"],
            payload["factors"]["dlf"],
        ]
        rate_keys = {
            "retail_peak_c_per_kwh",
            "retail_off_peak_c_per_kwh",
            "incentive_demand_aud_per_kva_month",
            "rolling_demand_aud_per_kva_month",
            "network_peak_c_per_kwh",
            "network_off_peak_c_per_kwh",
            "aemo_ancillary_c_per_kwh",
            "aemo_participant_c_per_kwh",
            "aemo_frc_c_per_day",
            "metering_aud_per_day",
            "value_added_c_per_day",
        }
        numeric_values.extend(payload["rates"][key] for key in rate_keys)
        if not isinstance(payload["rates"]["environmental"], list):
            raise ValueError("environmental rates")
        for item in payload["rates"]["environmental"]:
            numeric_values.extend(
                (item["rate_c_per_kwh"], item["certificate_fraction"])
            )
        if any(
            isinstance(value, bool)
            or not math.isfinite(float(value))
            or float(value) < 0
            for value in numeric_values
        ):
            raise ValueError("numeric values")
        additional_bill_adjustment = payload.get(
            "additional_bill_adjustment_aud", 0.0
        )
        if (
            isinstance(additional_bill_adjustment, bool)
            or not isinstance(additional_bill_adjustment, int | float)
            or not math.isfinite(float(additional_bill_adjustment))
            or abs(float(additional_bill_adjustment)) > 1_000_000
        ):
            raise ValueError("additional bill adjustment")
        if float(payload["gst_rate"]) != 0.10:
            raise ValueError("gst rate")
        annual_model = payload.get("annual_financial_model")
        if annual_model is not None:
            if (
                not isinstance(annual_model, dict)
                or annual_model.get("method") != "representative_year_repeat_v1"
            ):
                raise ValueError("annual financial model")
            months = annual_model.get("incentive_demand_months")
            if (
                not isinstance(months, list)
                or not months
                or len(months) != len(set(months))
                or any(
                    isinstance(month, bool)
                    or not isinstance(month, int)
                    or not 1 <= month <= 12
                    for month in months
                )
            ):
                raise ValueError("annual incentive months")
            annual_rate = annual_model.get(
                "incentive_demand_aud_per_kva_month"
            )
            if (
                isinstance(annual_rate, bool)
                or not math.isfinite(float(annual_rate))
                or float(annual_rate) < 0
            ):
                raise ValueError("annual incentive rate")
        expected_keys = {
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
        if set(payload["expected_reconciliation"]) != expected_keys:
            raise ValueError("expected reconciliation")
        if any(
            isinstance(value, bool) or not math.isfinite(float(value))
            for value in payload["expected_reconciliation"].values()
        ):
            raise ValueError("expected reconciliation values")
    except Exception as exc:
        raise CiTariffAnalysisError("profile_invalid") from exc


def _date_range(start: date, end: date) -> list[date]:
    if end < start:
        raise CiTariffAnalysisError("profile_invalid")
    return [start + timedelta(days=index) for index in range((end - start).days + 1)]


def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _quantity_2dp(value: float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _round(value: float, places: int) -> float:
    return round(float(value), places)


def _window_label(window: dict[str, Any]) -> str:
    return f"{window['start']}-{window['end']} {window['time_basis']} workdays"

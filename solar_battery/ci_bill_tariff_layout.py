"""Printed tariff candidates from native tables and OCR geometry.

Only explicit ex-GST rows with known labels, units and reconciled amounts
populate the review draft. Billing cycles and loss factors are never inferred.
"""
from decimal import Decimal, ROUND_HALF_UP
import re

from solar_battery.ci_bill_document import BillText

VERSION = 2
NUMBER = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
ROW = re.compile(
    rf"^(.*?)\s+({NUMBER})\s*(kWh|kVA|days?)\s+\$?({NUMBER})\s*"
    rf"([c¢$]\s*/\s*(?:kWh|day|kVA(?:\s*/\s*month)?))\s+"
    rf"((?:{NUMBER}\s+)*)\$\s*({NUMBER})\s*$", re.I,
)
HEADINGS = {
    "energy charges": "retail", "retail energy charges": "retail",
    "network charges": "network", "regulated charges": "regulated",
    "environmental charges": "environmental", "metering charges": "metering",
    "metering and services charges": "metering",
}


def _number(value):
    return Decimal(value.replace(",", ""))


def _key(label, section):
    label = re.sub(r"[-–]", " ", label.lower()).strip()
    label = re.sub(r"\s+", " ", label)
    for prefix in ("retail", "network"):
        if label.startswith(prefix + " "):
            section, label = prefix, label[len(prefix) + 1:]
    if section in {"retail", "network"} and label in {"peak", "peak usage", "off peak", "off peak usage"}:
        return f"{section}_{'off_peak' if label.startswith('off') else 'peak'}_c_per_kwh", "kwh"
    return {
        "aemo ancillary charge": ("aemo_ancillary_c_per_kwh", "kwh"),
        "aemo ancillary charge and ufe charge": ("aemo_ancillary_c_per_kwh", "kwh"),
        "aemo participant charge": ("aemo_participant_c_per_kwh", "kwh"),
        "aemo frc operations": ("aemo_frc_c_per_day", "day"),
        "metering charge": ("metering_aud_per_day", "day"),
        "value added service charge": ("value_added_c_per_day", "day"),
        "incentive demand": ("incentive_demand_aud_per_kva_month", "kva/month"),
        "rolling demand": ("rolling_demand_aud_per_kva_month", "kva/month"),
        "demand charge": ("rolling_demand_aud_per_kva_month", "kva/month"),
    }.get(label)


def extract_layout_tariff_lines(document: BillText) -> dict:
    result = {"version": VERSION, "rates": {}, "factors": {}, "sources": [], "issues": []}
    candidates, rejected = {}, set()

    def source(field, row, text):
        result["sources"].append({"field": "tariff_" + field, "page": row["page"],
            "method": row["method"], "bbox": row["bbox"], "confidence": round(row["confidence"], 4),
            "text": text[:180]})

    def reject(field, row, reason):
        rejected.add(field)
        issue = {"code": "tariff_candidate_uncertain", "field": "tariff_" + field,
            "page": row["page"], "message": f"Check {field.replace('_', ' ')}: {reason}.", "resolved_by_review": False}
        if issue not in result["issues"]:
            result["issues"].append(issue)

    for page in document.pages:
        # Tables are separate streams so headings/columns cannot leak between
        # unrelated tables. Native text and table duplicates must agree.
        streams = [page["lines"]]
        streams += [[{"text": " ".join(re.sub(r"\s+", " ", c or "").strip() for c in cells),
                      "page": page["page"], "bbox": table["bbox"], "method": "native_table", "confidence": 1.0}
                     for cells in table["rows"]] for table in page["tables"]]
        for rows in streams:
            section, columns, context_confidence, ex_gst = "", [], 1.0, False
            for row in rows:
                text = re.sub(r"\s+", " ", row["text"].replace("|", " ")).strip()
                lower = text.lower()
                if lower in HEADINGS:
                    section, columns, context_confidence, ex_gst = HEADINGS[lower], [], row["confidence"], False
                    continue
                if lower.startswith("total ") or lower.startswith("sub-total"):
                    section, columns, ex_gst = "", [], False
                    continue
                if re.search(r"\b(?:inc|incl|including)\.?\s+gst\b", lower):
                    ex_gst = False
                if re.search(r"\b(?:ex|excl|excluding)\.?\s+gst\b", lower):
                    ex_gst = True
                    context_confidence = min(context_confidence, row["confidence"])
                if re.search(r"\bquantity\b", lower) and re.search(r"\brate\b", lower):
                    columns = re.findall(r"\b(mlf|dlf)\b", lower)
                    context_confidence = min(context_confidence, row["confidence"])
                # Explicit named factors are useful even without a charge row.
                factor = re.fullmatch(rf"(MLF|DLF|Marginal Loss Factor|Distribution Loss Factor)\s*[:=]?\s*({NUMBER})", text, re.I)
                if factor:
                    field = "mlf" if factor[1].lower() in {"mlf", "marginal loss factor"} else "dlf"
                    value = _number(factor[2])
                    source(field, row, text)
                    if row["confidence"] < .9 or not Decimal('.01') <= value <= 5:
                        reject(field, row, "uncertain loss factor")
                    else:
                        candidates.setdefault(field, set()).add(float(value))
                    continue
                match = ROW.fullmatch(text)
                if not match:
                    labelled = re.match(rf"^(.*?)\s+-?{NUMBER}\s*(?:kWh|kVA|kW|days?)\b", text, re.I)
                    mapped = _key(labelled[1], section) if labelled else None
                    if mapped:
                        source(mapped[0], row, text)
                        reject(mapped[0], row, "unsupported or incomplete charge row")
                    continue
                label, quantity, unit, rate, rate_unit, printed_factors, amount = match.groups()
                mapped = _key(label, section)
                if mapped is None:
                    continue
                field, expected_unit = mapped
                source(field, row, text)
                rate_unit = re.sub(r"\s+", "", rate_unit.lower())
                quantity_unit = unit.lower().rstrip('s')
                factor_values = [_number(v) for v in printed_factors.split()]
                if (not ex_gst or min(context_confidence, row["confidence"]) < .9
                        or rate_unit[2:] != expected_unit
                        or quantity_unit != expected_unit.split('/')[0]
                        or len(factor_values) != len(columns) or len(set(columns)) != len(columns)
                        or any(not Decimal('.01') <= v <= 5 for v in factor_values)):
                    reject(field, row, "check ex-GST basis, units, billing cycle, loss-factor columns and OCR confidence")
                    continue
                value, quantity, amount = _number(rate), _number(quantity), _number(amount)
                calculated = quantity * value / (100 if rate_unit[0] in 'c¢' else 1)
                for factor_value in factor_values:
                    calculated *= factor_value
                if quantity <= 0 or abs(calculated.quantize(Decimal('.01'), rounding=ROUND_HALF_UP) - amount) > Decimal('.02'):
                    reject(field, row, "printed quantity × rate × factors does not reconcile")
                    continue
                # Canonical profile uses cents for energy/service, dollars for
                # metering/demand. Convert only explicitly printed units.
                target_cents = '_c_per_' in field
                value *= (100 if target_cents and rate_unit[0] == '$' else
                          Decimal('.01') if not target_cents and rate_unit[0] in 'c¢' else 1)
                if not 0 <= value <= 1_000_000:
                    reject(field, row, "rate is outside the supported range")
                    continue
                candidates.setdefault(field, set()).add(float(value))
                for name, value in zip(columns, factor_values):
                    candidates.setdefault(name, set()).add(float(value))
                    source(name, row, text)
    for field, values in candidates.items():
        if len(values) > 1:
            reject(field, {"page": next(s['page'] for s in result['sources'] if s['field'] == 'tariff_' + field)}, "multiple printed values disagree")
        if field not in rejected:
            result["factors" if field in {"mlf", "dlf"} else "rates"][field] = next(iter(values))
    # Bound selected evidence; no raw document text is persisted.
    result['sources'] = result['sources'][:100]
    result['issues'] = result['issues'][:100]
    return result

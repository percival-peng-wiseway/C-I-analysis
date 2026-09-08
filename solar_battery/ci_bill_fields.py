"""Retailer-neutral, source-backed bill candidates and authoritative reconciliation.

No language model invents values. Ambiguous/low-confidence fields are blanked.
Only selected evidence is returned; raw pages and private site identifiers stay
inside the intake call. This layer never approves a tariff or derives its rates
from aggregate dollars divided by usage.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import re
from typing import Callable

from solar_battery.ci_bill_document import BillText
from solar_battery.ci_bill_tariff_layout import extract_layout_tariff_lines

CATEGORY_LABELS = {
    "energy_charges": "Energy charges",
    "network_charges": "Network charges",
    "regulated_charges": "Regulated charges",
    "environmental_charges": "Environmental charges",
    "metering_charges": "Metering charges",
    "additional_charges": "Additional charges, credits & adjustments",
}
NUMBER = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
MONEY = rf"(?:AUD\s*)?\$?\s*(\(?-?{NUMBER}\)?)(?:\s*(CR))?"
DATE = r"(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})"
SEP = r"\s*[:|]?\s*"


def decimal(value: object) -> Decimal:
    return Decimal(str(value).replace(",", ""))


def money(match: re.Match) -> float:
    token = match.group(1)
    if token.startswith("(") != token.endswith(")"):
        raise ValueError("Unbalanced amount parentheses")
    negative = token.startswith("(") or bool(match.group(2))
    number = decimal(token.strip("()"))
    return float(-abs(number) if negative else number)


def _rows(document: BillText) -> list[dict]:
    rows = []
    for page in document.pages:
        rows.extend(page["lines"])
        for table in page["tables"]:
            for cells in table["rows"]:
                rows.append({"text": " | ".join(re.sub(r"\s+", " ", cell or "").strip() for cell in cells),
                             "page": page["page"], "bbox": table["bbox"], "method": "native_table", "confidence": 1.0})
        # A wrapped label can be followed by a bare value; never join two
        # complete labelled lines or text from another page.
        for first, second in zip(page["lines"], page["lines"][1:]):
            if re.fullmatch(rf"{MONEY}(?:\s*(?:kWh|kVA))?|{DATE}\s*(?:to|[-–])\s*{DATE}", second["text"], re.I):
                rows.append({**first, "text": first["text"] + " " + second["text"],
                             "bbox": [min(first["bbox"][0], second["bbox"][0]), first["bbox"][1],
                                      max(first["bbox"][2], second["bbox"][2]), second["bbox"][3]],
                             "confidence": min(first["confidence"], second["confidence"])})
    return rows


def structure_bill(document: BillText, bill: dict, parse_date: Callable[[str], date]) -> dict:
    bill = dict(bill)
    verified_template = bill["extraction_method"] == "verified_origin_template"
    rows = _rows(document)
    summary_rows = []
    in_summary = False
    for row in rows:
        if row["text"].strip().upper() == "INVOICE SUMMARY":
            in_summary = True
        elif row["text"].strip().upper() == "INVOICE CHARGE SUMMARY":
            in_summary = False
        elif in_summary and row["method"] != "native_table":
            summary_rows.append(row)
    issues = [{**issue, "resolved_by_review": False} for issue in document.warnings]
    sources = []

    def select(field: str, pattern: str, convert: Callable = lambda m: m.group(1), *, fallback=None, summary=False):
        candidates = []
        for row in (summary_rows if summary and verified_template else rows):
            for match in re.finditer(pattern, row["text"], re.I):
                try:
                    value = convert(match)
                except (ValueError, ArithmeticError):
                    continue
                if isinstance(value, float) and (not decimal(value).is_finite() or (value < 0 and field != "additional_charges")):
                    continue
                candidates.append((value, row, match.group(0)))
        unique = {str(value) for value, _, _ in candidates}
        if candidates:
            for value, row, snippet in candidates[:4]:
                sources.append({"field": field, "page": row["page"], "method": row["method"],
                                "bbox": row["bbox"], "confidence": round(row["confidence"], 4),
                                "text": "Site identifier extracted privately" if field == "nmi" else snippet[:180]})
            low = all(row["confidence"] < 0.9 for _, row, _ in candidates)
            if len(unique) > 1 or low:
                issues.append({"code": "conflicting_values" if len(unique) > 1 else "low_ocr_confidence", "field": field,
                               "message": f"Check {field.replace('_', ' ')} against the PDF; the extracted value is uncertain.",
                               "resolved_by_review": False})
                return None
            return candidates[0][0]
        return fallback

    def prior(field):
        return bill.get(field) if verified_template else None

    for key, label in (
        ("subtotal_ex_gst_aud", r"(?:sub\s*-?\s*total(?:\s+ex(?:cluding)?\.?\s+GST)?|total\s+(?:excluding|ex)\.?\s+GST)"),
        ("gst_aud", r"(?:total\s+GST|GST(?:\s+amount)?)(?:\s*\(10%\))?"),
        ("total_inc_gst_aud", r"(?:invoice\s+total|total\s+(?:including|incl?\.?|inc)\s+GST|(?:total\s+)?current\s+charges(?:\s*\(inc(?:luding)?\.?\s+GST\))?|total\s+new\s+charges)"),
    ):
        # Generic 'Total' / 'Amount due' includes balances and is deliberately
        # not a current-charge candidate. The strict Origin summary is scoped.
        if key == "total_inc_gst_aud" and verified_template:
            label = rf"(?:{label}|Total)"
        bill[key] = select(key, rf"^\s*{label}{SEP}{MONEY}\s*$", money, fallback=prior(key), summary=True)

    for key, pattern in (
        ("nmi", r"\b(?:NMI|National Meter(?:ing)? Identifier)\s*[:#-]?\s*([A-Z0-9]{10,11})\b"),
        ("network_tariff_code", r"\b(?:Network\s+Tariff(?:\s+Code)?|Tariff\s+Code|Tariff)\s*[:#-]\s*([A-Z0-9][A-Z0-9_-]{1,39})\b"),
        ("consumption_kwh", rf"\b(?:Consumption(?:\s+this\s+period)?|Total\s+(?:electricity\s+)?(?:usage|consumption)|Usage\s+this\s+period){SEP}({NUMBER})\s*kWh\b"),
        ("highest_metered_demand_kva", rf"\b(?:Highest\s+metered\s+demand(?:\s+this\s+period\s+is)?|Maximum\s+demand|Peak\s+demand){SEP}({NUMBER})\s*kVA\b"),
        ("power_factor_at_highest_demand", rf"\b(?:Power\s+Factor(?:\s+at\s+(?:highest|maximum)\s+demand)?|PF){SEP}({NUMBER})(\s*%)?"),
    ):
        convert = (lambda m: m.group(1).upper()) if key in {"nmi", "network_tariff_code"} else (lambda m: float(decimal(m.group(1))))
        if key == "power_factor_at_highest_demand":
            convert = lambda m: float(decimal(m.group(1)) / (100 if m.group(2) else 1))
        bill[key] = select(key, pattern, convert, fallback=prior(key))
    pf = bill["power_factor_at_highest_demand"]
    if pf is not None and not 0 <= pf <= 1:
        bill["power_factor_at_highest_demand"] = None
        issues.append({"code": "invalid_power_factor", "field": "power_factor_at_highest_demand", "message": "Power factor must be between 0 and 1.", "resolved_by_review": False})

    period = select("billing_period", rf"(?:\b(?:Billing|Bill|Charge|Supply|Invoice)\s+Period|\bElectricity\s+Tax\s+Invoice){SEP}({DATE})\s*(?:to|[-–])\s*({DATE})",
                    lambda m: (parse_date(m.group(1)).isoformat(), parse_date(m.group(2)).isoformat()),
                    fallback=(bill["billing_period_start"], bill["billing_period_end"]) if verified_template else None)
    bill["billing_period_start"], bill["billing_period_end"] = period or (None, None)
    bill["billing_days"] = ((date.fromisoformat(period[1]) - date.fromisoformat(period[0])).days + 1) if period and period[0] <= period[1] else None
    printed_days = select("printed_billing_days", rf"\b(?:No\.?\s*of\s*Days|Billing\s+days){SEP}(\d+)\b", lambda m: int(m.group(1)))
    categories = {}
    for key, label in CATEGORY_LABELS.items():
        pattern = re.escape(label).replace(r"\ ", r"\s+")
        value = select(key, rf"^\s*(?:Total\s+)?{pattern}{SEP}{MONEY}\s*$", money,
                       fallback=bill.get("charge_categories_ex_gst_aud", {}).get(key) if verified_template else None, summary=True)
        if value is not None:
            categories[key] = value
    bill["charge_categories_ex_gst_aud"] = categories

    line_items, seen = [], set()
    # Only verify explicit, dimensionally compatible rows. Demand billing cycles,
    # loss factors and percentages must not be guessed from an amount.
    for row in rows:
        match = re.search(rf"\b({NUMBER})\s*(kWh|days?)\s*\|?\s*\$?({NUMBER})\s*(c/kWh|¢/kWh|\$/kWh|\$/day|c/day)\s*\|?\s*\$(-?{NUMBER})\s*$", row["text"], re.I)
        if not match:
            continue
        quantity, unit, rate, rate_unit, amount = match.groups()
        if (unit.lower() == "kwh") != (rate_unit.lower().endswith("kwh")):
            continue
        identity = (row["page"], match.group(0))
        if identity in seen:
            continue
        seen.add(identity)
        expected = decimal(quantity) * decimal(rate) / (100 if rate_unit[0] in "c¢" else 1)
        delta = expected.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) - decimal(amount)
        line_items.append({"page": row["page"], "quantity": float(decimal(quantity)), "unit": unit,
                           "rate": float(decimal(rate)), "rate_unit": rate_unit, "amount_aud": float(decimal(amount)),
                           "difference_aud": float(delta), "passed": abs(delta) <= Decimal("0.02")})
    if len(line_items) > 100:
        issues.append({"code": "charge_line_limit", "message": "Only the first 100 explicit charge rows were checked. Review the remaining rows against the PDF.", "resolved_by_review": False})
    bill["extraction_audit"] = {"version": 1, "pages": [{"page": p["page"], "method": p["method"], "table_count": len(p["tables"])} for p in document.pages],
                                 "sources": sources, "issues": issues, "line_items": line_items[:100],
                                 "printed_billing_days": printed_days, "checks": []}
    # Each generic/OCR rate is independently checked against its source row.
    # Missing summary categories must not hide valid candidates from the draft.
    if not verified_template or any(p["method"] == "paddle_ocr" for p in document.pages):
        detected = extract_layout_tariff_lines(document)
        bill["tariff_line_items"] = detected
        sources.extend(detected["sources"])
        issues.extend(detected["issues"])
    if not verified_template:
        bill["extraction_method"] = "paddle_ocr_layout" if any(p["method"] == "paddle_ocr" for p in document.pages) else ("layout_pdf_text" if document.strip() else "manual_review_only")
    if issues or any(p["method"] == "paddle_ocr" for p in document.pages) or not verified_template:
        bill["review_status"] = "confirmation_required"
    reconcile_bill(bill)
    return bill


def reconcile_bill(bill: dict, *, confirmed: bool = False, line_items_reviewed: bool = False) -> None:
    """Recompute checks from current values, including after manual corrections."""
    audit = bill["extraction_audit"]
    checks = []
    def check(code, passed, message):
        checks.append({"code": code, "passed": bool(passed), "message": message})
    subtotal, gst, total = (bill.get(k) for k in ("subtotal_ex_gst_aud", "gst_aud", "total_inc_gst_aud"))
    totals_ok = all(v is not None and decimal(v).is_finite() and v >= 0 for v in (subtotal, gst, total)) and abs(decimal(subtotal) + decimal(gst) - decimal(total)) <= Decimal("0.02")
    check("invoice_totals", totals_ok, "Subtotal + GST must equal current invoice charges (within AUD 0.02).")
    days = bill.get("billing_days")
    period_ok = isinstance(days, int) and days > 0
    check("billing_period", period_ok, "The billing period must have a valid start and end date.")
    printed = audit.get("printed_billing_days")
    if printed is not None:
        check("printed_billing_days", confirmed or printed == days, "Check the printed billing day count against the confirmed date range.")
    categories = bill.get("charge_categories_ex_gst_aud", {})
    categories_complete = all(k in categories for k in CATEGORY_LABELS)
    categories_ok = categories_complete and subtotal is not None and abs(sum(decimal(categories[k]) for k in CATEGORY_LABELS) - decimal(subtotal)) <= Decimal("0.02")
    check("charge_categories", categories_ok, "All six charge categories must sum to the subtotal before they can support tariff review.")
    for index, line in enumerate(audit["line_items"]):
        check(f"charge_line_{index + 1}", line["passed"], f"Page {line['page']}: printed quantity × rate must match the line amount after unit conversion.")
    lines_ok = all(line["passed"] for line in audit["line_items"])
    audit["line_items_reviewed"] = bool(confirmed and line_items_reviewed)
    bill["invoice_arithmetic_scope"] = "charge_categories_and_totals" if categories_complete else "invoice_totals_only"
    bill["invoice_arithmetic_reconciled"] = bool(totals_ok and period_ok and (not categories_complete or categories_ok)
                                                and (lines_ok or audit["line_items_reviewed"])
                                                and (confirmed or printed is None or printed == days))
    audit["checks"] = checks
    if confirmed:
        for issue in audit["issues"]:
            issue["resolved_by_review"] = True
    # Unreconciled OCR/detail evidence must never supply automatic tariff rates.
    if (bill.get("tariff_line_items", {}).get("version", 1) < 2
            and (any(not item["passed"] for item in audit["line_items"]) or (not confirmed and audit["issues"]))):
        bill["tariff_line_items"] = {"version": 1, "rates": {}, "factors": {}}
        bill["review_status"] = "confirmation_required" if not confirmed else bill["review_status"]
    if not bill["invoice_arithmetic_reconciled"]:
        bill["review_status"] = "confirmation_required"

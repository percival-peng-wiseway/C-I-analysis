"""Conservative extraction of printed Origin invoice rates (never total/usage).

This is evidence for a review draft, not approval of tariff terms. Unknown or
ambiguous rows remain absent. No customer text or identifiers are returned.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
import re
from typing import Any


_NUMBER = r"-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
_CENTS = r"[c¢]/"


def extract_bill_tariff_lines(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {"version": 1, "rates": {}, "factors": {}}
    if "originenergy.com.au" not in text or "Business Electricity Tax Invoice" not in text:
        return result
    rates = result["rates"]
    factors: dict[str, set[float]] = {"mlf": set(), "dlf": set()}

    def section(heading: str, end: str) -> str:
        matches = re.findall(re.escape(heading) + r"\s+(.*?)" + re.escape(end), text, re.DOTALL)
        return matches[0] if len(matches) == 1 else ""

    def number(token: str) -> Decimal:
        return Decimal(token.replace(",", ""))

    def row(body: str, label: str, quantity_unit: str, rate_unit: str,
            factor_names: tuple[str, ...] = ()) -> tuple[float, float] | None:
        pattern = (r"(?<![\w-])" + label + rf"\s+({_NUMBER})\s+{quantity_unit}\s+"
                   rf"({_NUMBER})\s+{rate_unit}\s+"
                   + "".join(rf"({_NUMBER})\s+" for _ in factor_names)
                   + rf"\$({_NUMBER})(?![\d.])")
        matches = list(re.finditer(pattern, body, re.IGNORECASE))
        if len(matches) != 1:
            return None
        values = [number(value) for value in matches[0].groups()]
        quantity, rate, *rest = values
        printed_factors, amount = rest[:-1], rest[-1]
        if quantity < 0 or not 0 <= rate <= 1_000_000 or any(not Decimal('0.01') <= v <= 5 for v in printed_factors):
            return None
        calculated = quantity * rate / (100 if rate_unit.startswith(_CENTS) else 1)
        for factor in printed_factors:
            calculated *= factor
        if abs(calculated.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP) - amount) > Decimal('0.01'):
            return None
        for name, value in zip(factor_names, printed_factors):
            factors[name].add(float(value))
        return float(rate), float(amount)

    energy = section("ENERGY CHARGES", "Total Energy Charges")
    network = section("NETWORK CHARGES", "Total Network Charges")
    regulated = section("REGULATED CHARGES", "Total Regulated Charges")
    for body, label, quantity_unit, rate_unit, names, key in (
        (energy, r"Peak", "kWh", _CENTS + "kWh", ("mlf", "dlf"), "retail_peak_c_per_kwh"),
        (energy, r"Off[- ]Peak", "kWh", _CENTS + "kWh", ("mlf", "dlf"), "retail_off_peak_c_per_kwh"),
        (network, r"Peak", "kWh", _CENTS + "kWh", (), "network_peak_c_per_kwh"),
        (network, r"Off[- ]Peak", "kWh", _CENTS + "kWh", (), "network_off_peak_c_per_kwh"),
        (network, "Incentive Demand", "kVA", r"\$/kVA", (), "incentive_demand_aud_per_kva_month"),
        (network, "Demand Charge", "kVA", r"\$/kVA", (), "rolling_demand_aud_per_kva_month"),
        (regulated, r"AEMO Ancillary Charge(?: and UFE Charge)?", "kWh", _CENTS + "kWh", ("dlf",), "aemo_ancillary_c_per_kwh"),
        (regulated, "AEMO Participant Charge", "kWh", _CENTS + "kWh", ("dlf",), "aemo_participant_c_per_kwh"),
        (regulated, "AEMO FRC Operations", "Days?", _CENTS + "Day", (), "aemo_frc_c_per_day"),
    ):
        # Exclude Off Peak before searching Peak; a space is also a word boundary.
        if label == "Peak":
            body = re.sub(r"Off[- ]Peak", "OffPeak", body, flags=re.IGNORECASE)
        detected = row(body, label, quantity_unit, rate_unit, names)
        if detected is not None:
            rates[key] = detected[0]

    environmental = section("ENVIRONMENTAL CHARGES", "Total Environmental Charges")
    pattern = (rf"\b([A-Z][A-Z0-9-]* Charge)\s+({_NUMBER})\s+kWh\s+({_NUMBER})\s+"
               rf"{_CENTS}kWh\s+({_NUMBER})\s+({_NUMBER})\s+\$({_NUMBER})")
    items, amounts, environmental_dlfs = [], [], []
    for match in re.finditer(pattern, environmental):
        label = match.group(1)
        quantity, rate, percent, dlf, amount = [number(v) for v in match.groups()[1:]]
        calculated = quantity * rate / 100 * percent / 100 * dlf
        if (quantity < 0 or not 0 <= rate <= 1_000_000 or not 0 <= percent <= 100
                or not Decimal('0.01') <= dlf <= 5
                or abs(calculated.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP) - amount) > Decimal('0.01')):
            items = []
            break
        items.append({"label": label, "rate_c_per_kwh": float(rate), "certificate_fraction": float(percent / 100)})
        amounts.append(amount)
        environmental_dlfs.append(float(dlf))
    subtotal = re.search(rf"Sub-Total\s+\$({_NUMBER})", environmental)
    if (items and len(items) <= 20 and len({v['label'] for v in items}) == len(items)
            and subtotal and abs(sum(amounts) - number(subtotal.group(1))) <= Decimal('0.02')):
        result["environmental"] = items
        factors["dlf"].update(environmental_dlfs)

    metering = section("METERING AND SERVICES CHARGES", "Total Meter and Service Charges")
    # A $/Meter rate is per meter per day in this table. Convert only an explicit
    # single-meter row whose day quantity and printed amount reconcile.
    matches = list(re.finditer(rf"(?<!\w)Metering Charge\s+1\s+Meter\s+({_NUMBER})\s+\$/Meter\s+({_NUMBER})\s+Days\s+\$({_NUMBER})", metering))
    if len(matches) == 1:
        rate, days, amount = [number(v) for v in matches[0].groups()]
        if 0 <= rate <= 1_000_000 and days > 0 and abs((rate * days).quantize(Decimal('.01'), rounding=ROUND_HALF_UP) - amount) <= Decimal('.01'):
            rates["metering_aud_per_day"] = float(rate)
    service = row(metering, "Value Added Service Charge", "Days?", _CENTS + "Day")
    if service:
        rates["value_added_c_per_day"] = service[0]
    result["factors"] = {key: next(iter(values)) for key, values in factors.items() if len(values) == 1}
    return result

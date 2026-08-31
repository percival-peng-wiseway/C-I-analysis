"""Deterministic, private C&I internal-review HTML report renderer.

The renderer is deliberately presentation-only: all values are read from the
validated report dictionary and no financial, tariff, dispatch, or scenario
meaning is inferred here.
"""
from __future__ import annotations

from html import escape
import math
from typing import Any, Mapping, Sequence

RENDERER_CONTRACT_VERSION = "ci_internal_review_html_v1"
REPORT_CONTRACT_VERSION = "ci_internal_review_report_v1"
_PERMISSIONS = (
    "customer_facing_permission",
    "recommendation_permitted",
    "eligibility_permitted",
    "manual_delivery_permission",
    "repository_managed_delivery_permission",
)


class CiInternalReportRenderError(ValueError):
    """Safe, stable renderer contract failure."""


def render_ci_internal_review_report_html(contract: Mapping[str, object]) -> bytes:
    """Render a self-contained exactly-three-page report from a plain dict."""
    _validate(contract)
    solution = _mapping(contract.get("solution", contract.get("decision", {})))
    financial = _mapping(contract.get("financial_solution", contract.get("financial", solution)))
    if isinstance(financial.get("assumptions"), Mapping):
        financial = {**financial, **financial["assumptions"]}
    if isinstance(financial.get("metrics"), Mapping):
        financial = {**financial, **financial["metrics"]}
    comparison = _mapping(contract.get("comparison", contract.get("three_case_comparison", {})))
    energy = _mapping(contract.get("energy", contract.get("common_day", {})))
    if not energy and _all_points(comparison):
        energy = _energy_from_points(_all_points(comparison))
    assumptions = _mapping(contract.get("assumptions", {}))
    provenance = _mapping(contract.get("provenance", {}))
    limitations = contract.get("limitations", contract.get("disclaimer", "Internal evidence-bound review only."))
    document = _mapping(contract.get("document", {}))
    title = _text(document, "solution_label", _text(solution, "label", _text(document, "report_label", "C&I internal review")))
    body = _page_one(title, solution, financial, comparison)
    body += _page_two(energy, comparison)
    body += _page_three(financial, assumptions, {**_mapping(contract.get("source_identity", {})), **provenance}, limitations, contract)
    head = _head().replace("margin:14mm 16mm 16mm", "margin:0").replace(
        "margin:0 auto 12px", "margin:0 auto"
    ).replace(
        "min-height:297mm", "min-height:296mm"
    ).replace(
        "</style>",
        ".page{break-after:auto;page-break-after:auto;break-inside:avoid;page-break-inside:avoid}"
        ".page+.page{break-before:page;page-break-before:always}"
        ".topline{display:block}.topline span{float:right}</style>",
    )
    html = "<!doctype html><html lang=\"en\"><head>" + head + "</head><body><main data-renderer=\"" + RENDERER_CONTRACT_VERSION + "\">" + body + "</main></body></html>"
    return html.encode("utf-8")


def _validate(contract: Mapping[str, object]) -> None:
    if not isinstance(contract, Mapping) or contract.get("contract_version") != REPORT_CONTRACT_VERSION:
        raise CiInternalReportRenderError("report contract version is invalid")
    for key in _PERMISSIONS:
        value = contract.get(key)
        if value is None and isinstance(contract.get("permissions"), Mapping):
            value = contract["permissions"].get(key)
        if value is not False:
            raise CiInternalReportRenderError("report permissions must be false")
    try:
        _finite_walk(contract)
    except (TypeError, ValueError):
        raise CiInternalReportRenderError("report contains a non-finite number") from None
    comparison = contract.get("comparison", contract.get("three_case_comparison", {}))
    if not isinstance(comparison, Mapping):
        raise CiInternalReportRenderError("comparison is invalid")
    points = comparison.get("points", comparison.get("comparison_points"))
    if not isinstance(points, Sequence) or isinstance(points, (str, bytes)) or not (1 <= len(points) <= 100):
        raise CiInternalReportRenderError("comparison points must contain 1 to 100 points")


def _finite_walk(value: object) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError
    if isinstance(value, Mapping):
        for item in value.values():
            _finite_walk(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _finite_walk(item)


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _text(group: Mapping[str, object], key: str, default: str = "") -> str:
    value = group.get(key, default)
    return escape(str(value))


def _lookup(group: Mapping[str, object], *keys: str) -> object:
    for key in keys:
        if key in group:
            return group[key]
    return "—"


def _v(value: object) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return repr(value)
    return str(value)


def _cell(value: object) -> str:
    return escape(_v(value))


def _all_points(comparison: Mapping[str, object]) -> list[Mapping[str, object]]:
    points = comparison.get("points", comparison.get("comparison_points", []))
    return [p for p in points if isinstance(p, Mapping)]


def _energy_from_points(points: Sequence[Mapping[str, object]]) -> Mapping[str, object]:
    result: dict[str, object] = {}
    for case_id, kw_key, kva_key in (("no_system", "no_system_kw", "no_system_kva"), ("pv_only", "pv_only_kw", "pv_only_kva"), ("pv_battery", "pv_battery_kw", "pv_battery_kva")):
        rows = [_mapping(point.get(case_id)) for point in points]
        result[kw_key] = [_lookup(row, "import_kw") for row in rows]
        result[kva_key] = [_lookup(row, "import_kva") for row in rows]
    battery = [_mapping(point.get("pv_battery")) for point in points]
    result["grid_charge"] = [_lookup(row, "grid_charge_kw") for row in battery]
    result["pv_charge"] = [_lookup(row, "pv_charge_kw") for row in battery]
    result["battery_discharge"] = [_lookup(row, "battery_discharge_kw") for row in battery]
    result["soc"] = [_lookup(row, "soc_end_kwh") for row in battery]
    return result


def _series(group: Mapping[str, object], *keys: str) -> list[object]:
    for key in keys:
        value = group.get(key)
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return list(value)
    return []


def _svg_chart(title: str, series: Sequence[tuple[str, Sequence[object], str]]) -> str:
    width, height = 520, 150
    vals = [float(v) for _, values, _ in series for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    hi = max(vals, default=1.0); lo = min(vals, default=0.0)
    span = hi - lo or 1.0
    paths: list[str] = []
    for label, values, colour in series:
        nums = [float(v) for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if not nums:
            continue
        coords = []
        for i, val in enumerate(nums):
            x = 22 + (width - 34) * (i / max(1, len(nums) - 1))
            y = 128 - 96 * ((val - lo) / span)
            coords.append(f"{x:.2f},{y:.2f}")
        paths.append(f'<polyline aria-label="{escape(label)}" fill="none" stroke="{colour}" stroke-width="2" points="{" ".join(coords)}"/>')
    return f'<figure class="figure"><figcaption>{escape(title)}</figcaption><svg viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}"><line x1="22" y1="128" x2="506" y2="128" stroke="#cfd6df"/><line x1="22" y1="32" x2="22" y2="128" stroke="#cfd6df">{""}</line>{"".join(paths)}</svg><div class="legend">{escape(" · ".join(label for label, _, _ in series))}</div></figure>'


def _page_one(title: str, solution: Mapping[str, object], financial: Mapping[str, object], comparison: Mapping[str, object]) -> str:
    rows = []
    point_rows = _all_points(comparison)
    for case in comparison.get("cases", []):
        if isinstance(case, Mapping):
            case_id = str(case.get("case_id", ""))
            values = [_mapping(point.get(case_id)) for point in point_rows]
            peak_kw = max((float(value["import_kw"]) for value in values if isinstance(value.get("import_kw"), (int, float))), default=None)
            peak_kva = max((float(value["import_kva"]) for value in values if isinstance(value.get("import_kva"), (int, float))), default=None)
            rows.append("<tr><th>" + _cell(_lookup(case, "case_label", "label", "case_id")) + "</th><td>" + _cell(peak_kw) + "</td><td>" + _cell(peak_kva) + "</td></tr>")
    if not rows:
        rows.append("<tr><td colspan=\"3\">No case rows returned</td></tr>")
    return f'''<section class="page"><div class="topline"><b>PRIVATE INTERNAL REVIEW</b><span>01 / 03</span></div><header><span class="kicker">Private internal review</span><h1>{title}</h1><p>Not a customer report. Exact returned values on one consistent evidence basis.</p></header><div class="meta"><div><small>Solution</small><b>{_text(solution, "configuration", _text(solution, "config", "—"))}</b></div><div><small>PV / battery</small><b>{_cell(_lookup(solution, "pv_capacity_kwp_dc", "pv_kw", "pv_capacity"))} / {_cell(_lookup(solution, "battery_capacity_kwh", "battery_kwh", "capacity_kwh"))}</b></div><div><small>Inverter</small><b>{_cell(_lookup(solution, "inverter_kw", "pv_inverter_kw_ac", "inverter_capacity_kw"))}</b></div></div><div class="metrics">{_metric("Upfront", _lookup(financial, "upfront_cost_aud", "upfront_aud", "net_investment_aud"))}{_metric("Year 1 value", _lookup(financial, "first_year_net_value_aud", "year_1_value_aud", "annual_value_aud"))}{_metric("NPV", _lookup(financial, "net_present_value_aud", "npv_aud"))}{_metric("Payback", _lookup(financial, "payback_period_years", "payback_years"))}{_metric("IRR", _lookup(financial, "internal_rate_of_return", "irr"))}</div><h2>No-system / PV-only / PV+battery</h2><table class="data"><thead><tr><th>Case</th><th>Peak kW</th><th>Peak kVA</th></tr></thead><tbody>{"".join(rows)}</tbody></table><p class="notice">customer-facing permission: false · recommendation permission: false · eligibility permission: false · manual-delivery permission: false · repository-delivery permission: false</p></section>'''


def _metric(label: str, value: object) -> str:
    return f'<div class="metric"><small>{escape(label)}</small><strong>{_cell(value)}</strong></div>'


def _page_two(energy: Mapping[str, object], comparison: Mapping[str, object]) -> str:
    kw = _series(energy, "kw", "common_day_kw", "kw_series")
    kva = _series(energy, "kva", "common_day_kva", "kva_series")
    grid_charge = _series(energy, "grid_charge")
    pv_charge = _series(energy, "pv_charge")
    discharge = _series(energy, "battery_discharge", "battery_flows", "battery_flow", "battery_kw")
    soc = _series(energy, "soc", "soc_series", "battery_soc")
    table_rows = []
    points = _all_points(comparison)
    sample_count = min(6, len(points))
    indexes = (
        sorted(
            {
                round(index * (len(points) - 1) / max(1, sample_count - 1))
                for index in range(sample_count)
            }
        )
        if points
        else []
    )
    for index in indexes:
        point = points[index]
        no_system = _mapping(point.get("no_system")); pv_only = _mapping(point.get("pv_only")); battery = _mapping(point.get("pv_battery"))
        table_rows.append(f'<tr><th>{index + 1}</th><td>{_cell(_lookup(point, "local_time_label", "interval_timestamp"))}</td><td>{_cell(_lookup(no_system, "import_kw"))}</td><td>{_cell(_lookup(pv_only, "import_kw"))}</td><td>{_cell(_lookup(battery, "import_kw"))}</td><td>{_cell(_lookup(battery, "soc_end_kwh"))}</td></tr>')
    return f'''<section class="page"><div class="topline"><b>PRIVATE INTERNAL REVIEW</b><span>02 / 03</span></div><header><span class="kicker">Energy change</span><h1>Common-day energy and power</h1><p>Three-case traces and exact returned points. No renderer recalculation.</p></header><div class="charts">{_svg_chart("Common-day kW", [("no-system", _series(energy, "no_system_kw"), "#687486"),("PV-only", _series(energy, "pv_only_kw"), "#1769e0"),("PV+battery", _series(energy, "pv_battery_kw") or kw, "#178078")])}{_svg_chart("Common-day kVA", [("no-system", _series(energy, "no_system_kva"), "#687486"),("PV-only", _series(energy, "pv_only_kva"), "#1769e0"),("PV+battery", _series(energy, "pv_battery_kva") or kva, "#178078")])}</div><div class="charts">{_svg_chart("Battery flows", [("grid charge", grid_charge, "#687486"),("PV charge", pv_charge, "#1769e0"),("discharge", discharge, "#ad6500")])}{_svg_chart("State of charge", [("SOC", soc, "#178078")])}</div><h2>Exact returned sample</h2><table class="data compact"><thead><tr><th>Point</th><th>Local time</th><th>No system kW</th><th>PV-only kW</th><th>PV+battery kW</th><th>SOC kWh</th></tr></thead><tbody>{"".join(table_rows) or '<tr><td colspan="6">No points returned</td></tr>'}</tbody></table></section>'''


def _page_three(financial: Mapping[str, object], assumptions: Mapping[str, object], provenance: Mapping[str, object], limitations: object, contract: Mapping[str, object]) -> str:
    cash = _series(financial, "annual_cashflows_aud", "cashflows_aud", "annual_cashflow")
    cash_indexes = sorted({round(index * (len(cash) - 1) / 5) for index in range(min(6, len(cash)))}) if cash else []
    rows = "".join(f"<tr><th>Year {index + 1}</th><td>{_cell(cash[index])}</td></tr>" for index in cash_indexes) or '<tr><td colspan="2">No annual cashflows returned</td></tr>'
    provenance_rows = "".join(f"<tr><th>{escape(str(k).replace('_', ' ').title())}</th><td class=\"digest\">{_cell(v)}</td></tr>" for k, v in provenance.items()) or '<tr><td colspan="2">No provenance fields returned</td></tr>'
    assumption_rows = "".join(f"<li><b>{escape(str(k).replace('_', ' ').title())}:</b> {_cell(v)}</li>" for k, v in assumptions.items()) or '<li>No assumptions returned</li>'
    return f'''<section class="page"><div class="topline"><b>PRIVATE INTERNAL REVIEW</b><span>03 / 03</span></div><header><span class="kicker">Investment and evidence</span><h1>Cashflow, assumptions, provenance</h1><p>Internal evidence-bound review with explicit limitations.</p></header><div class="cash">{_svg_chart("Annual cashflow", [("cashflow", cash, "#1769e0")])}<table class="data compact"><thead><tr><th>Period</th><th>Cashflow AUD</th></tr></thead><tbody>{rows}</tbody></table></div><div class="columns"><div><h2>Assumptions</h2><ul>{assumption_rows}</ul></div><div><h2>Provenance and digests</h2><table class="data compact">{provenance_rows}</table></div></div><div class="disclaimer"><h2>Limitations</h2><p>{_cell(limitations)}</p><p>Customer-facing, recommendation, manual-delivery and repository-delivery permissions are false. This artifact is for private internal review and is not a customer report.</p></div></section>'''


def _head() -> str:
    return '''<meta charset="utf-8"><title>Private internal review</title><style>@page{size:A4 portrait;margin:14mm 16mm 16mm}*{box-sizing:border-box}html,body{margin:0;color:#152235;font-family:"DejaVu Sans",Arial,sans-serif;font-size:9pt;line-height:1.4}body{background:#eef2f6}.page{width:210mm;min-height:297mm;margin:0 auto 12px;padding:14mm 16mm 16mm;background:#fff;break-after:page;page-break-after:always}.page:last-child{break-after:auto;page-break-after:auto}.topline{display:flex;justify-content:space-between;border-bottom:1px solid #dbe2ea;padding-bottom:3mm;color:#506176;font-size:7pt;letter-spacing:.08em}.kicker{color:#1769e0;font-size:7pt;font-weight:700;letter-spacing:.1em;text-transform:uppercase}header{padding:7mm 0 5mm}h1{font-size:23pt;line-height:1.1;font-weight:500;letter-spacing:-.03em;margin:2mm 0}header p{color:#506176;max-width:150mm}.meta{display:grid;grid-template-columns:2fr 1fr 1fr;gap:5mm;border-block:1px solid #dbe2ea;padding:4mm 0;margin-bottom:6mm}.meta small,.metric small{display:block;color:#66778b;font-size:7pt;text-transform:uppercase;letter-spacing:.05em}.meta b{display:block;margin-top:1mm}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:4mm;margin-bottom:7mm}.metric{border-top:2px solid #1769e0;padding-top:3mm}.metric strong{display:block;font-size:13pt;font-weight:500;margin-top:2mm;overflow-wrap:anywhere}h2{font-size:12pt;font-weight:600;margin:4mm 0 2mm}.data{width:100%;border-collapse:collapse}.data th,.data td{padding:2.2mm 2mm;border-bottom:1px solid #dbe2ea;text-align:right;font-variant-numeric:tabular-nums}.data th:first-child,.data td:first-child{text-align:left}.compact th,.compact td{padding:1.2mm 1mm;font-size:7.5pt}.notice{margin-top:6mm;padding:3mm;background:#f2f6fb;color:#506176;font-size:8pt}.charts,.cash{display:grid;grid-template-columns:1fr 1fr;gap:5mm}.figure{margin:0 0 2mm}.figure figcaption{font-weight:700;margin-bottom:1mm}.figure svg{width:100%;height:auto;background:#fbfcfe;border:1px solid #e1e7ee}.legend{font-size:7pt;color:#66778b;margin-top:1mm}.columns{display:grid;grid-template-columns:1fr 1.15fr;gap:5mm;margin-top:3mm}.columns ul{margin:0;padding-left:5mm;font-size:7.4pt}.columns li{margin:.7mm 0}.columns .data th,.columns .data td{padding:.7mm;font-size:6.3pt;line-height:1.18}.columns .data th{width:33%}.digest{overflow-wrap:anywhere;word-break:break-all}.disclaimer{margin-top:3mm;border-top:2px solid #152235;padding-top:2mm;color:#506176;font-size:7.5pt}.disclaimer h2{margin-top:0;font-size:9pt}@media screen{.page{box-shadow:0 5px 25px #c9d2dc}}@media screen and (max-width:700px){body{background:#fff}.page{width:auto;min-height:0;margin:0;padding:24px 18px}.charts,.cash,.columns,.meta,.metrics{grid-template-columns:1fr}.page{break-after:auto}.topline{margin-top:12px}} </style>'''

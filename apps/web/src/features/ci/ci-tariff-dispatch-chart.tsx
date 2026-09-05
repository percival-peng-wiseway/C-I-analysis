import { useState } from "react";

import type { CiDispatchReviewPoint, CiDispatchReviewProjection } from "./api/ci-scenarios";

type Series = { key: keyof CiDispatchReviewPoint; label: string; color: string };
const batterySeries: Series[] = [
  { key: "battery_discharge_kw", label: "Battery discharge", color: "#059669" },
  { key: "grid_charge_kw", label: "Grid charging", color: "#d97706" },
  { key: "pv_charge_kw", label: "PV charging", color: "#7c3aed" },
];

/** Charts only the saved Python dispatch projection; viewing never runs a solver. */
export function CiTariffDispatchChart({ projection }: { projection: CiDispatchReviewProjection }) {
  const [unit, setUnit] = useState<"kVA" | "kW">("kVA");
  const points = projection.points;
  if (!points.length) return <p role="status">No saved tariff dispatch intervals are available.</p>;
  const activeIntervals = points.filter((point) => point.battery_discharge_kw > 1e-3 || point.grid_charge_kw > 1e-3 || point.pv_charge_kw > 1e-3).length;
  const maximumReactive = Math.max(0, ...points.map((point) => point.inverter_reactive_support_kvar));
  const hasSoc = projection.soc_status !== "not_applicable_no_battery" && points.some((point) => point.soc_end_kwh !== null && Number.isFinite(point.soc_end_kwh));
  const demandSeries: Series[] = unit === "kVA"
    ? [{ key: "baseline_kva", label: "Baseline kVA", color: "#64748b" }, { key: "post_dispatch_kva", label: "Post-dispatch kVA", color: "#0891b2" }]
    : [{ key: "baseline_import_kw", label: "Baseline import kW", color: "#64748b" }, { key: "post_dispatch_import_kw", label: "Post-dispatch import kW", color: "#0891b2" }];

  return <section aria-label="Saved tariff dispatch" className="space-y-5 rounded-xl border border-slate-200 p-4 sm:p-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h4 className="font-semibold text-slate-950">Tariff-aware dispatch · Finance calculation source</h4><p className="mt-1 text-sm text-slate-500">{projection.peak_local_date} · highest post-dispatch rolling-window kVA day</p></div>
      <div aria-label="Tariff demand unit" className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1" role="group">
        {(["kVA", "kW"] as const).map((value) => <button aria-pressed={unit === value} className={`rounded-md px-3 py-2 text-xs font-semibold ${unit === value ? "bg-white text-cyan-800 shadow-sm" : "text-slate-500"}`} key={value} onClick={() => setUnit(value)} type="button">{value === "kVA" ? "Apparent demand · kVA" : "Active import · kW"}</button>)}
      </div>
    </div>
    <div className="flex flex-wrap gap-2 text-xs font-semibold"><span className={`rounded-full px-3 py-1.5 ${activeIntervals ? "bg-cyan-50 text-cyan-800" : "bg-amber-50 text-amber-900"}`}>{activeIntervals ? `${activeIntervals} battery-active intervals` : "Battery idle on this day"}</span><span className="rounded-full bg-violet-50 px-3 py-1.5 text-violet-800">Reactive support up to {number(maximumReactive)} kvar</span></div>
    {!activeIntervals ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">This selected tariff peak day contains no battery charge or discharge, so a battery-created flat top is not expected. The apparent-demand reduction shown here comes from PV and reactive support.</p> : null}
    <SavedSeriesChart label="Tariff interval demand replay" points={points} series={demandSeries} unit={unit} />
    <div className="border-t border-slate-200 pt-5">
      <h4 className="mb-3 text-sm font-semibold text-slate-950">Battery charging &amp; discharging</h4>
      <SavedSeriesChart label="Tariff battery charge and discharge" points={points} series={batterySeries} unit="kW" />
    </div>
    <div className="border-t border-slate-200 pt-5">
      <h4 className="mb-3 text-sm font-semibold text-slate-950">Stored energy · end of interval</h4>
      {hasSoc ? <SavedSeriesChart label="Tariff battery state of charge" points={points} series={[{ key: "soc_end_kwh", label: "Stored energy", color: "#0891b2" }]} unit="kWh" /> : <p className="text-sm text-slate-500">{projection.soc_status === "not_applicable_no_battery" ? "Solar-only solution · no battery SOC applies." : "No saved battery SOC is available."}</p>}
    </div>
    <details className="border-t border-slate-200 pt-4">
      <summary className="cursor-pointer text-sm font-semibold text-cyan-800">Saved interval values</summary>
      <div className="mt-3 max-h-80 overflow-auto"><table className="w-full min-w-[1050px] text-right text-xs tabular-nums"><caption className="sr-only">Saved Python tariff dispatch values for {projection.peak_local_date}</caption><thead className="sticky top-0 bg-slate-50 text-slate-600"><tr>{["Local time", "Before kW", "After kW", "Before kVA", "After kVA", "Discharge kW", "Grid charge kW", "PV charge kW", "SOC kWh", "Support kvar"].map((label) => <th className="px-3 py-2 font-medium first:text-left" key={label}>{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{points.map((point, index) => <tr key={point.interval_timestamp ?? index}><th className="whitespace-nowrap px-3 py-2 text-left font-medium">{point.local_time_label}</th>{[point.baseline_import_kw, point.post_dispatch_import_kw, point.baseline_kva, point.post_dispatch_kva, point.battery_discharge_kw, point.grid_charge_kw, point.pv_charge_kw, point.soc_end_kwh, point.inverter_reactive_support_kvar].map((value, column) => <td className="px-3 py-2" key={column}>{number(value)}</td>)}</tr>)}</tbody></table></div>
    </details>
  </section>;
}

function SavedSeriesChart({ label, points, series, unit }: { label: string; points: CiDispatchReviewPoint[]; series: Series[]; unit: string }) {
  const width = 920; const height = 250; const left = 65; const right = 18; const top = 24; const bottom = 40;
  const numericValue = (point: CiDispatchReviewPoint, key: keyof CiDispatchReviewPoint) => typeof point[key] === "number" && Number.isFinite(point[key]) ? point[key] as number : null;
  const values = points.flatMap((point) => series.flatMap(({ key }) => { const value = numericValue(point, key); return value === null ? [] : [value]; }));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(1, ...values) * 1.06;
  const x = (index: number) => left + (width - left - right) * index / Math.max(1, points.length - 1);
  const y = (value: number) => top + (height - top - bottom) * (maximum - value) / (maximum - minimum);
  const path = (key: keyof CiDispatchReviewPoint) => {
    let connected = false;
    return points.map((point, index) => { const value = numericValue(point, key); if (value === null) { connected = false; return ""; } const segment = `${connected ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`; connected = true; return segment; }).join(" ");
  };
  const ticks = [...new Set([0, .25, .5, .75, 1].map((fraction) => Math.round((points.length - 1) * fraction)))];
  return <div>
    <div className="overflow-x-auto"><svg aria-label={label} className="block h-auto w-full min-w-[640px]" role="img" viewBox={`0 0 ${width} ${height}`}>
      <title>{label} · {unit} · saved Python tariff dispatch</title>
      <rect fill="#fbfdff" height={height - top - bottom} width={width - left - right} x={left} y={top} />
      {[0, .25, .5, .75, 1].map((fraction) => { const value = minimum + (maximum - minimum) * fraction; return <g key={fraction}><line stroke="#e2e8f0" x1={left} x2={width-right} y1={y(value)} y2={y(value)} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left-8} y={y(value)+4}>{number(value, 1)}</text></g>; })}
      {series.map(({ color, key, label: seriesLabel }) => <g key={key}><path d={path(key)} fill="none" stroke={color} strokeWidth="2.5" />{points.map((point, index) => { const value = numericValue(point, key); return value === null ? null : <circle cx={x(index)} cy={y(value)} fill={color} key={index} r={points.length === 1 ? 3 : 1.4}><title>{point.local_time_label} · {seriesLabel}: {number(value)} {unit}</title></circle>; })}</g>)}
      {ticks.map((index) => <text fill="#64748b" fontSize="11" key={index} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} x={x(index)} y={height-12}>{points[index].local_time_label}</text>)}
      <text fill="#475569" fontSize="11" x="8" y="15">{unit}</text>
    </svg></div>
    <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">{series.map(({ color, label: seriesLabel }) => <span className="inline-flex items-center gap-2" key={seriesLabel}><span aria-hidden="true" className="h-0.5 w-5" style={{ backgroundColor: color }} />{seriesLabel}</span>)}</div>
  </div>;
}

function number(value: number | null | undefined, digits = 3) { return value === null || value === undefined || !Number.isFinite(value) ? "Not available" : new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value); }

import { useState } from "react";
import type { CiFeasibilityScenario } from "./api/ci-design-feasibility";
import { useChartWidth } from "./use-chart-width";

const series = [
  { key: "baseline_kw", label: "Measured import", colour: "#334155" },
  { key: "pv_only_import_kw", label: "PV only", colour: "#d97706" },
  { key: "pv_battery_import_kw", label: "PV + battery", colour: "#0891b2" },
] as const;
type ImportKey = typeof series[number]["key"];
const number = (value: number) => Number.isFinite(value) ? value.toLocaleString("en-AU", { maximumFractionDigits: 2 }) : "Unavailable";
const left = 58, right = 18;
// Use Python's meter-time labels directly. Browser timezone conversion would shift the curves.
const minute = (label: string) => { const [h, m] = label.split(":").map(Number); return h * 60 + m; };

export function ScenarioPeakReplay({ scenario }: { scenario: CiFeasibilityScenario }) {
  return <PeakReplay key={`${scenario.scenario_id}:${scenario.peak_day.date}`} scenario={scenario} />;
}

function PeakReplay({ scenario }: { scenario: CiFeasibilityScenario }) {
  const { ref, width } = useChartWidth();
  const x = (label: string) => left + (width - left - right) * minute(label) / 1440;
  const { points, sampled_target_kw: target, date } = scenario.peak_day;
  const [visible, setVisible] = useState<Record<ImportKey, boolean>>({ baseline_kw: true, pv_only_import_kw: true, pv_battery_import_kw: true });
  const [showPv, setShowPv] = useState(true);
  const [selected, setSelected] = useState(0);
  if (!points.length) return <p className="p-5 text-sm text-slate-600">No peak-day intervals available. Run analysis to populate this chart.</p>;
  const current = points[Math.min(selected, points.length - 1)];
  const pvAvailable = points.every(point => Number.isFinite(point.pv_generation_kw));
  const generating = points.filter(point => point.pv_generation_kw > 0.001);
  const discharging = points.filter(point => point.battery_discharge_kw > 0.001);
  const overlaps = Math.abs(current.pv_only_import_kw - current.pv_battery_import_kw) <= 0.01;
  // Keep scales stable when toggling series; never offset overlapping values for visibility.
  const maximum = Math.max(1, target ?? 0, ...points.flatMap(point => series.map(s => point[s.key]))) * 1.05;
  const pvMaximum = Math.max(1, ...points.map(point => Number.isFinite(point.pv_generation_kw) ? point.pv_generation_kw : 0)) * 1.05;
  const y = (value: number, max: number, bottom: number) => bottom - (bottom - 20) * value / max;
  const path = (key: ImportKey | "pv_generation_kw", max: number, bottom: number) => points.map((point, index) => `${index ? "L" : "M"}${x(point.time_label).toFixed(2)},${y(point[key], max, bottom).toFixed(2)}`).join(" ");
  const axes = (max: number, bottom: number) => <>
    {[0, .25, .5, .75, 1].map(tick => <g key={tick}><line stroke="#e2e8f0" x1={left} x2={width - right} y1={y(max * tick, max, bottom)} y2={y(max * tick, max, bottom)} /><text x={left - 8} y={y(max * tick, max, bottom) + 4} textAnchor="end" fill="#64748b" fontSize="11">{number(max * tick)}</text></g>)}
    {(width < 480 ? [0, 12, 24] : [0, 6, 12, 18, 24]).map(hour => <text key={hour} x={x(`${hour}:00`)} y={bottom + 22} textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"} fill="#64748b" fontSize="11">{String(hour).padStart(2, "0")}:00</text>)}
    <text x="8" y="13" fill="#475569" fontSize="11">kW</text>
  </>;
  const hoverTargets = (bottom: number) => points.map((point, index) => {
    const start = index === 0 ? left : (x(points[index - 1].time_label) + x(point.time_label)) / 2;
    const end = index === points.length - 1 ? width - right : (x(point.time_label) + x(points[index + 1].time_label)) / 2;
    return <rect key={point.time_label} x={start} y={20} width={Math.max(0, end - start)} height={bottom - 20} fill="transparent" onMouseEnter={() => setSelected(index)} onClick={() => setSelected(index)}><title>{point.time_label} · PV generation: {number(point.pv_generation_kw)} kW · PV only import: {number(point.pv_only_import_kw)} kW · PV + battery import: {number(point.pv_battery_import_kw)} kW</title></rect>;
  });
  const toggleClass = "inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-700";
  return <section aria-label="Technical peak-day replay" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
    <h4 className="font-semibold text-slate-950">Scenario Analysis · active-power peak shaving</h4>
    <p className="mt-1 text-sm text-slate-500">{date} · pre-tariff technical dispatch in kW</p>
    <p className="mt-3 text-sm text-slate-600">Top chart: electricity imported from the grid, not solar output. PV generation is shown separately below.</p>
    <div className="mt-4 flex flex-wrap gap-2" aria-label="Visible chart series">
      {series.map(s => <button key={s.key} type="button" aria-pressed={visible[s.key]} className={`${toggleClass} ${visible[s.key] ? "border-slate-300 text-slate-800" : "border-slate-200 text-slate-400"}`} onClick={() => setVisible(v => ({ ...v, [s.key]: !v[s.key] }))}><span aria-hidden="true" className="w-5 border-t-[3px]" style={{ borderColor: s.colour, borderTopStyle: s.key === "pv_battery_import_kw" ? "dashed" : "solid" }} />{s.label}</button>)}
      <button type="button" aria-pressed={showPv} className={`${toggleClass} ${showPv ? "border-slate-300 text-slate-800" : "border-slate-200 text-slate-400"}`} onClick={() => setShowPv(v => !v)}><span aria-hidden="true" className="w-5 border-t-[3px] border-emerald-600" />PV generation</button>
    </div>
    <p className="mt-2 text-xs text-slate-500">Click a legend to show or hide a series. Dashed blue over solid amber means equal grid import, not missing PV.</p>
    <div ref={ref} className="mt-4 min-w-0">
      <svg aria-label="Scenario Analysis active-power peak shaving replay" role="img" className="block w-full" viewBox={`0 0 ${width} 300`}>
        {axes(maximum, 264)}
        {target !== null && <line stroke="#64748b" strokeDasharray="3 5" x1={left} x2={width - right} y1={y(target, maximum, 264)} y2={y(target, maximum, 264)} />}
        {series.filter(s => visible[s.key]).map(s => <path key={s.key} data-series={s.key} d={path(s.key, maximum, 264)} fill="none" stroke={s.colour} strokeWidth={s.key === "pv_only_import_kw" ? 3.5 : 2.5} strokeDasharray={s.key === "pv_battery_import_kw" ? "7 5" : undefined} />)}
        <line x1={x(current.time_label)} x2={x(current.time_label)} y1={20} y2={264} stroke="#94a3b8" strokeDasharray="2 4" />
        {hoverTargets(264)}
      </svg>
      {showPv && <div className="mt-4 min-w-0 border-t border-slate-100 pt-4">
        <h5 className="text-sm font-semibold text-emerald-800">PV generation (modelled)</h5>
        <p className="mt-1 text-xs text-slate-500">Same meter-time axis; separate kW scale. Generation is not the same as avoided grid import.</p>
        {pvAvailable ? <svg aria-label="Technical screening PV generation" role="img" className="block w-full" viewBox={`0 0 ${width} 170`}>
          {axes(pvMaximum, 134)}
          <path d={`${path("pv_generation_kw", pvMaximum, 134)} L${x(points[points.length - 1].time_label)},134 L${x(points[0].time_label)},134 Z`} fill="#d1fae5" />
          <path data-series="pv_generation_kw" d={path("pv_generation_kw", pvMaximum, 134)} fill="none" stroke="#047857" strokeWidth="2.5" />
          <line x1={x(current.time_label)} x2={x(current.time_label)} y1={20} y2={134} stroke="#94a3b8" strokeDasharray="2 4" />
          {hoverTargets(134)}
        </svg> : <p className="py-4 text-sm text-slate-600">PV generation data unavailable. Run analysis again.</p>}
      </div>}
    </div>
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
      <span>{pvAvailable ? generating.length ? `Modelled PV above 0.001 kW: ${generating[0].time_label} to ${generating[generating.length - 1].time_label}` : "No modelled PV generation on this day" : "PV generation unavailable"}</span>
      <span>{discharging.length} discharge intervals</span>
      {target !== null && <><span>{points.filter(p => p.battery_discharge_kw > .001 && Math.abs(p.pv_battery_import_kw - target) <= .01).length} intervals at target</span><span>Sampled target {number(target)} kW (dotted grey)</span></>}
    </div>
    <div className="mt-4 rounded-lg bg-slate-50 p-4">
      <label className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">Inspect interval <span className="tabular-nums">{current.time_label} · meter time</span><input aria-label="Inspect replay interval" className="w-1/3 accent-cyan-700" type="range" min="0" max={points.length - 1} value={Math.min(selected, points.length - 1)} onChange={e => setSelected(Number(e.target.value))} /></label>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4" aria-label="Selected interval values">
        {series.map(s => <div key={s.key}><dt className="text-slate-500">{s.label}</dt><dd className="mt-1 font-semibold tabular-nums text-slate-900">{number(current[s.key])} kW</dd></div>)}
        <div><dt className="text-slate-500">PV generation</dt><dd className="mt-1 font-semibold tabular-nums text-emerald-800">{number(current.pv_generation_kw)} kW</dd></div>
      </dl>
      <p className="mt-3 text-xs text-slate-600">Battery charge {number(current.battery_charge_kw)} kW · discharge {number(current.battery_discharge_kw)} kW. {overlaps ? "PV only and PV + battery overlap at this interval (within 0.01 kW)." : "PV only and PV + battery have different grid import at this interval."}</p>
    </div>
    <p className="mt-3 text-xs text-slate-500">Times come from the saved meter intervals, without browser timezone conversion. The PV window is modelled output, not an observed sunrise or a weather measurement.</p>
  </section>;
}

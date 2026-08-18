import { useState } from "react";
import { Activity, BatteryCharging, Gauge, ShieldCheck, SunMedium } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiDesignFeasibilityResult, CiFeasibilityEnergyTotals, CiFeasibilityPerformance, CiFeasibilityScenario } from "@/features/ci/api/ci-design-feasibility";
import { CiIntervalActivityChart } from "@/features/ci/ci-interval-activity-chart";

export function CiDesignFeasibility({ projectId, result }: { projectId: string; result: CiDesignFeasibilityResult }) {
  const [scenarioId, setScenarioId] = useState(result.scenarios[0].scenario_id);
  const selected = result.scenarios.find((item) => item.scenario_id === scenarioId) ?? result.scenarios[0];
  const availableYears = result.coverage.years.map((item) => item.year);
  const [year, setYear] = useState(result.coverage.primary_year);
  const yearResult = selected.yearly_energy.find((item) => item.year === year);
  const energy = yearResult ?? selected.coverage_energy;
  const performance = yearResult?.performance ?? selected.coverage_performance;
  const yearState = result.coverage.years.find((item) => item.year === year);

  return <section className="space-y-5" aria-label="System feasibility analysis">
    <Card className="overflow-hidden border-slate-800 bg-slate-950 text-white">
      <CardHeader><div className="flex flex-wrap items-start justify-between gap-4"><div><CardTitle as="h2" className="text-2xl">Physical feasibility explorer</CardTitle><CardDescription className="mt-2 max-w-3xl text-slate-300">Compare every saved system against the project’s measured active import. Energy and peak-day views use separate, explicit physical review modes.</CardDescription></div><div className="flex gap-2"><Badge variant="secondary">{result.coverage.interval_minutes}-minute source basis</Badge><Badge variant="outline" className="border-white/20 text-slate-200">No tariff dollars</Badge></div></div></CardHeader>
      <CardContent><div className="grid gap-3 md:grid-cols-3"><ScopeFact label="Coverage" value={`${dateLabel(result.coverage.start_timestamp)} – ${dateLabel(result.coverage.end_timestamp)}`} /><ScopeFact label="Measured intervals" value={formatNumber(result.coverage.interval_count, 0)} /><ScopeFact label="Candidates evaluated" value={String(result.scenarios.length)} /></div></CardContent>
    </Card>

    <Card><CardHeader><div className="flex flex-wrap items-end justify-between gap-4"><div><CardTitle as="h3">Choose a scenario to inspect</CardTitle><CardDescription>All candidates are shown without ranking or recommendation.</CardDescription></div><div className="flex flex-wrap gap-3"><label className="text-xs font-medium text-slate-600">Scenario<select className="mt-1 block min-w-[250px] rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-900" value={selected.scenario_id} onChange={(event) => setScenarioId(event.target.value)}>{result.scenarios.map((item) => <option value={item.scenario_id} key={item.scenario_id}>{item.label}</option>)}</select></label><label className="text-xs font-medium text-slate-600">Energy year<select className="mt-1 block rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-900" value={year} onChange={(event) => setYear(Number(event.target.value))}>{availableYears.map((value) => <option value={value} key={value}>{value}</option>)}</select></label></div></div></CardHeader>
      <CardContent className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={SunMedium} label={`${year} grid import reduction`} value={`${formatNumber(energy.grid_import_reduction_kwh / 1000)} MWh`} detail={`${formatNumber(energy.grid_import_reduction_percent)}% of measured import`} /><Metric icon={Gauge} label="Targeted peak-day capability" value={`${formatNumber(selected.peak_day.peak_reduction_kw)} kW`} detail={`${formatNumber(selected.peak_day.baseline_peak_kw)} → ${formatNumber(selected.peak_day.achieved_peak_kw)} kW physical envelope`} /><Metric icon={Activity} label="Top measured peaks improved" value={`${formatNumber(performance.top_10_event_coverage_percent, 0)}%`} detail={`${performance.top_10_events_mitigated} of ${performance.top_10_event_count} PV-first coverage events`} /><Metric icon={BatteryCharging} label="Battery utilisation" value={`${formatNumber(energy.battery_equivalent_full_cycles)} EFC`} detail={`${energy.battery_active_days} active days · ${formatNumber(performance.battery_duration_at_max_discharge_hours)} h duration`} /></div>{yearState && !yearState.complete_calendar_year ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><strong>{year} is partial coverage.</strong> Values show only the measured intervals in this project; they are not annualised.</p> : null}</CardContent>
    </Card>

    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardHeader><CardTitle as="h3">Grid import outcome</CardTitle><CardDescription>No system, PV-only and PV+battery remain separate so battery impact is not attributed to solar.</CardDescription></CardHeader><CardContent><EnergyComparisonChart energy={energy} /></CardContent></Card>
      <Card><CardHeader><CardTitle as="h3">PV utilisation</CardTitle><CardDescription>Physical disposition of generated solar across direct use, battery charging, export and inverter/headroom clipping.</CardDescription></CardHeader><CardContent><PvDispositionChart energy={energy} /></CardContent></Card>
    </div>

    <div className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]">
      <Card><CardHeader><CardTitle as="h3">Peak-day import profile</CardTitle><CardDescription>{selected.peak_day.date}: measured import, PV-only import and PV+battery physical envelope.</CardDescription></CardHeader><CardContent><PeakDayChart scenario={selected} /></CardContent></Card>
      <Card><CardHeader><CardTitle as="h3">Peak-day outcome</CardTitle><CardDescription>Battery targets active-power peaks only; this is not chargeable demand.</CardDescription></CardHeader><CardContent className="space-y-4"><PeakFlow maximum={selected.peak_day.baseline_peak_kw} value={selected.peak_day.baseline_peak_kw} label="Measured peak" tone="slate" /><PeakFlow maximum={selected.peak_day.baseline_peak_kw} value={selected.peak_day.pv_only_peak_kw} label="After PV" tone="amber" /><PeakFlow maximum={selected.peak_day.baseline_peak_kw} value={selected.peak_day.achieved_peak_kw} label="After PV + battery" tone="cyan" /><div className="rounded-xl bg-cyan-50 p-4 text-cyan-950"><p className="text-xs font-semibold uppercase tracking-[.16em]">Physical peak reduction</p><p className="mt-1 text-3xl font-semibold tabular-nums">{formatNumber(selected.peak_day.peak_reduction_percent)}%</p><p className="mt-2 text-xs text-cyan-900/75">Starts at the authored {formatNumber(selected.initial_soc_kwh ?? 0)} kWh SOC. Tariff windows and kVA billing are not applied.</p></div></CardContent></Card>
    </div>

    <div className="grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
      <Card><CardHeader><CardTitle as="h3">Top measured peak events</CardTitle><CardDescription>Highest measured events are separated by at least two hours. Bars show the PV-first coverage dispatch, not tariff-window demand.</CardDescription></CardHeader><CardContent><TopPeakEventsChart performance={performance} /></CardContent></Card>
      <Card><CardHeader><CardTitle as="h3">Power and energy fit</CardTitle><CardDescription>Checks whether the authored battery has enough power, usable duration and operating opportunity.</CardDescription></CardHeader><CardContent><TechnicalFitSummary energy={energy} performance={performance} /></CardContent></Card>
    </div>

    <CiIntervalActivityChart projectId={projectId} result={result} scenario={selected} />

    <Card><CardHeader><CardTitle as="h3">Measured daily demand context</CardTitle><CardDescription>Grey shows sampled measured days; purple shows the average day and magenta highlights the selected maximum-kW day.</CardDescription></CardHeader><CardContent><DailyProfileCloud result={result} /></CardContent></Card>

    <Card>
      <CardHeader><CardTitle as="h3">Candidate comparison</CardTitle><CardDescription>Use the charts to compare physical effect. Exact values stay available on demand without dominating the page.</CardDescription></CardHeader>
      <CardContent>
        <div className="grid gap-6 xl:grid-cols-2"><div><h4 className="text-sm font-semibold text-slate-900">Physical benefit comparison</h4><p className="mt-1 text-xs text-slate-500">Selected-year grid-import reduction and common peak-day capability.</p><CandidateComparison scenarios={result.scenarios} year={year} /></div><div><h4 className="text-sm font-semibold text-slate-900">Battery sizing map</h4><p className="mt-1 text-xs text-slate-500">Capacity versus peak-day reduction; larger dots indicate more grid-import reduction.</p><SizingEfficiencyChart scenarios={result.scenarios} year={year} selectedId={selected.scenario_id} /></div></div>
        <details className="group mt-5 rounded-xl border border-border bg-slate-50"><summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-800"><span>View exact candidate values</span><span className="text-xs font-normal text-slate-500">{result.scenarios.length} candidates · optional detail</span></summary><div className="max-h-[520px] overflow-auto border-t border-border bg-white"><table className="w-full min-w-[1100px] text-left text-sm"><thead className="sticky top-0 bg-slate-100"><tr><th className="px-4 py-3">Candidate</th><th className="px-4 py-3">PV / inverter</th><th className="px-4 py-3">Battery / power</th><th className="px-4 py-3">Grid import reduction</th><th className="px-4 py-3">Peak-day capability</th><th className="px-4 py-3">EFC / active days</th><th className="px-4 py-3"></th></tr></thead><tbody>{result.scenarios.map((item) => { const itemEnergy = item.yearly_energy.find((entry) => entry.year === year) ?? item.coverage_energy; return <tr className={`border-t ${item.scenario_id === selected.scenario_id ? "bg-cyan-50" : "bg-white"}`} key={item.scenario_id}><td className="px-4 py-3 font-medium">{item.label}</td><td className="px-4 py-3 tabular-nums">{formatNumber(item.authored_inputs.pv_capacity_kwp_dc)} kWp / {formatNumber(item.authored_inputs.pv_inverter_capacity_kw_ac)} kW</td><td className="px-4 py-3 tabular-nums">{formatNumber(item.authored_inputs.nominal_capacity_kwh)} kWh / {formatNumber(item.authored_inputs.max_discharge_kw)} kW</td><td className="px-4 py-3 tabular-nums">{formatNumber(itemEnergy.grid_import_reduction_percent)}%</td><td className="px-4 py-3 tabular-nums">{formatNumber(item.peak_day.peak_reduction_kw)} kW</td><td className="px-4 py-3 tabular-nums">{formatNumber(itemEnergy.battery_equivalent_full_cycles)} / {itemEnergy.battery_active_days}</td><td className="px-4 py-3"><Button type="button" variant="outline" onClick={() => setScenarioId(item.scenario_id)}>Inspect</Button></td></tr>; })}</tbody></table></div></details>
      </CardContent>
    </Card>

    <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-950"><div className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><div><strong>Interpretation boundary</strong><p className="mt-1">This stage compares physical kW/kWh behavior only. A later evidence-approved tariff stage must separately confirm billing windows, kVA/PF treatment, minimum demand and customer-dollar values.</p></div></div></div>
  </section>;
}

function EnergyComparisonChart({ energy }: { energy: CiFeasibilityEnergyTotals }) {
  const rows = [
    { label: "No system", value: energy.site_import_before_kwh, color: "#334155" },
    { label: "PV only", value: energy.grid_import_after_pv_only_kwh, color: "#eab308" },
    { label: "PV + battery", value: energy.grid_import_after_kwh, color: "#0891b2" },
  ];
  const width = 640; const height = 220; const left = 118; const right = 82; const top = 20; const rowHeight = 58; const maximum = Math.max(1, ...rows.map((row) => row.value));
  const scale = (value: number) => (width - left - right) * value / maximum;
  return <div><svg aria-label="Annual grid import comparison" className="w-full min-w-[520px]" role="img" viewBox={`0 0 ${width} ${height}`}>{rows.map((row, index) => { const y = top + index * rowHeight; return <g key={row.label}><text fill="#475569" fontSize="12" textAnchor="end" x={left - 10} y={y + 24}>{row.label}</text><rect fill="#eef2f7" height="30" rx="5" width={width - left - right} x={left} y={y + 5} /><rect fill={row.color} height="30" rx="5" width={scale(row.value)} x={left} y={y + 5} /><text fill="#0f172a" fontSize="12" fontWeight="600" x={width - right + 9} y={y + 25}>{formatNumber(row.value / 1000)} MWh</text></g>; })}</svg><Legend items={[["#334155", "Measured baseline"], ["#eab308", "After PV"], ["#0891b2", "After PV + battery"]]} /></div>;
}

function PvDispositionChart({ energy }: { energy: CiFeasibilityEnergyTotals }) {
  const categories = [
    { label: "Direct to load", value: energy.pv_direct_to_load_kwh, color: "#f59e0b" },
    { label: "To battery", value: energy.pv_to_battery_kwh, color: "#0891b2" },
    { label: "Grid export", value: energy.grid_export_kwh, color: "#d946ef" },
    { label: "Clipped", value: energy.pv_clipped_kwh, color: "#94a3b8" },
  ];
  const total = Math.max(1, categories.reduce((sum, item) => sum + item.value, 0));
  const width = 640; const height = 150; const left = 18; const right = 18; const barY = 44; const barHeight = 42; let offset = left;
  return <div><svg aria-label="Solar generation disposition" className="w-full min-w-[520px]" role="img" viewBox={`0 0 ${width} ${height}`}><text fill="#475569" fontSize="12" x={left} y="20">{formatNumber(energy.pv_generation_kwh / 1000)} MWh generated · {formatNumber(energy.pv_self_consumption_percent)}% physically self-consumed</text><rect fill="#eef2f7" height={barHeight} rx="7" width={width - left - right} x={left} y={barY} />{categories.map((item) => { const itemWidth = (width - left - right) * item.value / total; const current = offset; offset += itemWidth; return <rect fill={item.color} height={barHeight} key={item.label} width={itemWidth} x={current} y={barY}><title>{item.label}: {formatNumber(item.value / 1000)} MWh</title></rect>; })}<text fill="#64748b" fontSize="11" x={left} y="112">PV used onsite or charged: {formatNumber((energy.pv_direct_to_load_kwh + energy.pv_to_battery_kwh) / 1000)} MWh</text><text fill="#64748b" fontSize="11" textAnchor="end" x={width - right} y="112">Export: {formatNumber(energy.grid_export_kwh / 1000)} MWh</text></svg><Legend items={categories.map((item) => [item.color, item.label]) as Array<[string, string]>} /></div>;
}

function TopPeakEventsChart({ performance }: { performance: CiFeasibilityPerformance }) {
  const events = performance.top_peak_events.slice(0, 10);
  if (!events.length) return <p className="text-sm text-slate-500">No measured peak events are available for this period.</p>;
  const width = Math.max(760, events.length * 78); const height = 320; const left = 54; const right = 16; const top = 24; const bottom = 66; const plotHeight = height - top - bottom; const groupWidth = (width - left - right) / events.length; const maximum = Math.max(1, ...events.map((event) => event.baseline_kw)) * 1.08; const y = (value: number) => top + plotHeight * (1 - value / maximum);
  return <div className="overflow-x-auto"><svg aria-label="Top measured peak event comparison" className="min-w-[760px]" role="img" viewBox={`0 0 ${width} ${height}`}>{[0, .25, .5, .75, 1].map((tick) => <g key={tick}><line stroke="#dbe3ec" x1={left} x2={width-right} y1={y(maximum*tick)} y2={y(maximum*tick)} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left-8} y={y(maximum*tick)+4}>{formatNumber(maximum*tick,0)}</text></g>)}{events.map((event, index) => { const x = left + index * groupWidth + groupWidth * .14; const barWidth = Math.max(8, groupWidth * .2); return <g key={event.timestamp}><rect fill="#334155" height={top+plotHeight-y(event.baseline_kw)} width={barWidth} x={x} y={y(event.baseline_kw)}><title>Measured: {formatNumber(event.baseline_kw)} kW</title></rect><rect fill="#eab308" height={top+plotHeight-y(event.pv_only_import_kw)} width={barWidth} x={x+barWidth+2} y={y(event.pv_only_import_kw)}><title>PV only: {formatNumber(event.pv_only_import_kw)} kW</title></rect><rect fill="#0891b2" height={top+plotHeight-y(event.grid_import_kw)} width={barWidth} x={x+(barWidth+2)*2} y={y(event.grid_import_kw)}><title>PV + battery: {formatNumber(event.grid_import_kw)} kW</title></rect><text fill="#64748b" fontSize="10" textAnchor="middle" x={x+barWidth+2} y={height-38}>#{event.rank}</text><text fill="#64748b" fontSize="9" textAnchor="middle" transform={`rotate(-28 ${x+barWidth+2} ${height-16})`} x={x+barWidth+2} y={height-16}>{shortDate(event.timestamp)}</text></g>; })}<text fill="#475569" fontSize="11" x="8" y="17">kW</text></svg><Legend items={[["#334155", "Measured"], ["#eab308", "PV only"], ["#0891b2", "PV + battery"]]} /></div>;
}

function TechnicalFitSummary({ energy, performance }: { energy: CiFeasibilityEnergyTotals; performance: CiFeasibilityPerformance }) {
  const socRange = performance.minimum_observed_soc_kwh === null || performance.maximum_observed_soc_kwh === null ? "Not applicable" : `${formatNumber(performance.minimum_observed_soc_kwh)} – ${formatNumber(performance.maximum_observed_soc_kwh)} kWh`;
  const items = [
    ["Battery power / measured peak", `${formatNumber(performance.battery_power_to_peak_percent)}%`],
    ["Usable duration at max discharge", `${formatNumber(performance.battery_duration_at_max_discharge_hours)} h`],
    ["Observed SOC range", socRange],
    ["Battery active days", `${energy.battery_active_days} (${formatNumber(energy.battery_active_day_percent)}%)`],
    ["Coverage-dispatch peak change", `${formatNumber(performance.grid_import_peak_reduction_kw)} kW`],
    ["Top-20 events improved", `${performance.top_20_events_mitigated} / ${performance.top_20_event_count}`],
  ];
  return <dl className="divide-y divide-slate-200">{items.map(([label, value]) => <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0" key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="text-sm font-semibold tabular-nums text-slate-950">{value}</dd></div>)}</dl>;
}

function PeakDayChart({ scenario }: { scenario: CiFeasibilityScenario }) {
  const points = scenario.peak_day.points;
  const width = 820; const height = 330; const left = 54; const top = 22; const bottom = 42; const right = 18;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...points.flatMap((point) => [point.baseline_kw, point.pv_only_import_kw, point.pv_battery_import_kw, point.pv_generation_kw])) * 1.08;
  const x = (index: number) => left + plotWidth * index / Math.max(1, points.length - 1);
  const y = (value: number) => top + plotHeight * (1 - value / maximum);
  const path = (key: "baseline_kw" | "pv_only_import_kw" | "pv_battery_import_kw") => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  const ticks = [0, .25, .5, .75, 1];
  return <div><div className="overflow-x-auto"><svg aria-label="Peak day active power chart" className="min-w-[680px]" role="img" viewBox={`0 0 ${width} ${height}`}><rect fill="#f8fafc" x={left} y={top} width={plotWidth} height={plotHeight} rx="10" />{ticks.map((tick) => <g key={tick}><line stroke="#dbe3ec" x1={left} x2={width - right} y1={y(maximum * tick)} y2={y(maximum * tick)} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left - 8} y={y(maximum * tick) + 4}>{formatNumber(maximum * tick, 0)}</text></g>)}{scenario.peak_day.sampled_target_kw !== null ? <line stroke="#f97316" strokeDasharray="7 6" x1={left} x2={width - right} y1={y(scenario.peak_day.sampled_target_kw)} y2={y(scenario.peak_day.sampled_target_kw)} /> : null}<path d={path("baseline_kw")} fill="none" stroke="#172033" strokeWidth="3" /><path d={path("pv_only_import_kw")} fill="none" stroke="#eab308" strokeWidth="2.5" /><path d={path("pv_battery_import_kw")} fill="none" stroke="#0891b2" strokeWidth="3" />{[0, .25, .5, .75, 1].map((tick) => { const index = Math.min(points.length - 1, Math.round((points.length - 1) * tick)); return <text fill="#64748b" fontSize="11" textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} x={x(index)} y={height - 13} key={tick}>{points[index].time_label}</text>; })}<text fill="#475569" fontSize="11" x="8" y="16">kW</text></svg></div><Legend items={[["#172033", "Measured import"], ["#eab308", "PV only"], ["#0891b2", "PV + battery"], ["#f97316", "Sampled peak target"]]} /></div>;
}

function DailyProfileCloud({ result }: { result: CiDesignFeasibilityResult }) {
  const cloud = result.baseline.daily_profile_cloud;
  const width = 980; const height = 330; const left = 52; const top = 20; const bottom = 40; const right = 14;
  const all = [...cloud.sampled_daily_profiles.flatMap((item) => item.values_kw), ...cloud.average_day_kw, ...cloud.selected_peak_day_kw];
  const maximum = Math.max(1, ...all) * 1.06; const count = cloud.selected_peak_day_kw.length;
  const x = (index: number) => left + (width - left - right) * index / Math.max(1, count - 1);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / maximum);
  const path = (values: number[]) => values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return <div className="overflow-x-auto"><svg aria-label="Daily measured demand profile cloud" className="min-w-[760px]" role="img" viewBox={`0 0 ${width} ${height}`}><rect fill="#fbfcfe" x={left} y={top} width={width-left-right} height={height-top-bottom} />{cloud.sampled_daily_profiles.map((profile) => <path d={path(profile.values_kw)} fill="none" key={profile.date} opacity=".16" stroke="#94a3b8" strokeWidth=".75" />)}<path d={path(cloud.average_day_kw)} fill="none" stroke="#7e22ce" strokeWidth="3" /><path d={path(cloud.selected_peak_day_kw)} fill="none" stroke="#d946ef" strokeWidth="3" />{[0, .25, .5, .75, 1].map((tick) => { const index = Math.min(count - 1, Math.round((count - 1) * tick)); return <text fill="#64748b" fontSize="11" textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} x={x(index)} y={height - 13} key={tick}>{cloud.time_labels[index]}</text>; })}<text fill="#475569" fontSize="11" x="8" y="16">kW</text></svg><Legend items={[["#94a3b8", "Sampled days"], ["#7e22ce", "Average day"], ["#d946ef", "Selected peak day"]]} /></div>;
}

function CandidateComparison({ scenarios, year }: { scenarios: CiFeasibilityScenario[]; year: number }) {
  const width = Math.max(760, scenarios.length * 54); const height = 280; const left = 45; const top = 20; const bottom = 50; const maximum = Math.max(1, ...scenarios.flatMap((item) => [(item.yearly_energy.find((entry) => entry.year === year) ?? item.coverage_energy).grid_import_reduction_percent, item.peak_day.peak_reduction_percent]));
  const plotHeight = height - top - bottom; const y = (value: number) => top + plotHeight * (1 - value / maximum); const group = (width - left - 12) / scenarios.length;
  return <div className="overflow-x-auto"><svg aria-label="Candidate reduction comparison" style={{ minWidth: width }} role="img" viewBox={`0 0 ${width} ${height}`}><line stroke="#cbd5e1" x1={left} x2={width-12} y1={top+plotHeight} y2={top+plotHeight} />{scenarios.map((item, index) => { const energy = item.yearly_energy.find((entry) => entry.year === year) ?? item.coverage_energy; const x = left + index * group + group * .18; const barWidth = Math.max(6, group * .28); return <g key={item.scenario_id}><rect fill="#22c55e" x={x} y={y(energy.grid_import_reduction_percent)} width={barWidth} height={top+plotHeight-y(energy.grid_import_reduction_percent)} rx="2" /><rect fill="#f97316" x={x+barWidth+2} y={y(item.peak_day.peak_reduction_percent)} width={barWidth} height={top+plotHeight-y(item.peak_day.peak_reduction_percent)} rx="2" /><text fill="#64748b" fontSize="9" textAnchor="middle" transform={`rotate(-35 ${x+barWidth} ${height-10})`} x={x+barWidth} y={height-10}>{item.label.slice(0, 18)}</text></g>; })}<text fill="#475569" fontSize="11" x="4" y="16">%</text></svg><Legend items={[["#22c55e", "Grid-import reduction"], ["#f97316", "Peak-day reduction"]]} /></div>;
}

function SizingEfficiencyChart({ scenarios, selectedId, year }: { scenarios: CiFeasibilityScenario[]; selectedId: string; year: number }) {
  const width = 720; const height = 300; const left = 58; const right = 24; const top = 24; const bottom = 48;
  const points = scenarios.map((scenario) => {
    const energy = scenario.yearly_energy.find((entry) => entry.year === year) ?? scenario.coverage_energy;
    return {
      id: scenario.scenario_id,
      label: scenario.label,
      capacity: scenario.authored_inputs.nominal_capacity_kwh,
      reduction: scenario.peak_day.peak_reduction_kw,
      importReduction: energy.grid_import_reduction_percent,
    };
  });
  const maximumCapacity = Math.max(1, ...points.map((point) => point.capacity)) * 1.08;
  const maximumReduction = Math.max(1, ...points.map((point) => point.reduction)) * 1.08;
  const maximumImportReduction = Math.max(1, ...points.map((point) => point.importReduction));
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const x = (value: number) => left + plotWidth * value / maximumCapacity;
  const y = (value: number) => top + plotHeight * (1 - value / maximumReduction);
  return <div className="overflow-x-auto"><svg aria-label="Battery capacity and peak reduction sizing map" className="min-w-[620px]" role="img" viewBox={`0 0 ${width} ${height}`}>{[0, .25, .5, .75, 1].map((tick) => <g key={tick}><line stroke="#e2e8f0" x1={left} x2={width-right} y1={y(maximumReduction*tick)} y2={y(maximumReduction*tick)} /><text fill="#64748b" fontSize="10" textAnchor="end" x={left-8} y={y(maximumReduction*tick)+4}>{formatNumber(maximumReduction*tick,0)}</text><text fill="#64748b" fontSize="10" textAnchor="middle" x={x(maximumCapacity*tick)} y={height-16}>{formatNumber(maximumCapacity*tick,0)}</text></g>)}{points.map((point) => { const selected = point.id === selectedId; const radius = 6 + 10 * point.importReduction / maximumImportReduction; return <circle cx={x(point.capacity)} cy={y(point.reduction)} fill={selected ? "#0891b2" : "#94a3b8"} key={point.id} opacity={selected ? 1 : .72} r={radius} stroke={selected ? "#164e63" : "white"} strokeWidth={selected ? 3 : 1.5}><title>{point.label}: {formatNumber(point.capacity)} kWh, {formatNumber(point.reduction)} kW peak-day reduction, {formatNumber(point.importReduction)}% grid-import reduction</title></circle>; })}<text fill="#475569" fontSize="11" x="7" y="15">Peak-day reduction (kW)</text><text fill="#475569" fontSize="11" textAnchor="end" x={width-right} y={height-3}>Battery capacity (kWh)</text></svg><Legend items={[["#0891b2", "Selected candidate"], ["#94a3b8", "Other candidates"]]} /></div>;
}

function Metric({ detail, icon: Icon, label, value }: { detail: string; icon: typeof SunMedium; label: string; value: string }) { return <div className="rounded-xl border bg-slate-50 p-4"><span className="grid size-9 place-items-center rounded-lg bg-white text-cyan-800 shadow-sm"><Icon className="size-4" /></span><p className="mt-4 text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>; }
function ScopeFact({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-[10px] uppercase tracking-[.16em] text-slate-400">{label}</p><p className="mt-2 text-sm font-semibold">{value}</p></div>; }
function PeakFlow({ label, maximum, tone, value }: { label: string; maximum: number; tone: "slate" | "amber" | "cyan"; value: number }) { const colors = { slate: "bg-slate-800", amber: "bg-amber-400", cyan: "bg-cyan-600" }; return <div><div className="mb-1 flex justify-between text-sm"><span>{label}</span><strong className="tabular-nums">{formatNumber(value)} kW</strong></div><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${colors[tone]}`} style={{ width: `${Math.min(100, value / Math.max(1, maximum) * 100)}%` }} /></div></div>; }
function Legend({ items }: { items: Array<[string, string]> }) { return <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">{items.map(([color, label]) => <span className="flex items-center gap-2" key={label}><span className="h-0.5 w-5" style={{ background: color }} />{label}</span>)}</div>; }
function formatNumber(value: number, digits = 1) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value); }
function dateLabel(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(new Date(value)); }

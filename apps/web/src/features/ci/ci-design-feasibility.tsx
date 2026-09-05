import { useState } from "react";
import { Activity, BarChart3, BatteryCharging, Gauge, LayoutDashboard, Leaf, Search, ShieldCheck, SunMedium } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CiDesignFeasibilityResult,
  CiFeasibilityEnergyTotals,
  CiFeasibilityPerformance,
  CiFeasibilityScenario,
} from "@/features/ci/api/ci-design-feasibility";
import { CiIntervalActivityChart } from "@/features/ci/ci-interval-activity-chart";

type DispatchView = "overview" | "peak_shaving" | "interval_activity" | "energy_battery" | "peak_events" | "carbon";
type ScenarioMetric = "grid_import_reduction" | "peak_reduction" | "post_system_peak" | "battery_cycles";

const dispatchViews: Array<{ icon: typeof Activity; id: DispatchView; label: string }> = [
  { icon: LayoutDashboard, id: "overview", label: "Overview" },
  { icon: Gauge, id: "peak_shaving", label: "Peak shaving" },
  { icon: Activity, id: "interval_activity", label: "Interval activity" },
  { icon: BatteryCharging, id: "energy_battery", label: "Energy & SOC" },
  { icon: BarChart3, id: "peak_events", label: "Peak events" },
  { icon: Leaf, id: "carbon", label: "Carbon" },
];

export function CiDesignFeasibility({ projectId, result }: { projectId: string; result: CiDesignFeasibilityResult }) {
  const [scenarioId, setScenarioId] = useState(result.scenarios[0].scenario_id);
  const [view, setView] = useState<DispatchView>("overview");
  const [metric, setMetric] = useState<ScenarioMetric>("grid_import_reduction");
  const [query, setQuery] = useState("");
  const selected = result.scenarios.find((item) => item.scenario_id === scenarioId) ?? result.scenarios[0];
  const availableYears = result.coverage.years.map((item) => item.year);
  const [year, setYear] = useState(result.coverage.primary_year);
  const yearResult = selected.yearly_energy.find((item) => item.year === year);
  const energy = yearResult ?? selected.coverage_energy;
  const performance = yearResult?.performance ?? selected.coverage_performance;
  const yearState = result.coverage.years.find((item) => item.year === year);
  const normalizedQuery = query.trim().toLowerCase();
  const scenarios = result.scenarios
    .filter((scenario) => !normalizedQuery || `${scenario.scenario_id} ${scenario.physical_review_rank} ${configuration(scenario)}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => compareScenarioMetric(left, right, metric, year));

  return (
    <section aria-label="Dispatch scenario analysis" className="grid overflow-hidden rounded-xl border border-slate-200 bg-white xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50/70 xl:border-b-0 xl:border-r">
        <div className="border-b border-slate-200 p-4">
          <h2 className="font-semibold text-slate-950">{result.scenarios.length} simulated scenarios</h2>
          <label className="mt-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-500">
            <Search className="size-4 shrink-0" />
            <input aria-label="Search dispatch solutions" className="min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400" onChange={(event) => setQuery(event.target.value)} placeholder="Search PV, battery or rank" value={query} />
          </label>
          <label className="mt-3 block text-xs font-medium text-slate-600">List metric
            <select aria-label="Scenario list metric" className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" onChange={(event) => setMetric(event.target.value as ScenarioMetric)} value={metric}>
              <option value="grid_import_reduction">Grid import reduction</option>
              <option value="peak_reduction">Peak reduction</option>
              <option value="post_system_peak">Post-system peak</option>
              <option value="battery_cycles">Battery cycles</option>
            </select>
          </label>
        </div>
        <div aria-label="Generated dispatch solutions" className="max-h-[calc(100vh-270px)] min-h-[560px] space-y-2 overflow-y-auto p-3" role="list">
          {scenarios.map((scenario) => {
            const active = scenario.scenario_id === selected.scenario_id;
            return (
              <button aria-label={`Open solution ${scenario.physical_review_rank}: ${configuration(scenario)}`} aria-pressed={active} className={`w-full rounded-xl border p-3 text-left transition ${active ? "border-cyan-300 bg-cyan-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`} key={scenario.scenario_id} onClick={() => setScenarioId(scenario.scenario_id)} type="button">
                <div className="flex items-center justify-between gap-3"><span className={`grid size-7 place-items-center rounded-full text-[11px] font-semibold ${active ? "bg-cyan-700 text-white" : "bg-slate-100 text-slate-700"}`}>#{scenario.physical_review_rank}</span><strong className={`text-xs tabular-nums ${active ? "text-cyan-900" : "text-slate-700"}`}>{scenarioMetricLabel(scenario, metric, year)}</strong></div>
                <p className="mt-2 text-sm font-semibold tabular-nums text-slate-950">{formatCapacity(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp PV · {formatCapacity(scenario.authored_inputs.nominal_capacity_kwh)} kWh</p>
                <p className="mt-1 text-xs tabular-nums text-slate-500">{formatCapacity(scenario.authored_inputs.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS</p>
              </button>
            );
          })}
          {!scenarios.length ? <p className="rounded-lg border border-dashed border-slate-300 p-5 text-center text-xs text-slate-500">No solutions match this search.</p> : null}
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b border-slate-200 p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
              <p className="text-xs font-semibold uppercase tracking-[.16em] text-cyan-700">Solution #{selected.physical_review_rank}</p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">{configuration(selected)}</h2>
              <p className="mt-1 text-xs text-slate-500">{result.coverage.interval_minutes}-minute source · {dateLabel(result.coverage.start_timestamp)}–{dateLabel(result.coverage.end_timestamp)}</p>
          </div>
          <label className="text-xs font-medium text-slate-600">
              Analysis year
              <select aria-label="Dispatch analysis year" className="mt-1 block rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" onChange={(event) => setYear(Number(event.target.value))} value={year}>
              {availableYears.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <nav aria-label="Dispatch analysis metrics" className="mt-5 flex flex-wrap gap-2">
          {dispatchViews.map(({ icon: Icon, id, label }) => <button aria-pressed={view === id} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition ${view === id ? "bg-slate-950 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`} key={id} onClick={() => setView(id)} type="button"><Icon className="size-3.5" />{label}</button>)}
        </nav>
        </header>

        <div className="space-y-5 p-5 sm:p-6">
          {yearState && !yearState.complete_calendar_year ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><strong>{year} is partial coverage.</strong> Values show only measured intervals and are not annualised.</p> : null}
          {view === "overview" ? <OverviewView energy={energy} performance={performance} scenario={selected} year={year} /> : null}
          {view === "peak_shaving" ? <PeakShavingView performance={performance} scenario={selected} /> : null}
          {view === "interval_activity" ? <CiIntervalActivityChart projectId={projectId} result={result} scenario={selected} /> : null}
          {view === "energy_battery" ? <EnergyBatteryView energy={energy} performance={performance} result={result} scenario={selected} /> : null}
          {view === "peak_events" ? <PeakEventsView energy={energy} performance={performance} /> : null}
          {view === "carbon" ? <CarbonView energy={energy} year={year} /> : null}
          <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-950"><div className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><p>Pre-tariff physical screening only. These charts do not supply tariff or financial results; Finance uses the separate tariff-aware replay after this stage.</p></div></div>
        </div>
      </div>
    </section>
  );
}

function OverviewView({ energy, performance, scenario, year }: { energy: CiFeasibilityEnergyTotals; performance: CiFeasibilityPerformance; scenario: CiFeasibilityScenario; year: number }) {
  return <><div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4"><Metric icon={SunMedium} label={`${year} grid import reduction`} value={`${formatNumber(energy.grid_import_reduction_kwh / 1000)} MWh`} detail={`${formatNumber(energy.grid_import_reduction_percent)}% of measured import`} /><Metric icon={Gauge} label="Peak-shaving capability" value={`${formatNumber(scenario.peak_day.peak_reduction_kw)} kW`} detail={`${formatNumber(scenario.peak_day.baseline_peak_kw)} → ${formatNumber(scenario.peak_day.achieved_peak_kw)} kW`} /><Metric icon={Activity} label="Top peaks improved" value={`${formatNumber(performance.top_10_event_coverage_percent, 0)}%`} detail={`${performance.top_10_events_mitigated} of ${performance.top_10_event_count} events`} /><Metric icon={BatteryCharging} label="Battery utilisation" value={`${formatNumber(energy.battery_equivalent_full_cycles)} EFC`} detail={`${energy.battery_active_days} active days`} /></div><div className="grid min-w-0 gap-5 min-[1900px]:grid-cols-2"><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">Grid import outcome</CardTitle><CardDescription>Measured baseline, PV-only and PV+battery.</CardDescription></CardHeader><CardContent><EnergyComparisonChart energy={energy} /></CardContent></Card><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">PV utilisation</CardTitle><CardDescription>Direct use, battery charging, export and clipping.</CardDescription></CardHeader><CardContent><PvDispositionChart energy={energy} /></CardContent></Card></div></>;
}

function PeakShavingView({ performance, scenario }: { performance: CiFeasibilityPerformance; scenario: CiFeasibilityScenario }) {
  return <><div className="grid min-w-0 gap-5 min-[1900px]:grid-cols-[minmax(0,1fr)_340px]"><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">Peak-day import profile</CardTitle><CardDescription>{scenario.peak_day.date}: measured import, PV-only and PV+battery. This pre-tariff view charges only from surplus PV, never from the grid.</CardDescription></CardHeader><CardContent><PeakDayChart scenario={scenario} /></CardContent></Card><Card className="min-w-0"><CardHeader><CardTitle as="h3">Peak-day outcome</CardTitle><CardDescription>Active-power capability only; not chargeable demand.</CardDescription></CardHeader><CardContent className="space-y-4"><PeakFlow maximum={scenario.peak_day.baseline_peak_kw} value={scenario.peak_day.baseline_peak_kw} label="Measured peak" tone="slate" /><PeakFlow maximum={scenario.peak_day.baseline_peak_kw} value={scenario.peak_day.pv_only_peak_kw} label="After PV" tone="amber" /><PeakFlow maximum={scenario.peak_day.baseline_peak_kw} value={scenario.peak_day.achieved_peak_kw} label="After PV + battery" tone="cyan" /><div className="rounded-xl bg-cyan-50 p-4 text-cyan-950"><p className="text-xs font-semibold uppercase tracking-[.16em]">Physical peak reduction</p><p className="mt-1 text-3xl font-semibold tabular-nums">{formatNumber(scenario.peak_day.peak_reduction_percent)}%</p><p className="mt-2 text-xs text-cyan-900/75">Starts at the authored {formatNumber(scenario.initial_soc_kwh ?? 0)} kWh SOC.</p></div></CardContent></Card></div><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">Top measured peak events</CardTitle><CardDescription>Highest events separated by at least two hours.</CardDescription></CardHeader><CardContent><TopPeakEventsChart performance={performance} /></CardContent></Card></>;
}

function EnergyBatteryView({ energy, performance, result, scenario }: { energy: CiFeasibilityEnergyTotals; performance: CiFeasibilityPerformance; result: CiDesignFeasibilityResult; scenario: CiFeasibilityScenario }) {
  return <><div className="grid min-w-0 gap-5 min-[1900px]:grid-cols-[minmax(0,1fr)_340px]"><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">Battery SOC and power</CardTitle><CardDescription>{scenario.peak_day.date} · highest measured interval day across the uploaded data.</CardDescription></CardHeader><CardContent><BatteryOperationChart scenario={scenario} /></CardContent></Card><Card className="min-w-0"><CardHeader><CardTitle as="h3">Power and energy fit</CardTitle><CardDescription>Battery power, duration, SOC and operating opportunity.</CardDescription></CardHeader><CardContent><TechnicalFitSummary energy={energy} performance={performance} /></CardContent></Card></div><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">Measured daily demand context</CardTitle><CardDescription>Sampled days, average day and the same highest measured interval day.</CardDescription></CardHeader><CardContent><DailyProfileCloud result={result} /></CardContent></Card></>;
}

function PeakEventsView({ energy, performance }: { energy: CiFeasibilityEnergyTotals; performance: CiFeasibilityPerformance }) {
  return <div className="grid min-w-0 gap-5 min-[1900px]:grid-cols-[minmax(0,1fr)_340px]"><Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle as="h3">Top measured peak events</CardTitle><CardDescription>Measured, PV-only and PV+battery outcomes.</CardDescription></CardHeader><CardContent><TopPeakEventsChart performance={performance} /></CardContent></Card><Card className="min-w-0"><CardHeader><CardTitle as="h3">Peak-event coverage</CardTitle><CardDescription>Response across the highest measured demand events.</CardDescription></CardHeader><CardContent><TechnicalFitSummary energy={energy} performance={performance} /></CardContent></Card></div>;
}

function CarbonView({ energy, year }: { energy: CiFeasibilityEnergyTotals; year: number }) {
  const factor = energy.grid_emissions_factor_kg_co2e_per_kwh;
  const baseline = energy.baseline_scope_2_emissions_t_co2e;
  const after = energy.post_system_scope_2_emissions_t_co2e;
  const avoided = energy.avoided_scope_2_emissions_t_co2e;
  const reduction = energy.scope_2_emissions_reduction_percent;
  if ([factor, baseline, after, avoided, reduction].some((value) => value === undefined)) {
    return <Card><CardHeader><CardTitle as="h3">Operational carbon estimate unavailable</CardTitle><CardDescription>Re-run this solution space to calculate carbon using the saved grid emissions factor.</CardDescription></CardHeader></Card>;
  }
  const maximum = Math.max(1, baseline ?? 0);
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
      <Metric icon={Leaf} label={`${year} avoided emissions`} value={`${formatNumber(avoided ?? 0)} t CO2-e`} detail={`${formatNumber(reduction ?? 0)}% reduction`} />
      <Metric icon={Activity} label="Baseline Scope 2" value={`${formatNumber(baseline ?? 0)} t CO2-e`} detail="Measured grid import" />
      <Metric icon={SunMedium} label="Post-system Scope 2" value={`${formatNumber(after ?? 0)} t CO2-e`} detail="Modelled residual grid import" />
      <Metric icon={ShieldCheck} label="Grid emissions factor" value={`${formatNumber(factor ?? 0, 3)} kg/kWh`} detail="Analyst-entered assumption" />
    </div>
    <Card className="overflow-hidden"><CardHeader><CardTitle as="h3">Operational Scope 2 comparison</CardTitle><CardDescription>Location-based estimate from measured grid import and the saved emissions factor.</CardDescription></CardHeader><CardContent><div className="space-y-5"><CarbonBar label="Measured baseline" maximum={maximum} tone="bg-slate-700" value={baseline ?? 0} /><CarbonBar label="With selected system" maximum={maximum} tone="bg-emerald-500" value={after ?? 0} /></div><div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><strong>Accounting boundary:</strong> operational grid-import emissions only. It does not include embodied carbon, exported-energy attribution, offsets, certificates or a formal greenhouse inventory.</div></CardContent></Card>
  </div>;
}

function CarbonBar({ label, maximum, tone, value }: { label: string; maximum: number; tone: string; value: number }) {
  return <div><div className="mb-2 flex items-center justify-between gap-3 text-sm"><span className="text-slate-600">{label}</span><strong className="tabular-nums text-slate-950">{formatNumber(value)} t CO2-e</strong></div><div className="h-4 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value / maximum * 100)}%` }} /></div></div>;
}

function EnergyComparisonChart({ energy }: { energy: CiFeasibilityEnergyTotals }) {
  const rows = [{ label: "No system", value: energy.site_import_before_kwh, color: "#334155" }, { label: "PV only", value: energy.grid_import_after_pv_only_kwh, color: "#eab308" }, { label: "PV + battery", value: energy.grid_import_after_kwh, color: "#0891b2" }];
  const width = 640; const height = 220; const left = 118; const right = 82; const top = 20; const rowHeight = 58; const maximum = Math.max(1, ...rows.map((row) => row.value));
  const scale = (value: number) => (width - left - right) * value / maximum;
  return <div><div className="overflow-x-auto"><svg aria-label="Annual grid import comparison" className="w-full min-w-[520px]" role="img" viewBox={`0 0 ${width} ${height}`}>{rows.map((row, index) => { const y = top + index * rowHeight; return <g key={row.label}><text fill="#475569" fontSize="12" textAnchor="end" x={left - 10} y={y + 24}>{row.label}</text><rect fill="#eef2f7" height="30" rx="5" width={width - left - right} x={left} y={y + 5} /><rect fill={row.color} height="30" rx="5" width={scale(row.value)} x={left} y={y + 5} /><text fill="#0f172a" fontSize="12" fontWeight="600" x={width - right + 9} y={y + 25}>{formatNumber(row.value / 1000)} MWh</text></g>; })}</svg></div><Legend items={[["#334155", "Measured baseline"], ["#eab308", "After PV"], ["#0891b2", "After PV + battery"]]} /></div>;
}

function PvDispositionChart({ energy }: { energy: CiFeasibilityEnergyTotals }) {
  const categories = [{ label: "Direct to load", value: energy.pv_direct_to_load_kwh, color: "#f59e0b" }, { label: "To battery", value: energy.pv_to_battery_kwh, color: "#0891b2" }, { label: "Grid export", value: energy.grid_export_kwh, color: "#d946ef" }, { label: "Clipped", value: energy.pv_clipped_kwh, color: "#94a3b8" }];
  const total = Math.max(1, categories.reduce((sum, item) => sum + item.value, 0));
  const width = 640; const height = 150; const left = 18; const right = 18; const barY = 44; const barHeight = 42; let offset = left;
  return <div><div className="overflow-x-auto"><svg aria-label="Solar generation disposition" className="w-full min-w-[520px]" role="img" viewBox={`0 0 ${width} ${height}`}><text fill="#475569" fontSize="12" x={left} y="20">{formatNumber(energy.pv_generation_kwh / 1000)} MWh generated · {formatNumber(energy.pv_self_consumption_percent)}% self-consumed</text><rect fill="#eef2f7" height={barHeight} rx="7" width={width - left - right} x={left} y={barY} />{categories.map((item) => { const itemWidth = (width - left - right) * item.value / total; const current = offset; offset += itemWidth; return <rect fill={item.color} height={barHeight} key={item.label} width={itemWidth} x={current} y={barY}><title>{item.label}: {formatNumber(item.value / 1000)} MWh</title></rect>; })}<text fill="#64748b" fontSize="11" x={left} y="112">Used onsite or charged: {formatNumber((energy.pv_direct_to_load_kwh + energy.pv_to_battery_kwh) / 1000)} MWh</text><text fill="#64748b" fontSize="11" textAnchor="end" x={width - right} y="112">Export: {formatNumber(energy.grid_export_kwh / 1000)} MWh</text></svg></div><Legend items={categories.map((item) => [item.color, item.label]) as Array<[string, string]>} /></div>;
}

function PeakDayChart({ scenario }: { scenario: CiFeasibilityScenario }) {
  const points = scenario.peak_day.points; const width = 820; const height = 330; const left = 54; const top = 22; const bottom = 42; const right = 18;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...points.flatMap((point) => [point.baseline_kw, point.pv_only_import_kw, point.pv_battery_import_kw, point.pv_generation_kw])) * 1.08;
  const x = (index: number) => left + plotWidth * index / Math.max(1, points.length - 1); const y = (value: number) => top + plotHeight * (1 - value / maximum);
  const path = (key: "baseline_kw" | "pv_only_import_kw" | "pv_battery_import_kw") => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  return <div><div className="overflow-x-auto"><svg aria-label="Peak day active power chart" className="w-full min-w-[680px]" role="img" viewBox={`0 0 ${width} ${height}`}><rect fill="#f8fafc" x={left} y={top} width={plotWidth} height={plotHeight} rx="10" />{[0, .25, .5, .75, 1].map((tick) => <g key={tick}><line stroke="#dbe3ec" x1={left} x2={width - right} y1={y(maximum * tick)} y2={y(maximum * tick)} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left - 8} y={y(maximum * tick) + 4}>{formatNumber(maximum * tick, 0)}</text></g>)}{scenario.peak_day.sampled_target_kw !== null ? <line stroke="#f97316" strokeDasharray="7 6" x1={left} x2={width - right} y1={y(scenario.peak_day.sampled_target_kw)} y2={y(scenario.peak_day.sampled_target_kw)} /> : null}<path d={path("baseline_kw")} fill="none" stroke="#172033" strokeWidth="3" /><path d={path("pv_only_import_kw")} fill="none" stroke="#eab308" strokeWidth="2.5" /><path d={path("pv_battery_import_kw")} fill="none" stroke="#0891b2" strokeWidth="3" />{[0, .25, .5, .75, 1].map((tick) => { const index = Math.min(points.length - 1, Math.round((points.length - 1) * tick)); return <text fill="#64748b" fontSize="11" textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} x={x(index)} y={height - 13} key={tick}>{points[index].time_label}</text>; })}<text fill="#475569" fontSize="11" x="8" y="16">kW</text></svg></div><Legend items={[["#172033", "Measured import"], ["#eab308", "PV only"], ["#0891b2", "PV + battery"], ["#f97316", "Feasible peak cap (sampled)"]]} /><p className="mt-2 text-xs leading-5 text-slate-500">The battery discharges above the sampled cap and follows PV-only import below it. Grid charging is excluded from this pre-tariff view.</p></div>;
}

function TopPeakEventsChart({ performance }: { performance: CiFeasibilityPerformance }) {
  const events = performance.top_peak_events.slice(0, 10);
  if (!events.length) return <p className="text-sm text-slate-500">No measured peak events are available.</p>;
  const width = Math.max(760, events.length * 78); const height = 320; const left = 54; const right = 16; const top = 24; const bottom = 66; const plotHeight = height - top - bottom; const groupWidth = (width - left - right) / events.length; const maximum = Math.max(1, ...events.map((event) => event.baseline_kw)) * 1.08; const y = (value: number) => top + plotHeight * (1 - value / maximum);
  return <div className="overflow-x-auto"><svg aria-label="Top measured peak event comparison" className="w-full min-w-[700px]" role="img" viewBox={`0 0 ${width} ${height}`}>{[0, .25, .5, .75, 1].map((tick) => <g key={tick}><line stroke="#dbe3ec" x1={left} x2={width-right} y1={y(maximum*tick)} y2={y(maximum*tick)} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left-8} y={y(maximum*tick)+4}>{formatNumber(maximum*tick,0)}</text></g>)}{events.map((event, index) => { const x = left + index * groupWidth + groupWidth * .14; const barWidth = Math.max(8, groupWidth * .2); return <g key={event.timestamp}><rect fill="#334155" height={top+plotHeight-y(event.baseline_kw)} width={barWidth} x={x} y={y(event.baseline_kw)} /><rect fill="#eab308" height={top+plotHeight-y(event.pv_only_import_kw)} width={barWidth} x={x+barWidth+2} y={y(event.pv_only_import_kw)} /><rect fill="#0891b2" height={top+plotHeight-y(event.grid_import_kw)} width={barWidth} x={x+(barWidth+2)*2} y={y(event.grid_import_kw)} /><text fill="#64748b" fontSize="10" textAnchor="middle" x={x+barWidth+2} y={height-38}>#{event.rank}</text><text fill="#64748b" fontSize="9" textAnchor="middle" transform={`rotate(-28 ${x+barWidth+2} ${height-16})`} x={x+barWidth+2} y={height-16}>{shortDate(event.timestamp)}</text></g>; })}<text fill="#475569" fontSize="11" x="8" y="17">kW</text></svg><Legend items={[["#334155", "Measured"], ["#eab308", "PV only"], ["#0891b2", "PV + battery"]]} /></div>;
}

function TechnicalFitSummary({ energy, performance }: { energy: CiFeasibilityEnergyTotals; performance: CiFeasibilityPerformance }) {
  const socRange = performance.minimum_observed_soc_kwh === null || performance.maximum_observed_soc_kwh === null ? "Not applicable" : `${formatNumber(performance.minimum_observed_soc_kwh)} – ${formatNumber(performance.maximum_observed_soc_kwh)} kWh`;
  const items = [["Battery power / measured peak", `${formatNumber(performance.battery_power_to_peak_percent)}%`], ["Usable duration at max discharge", `${formatNumber(performance.battery_duration_at_max_discharge_hours)} h`], ["Observed SOC range", socRange], ["Battery active days", `${energy.battery_active_days} (${formatNumber(energy.battery_active_day_percent)}%)`], ["Coverage-dispatch peak change", `${formatNumber(performance.grid_import_peak_reduction_kw)} kW`], ["Top-20 events improved", `${performance.top_20_events_mitigated} / ${performance.top_20_event_count}`]];
  return <dl className="divide-y divide-slate-200">{items.map(([label, value]) => <div className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,auto)] items-center gap-4 py-3 first:pt-0 last:pb-0" key={label}><dt className="min-w-0 text-xs leading-5 text-slate-500">{label}</dt><dd className="whitespace-nowrap text-right text-sm font-semibold tabular-nums text-slate-950">{value}</dd></div>)}</dl>;
}

function BatteryOperationChart({ scenario }: { scenario: CiFeasibilityScenario }) {
  const points = scenario.peak_day.points;
  const socPoints = points.map((point, index) => ({ index, value: point.soc_kwh })).filter((point): point is { index: number; value: number } => point.value !== null);
  if (!socPoints.length) return <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">This is a solar-only solution; no battery SOC or charge/discharge activity applies.</p>;
  const width = 920; const height = 430; const left = 78; const right = 28; const plotWidth = width - left - right;
  const socTop = 48; const socHeight = 162; const socBottom = socTop + socHeight;
  const powerTop = 278; const powerHalfHeight = 52; const powerZero = powerTop + powerHalfHeight; const powerBottom = powerZero + powerHalfHeight;
  const maximumSoc = Math.max(1, scenario.authored_inputs.nominal_capacity_kwh, ...socPoints.map((point) => point.value));
  const maximumPower = Math.max(1, ...points.flatMap((point) => [point.battery_charge_kw, point.battery_discharge_kw]));
  const minimumOperatingSoc = scenario.authored_inputs.nominal_capacity_kwh * (scenario.authored_inputs.min_soc_fraction ?? 0);
  const maximumOperatingSoc = scenario.authored_inputs.nominal_capacity_kwh * (scenario.authored_inputs.max_soc_fraction ?? 1);
  const peakIndex = points.reduce((best, point, index) => point.baseline_kw > points[best].baseline_kw ? index : best, 0);
  const peakPoint = points[peakIndex];
  const x = (index: number) => left + plotWidth * index / Math.max(1, points.length - 1);
  const socY = (value: number) => socTop + socHeight * (1 - value / maximumSoc);
  const powerScale = (value: number) => powerHalfHeight * value / maximumPower;
  const socPath = socPoints.map((point, index) => `${index ? "L" : "M"}${x(point.index).toFixed(2)},${socY(point.value).toFixed(2)}`).join(" ");
  const socArea = `${socPath} L${x(socPoints.at(-1)?.index ?? 0).toFixed(2)},${socBottom} L${x(socPoints[0].index).toFixed(2)},${socBottom} Z`;
  const barWidth = Math.max(1.5, plotWidth / Math.max(1, points.length) * 0.72);
  const peakX = x(peakIndex);
  const peakLabelAnchor = peakIndex / Math.max(1, points.length - 1) > .55 ? "end" : "start";
  const peakLabelX = peakX + (peakLabelAnchor === "end" ? -8 : 8);
  const peakSoc = peakPoint.soc_kwh;
  const responseKw = peakPoint.battery_discharge_kw - peakPoint.battery_charge_kw;
  return <div>
    <div className="overflow-x-auto">
      <svg aria-label="Battery state of charge and power chart" className="block h-auto w-full min-w-[540px]" role="img" viewBox={`0 0 ${width} ${height}`}>
        <title>Battery state of charge and power on highest measured interval day {scenario.peak_day.date}</title>
        <rect fill="#f8fafc" height={socHeight} rx="10" width={plotWidth} x={left} y={socTop} />
        <rect fill="#f8fafc" height={powerBottom-powerTop} rx="10" width={plotWidth} x={left} y={powerTop} />
        {[0, .25, .5, .75, 1].map((tick) => <g key={`soc-${tick}`}><line stroke="#e2e8f0" x1={left} x2={width-right} y1={socY(maximumSoc*tick)} y2={socY(maximumSoc*tick)} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left-10} y={socY(maximumSoc*tick)+4}>{formatNumber(maximumSoc*tick, 0)}</text></g>)}
        <line stroke="#94a3b8" strokeDasharray="4 5" x1={left} x2={width-right} y1={socY(minimumOperatingSoc)} y2={socY(minimumOperatingSoc)}><title>Minimum operating SOC {formatNumber(minimumOperatingSoc)} kWh</title></line>
        <line stroke="#94a3b8" strokeDasharray="4 5" x1={left} x2={width-right} y1={socY(maximumOperatingSoc)} y2={socY(maximumOperatingSoc)}><title>Maximum operating SOC {formatNumber(maximumOperatingSoc)} kWh</title></line>
        <path d={socArea} fill="#06b6d4" opacity=".12" />
        <path d={socPath} fill="none" stroke="#0891b2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
        <line stroke="#d946ef" strokeDasharray="5 5" x1={peakX} x2={peakX} y1={socTop} y2={powerBottom} />
        {peakSoc !== null ? <circle cx={peakX} cy={socY(peakSoc)} fill="#fff" r="5" stroke="#0891b2" strokeWidth="3"><title>SOC at measured peak: {formatNumber(peakSoc)} kWh</title></circle> : null}
        <text fill="#475569" fontSize="11" fontWeight="600" x={left} y="22">Stored energy · kWh</text>
        <text fill="#a21caf" fontSize="11" fontWeight="600" textAnchor={peakLabelAnchor} x={peakLabelX} y="38">Measured peak {formatNumber(peakPoint.baseline_kw)} kW · {peakPoint.time_label}</text>
        {[powerTop, powerZero, powerBottom].map((lineY) => <line key={lineY} stroke={lineY === powerZero ? "#94a3b8" : "#e2e8f0"} x1={left} x2={width-right} y1={lineY} y2={lineY} />)}
        {points.map((point, index) => { const chargeHeight = powerScale(point.battery_charge_kw); const dischargeHeight = powerScale(point.battery_discharge_kw); return <g key={point.timestamp}><rect fill="#f59e0b" height={chargeHeight} rx="1" width={barWidth} x={x(index)-barWidth/2} y={powerZero}><title>{point.time_label} charge {formatNumber(point.battery_charge_kw)} kW</title></rect><rect fill="#10b981" height={dischargeHeight} rx="1" width={barWidth} x={x(index)-barWidth/2} y={powerZero-dischargeHeight}><title>{point.time_label} discharge {formatNumber(point.battery_discharge_kw)} kW</title></rect></g>; })}
        <text fill="#475569" fontSize="11" fontWeight="600" x={left} y={powerTop-14}>Battery power · kW</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-10} y={powerTop+4}>+{formatNumber(maximumPower)}</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-10} y={powerZero+4}>0</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-10} y={powerBottom+4}>−{formatNumber(maximumPower)}</text>
        {[0, .25, .5, .75, 1].map((tick) => { const index = Math.min(points.length - 1, Math.round((points.length - 1) * tick)); return <text fill="#64748b" fontSize="11" key={tick} textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} x={x(index)} y={height-14}>{points[index].time_label}</text>; })}
      </svg>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><Legend items={[["#0891b2", "State of charge"], ["#10b981", "Discharge (+)"], ["#f59e0b", "Charge (−)"], ["#d946ef", "Highest measured interval"]]} /><span className="text-xs text-slate-500">Dashed SOC lines show the authored operating range.</span></div>
    <dl className="mt-4 grid gap-3 sm:grid-cols-3"><ChartFact label="Highest measured interval" value={`${peakPoint.time_label} · ${formatNumber(peakPoint.baseline_kw)} kW`} /><ChartFact label="SOC at peak" value={peakSoc === null ? "Not available" : `${formatNumber(peakSoc)} kWh`} /><ChartFact label="Battery response at peak" value={`${responseKw >= 0 ? "+" : "−"}${formatNumber(Math.abs(responseKw))} kW`} /></dl>
  </div>;
}

function ChartFact({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5"><dt className="text-[10px] uppercase tracking-[.12em] text-slate-400">{label}</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{value}</dd></div>; }

function DailyProfileCloud({ result }: { result: CiDesignFeasibilityResult }) {
  const cloud = result.baseline.daily_profile_cloud; const width = 980; const height = 330; const left = 52; const top = 20; const bottom = 40; const right = 14;
  const all = [...cloud.sampled_daily_profiles.flatMap((item) => item.values_kw), ...cloud.average_day_kw, ...cloud.selected_peak_day_kw]; const maximum = Math.max(1, ...all) * 1.06; const count = cloud.selected_peak_day_kw.length;
  const x = (index: number) => left + (width - left - right) * index / Math.max(1, count - 1); const y = (value: number) => top + (height - top - bottom) * (1 - value / maximum);
  const path = (values: number[]) => values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return <div className="overflow-x-auto"><svg aria-label="Daily measured demand profile cloud" className="min-w-[760px]" role="img" viewBox={`0 0 ${width} ${height}`}><rect fill="#fbfcfe" x={left} y={top} width={width-left-right} height={height-top-bottom} />{cloud.sampled_daily_profiles.map((profile) => <path d={path(profile.values_kw)} fill="none" key={profile.date} opacity=".16" stroke="#94a3b8" strokeWidth=".75" />)}<path d={path(cloud.average_day_kw)} fill="none" stroke="#7e22ce" strokeWidth="3" /><path d={path(cloud.selected_peak_day_kw)} fill="none" stroke="#d946ef" strokeWidth="3" />{[0, .25, .5, .75, 1].map((tick) => { const index = Math.min(count - 1, Math.round((count - 1) * tick)); return <text fill="#64748b" fontSize="11" textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} x={x(index)} y={height - 13} key={tick}>{cloud.time_labels[index]}</text>; })}<text fill="#475569" fontSize="11" x="8" y="16">kW</text></svg><Legend items={[["#94a3b8", "Sampled days"], ["#7e22ce", "Average day"], ["#d946ef", "Selected peak day"]]} /></div>;
}

function Metric({ detail, icon: Icon, label, value }: { detail: string; icon: typeof SunMedium; label: string; value: string }) { return <div className="rounded-xl border border-slate-200 bg-white p-4"><span className="grid size-9 place-items-center rounded-lg bg-slate-50 text-cyan-800"><Icon className="size-4" /></span><p className="mt-4 text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>; }
function PeakFlow({ label, maximum, tone, value }: { label: string; maximum: number; tone: "slate" | "amber" | "cyan"; value: number }) { const colors = { slate: "bg-slate-800", amber: "bg-amber-400", cyan: "bg-cyan-600" }; return <div><div className="mb-1 flex justify-between text-sm"><span>{label}</span><strong className="tabular-nums">{formatNumber(value)} kW</strong></div><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${colors[tone]}`} style={{ width: `${Math.min(100, value / Math.max(1, maximum) * 100)}%` }} /></div></div>; }
function Legend({ items }: { items: Array<[string, string]> }) { return <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">{items.map(([color, label]) => <span className="flex items-center gap-2" key={label}><span className="h-0.5 w-5" style={{ background: color }} />{label}</span>)}</div>; }
function scenarioEnergy(scenario: CiFeasibilityScenario, year: number) { return scenario.yearly_energy.find((item) => item.year === year) ?? scenario.coverage_energy; }
function scenarioPerformance(scenario: CiFeasibilityScenario, year: number) { return scenario.yearly_energy.find((item) => item.year === year)?.performance ?? scenario.coverage_performance; }
function scenarioMetricValue(scenario: CiFeasibilityScenario, metric: ScenarioMetric, year: number) { const energy = scenarioEnergy(scenario, year); const performance = scenarioPerformance(scenario, year); if (metric === "grid_import_reduction") return energy.grid_import_reduction_percent; if (metric === "peak_reduction") return performance.grid_import_peak_reduction_percent; if (metric === "post_system_peak") return performance.grid_import_peak_kw; return energy.battery_equivalent_full_cycles; }
function compareScenarioMetric(left: CiFeasibilityScenario, right: CiFeasibilityScenario, metric: ScenarioMetric, year: number) { const direction = metric === "post_system_peak" ? 1 : -1; return direction * (scenarioMetricValue(left, metric, year) - scenarioMetricValue(right, metric, year)) || left.physical_review_rank - right.physical_review_rank; }
function scenarioMetricLabel(scenario: CiFeasibilityScenario, metric: ScenarioMetric, year: number) { const value = formatNumber(scenarioMetricValue(scenario, metric, year)); if (metric === "grid_import_reduction" || metric === "peak_reduction") return `${value}%`; if (metric === "post_system_peak") return `${value} kW`; return `${value} EFC`; }
function configuration(scenario: CiFeasibilityScenario) { return `${formatCapacity(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp PV · ${formatCapacity(scenario.authored_inputs.nominal_capacity_kwh)} kWh battery · ${formatCapacity(scenario.authored_inputs.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS`; }
function formatCapacity(value: number) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 9 }).format(value); }
function formatNumber(value: number, digits = 1) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value); }
function dateLabel(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(new Date(value)); }

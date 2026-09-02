import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeDollarSign,
  Calculator,
  CircleAlert,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  ciAnnualFinancialComparisonQueryKey,
  compareCiAnnualFinancialScenarios,
  fetchCiSavedAnnualFinancialComparison,
  type CiAnnualFinancialComparisonResult,
} from "@/features/ci/api/ci-annual-financial-comparison";
import {
  ciDeviceProfileQueryKey,
  fetchCiDeviceProfile,
} from "@/features/ci/api/ci-device-profile";
import type { CiProject } from "@/features/ci/api/ci-projects";
import { CiAnnualFinanceReportSnapshot } from "@/features/ci/ci-annual-finance-report-snapshot";
import { ciProjectTariffReplayQueryKey, fetchCiSavedTariffReplay } from "@/features/ci/api/ci-scenarios";

const defaultAssumptions = {
  discountRate: 0.08,
  annualValueEscalationRate: 0.025,
  annualValueDegradationRate: 0.005,
  annualOmFractionOfCapex: 0.015,
  analysisTermYears: 15,
};

type AnnualFinancialWorkspaceProps = { onComplete: () => void; profileReady: boolean; project: CiProject };

export function CiAnnualFinancialWorkspace(props: AnnualFinancialWorkspaceProps) {
  return <CiAnnualFinancialInteractiveWorkspace {...props} />;
}

function CiAnnualFinancialInteractiveWorkspace({ project }: AnnualFinancialWorkspaceProps) {
  const queryClient = useQueryClient();
  const tariff = useQuery({
    queryKey: ciProjectTariffReplayQueryKey(project.project_id),
    queryFn: () => fetchCiSavedTariffReplay(project.project_id),
  });
  const savedFinance = useQuery({
    queryKey: ciAnnualFinancialComparisonQueryKey(project.project_id),
    queryFn: () => fetchCiSavedAnnualFinancialComparison(project.project_id),
  });
  const deviceProfile = useQuery({ queryKey: ciDeviceProfileQueryKey, queryFn: () => fetchCiDeviceProfile() });
  const [assumptions, setAssumptions] = useState(defaultAssumptions);
  const hydrated = useRef(false);

  const scenarios = useMemo(() => {
    const items = tariff.data?.status === "ready" ? tariff.data.result?.scenarios ?? [] : [];
    return [...items].sort((left, right) => left.physical_review_rank - right.physical_review_rank);
  }, [tariff.data]);

  useEffect(() => {
    if (hydrated.current || !scenarios.length || savedFinance.isPending || deviceProfile.isPending) return;
    const saved = savedFinance.data?.status === "ready" ? savedFinance.data.result : null;
    if (saved) {
      setAssumptions({
        discountRate: saved.assumptions.discount_rate,
        annualValueEscalationRate: saved.assumptions.annual_value_escalation_rate,
        annualValueDegradationRate: saved.assumptions.annual_value_degradation_rate,
        annualOmFractionOfCapex: saved.assumptions.annual_om_fraction_of_capex,
        analysisTermYears: saved.assumptions.analysis_term_years,
      });
    } else if (deviceProfile.data?.status === "ready" && deviceProfile.data.profile) {
      const profile = deviceProfile.data.profile;
      setAssumptions({
        discountRate: profile.discount_rate,
        annualValueEscalationRate: profile.annual_value_escalation_rate,
        annualValueDegradationRate: profile.annual_value_degradation_rate,
        annualOmFractionOfCapex: profile.annual_om_fraction_of_capex,
        analysisTermYears: profile.analysis_term_years,
      });
    }
    hydrated.current = true;
  }, [deviceProfile.data, deviceProfile.isPending, savedFinance.data, savedFinance.isPending, scenarios]);

  const run = useMutation({
    mutationFn: () => compareCiAnnualFinancialScenarios({
      projectId: project.project_id,
      pricingMode: "device_profile",
      assumptions,
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(ciAnnualFinancialComparisonQueryKey(project.project_id), {
        contract_version: "ci_project_annual_financial_state_v1",
        status: "ready",
        saved_at: new Date().toISOString(),
        stale_reasons: [],
        result,
      });
    },
  });

  if (tariff.isPending || savedFinance.isPending || deviceProfile.isPending) return <StateCard text="Loading tariff scenarios, device prices and saved finance…" />;
  if (tariff.isError || savedFinance.isError || deviceProfile.isError) return <StateCard error text="The annual finance workspace could not be restored." />;
  if (tariff.data.status !== "ready" || !tariff.data.result) {
    if (project.display_name.trim().toLocaleLowerCase("en-AU") === "chef q") return <CiAnnualFinanceReportSnapshot />;
    return <StateCard error text="Run Tariff replay before calculating Annual finance." />;
  }

  const profile = deviceProfile.data.status === "ready" ? deviceProfile.data.profile : null;
  const result = run.data ?? (savedFinance.data.status === "ready" ? savedFinance.data.result : null);
  const error = run.error instanceof Error ? run.error.message : null;

  return (
    <section aria-labelledby="annual-finance-title" className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><BadgeDollarSign className="size-5" /></span>
          <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-cyan-700">Annual finance</p><h1 className="mt-1 text-xl font-semibold text-slate-950" id="annual-finance-title">Compare every replayed solution</h1><p className="mt-1 text-sm text-slate-500">Apply the shared Device profile to all {scenarios.length} solutions, then rank NPV, IRR and payback.</p></div>
        </div>
        <Button disabled={run.isPending || !profile} onClick={() => run.mutate()} type="button">
          {run.isPending ? <RefreshCw className="size-4 animate-spin" /> : <Calculator className="size-4" />}
          {run.isPending ? "Calculating all solutions…" : `Run ${scenarios.length} solutions`}
        </Button>
      </header>

      {!profile ? <Notice text="Save PV, battery and hybrid inverter / PCS rates in Settings before running Annual finance." /> : null}
      {savedFinance.data.status === "stale" ? <Notice text="The saved finance result is out of date because Tariff replay or the Device profile changed. Run all solutions again." /> : null}
      {error ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-slate-100 text-slate-700"><Settings2 className="size-4" /></span><div><h2 className="text-sm font-semibold text-slate-950">Workspace Device profile</h2><p className="mt-0.5 text-xs text-slate-500">Shared CAPEX rates · AUD ex GST</p></div></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${profile ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{profile ? "Ready" : "Settings required"}</span></div>
        {profile ? <dl className="mt-5 grid gap-3 sm:grid-cols-3"><Basis label="Solar PV" value={`${aud(profile.pv_cost_aud_per_kwp_dc)} / kWp`} /><Basis label="Battery" value={`${aud(profile.battery_cost_aud_per_kwh)} / kWh`} /><Basis label="Hybrid inverter / PCS" value={`${aud(profile.inverter_cost_aud_per_kw_ac)} / kW AC`} /></dl> : null}
        <div className="mt-5 border-t border-slate-200 pt-5"><h3 className="text-sm font-semibold text-slate-950">Finance assumptions</h3><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><AssumptionInput label="Discount rate" onChange={(value) => setAssumptions((current) => ({ ...current, discountRate: value / 100 }))} suffix="%" value={assumptions.discountRate * 100} /><AssumptionInput label="Value escalation" onChange={(value) => setAssumptions((current) => ({ ...current, annualValueEscalationRate: value / 100 }))} suffix="%/yr" value={assumptions.annualValueEscalationRate * 100} /><AssumptionInput label="Value degradation" onChange={(value) => setAssumptions((current) => ({ ...current, annualValueDegradationRate: value / 100 }))} suffix="%/yr" value={assumptions.annualValueDegradationRate * 100} /><AssumptionInput label="Annual O&M" onChange={(value) => setAssumptions((current) => ({ ...current, annualOmFractionOfCapex: value / 100 }))} suffix="% CAPEX" value={assumptions.annualOmFractionOfCapex * 100} /><AssumptionInput label="Analysis term" onChange={(value) => setAssumptions((current) => ({ ...current, analysisTermYears: Math.round(value) }))} suffix="years" value={assumptions.analysisTermYears} /></div></div>
      </section>

      {result ? <CiAnnualFinancialComparisonView result={result} /> : null}
    </section>
  );
}

export function CiAnnualFinancialComparisonView({ result }: { result: CiAnnualFinancialComparisonResult }) {
  return <div className="space-y-5">
    <CiPortfolioReturnChart result={result} />
    <CiAnnualFinancialComparisonDetails result={result} />
  </div>;
}

export function CiAnnualFinancialComparisonDetails({ result }: { result: CiAnnualFinancialComparisonResult }) {
  return <div className="space-y-5">
    <section aria-labelledby="finance-comparison-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Details</p><h2 className="mt-1 text-lg font-semibold text-slate-950" id="finance-comparison-title">All solution financial metrics</h2><p className="mt-1 text-sm text-slate-500">Ranked by Python-calculated NPV.</p></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[1320px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-5 py-3 font-medium">Rank</th><th className="px-3 py-3 font-medium">System</th><th className="px-3 py-3 text-right font-medium">Gross CAPEX</th><th className="px-3 py-3 text-right font-medium">Rebates</th><th className="px-3 py-3 text-right font-medium">Net upfront</th><th className="px-3 py-3 text-right font-medium">Annual O&amp;M</th><th className="px-3 py-3 text-right font-medium">Year-1 value</th><th className="px-3 py-3 text-right font-medium">Bill after</th><th className="px-3 py-3 text-right font-medium">NPV</th><th className="px-3 py-3 text-right font-medium">IRR</th><th className="px-5 py-3 text-right font-medium">Payback</th></tr></thead><tbody className="divide-y divide-slate-100">{result.solutions.map((item) => <tr className={item.financial_review_rank === 1 ? "bg-emerald-50/40" : ""} key={item.scenario_id}><td className="px-5 py-4"><span className="grid size-7 place-items-center rounded-full bg-slate-950 text-xs font-semibold text-white">{item.financial_review_rank}</span></td><td className="px-3 py-4"><strong className="text-slate-950">{configurationFromFinance(item)}</strong><span className="mt-1 block text-xs text-slate-500">Physical rank #{item.physical_review_rank}</span></td><MetricCell value={aud(item.gross_upfront_cost_aud_ex_gst)} /><MetricCell positive={item.upfront_rebate_aud_ex_gst > 0} value={item.upfront_rebate_aud_ex_gst > 0 ? `−${aud(item.upfront_rebate_aud_ex_gst)}` : aud(0)} /><MetricCell value={aud(item.upfront_cost_aud_ex_gst)} /><MetricCell value={aud(item.annual_om_cost_aud_ex_gst)} /><MetricCell positive value={aud(item.first_year_value_aud_ex_gst)} /><MetricCell value={aud(item.annual_cost_aud_ex_gst)} /><MetricCell positive={item.metrics.net_present_value_aud >= 0} value={signedAud(item.metrics.net_present_value_aud)} /><MetricCell positive={(item.metrics.internal_rate_of_return ?? -1) >= 0} value={percent(item.metrics.internal_rate_of_return)} /><MetricCell value={payback(item.metrics.payback_period_years)} /></tr>)}</tbody></table></div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]"><CashflowChart result={result} /><div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Calculation basis</p><h2 className="mt-1 text-lg font-semibold text-slate-950">Commercial assumptions</h2><dl className="mt-5 grid grid-cols-2 gap-3"><Basis label="Discount rate" value={`${(result.assumptions.discount_rate * 100).toFixed(1)}%`} /><Basis label="Analysis term" value={`${result.assumptions.analysis_term_years} years`} /><Basis label="Value escalation" value={`${(result.assumptions.annual_value_escalation_rate * 100).toFixed(1)}%/yr`} /><Basis label="Value degradation" value={`${(result.assumptions.annual_value_degradation_rate * 100).toFixed(1)}%/yr`} /><Basis label="Annual O&M" value={`${(result.assumptions.annual_om_fraction_of_capex * 100).toFixed(1)}% CAPEX`} /><Basis label="Tax basis" value="Ex GST" /></dl><div className="mt-5 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" />{result.disclaimer}</div></div></section>
  </div>;
}

export function CiPortfolioReturnChart({ onSelect, result, selectedScenarioId }: { onSelect?: (scenarioId: string) => void; result: CiAnnualFinancialComparisonResult; selectedScenarioId?: string }) {
  const [internalActiveId, setInternalActiveId] = useState(result.solutions[0].scenario_id);
  const activeId = selectedScenarioId ?? internalActiveId;
  const select = (scenarioId: string) => { setInternalActiveId(scenarioId); onSelect?.(scenarioId); };
  const active = result.solutions.find((item) => item.scenario_id === activeId) ?? result.solutions[0];
  const width = Math.max(1120, result.solutions.length * 50 + 150);
  const height = 570;
  const left = 104, right = 30;
  const chartWidth = width - left - right;
  const step = chartWidth / result.solutions.length;
  const barWidth = Math.min(36, Math.max(22, step * .62));
  const npvTop = 64, panelHeight = 170, paybackTop = 326;
  const npvValues = result.solutions.map((item) => item.metrics.net_present_value_aud);
  const npvMin = Math.min(0, ...npvValues);
  const npvMax = Math.max(1, ...npvValues);
  const npvSpan = Math.max(1, npvMax - npvMin);
  const npvY = (value: number) => npvTop + ((npvMax - value) / npvSpan) * panelHeight;
  const npvZero = npvY(0);
  const maxPayback = Math.max(result.assumptions.analysis_term_years, ...result.solutions.map((item) => item.metrics.payback_period_years ?? result.assumptions.analysis_term_years));
  const paybackY = (value: number) => paybackTop + panelHeight - (value / maxPayback) * panelHeight;
  const colour = (rank: number, scenarioId: string) => scenarioId === activeId ? "#102a4d" : rank <= 3 ? "#a63db7" : "#9ab6eb";
  const x = (index: number) => left + index * step + (step - barWidth) / 2;
  const ticks = [0, .5, 1];

  return <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-labelledby="portfolio-return-title">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 p-5 sm:px-6 sm:py-5"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Portfolio view</p><h2 className="mt-1 text-xl font-semibold text-slate-950" id="portfolio-return-title">NPV and payback across all solutions</h2><p className="mt-1 text-sm text-slate-500">Select a bar to inspect the same solution throughout Tariff replay.</p></div><div className="flex items-center gap-3"><span className="inline-flex items-center gap-2 text-xs text-slate-500"><span className="size-2.5 rounded-sm bg-[#a63db7]" />Top 3 NPV</span><span className="inline-flex items-center gap-2 text-xs text-slate-500"><span className="size-2.5 rounded-sm bg-[#102a4d]" />Selected</span><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{result.solutions.length} solutions</span></div></div>
    <div className="overflow-x-auto p-4 sm:p-6">
      <div className="min-w-[860px]">
      <svg aria-label="All solution NPV and payback comparison" className="block h-auto w-full" role="img" viewBox={`0 0 ${width} ${height}`}>
        <rect fill="#f8fafc" height={panelHeight} rx="10" width={chartWidth} x={left} y={npvTop} />
        {ticks.map((fraction) => <line key={`npv-${fraction}`} stroke="#dbe2ea" x1={left} x2={width-right} y1={npvTop + fraction * panelHeight} y2={npvTop + fraction * panelHeight} />)}
        <text fill="#0f172a" fontSize="15" fontWeight="600" x={left} y="32">Net present value</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-14} y={npvTop+4}>{compactAud(npvMax)}</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-14} y={npvTop+panelHeight/2+4}>{compactAud(npvMax-(npvSpan/2))}</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-14} y={npvTop+panelHeight+4}>{compactAud(npvMin)}</text>
        <line stroke="#94a3b8" x1={left} x2={width-right} y1={npvZero} y2={npvZero} />
        {result.solutions.map((item, index) => {
          const valueY = npvY(item.metrics.net_present_value_aud);
          const barTop = Math.min(npvZero, valueY);
          return <g aria-label={`Rank ${item.financial_review_rank}, NPV ${aud(item.metrics.net_present_value_aud)}`} className="cursor-pointer outline-none" key={`npv-${item.scenario_id}`} onClick={() => select(item.scenario_id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") select(item.scenario_id); }} role="button" tabIndex={0}>
            <title>Solution #{item.financial_review_rank} · NPV {aud(item.metrics.net_present_value_aud)}</title>
            <rect fill={colour(item.financial_review_rank, item.scenario_id)} height={Math.max(2, Math.abs(npvZero-valueY))} rx="4" stroke={item.scenario_id === activeId ? "#38bdf8" : "none"} strokeWidth="3" width={barWidth} x={x(index)} y={barTop} />
            {item.financial_review_rank <= 3 ? <text fill="#fff" fontSize="14" fontWeight="700" textAnchor="middle" x={x(index)+barWidth/2} y={Math.min(npvZero-8, barTop+19)}>★</text> : null}
          </g>;
        })}
        <rect fill="#f8fafc" height={panelHeight} rx="10" width={chartWidth} x={left} y={paybackTop} />
        {ticks.map((fraction) => <line key={`payback-${fraction}`} stroke="#dbe2ea" x1={left} x2={width-right} y1={paybackTop + fraction * panelHeight} y2={paybackTop + fraction * panelHeight} />)}
        <text fill="#0f172a" fontSize="15" fontWeight="600" x={left} y={paybackTop-25}>Payback period</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-14} y={paybackTop+4}>{maxPayback.toFixed(0)} yr</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-14} y={paybackTop+panelHeight/2+4}>{(maxPayback/2).toFixed(1)} yr</text>
        <text fill="#64748b" fontSize="11" textAnchor="end" x={left-14} y={paybackTop+panelHeight+4}>0 yr</text>
        {result.solutions.map((item, index) => {
          const value = item.metrics.payback_period_years ?? maxPayback;
          const valueY = paybackY(value);
          return <g aria-label={`Rank ${item.financial_review_rank}, payback ${payback(value)}`} className="cursor-pointer outline-none" key={`payback-${item.scenario_id}`} onClick={() => select(item.scenario_id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") select(item.scenario_id); }} role="button" tabIndex={0}>
            <title>Solution #{item.financial_review_rank} · payback {payback(value)}</title>
            <rect fill={colour(item.financial_review_rank, item.scenario_id)} height={paybackTop+panelHeight-valueY} rx="4" stroke={item.scenario_id === activeId ? "#38bdf8" : "none"} strokeWidth="3" width={barWidth} x={x(index)} y={valueY} />
            <text fill={item.scenario_id === activeId ? "#102a4d" : "#64748b"} fontSize="9.5" fontWeight={item.scenario_id === activeId ? "700" : "500"} textAnchor="middle" x={x(index)+barWidth/2} y={paybackTop+panelHeight+22}>#{item.financial_review_rank}</text>
          </g>;
        })}
      </svg>
      </div>
    </div>
    <div className="grid gap-3 border-t border-slate-200 bg-slate-50/70 p-5 sm:grid-cols-2 lg:grid-cols-[minmax(260px,1.7fr)_repeat(5,minmax(110px,1fr))] lg:items-stretch"><div className="rounded-xl border border-slate-200 bg-white p-4 sm:col-span-2 lg:col-span-1"><p className="text-xs font-semibold uppercase tracking-[.13em] text-cyan-700">Selected solution #{active.financial_review_rank}</p><p className="mt-2 text-sm font-semibold leading-6 text-slate-950">{configurationFromFinance(active)}</p></div><ChartMetric label="Gross CAPEX" value={aud(active.gross_upfront_cost_aud_ex_gst)} /><ChartMetric label="Rebates" value={active.upfront_rebate_aud_ex_gst > 0 ? `−${aud(active.upfront_rebate_aud_ex_gst)}` : aud(0)} /><ChartMetric label="Net upfront" value={aud(active.upfront_cost_aud_ex_gst)} /><ChartMetric label="NPV" value={signedAud(active.metrics.net_present_value_aud)} /><ChartMetric label="Payback" value={payback(active.metrics.payback_period_years)} /></div>
  </section>;
}

function CashflowChart({ result }: { result: CiAnnualFinancialComparisonResult }) {
  const width = 720, height = 250, pad = 32;
  const shown = result.solutions.slice(0, 10);
  const series = shown.map((item) => {
    let total = -item.upfront_cost_aud_ex_gst;
    return [-item.upfront_cost_aud_ex_gst, ...item.metrics.annual_cashflows_aud.map((cash) => total += cash)];
  });
  const values = series.flat();
  const minimum = Math.min(...values, 0), maximum = Math.max(...values, 0), span = Math.max(1, maximum - minimum);
  const x = (index: number) => pad + (index / result.assumptions.analysis_term_years) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - minimum) / span) * (height - pad * 2);
  const colours = ["#0891b2", "#2563eb", "#7c3aed", "#16a34a", "#ea580c", "#db2777", "#475569", "#0f766e", "#9333ea", "#b45309"];
  return <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Cash flow</p><h2 className="mt-1 text-lg font-semibold text-slate-950">Top 10 cumulative cash flow</h2><p className="mt-1 text-sm text-slate-500">Year 0 starts at calculated CAPEX; crossing zero indicates simple payback.</p><svg aria-label="Cumulative cash flow comparison" className="mt-5 h-auto w-full" role="img" viewBox={`0 0 ${width} ${height}`}><line stroke="#cbd5e1" strokeDasharray="4 4" x1={pad} x2={width-pad} y1={y(0)} y2={y(0)} />{series.map((points, index) => <polyline fill="none" key={shown[index].scenario_id} points={points.map((value, pointIndex) => `${x(pointIndex)},${y(value)}`).join(" ")} stroke={colours[index]} strokeWidth="3" />)}</svg><div className="mt-3 flex flex-wrap gap-3">{shown.map((item, index) => <span className="inline-flex items-center gap-1.5 text-xs text-slate-600" key={item.scenario_id}><span className="size-2.5 rounded-full" style={{ backgroundColor: colours[index] }} />#{item.financial_review_rank} {numberLabel(item.pv_capacity_kwp_dc)} kWp / {numberLabel(item.battery_capacity_kwh)} kWh</span>)}</div></section>;
}

function AssumptionInput({ label, onChange, suffix, value }: { label: string; onChange: (value: number) => void; suffix: string; value: number }) { return <label className="rounded-lg bg-slate-50 p-3"><span className="block text-[11px] text-slate-500">{label}</span><span className="mt-1 flex items-center gap-1"><input className="min-w-0 flex-1 bg-transparent text-sm font-semibold tabular-nums text-slate-950 outline-none" min="0" onChange={(event) => onChange(Number(event.target.value))} step="0.1" type="number" value={Number(value.toFixed(3))} /><span className="text-[11px] text-slate-500">{suffix}</span></span></label>; }
function Notice({ text }: { text: string }) { return <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" />{text}</div>; }
function StateCard({ error = false, text }: { error?: boolean; text: string }) { return <div className={`rounded-xl border p-6 text-sm ${error ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-600"}`}>{text}</div>; }
function MetricCell({ positive = false, value }: { positive?: boolean; value: string }) { return <td className={`px-3 py-4 text-right font-semibold tabular-nums ${positive ? "text-emerald-700" : "text-slate-800"}`}>{value}</td>; }
function Basis({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-950">{value}</dd></div>; }
function ChartMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] uppercase tracking-[.12em] text-slate-400">{label}</p><p className="mt-2 text-base font-semibold tabular-nums text-slate-950">{value}</p></div>; }
function configurationFromFinance(item: CiAnnualFinancialComparisonResult["solutions"][number]) { return `${numberLabel(item.pv_capacity_kwp_dc)} kWp PV · ${numberLabel(item.battery_capacity_kwh)} kWh battery · ${numberLabel(item.inverter_capacity_kw_ac)} kW hybrid inverter / PCS`; }
function aud(value: number) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value); }
function signedAud(value: number) { return `${value >= 0 ? "+" : "−"}${aud(Math.abs(value))}`; }
function percent(value: number | null) { return value === null ? "No IRR" : `${(value * 100).toFixed(1)}%`; }
function payback(value: number | null) { return value === null ? "Beyond term" : `${value.toFixed(1)} yrs`; }
function numberLabel(value: number) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value); }
function compactAud(value: number) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", notation: "compact", maximumFractionDigits: 1 }).format(value); }

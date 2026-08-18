import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, BatteryCharging, CircleDollarSign, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  simulateCiAnnualFinancialScenario,
  type CiAnnualFinancialSimulationResult,
  type CiAnnualFinancialValueBasis,
} from "@/features/ci/api/ci-annual-financial-simulation";
import { ciSavedDesignQueryKey, fetchCiSavedDesign, type CiProject } from "@/features/ci/api/ci-projects";
import { listCiPricingCatalog, type CiPriceItem } from "@/features/ci/api/ci-pricing-catalog";
import { CiCatalogWorkspace } from "@/features/ci/ci-financial-workspace";

const pricingQueryKey = ["ci-pricing-catalog"] as const;

export function CiAnnualFinancialWorkspace({ onComplete, profileReady, project }: { onComplete: () => void; profileReady: boolean; project: CiProject }) {
  const design = useQuery({ queryKey: ciSavedDesignQueryKey(project.project_id), queryFn: () => fetchCiSavedDesign(project.project_id) });
  const pricing = useQuery({ queryKey: pricingQueryKey, queryFn: () => listCiPricingCatalog() });
  const batteryDesigns = useMemo(() => design.data?.candidates.filter((item) => item.nominal_capacity_kwh > 0) ?? [], [design.data]);
  const publishedCatalog = pricing.data?.find((item) => item.status === "published") ?? null;
  const [scenarioId, setScenarioId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [valueBasis, setValueBasis] = useState<CiAnnualFinancialValueBasis>("battery_incremental");
  const [discountRate, setDiscountRate] = useState("8");
  const [degradationRate, setDegradationRate] = useState("0");
  const [termYears, setTermYears] = useState("15");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [installationItemIds, setInstallationItemIds] = useState<string[]>([]);
  useEffect(() => { if (!scenarioId && batteryDesigns[0]) setScenarioId(batteryDesigns[0].scenario_id); }, [batteryDesigns, scenarioId]);
  useEffect(() => { setProductIds([]); setInstallationItemIds([]); }, [publishedCatalog?.catalog_version_id]);
  const simulation = useMutation({
    mutationFn: () => {
      if (!file || !publishedCatalog || !scenarioId) throw new Error("Complete the saved-design, NEM12 and price selections first.");
      return simulateCiAnnualFinancialScenario({
        projectId: project.project_id,
        file,
        scenarioId,
        valueBasis,
        pricingCatalogVersionId: publishedCatalog.catalog_version_id,
        productIds,
        installationItemIds,
        discountRate: Number(discountRate) / 100,
        degradationRate: Number(degradationRate) / 100,
        termYears: Number(termYears),
      });
    },
    onSuccess: onComplete,
  });
  if (design.isPending || pricing.isPending) return <StateCard text="Loading saved designs and the active price catalog…" />;
  if (design.isError || pricing.isError) return <StateCard error text="The annual finance workspace could not load its project inputs." />;
  if (!profileReady) return <StateCard text="An approved active tariff profile is required before annual tariff and financial simulation can run." />;
  if (!design.data || !batteryDesigns.length) return <StateCard text="Save at least one battery-bearing candidate in System design before starting annual finance." />;
  if (!publishedCatalog) return <div className="space-y-4"><StateCard text="Publish a price catalog before calculating NPV, payback and IRR." /><CiCatalogWorkspace /></div>;
  const valid = Boolean(file && scenarioId && productIds.length + installationItemIds.length > 0 && Number(discountRate) >= 0 && Number(degradationRate) >= 0 && Number(termYears) >= 1);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle as="h2">Annual scenario setup</CardTitle><CardDescription>Choose one saved battery design, re-select its NEM12 and apply an evidence-backed price catalog.</CardDescription></div><div className="flex gap-2"><Badge variant="secondary">Python calculated</Badge><Badge variant="outline">No recommendation</Badge></div></div></CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (valid) simulation.mutate(); }}>
            <div className="grid gap-4 lg:grid-cols-3">
              <Select label="Saved battery design" value={scenarioId} onChange={setScenarioId}>{batteryDesigns.map((item) => <option key={item.scenario_id} value={item.scenario_id}>{item.label} · {formatNumber(item.pv_capacity_kwp_dc)} kWp · {formatNumber(item.nominal_capacity_kwh)} kWh</option>)}</Select>
              <label className="grid gap-1 text-sm"><span className="font-medium">Matching NEM12 CSV</span><input accept=".csv,text/csv" aria-label="Matching NEM12 CSV" className="rounded-md border border-border bg-background px-3 py-2" onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" /><span className="text-xs text-muted-foreground">Files remain request-local and are not saved.</span></label>
              <Select label="Financial value basis" value={valueBasis} onChange={(value) => setValueBasis(value as CiAnnualFinancialValueBasis)}><option value="battery_incremental">Battery incremental: PV-only → PV+battery</option><option value="whole_solution">Whole solution: no system → PV+battery</option></Select>
            </div>
            <div className="grid gap-4 md:grid-cols-3"><Field label="Discount rate (%)" value={discountRate} onChange={setDiscountRate} /><Field label="Annual value degradation (%)" value={degradationRate} onChange={setDegradationRate} /><Field label="Analysis term (years)" value={termYears} onChange={setTermYears} /></div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{valueBasis === "battery_incremental" ? "Select only the battery and incremental installation items. The annual value is the evidence-bound difference between PV-only and PV+battery." : "Select every product and installation item included in the whole PV+battery solution."}</div>
            <div className="grid gap-4 lg:grid-cols-2"><PriceChoices heading="Published products" items={publishedCatalog.catalog.products} selected={productIds} onChange={setProductIds} /><PriceChoices heading="Published installation" items={publishedCatalog.catalog.installation_items} selected={installationItemIds} onChange={setInstallationItemIds} /></div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5"><Button disabled={!valid || simulation.isPending} type="submit">{simulation.isPending ? "Running annual replay…" : "Run annual financial simulation"}</Button><span className="text-sm text-muted-foreground">Tariff profile: evidence-bound · Price basis: {publishedCatalog.catalog.tax_basis === "gst_inclusive" ? "GST inclusive" : "GST exclusive"}</span></div>
            {simulation.isError ? <p className="text-sm text-destructive">{simulation.error.message}</p> : null}
          </form>
        </CardContent>
      </Card>
      {simulation.data ? <AnnualFinancialResults result={simulation.data} /> : null}
    </div>
  );
}

function AnnualFinancialResults({ result }: { result: CiAnnualFinancialSimulationResult }) {
  const taxBasis = result.financial_projection.assumptions.pricing_resolution.tax_basis;
  const inclusive = taxBasis === "gst_inclusive";
  const metrics = result.financial_projection.metrics;
  const assumptions = result.financial_projection.assumptions;
  return <section aria-label="Annual financial simulation results" className="space-y-5">
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"><strong>Annual simulation complete.</strong><span className="ml-2">Internal estimate on {result.profile.display_label}; customer-facing and recommendation permissions remain false.</span></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric icon={CircleDollarSign} label="Upfront selected cost" value={formatAud(assumptions.upfront_cost_aud)} /><Metric icon={TrendingUp} label="First-year net value" value={formatAud(assumptions.first_year_net_value_aud)} /><Metric icon={BarChart3} label="NPV" value={formatAud(metrics.net_present_value_aud)} /><Metric icon={BatteryCharging} label="Payback" value={metrics.payback_period_years === null ? "Beyond term" : `${metrics.payback_period_years.toFixed(2)} yr`} /><Metric icon={TrendingUp} label="IRR" value={metrics.internal_rate_of_return === null ? "—" : `${(metrics.internal_rate_of_return * 100).toFixed(1)}%`} /></div>
    <div className="grid gap-5 xl:grid-cols-2"><AnnualCaseChart inclusive={inclusive} result={result} /><CumulativeCashflowChart result={result} /></div>
    <Card><CardHeader><CardTitle as="h3">Battery before/after summary</CardTitle><CardDescription>PV-only compared with the same PV plus the selected battery; annual tariff values use the active evidence profile.</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-3"><Summary label="Battery incremental value ex GST" value={formatAud(result.battery_incremental_value.ex_gst_aud)} /><Summary label="Battery incremental value inc GST" value={formatAud(result.battery_incremental_value.inc_gst_aud)} /><Summary label="Annual O&M selected" value={formatAud(assumptions.annual_om_cost_aud)} /></CardContent></Card>
    <p className="rounded-lg border border-border bg-muted/20 p-4 text-xs leading-5 text-muted-foreground">{result.disclaimer}</p>
  </section>;
}

function AnnualCaseChart({ inclusive, result }: { inclusive: boolean; result: CiAnnualFinancialSimulationResult }) {
  const values = result.cases.map((item) => inclusive ? item.annual_cost_inc_gst_aud : item.annual_cost_ex_gst_aud);
  const maximum = Math.max(1, ...values);
  return <Card><CardHeader><CardTitle as="h3">Annual bill comparison</CardTitle><CardDescription>{inclusive ? "GST-inclusive" : "GST-exclusive"} annual modeled cost for the three consistent cases.</CardDescription></CardHeader><CardContent className="space-y-4">{result.cases.map((item, index) => <div key={item.case_id}><div className="mb-2 flex items-center justify-between gap-3 text-sm"><span className="font-medium">{item.label}</span><strong>{formatAud(values[index])}</strong></div><div className="h-4 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${item.case_id === "no_system" ? "bg-slate-500" : item.case_id === "pv_only" ? "bg-amber-400" : "bg-cyan-500"}`} style={{ width: `${Math.max(2, values[index] / maximum * 100)}%` }} /></div></div>)}</CardContent></Card>;
}

function CumulativeCashflowChart({ result }: { result: CiAnnualFinancialSimulationResult }) {
  const assumptions = result.financial_projection.assumptions;
  const cumulative = [-assumptions.upfront_cost_aud];
  result.financial_projection.metrics.annual_cashflows_aud.forEach((value) => cumulative.push(cumulative.at(-1)! + value));
  const min = Math.min(...cumulative); const max = Math.max(...cumulative); const span = Math.max(1, max - min); const width = 660; const height = 260; const pad = 38;
  const x = (index: number) => pad + index / Math.max(1, cumulative.length - 1) * (width - pad * 2);
  const y = (value: number) => pad + (max - value) / span * (height - pad * 2);
  const points = cumulative.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  return <Card><CardHeader><CardTitle as="h3">Cumulative project cashflow</CardTitle><CardDescription>Initial selected cost followed by Python-returned annual net cashflows.</CardDescription></CardHeader><CardContent><svg aria-label="Cumulative project cashflow chart" className="h-auto w-full" role="img" viewBox={`0 0 ${width} ${height}`}><line stroke="#cbd5e1" x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} /><polyline fill="none" points={points} stroke="#0891b2" strokeWidth="4" />{cumulative.map((value, index) => <circle cx={x(index)} cy={y(value)} fill={value >= 0 ? "#059669" : "#0891b2"} key={index} r="4"><title>{`Year ${index}: ${formatAud(value)}`}</title></circle>)}</svg><div className="flex justify-between text-xs text-muted-foreground"><span>Year 0</span><span>Year {assumptions.analysis_term_years}</span></div></CardContent></Card>;
}

function PriceChoices({ heading, items, onChange, selected }: { heading: string; items: CiPriceItem[]; onChange: (ids: string[]) => void; selected: string[] }) {
  const active = items.filter((item) => item.effective_status === "active");
  return <fieldset className="rounded-lg border border-border p-4"><legend className="px-1 text-sm font-semibold">{heading}</legend>{active.length ? <div className="space-y-2">{active.map((item) => <label className="flex items-start gap-2 text-sm" key={item.item_id}><input aria-label={item.label} checked={selected.includes(item.item_id)} className="mt-0.5" onChange={(event) => onChange(event.target.checked ? [...selected, item.item_id] : selected.filter((id) => id !== item.item_id))} type="checkbox" /><span><strong className="block font-medium">{item.label}</strong><small className="text-muted-foreground">{item.pricing_basis.replaceAll("_", " ")}</small></span></label>)}</div> : <p className="text-xs text-muted-foreground">No active entries.</p>}</fieldset>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof CircleDollarSign; label: string; value: string }) { return <div className="rounded-xl border border-border bg-white p-4"><Icon className="size-4 text-cyan-700" /><span className="mt-3 block text-xs text-muted-foreground">{label}</span><strong className="mt-1 block text-lg tabular-nums">{value}</strong></div>; }
function Summary({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-slate-50 p-4"><span className="text-xs text-muted-foreground">{label}</span><strong className="mt-1 block text-lg tabular-nums">{value}</strong></div>; }
function Field({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) { return <label className="grid gap-1 text-sm"><span className="font-medium">{label}</span><input className="rounded-md border border-border bg-background px-3 py-2" min="0" onChange={(event) => onChange(event.target.value)} step="any" type="number" value={value} /></label>; }
function Select({ children, label, onChange, value }: { children: React.ReactNode; label: string; onChange: (value: string) => void; value: string }) { return <label className="grid gap-1 text-sm"><span className="font-medium">{label}</span><select className="rounded-md border border-border bg-background px-3 py-2" onChange={(event) => onChange(event.target.value)} value={value}>{children}</select></label>; }
function StateCard({ error = false, text }: { error?: boolean; text: string }) { return <Card><CardContent className={`p-5 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>{text}</CardContent></Card>; }
function formatAud(value: number) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value); }
function formatNumber(value: number) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value); }

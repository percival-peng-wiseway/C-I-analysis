import {
  Activity,
  ArrowRight,
  BatteryCharging,
  Check,
  CircleDollarSign,
  FileCheck2,
  Gauge,
  LineChart,
  LockKeyhole,
  Network,
  SunMedium,
  UploadCloud,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiAnalysisResult } from "@/features/ci/api/ci-analysis";
import type { CiPhysicalScenarioResult } from "@/features/ci/api/ci-scenarios";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type WorkflowStatus = "complete" | "current" | "available" | "locked";

const workflow = [
  { id: "data-tariff", label: "Data & tariff", short: "01", icon: UploadCloud },
  { id: "technology", label: "System design", short: "02", icon: Network },
  { id: "solutions", label: "Optimisation", short: "03", icon: Gauge },
  { id: "finance", label: "Financials", short: "04", icon: CircleDollarSign },
  { id: "review-report", label: "Review & report", short: "05", icon: FileCheck2 },
] as const;

export function CiWorkflowNavigator({
  analysisReady,
  evidenceReady,
  posture,
  scenariosReady,
}: {
  analysisReady: boolean;
  evidenceReady: boolean;
  posture: "analyse" | "review";
  scenariosReady: boolean;
}) {
  const statuses: WorkflowStatus[] = [
    analysisReady ? "complete" : evidenceReady ? "current" : "locked",
    scenariosReady ? "complete" : analysisReady ? "current" : "locked",
    scenariosReady ? "complete" : analysisReady ? "available" : "locked",
    scenariosReady ? "available" : "locked",
    posture === "review" ? "current" : scenariosReady ? "available" : "locked",
  ];

  return (
    <nav aria-label="Analysis workflow" className="ci-workflow-nav">
      {workflow.map((step, index) => {
        const status = statuses[index];
        const IconComponent = step.icon;
        return (
          <a
            aria-disabled={status === "locked"}
            className="ci-workflow-step"
            data-status={status}
            href={status === "locked" ? undefined : `#${step.id}`}
            key={step.id}
          >
            <span className="ci-workflow-icon" aria-hidden="true">
              {status === "complete" ? <Check className="size-4" /> : status === "locked" ? <LockKeyhole className="size-3.5" /> : <IconComponent className="size-4" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{step.short}</span>
              <span className="block truncate text-sm font-semibold">{step.label}</span>
            </span>
            {index < workflow.length - 1 ? <ArrowRight className="ci-workflow-arrow size-4" aria-hidden="true" /> : null}
          </a>
        );
      })}
    </nav>
  );
}

export function CiCalculationMap() {
  const stages: Array<{ icon: Icon; title: string; detail: string }> = [
    { icon: UploadCloud, title: "Evidence", detail: "NEM12 E/B/Q/K streams and bound tariff profile" },
    { icon: Activity, title: "Interval model", detail: "15-minute active, reactive, kVA and power-factor evidence" },
    { icon: SunMedium, title: "System design", detail: "PV, inverter, battery, SOC and shared-port assumptions" },
    { icon: BatteryCharging, title: "Dispatch", detail: "Annual plan with 48-hour look-ahead and 24-hour commits" },
    { icon: LineChart, title: "Exact replay", detail: "Physical, tariff and whole-bill reconciliation gates" },
  ];
  return (
    <Card className="ci-dark-card overflow-hidden border-0 text-white">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle as="h2" className="text-white">Calculation pipeline</CardTitle>
            <CardDescription className="mt-1 text-slate-300">
              The web layer orchestrates the workflow; Python remains the calculation authority.
            </CardDescription>
          </div>
          <Badge className="border-white/20 bg-white/10 text-white" variant="outline">Repository-owned method</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="ci-pipeline-grid">
          {stages.map((stage, index) => {
            const IconComponent = stage.icon;
            return (
              <div className="ci-pipeline-stage" key={stage.title}>
                <span className="grid size-9 place-items-center rounded-xl bg-cyan-300/15 text-cyan-200">
                  <IconComponent className="size-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{stage.title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{stage.detail}</p>
                </div>
                {index < stages.length - 1 ? <ArrowRight className="ci-pipeline-arrow size-4 text-cyan-300/60" /> : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function CiBaselineVisuals({ result }: { result: CiAnalysisResult }) {
  const demandSeries = [
    { label: "12-month rolling", value: result.demand_evidence.rolling_demand_kva, color: "bg-cyan-500" },
    { label: "Summer incentive", value: result.demand_evidence.incentive_demand_kva, color: "bg-violet-500" },
    { label: "Billing maximum", value: result.demand_evidence.billing_period_max_kva, color: "bg-amber-500" },
  ];
  const maximumDemand = Math.max(1, ...demandSeries.map((item) => item.value));
  const categories = Object.entries(result.bill_reconciliation.charge_categories)
    .map(([label, value]) => ({ label: titleCase(label), value }))
    .filter((item) => Math.abs(item.value) > 0.0001)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const categoryTotal = Math.max(1, categories.reduce((total, item) => total + Math.abs(item.value), 0));
  const colors = ["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#64748b", "#ec4899", "#3b82f6"];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle as="h3">Demand evidence</CardTitle>
          <CardDescription>Python-returned apparent-power maxima on their applicable windows.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {demandSeries.map((item) => (
            <div key={item.label}>
              <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{item.label}</span>
                <strong className="tabular-nums">{item.value.toFixed(2)} kVA</strong>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max(2, item.value / maximumDemand * 100)}%` }} />
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <span className="text-slate-500">Power factor at billing maximum</span>
            <strong className="tabular-nums">{result.demand_evidence.billing_period_max_power_factor.toFixed(3)}</strong>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h3">Bill composition</CardTitle>
          <CardDescription>Reconciled ex-GST categories; credits retain their returned sign.</CardDescription>
        </CardHeader>
        <CardContent>
          <div aria-label="Bill composition chart" className="flex h-7 overflow-hidden rounded-lg bg-slate-100" role="img">
            {categories.map((item, index) => (
              <span
                key={item.label}
                style={{ backgroundColor: colors[index % colors.length], width: `${Math.abs(item.value) / categoryTotal * 100}%` }}
                title={`${item.label}: ${formatAud(item.value)}`}
              />
            ))}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {categories.map((item, index) => (
              <div className="flex min-w-0 items-center justify-between gap-3 text-sm" key={item.label}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colors[index % colors.length] }} />
                  <span className="truncate text-slate-600">{item.label}</span>
                </span>
                <strong className="shrink-0 tabular-nums">{formatAud(item.value)}</strong>
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-end justify-between border-t border-slate-200 pt-4">
            <span className="text-sm text-slate-500">Total including GST</span>
            <strong className="text-xl tabular-nums">{formatAud(result.bill_reconciliation.calculated_total_inc_gst_aud)}</strong>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CiScenarioVisuals({ result }: { result: CiPhysicalScenarioResult }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
      <ScenarioValueMap result={result} />
      <DemandComparison result={result} />
    </div>
  );
}

function ScenarioValueMap({ result }: { result: CiPhysicalScenarioResult }) {
  const scenarios = result.scenarios;
  const xValues = scenarios.map((item) => item.authored_inputs.pv_capacity_kwp_dc);
  const yValues = scenarios.map((item) => item.annual_tariff_value.first_year_value_ex_gst_aud);
  const batteryValues = scenarios.map((item) => item.authored_inputs.nominal_capacity_kwh);
  const xMax = Math.max(1, ...xValues);
  const yMin = Math.min(0, ...yValues);
  const yMax = Math.max(1, ...yValues);
  const ySpan = Math.max(1, yMax - yMin);
  const batteryMax = Math.max(1, ...batteryValues);
  const left = 62;
  const right = 20;
  const top = 22;
  const bottom = 46;
  const width = 720;
  const height = 310;
  const x = (value: number) => left + value / xMax * (width - left - right);
  const y = (value: number) => top + (yMax - value) / ySpan * (height - top - bottom);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle as="h3">Solution landscape</CardTitle>
            <CardDescription>PV size versus returned first-year tariff value; bubble size represents battery capacity.</CardDescription>
          </div>
          <Badge variant="outline">No automatic recommendation</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <svg aria-label="Solution landscape chart" className="h-auto min-w-[620px] w-full" role="img" viewBox={`0 0 ${width} ${height}`}>
            <line stroke="#cbd5e1" x1={left} x2={left} y1={top} y2={height - bottom} />
            <line stroke="#cbd5e1" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
            {[0, 0.5, 1].map((tick) => {
              const value = yMin + tick * ySpan;
              const yPosition = y(value);
              return <g key={tick}><line stroke="#e2e8f0" x1={left} x2={width - right} y1={yPosition} y2={yPosition} /><text fill="#64748b" fontSize="11" textAnchor="end" x={left - 9} y={yPosition + 4}>{compactAud(value)}</text></g>;
            })}
            {[0, 0.5, 1].map((tick) => <text fill="#64748b" fontSize="11" key={tick} textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} x={x(tick * xMax)} y={height - 22}>{formatNumber(tick * xMax)} kWp</text>)}
            {scenarios.map((scenario) => {
              const radius = 6 + Math.sqrt(scenario.authored_inputs.nominal_capacity_kwh / batteryMax) * 12;
              const topRank = scenario.physical_review_rank <= 3;
              return (
                <g key={scenario.scenario_id}>
                  <circle
                    cx={x(scenario.authored_inputs.pv_capacity_kwp_dc)}
                    cy={y(scenario.annual_tariff_value.first_year_value_ex_gst_aud)}
                    fill={topRank ? "#06b6d4" : "#8b5cf6"}
                    fillOpacity="0.76"
                    r={radius}
                    stroke="white"
                    strokeWidth="2"
                  >
                    <title>{`${scenario.label}: ${formatAud(scenario.annual_tariff_value.first_year_value_ex_gst_aud)}, ${formatCapacity(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp PV, ${formatCapacity(scenario.authored_inputs.nominal_capacity_kwh)} kWh battery`}</title>
                  </circle>
                </g>
              );
            })}
            <text fill="#475569" fontSize="12" fontWeight="600" textAnchor="middle" transform={`rotate(-90 16 ${height / 2})`} x="16" y={height / 2}>First-year value (AUD ex GST)</text>
            <text fill="#475569" fontSize="12" fontWeight="600" textAnchor="middle" x={(left + width - right) / 2} y={height - 4}>PV capacity</text>
          </svg>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-cyan-500" />Physical ranks 1–3</span>
          <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-violet-500" />Other returned scenarios</span>
        </div>
      </CardContent>
    </Card>
  );
}

function DemandComparison({ result }: { result: CiPhysicalScenarioResult }) {
  const ranked = [...result.scenarios].sort((a, b) => a.physical_review_rank - b.physical_review_rank).slice(0, 10);
  const maximum = Math.max(1, result.baseline.raw_rolling_demand_kva, ...ranked.map((item) => item.post_dispatch.raw_rolling_demand_kva));
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3">Rolling-demand comparison</CardTitle>
        <CardDescription>Baseline and the first ten physically ranked solutions.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <DemandBar label="Evidence baseline" maximum={maximum} value={result.baseline.raw_rolling_demand_kva} variant="baseline" />
        {ranked.map((scenario) => <DemandBar key={scenario.scenario_id} label={`#${scenario.physical_review_rank} ${scenario.label}`} maximum={maximum} value={scenario.post_dispatch.raw_rolling_demand_kva} variant="scenario" />)}
      </CardContent>
    </Card>
  );
}

function DemandBar({ label, maximum, value, variant }: { label: string; maximum: number; value: number; variant: "baseline" | "scenario" }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-medium" title={label}>{label}</span>
        <strong className="shrink-0 tabular-nums">{value.toFixed(2)} kVA</strong>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${variant === "baseline" ? "bg-slate-500" : "bg-cyan-500"}`} style={{ width: `${Math.max(2, value / maximum * 100)}%` }} />
      </div>
    </div>
  );
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value);
}

function compactAud(value: number) {
  return new Intl.NumberFormat("en-AU", { notation: "compact", style: "currency", currency: "AUD", maximumFractionDigits: 1 }).format(value);
}

function formatCapacity(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 9 }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value);
}

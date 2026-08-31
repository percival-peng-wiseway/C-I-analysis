import {
  BadgeDollarSign,
  BatteryCharging,
  CircleAlert,
  Gauge,
  ShieldCheck,
} from "lucide-react";

type ReportPlan = {
  rank: number;
  batteryKwh: number;
  capexAudInclGst: number;
  annualBillAudInclGst: number;
  annualSavingAudInclGst: number;
  rollingDemandKva: number;
  maxChargeKw: number;
  maxDischargeKw: number;
  maxSharedPortKw: number;
  maxInverterKva: number;
  npvAud: number;
  irrPercent: number;
  paybackYears: number;
  minSocKwh: number;
  finalSocKwh: number;
  wholeBillGapAud: number;
  categories: {
    energy: number;
    environmental: number;
    network: number;
    regulated: number;
  };
};

const reportPlans: ReportPlan[] = [
  {
    rank: 1,
    batteryKwh: 250,
    capexAudInclGst: 249800,
    annualBillAudInclGst: 174610,
    annualSavingAudInclGst: 64316.43,
    rollingDemandKva: 151.19,
    maxChargeKw: 101.58,
    maxDischargeKw: 179.62,
    maxSharedPortKw: 205.56,
    maxInverterKva: 220.58,
    npvAud: 417782.55,
    irrPercent: 24.8217,
    paybackYears: 3.884,
    minSocKwh: 25,
    finalSocKwh: 250,
    wholeBillGapAud: 3.48,
    categories: { energy: 16010, environmental: 4090, network: 38130, regulated: 247.66 },
  },
  {
    rank: 2,
    batteryKwh: 300,
    capexAudInclGst: 268000,
    annualBillAudInclGst: 173060,
    annualSavingAudInclGst: 65859.11,
    rollingDemandKva: 142.69,
    maxChargeKw: 102.19,
    maxDischargeKw: 160.56,
    maxSharedPortKw: 162.55,
    maxInverterKva: 181.17,
    npvAud: 415595.04,
    irrPercent: 23.5435,
    paybackYears: 4.069,
    minSocKwh: 30,
    finalSocKwh: 300,
    wholeBillGapAud: 3.46,
    categories: { energy: 16020, environmental: 4080, network: 39530, regulated: 247.23 },
  },
  {
    rank: 3,
    batteryKwh: 375.84,
    capexAudInclGst: 291000,
    annualBillAudInclGst: 171880,
    annualSavingAudInclGst: 67044.22,
    rollingDemandKva: 137.83,
    maxChargeKw: 104.81,
    maxDischargeKw: 177.02,
    maxSharedPortKw: 178.73,
    maxInverterKva: 195.82,
    npvAud: 404896.08,
    irrPercent: 21.8506,
    paybackYears: 4.34,
    minSocKwh: 37.58,
    finalSocKwh: 375.84,
    wholeBillGapAud: 3.81,
    categories: { energy: 16030, environmental: 4070, network: 40590, regulated: 246.78 },
  },
];

export function CiAnnualFinanceReportSnapshot() {
  return (
    <section aria-labelledby="annual-finance-title" className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><BadgeDollarSign className="size-5" /></span>
          <div>
            <h1 className="text-xl font-semibold text-slate-950" id="annual-finance-title">Commercial comparison snapshot</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">141.5 kW Solar · 2 × 125 kW inverter · 250, 300 and 375.84 kWh battery options.</p>
          </div>
        </div>
        <div className="text-right"><span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600"><ShieldCheck className="size-3.5" />Internal snapshot</span><p className="mt-2 text-[11px] text-slate-400">Report date · 19 Aug 2026</p></div>
      </header>

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <CircleAlert className="mt-1 size-4 shrink-0" />
        <p>Report snapshot only. Re-run Python after any input or assumption change.</p>
      </div>

      <section aria-labelledby="top-three-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-5 sm:p-6"><h2 className="text-lg font-semibold text-slate-950" id="top-three-title">Top 3 commercial results</h2></div>
        <div className="grid gap-px bg-slate-200 lg:grid-cols-3">
          {reportPlans.map((plan) => <PlanCard key={plan.batteryKwh} plan={plan} />)}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(380px,.85fr)]">
        <FinancialReturnChart plans={reportPlans} />
        <TradeoffSummary />
      </section>

      <section aria-labelledby="finance-table-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-5 sm:p-6"><h2 className="text-lg font-semibold text-slate-950" id="finance-table-title">Financial and tariff comparison · incl. GST</h2></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-5 py-3 font-medium">Rank</th><th className="px-3 py-3 font-medium">System</th><th className="px-3 py-3 text-right font-medium">CAPEX</th><th className="px-3 py-3 text-right font-medium">Annual bill</th><th className="px-3 py-3 text-right font-medium">Year-1 saving</th><th className="px-3 py-3 text-right font-medium">Residual demand</th><th className="px-3 py-3 text-right font-medium">NPV @ 5%</th><th className="px-3 py-3 text-right font-medium">IRR</th><th className="px-5 py-3 text-right font-medium">Payback</th></tr></thead><tbody className="divide-y divide-slate-100">{reportPlans.map((plan) => <tr className={plan.rank === 1 ? "bg-emerald-50/50" : ""} key={plan.batteryKwh}><td className="px-5 py-4"><span className="grid size-7 place-items-center rounded-full bg-slate-950 text-xs font-semibold text-white">{plan.rank}</span></td><td className="px-3 py-4"><strong className="text-slate-950">141.5 kW PV · {number(plan.batteryKwh)} kWh battery</strong><span className="mt-1 block text-xs text-slate-500">250 kW combined inverter</span></td><MetricCell value={aud(plan.capexAudInclGst)} /><MetricCell value={aud(plan.annualBillAudInclGst)} /><MetricCell positive value={aud2(plan.annualSavingAudInclGst)} /><MetricCell value={`${number(plan.rollingDemandKva, 2)} kVA`} /><MetricCell positive value={aud2(plan.npvAud)} /><MetricCell positive value={`${plan.irrPercent.toFixed(4)}%`} /><MetricCell value={`${plan.paybackYears.toFixed(3)} yrs`} /></tr>)}</tbody></table></div>
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs text-slate-500">ROI and LCOE / LCOS are not defined for this snapshot.</div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <CategorySavings plans={reportPlans} />
        <CalculationBasis plans={reportPlans} />
      </section>
    </section>
  );
}

function PlanCard({ plan }: { plan: ReportPlan }) {
  return <article className="bg-white p-5 sm:p-6"><div className="flex items-center justify-between gap-3"><span className={`grid size-9 place-items-center rounded-xl ${plan.rank === 1 ? "bg-emerald-100 text-emerald-800" : "bg-cyan-50 text-cyan-800"}`}><BatteryCharging className="size-4" /></span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Rank {plan.rank}</span></div><h3 className="mt-4 text-lg font-semibold text-slate-950">{number(plan.batteryKwh)} kWh battery</h3><dl className="mt-5 grid grid-cols-2 gap-3"><CardMetric label="CAPEX incl. GST" value={aud(plan.capexAudInclGst)} /><CardMetric label="Year-1 saving" value={aud2(plan.annualSavingAudInclGst)} /><CardMetric label="NPV @ 5%" value={aud2(plan.npvAud)} tone="positive" /><CardMetric label="IRR" value={`${plan.irrPercent.toFixed(2)}%`} tone="positive" /><CardMetric label="Simple payback" value={`${plan.paybackYears.toFixed(3)} yrs`} /><CardMetric label="Residual demand" value={`${number(plan.rollingDemandKva, 2)} kVA`} /></dl></article>;
}

function FinancialReturnChart({ plans }: { plans: ReportPlan[] }) {
  const maximumNpv = Math.max(...plans.map((plan) => plan.npvAud));
  return <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><h2 className="text-lg font-semibold text-slate-950">NPV, IRR and payback</h2><div aria-label="Top 3 financial return comparison" className="mt-6 space-y-5" role="img">{plans.map((plan) => <div key={plan.batteryKwh}><div className="mb-2 flex flex-wrap items-end justify-between gap-2"><div><strong className="text-sm text-slate-950">{number(plan.batteryKwh)} kWh</strong><span className="ml-2 text-xs text-slate-500">Rank {plan.rank}</span></div><strong className="text-sm tabular-nums text-emerald-700">NPV {aud2(plan.npvAud)}</strong></div><div className="h-4 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${plan.rank === 1 ? "bg-emerald-500" : plan.rank === 2 ? "bg-cyan-500" : "bg-violet-500"}`} style={{ width: `${plan.npvAud / maximumNpv * 100}%` }} /></div><div className="mt-2 flex justify-between gap-3 text-xs text-slate-500"><span>IRR <strong className="text-slate-700">{plan.irrPercent.toFixed(4)}%</strong></span><span>Payback <strong className="text-slate-700">{plan.paybackYears.toFixed(3)} years</strong></span></div></div>)}</div></section>;
}

function TradeoffSummary() {
  return <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><h2 className="text-lg font-semibold text-slate-950">Marginal value</h2><div className="mt-5 space-y-3"><TradeoffRow capex="+$18,200 CAPEX" demand="−8.498 kVA" from="250" saving="+$1,542.68/yr" to="300" /><TradeoffRow capex="+$23,000 CAPEX" demand="−4.867 kVA" from="300" saving="+$1,185.11/yr" to="375.84" /></div><div className="mt-5 rounded-lg bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">250 kWh leads financially; 375.84 kWh has the lowest residual demand.</div></section>;
}

function TradeoffRow({ capex, demand, from, saving, to }: { capex: string; demand: string; from: string; saving: string; to: string }) {
  return <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><strong className="text-sm text-slate-950">{from} → {to} kWh</strong><span className="inline-flex items-center gap-1 text-xs font-medium text-cyan-700"><Gauge className="size-3.5" />{demand}</span></div><div className="mt-3 grid grid-cols-2 gap-3 text-xs"><span className="rounded-lg bg-rose-50 px-3 py-2 font-medium text-rose-800">{capex}</span><span className="rounded-lg bg-emerald-50 px-3 py-2 font-medium text-emerald-800">{saving}</span></div></div>;
}

function CategorySavings({ plans }: { plans: ReportPlan[] }) {
  const colours = { energy: "bg-cyan-500", environmental: "bg-emerald-500", network: "bg-blue-600", regulated: "bg-violet-500" };
  return <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><h2 className="text-lg font-semibold text-slate-950">Annual saving composition · ex GST</h2><div className="mt-6 space-y-5">{plans.map((plan) => { const total=Object.values(plan.categories).reduce((sum,value)=>sum+value,0); return <div key={plan.batteryKwh}><div className="mb-2 flex justify-between gap-3 text-xs"><strong className="text-slate-700">{number(plan.batteryKwh)} kWh</strong><span className="tabular-nums text-slate-500">{aud(total)} ex GST</span></div><div className="flex h-4 overflow-hidden rounded-full bg-slate-100">{Object.entries(plan.categories).map(([key,value]) => <span className={colours[key as keyof typeof colours]} key={key} style={{ width: `${value/total*100}%` }} title={`${title(key)} ${aud(value)}`} />)}</div></div>; })}</div><div className="mt-5 flex flex-wrap gap-4 text-xs text-slate-500">{Object.entries(colours).map(([key,colour]) => <span className="inline-flex items-center gap-2" key={key}><span className={`size-2.5 rounded-sm ${colour}`} />{title(key)}</span>)}</div></section>;
}

function CalculationBasis({ plans }: { plans: ReportPlan[] }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><h2 className="text-lg font-semibold text-slate-950">Assumptions and integrity</h2><div className="mt-5 grid grid-cols-2 gap-3"><Basis label="Analysis term" value="15 years" /><Basis label="Discount rate" value="5.0%" /><Basis label="Annual O&M" value="0" /><Basis label="Value escalation" value="0%" /><Basis label="Degradation" value="0%" /><Basis label="Replacement" value="None" /></div><div className="mt-5 overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="text-slate-500"><tr><th className="py-2 font-medium">Battery</th><th className="py-2 text-right font-medium">Min SOC</th><th className="py-2 text-right font-medium">Final SOC</th><th className="py-2 text-right font-medium">Whole-bill gap</th><th className="py-2 text-right font-medium">Planner</th></tr></thead><tbody className="divide-y divide-slate-100">{plans.map((plan) => <tr key={plan.batteryKwh}><td className="py-3 font-semibold text-slate-800">{number(plan.batteryKwh)} kWh</td><td className="py-3 text-right tabular-nums text-slate-600">{number(plan.minSocKwh,2)} kWh</td><td className="py-3 text-right tabular-nums text-slate-600">{number(plan.finalSocKwh,2)} kWh</td><td className="py-3 text-right tabular-nums text-slate-600">{aud2(plan.wholeBillGapAud)}</td><td className="py-3 text-right font-medium text-emerald-700">Bounded optimal</td></tr>)}</tbody></table></div><div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" />Internal analysis only · no customer recommendation.</div></section>;
}

function CardMetric({ label, tone = "default", value }: { label: string; tone?: "default" | "positive"; value: string }) { return <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[11px] text-slate-500">{label}</dt><dd className={`mt-1 text-sm font-semibold tabular-nums ${tone === "positive" ? "text-emerald-700" : "text-slate-950"}`}>{value}</dd></div>; }
function MetricCell({ positive = false, value }: { positive?: boolean; value: string }) { return <td className={`px-3 py-4 text-right font-semibold tabular-nums ${positive ? "text-emerald-700" : "text-slate-800"}`}>{value}</td>; }
function Basis({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-950">{value}</dd></div>; }
function aud(value: number) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value); }
function aud2(value: number) { return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
function number(value: number, digits = 2) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value); }
function title(value: string) { return value.replace(/^./, (character) => character.toUpperCase()); }

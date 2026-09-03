import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  FileSpreadsheet,
  LineChart,
  ReceiptText,
} from "lucide-react";

import type { CiProject } from "@/features/ci/api/ci-projects";
import type { CiWorkspaceStage } from "@/features/ci/ci-workspace-context";

type TemplateStage = Extract<CiWorkspaceStage, "dispatch" | "tariff_replay">;

const definitions = {
  dispatch: {
    eyebrow: "Interval operations",
    title: "Dispatch",
    description: "Review how Solar and Battery operate through each interval before applying tariff charges.",
    icon: Activity,
    inputs: ["Selected physical configuration", "Measured site load", "Solar production profile", "Battery SOC and operating rules"],
    process: ["PV serves site load first", "Surplus charges the battery", "Battery discharges to the selected objective", "Grid import and export close the balance"],
    outputs: ["Solar generation", "Battery charge / discharge", "State of charge", "Grid import / export"],
  },
  tariff_replay: {
    eyebrow: "Cost reconstruction",
    title: "Tariff replay",
    description: "Replay every physical scenario against approved retail, network and demand-charge rules to rebuild the annual bill.",
    icon: ReceiptText,
    inputs: ["Approved peak / off-peak windows", "Network energy rates", "Demand-charge rules", "GST, losses and fixed charges"],
    process: ["Apply rates to each interval", "Recalculate billing demand", "Aggregate monthly charge categories", "Reconcile the representative year"],
    outputs: ["Annual bill by scenario", "Energy savings", "Demand savings", "Charge-category bridge"],
  },
} satisfies Record<TemplateStage, object>;

export function CiWorkflowTemplate({ project, stage }: { project: CiProject; stage: TemplateStage }) {
  const definition = definitions[stage];
  return (
    <div className="space-y-5">
      <section aria-label={`${definition.title} workflow`} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-5 sm:px-6"><div><p className="text-xs font-semibold uppercase tracking-[.16em] text-cyan-700">{definition.title}</p><h2 className="mt-1 text-xl font-semibold text-slate-950">Inputs → module logic → outputs</h2><p className="mt-1 text-sm text-slate-500">This establishes the review structure now; calculation contracts can be connected later without changing the navigation.</p></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500">Calculation pending</span></div>
        <div className="grid gap-px bg-slate-200 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <FlowColumn items={definition.inputs} label="Inputs" />
          <FlowArrow />
          <FlowColumn items={definition.process} label="Module logic" />
          <FlowArrow />
          <FlowColumn items={definition.outputs} label="Outputs" />
        </div>
      </section>

      {stage === "dispatch" ? <DispatchPreview /> : <TariffPreview />}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-950">
        <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-4 shrink-0" /><div><strong>{definition.title} page template is ready.</strong><p className="mt-1 text-cyan-900/75">Project: {project.display_name}. Python results will replace the placeholders when this module is implemented.</p></div></div>
        <span className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-cyan-800">No commercial claim</span>
      </section>
    </div>
  );
}

export function ModulePrerequisite({ description, project, title }: { description: string; project: CiProject; title: string }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-5 py-5 sm:px-6"><h2 className="text-xl font-semibold text-slate-950">{title}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{description}</p></div>
      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div><h3 className="text-lg font-semibold text-slate-950">Template available</h3><p className="mt-2 text-sm leading-6 text-slate-600">This module is part of the five-step flow and remains accessible. Complete the prerequisite evidence to replace this template with project-specific analysis.</p><div className="mt-5 grid gap-3 sm:grid-cols-3"><PlaceholderMetric label="Project" value={project.display_name} /><PlaceholderMetric label="Status" value="Input required" /><PlaceholderMetric label="Calculation" value="Not started" /></div></div>
        <div className="rounded-xl bg-amber-50 p-4 text-amber-950"><div className="flex items-center gap-2 font-semibold"><CircleDashed className="size-4" />Prerequisite</div><p className="mt-2 text-sm leading-6">Bill, NEM12 and the relevant system inputs must be available before Python can produce this module&apos;s project result.</p></div>
      </div>
    </section>
  );
}

function FlowColumn({ items, label }: { items: readonly string[]; label: string }) {
  return <div className="bg-white p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[.16em] text-cyan-700">{label}</p><ul className="mt-4 space-y-3">{items.map((item) => <li className="flex items-start gap-2.5 text-sm leading-5 text-slate-700" key={item}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-cyan-500" />{item}</li>)}</ul></div>;
}

function FlowArrow() {
  return <div className="hidden items-center justify-center bg-slate-50 px-2 text-slate-300 lg:flex"><ArrowRight className="size-5" /></div>;
}

function DispatchPreview() {
  return (
    <section aria-labelledby="dispatch-preview-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <PreviewHeading icon={LineChart} id="dispatch-preview-title" title="Interval operating view" description="Planned layout for Solar, Battery, SOC and grid flows. Values below are structural placeholders, not simulation results." />
      <div className="grid gap-5 p-5 sm:p-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-3"><TemplateField label="Scenario" value="Select physical case" /><TemplateField label="Period" value="Day / week / year" /><TemplateField label="Dispatch objective" value="Self-consumption / peak" /><TemplateField label="Interval" value="5 / 15 / 60 minutes" /></div>
        <div className="rounded-xl bg-slate-50 p-4"><svg aria-label="Dispatch chart template" className="h-auto w-full" role="img" viewBox="0 0 820 280"><rect fill="#fff" height="220" rx="10" width="750" x="50" y="18" />{[0,1,2,3,4].map((item)=><line key={item} stroke="#e2e8f0" x1="50" x2="800" y1={18+item*55} y2={18+item*55} />)}<path d="M50 195 C130 185 160 80 240 95 S360 180 440 150 S555 60 640 92 S730 180 800 165" fill="none" stroke="#f59e0b" strokeWidth="4" /><path d="M50 182 C145 175 180 150 250 160 S380 205 470 178 S590 125 680 148 S750 180 800 170" fill="none" stroke="#0891b2" strokeWidth="4" /><path d="M50 220 C160 215 245 198 330 175 S500 115 610 128 S720 155 800 142" fill="none" stroke="#7c3aed" strokeDasharray="8 7" strokeWidth="3" /><text fill="#64748b" fontSize="11" x="50" y="260">00:00</text><text fill="#64748b" fontSize="11" textAnchor="middle" x="425" y="260">12:00</text><text fill="#64748b" fontSize="11" textAnchor="end" x="800" y="260">24:00</text></svg><div className="flex flex-wrap gap-5 text-xs text-slate-600"><Legend colour="#f59e0b" label="Solar" /><Legend colour="#0891b2" label="Grid import" /><Legend colour="#7c3aed" label="Battery SOC" dashed /></div></div>
      </div>
    </section>
  );
}

function TariffPreview() {
  const rows = ["No system", "Solar only", "Solar + 250 kWh", "Solar + 300 kWh", "Solar + 389 kWh"];
  return (
    <section aria-labelledby="tariff-preview-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <PreviewHeading icon={FileSpreadsheet} id="tariff-preview-title" title="Annual bill replay table" description="Planned charge bridge for every physical scenario. Tariff windows and demand rules remain inputs, not inferred values." />
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-5 py-3 font-medium">Scenario</th><th className="px-3 py-3 text-right font-medium">Energy</th><th className="px-3 py-3 text-right font-medium">Network</th><th className="px-3 py-3 text-right font-medium">Demand</th><th className="px-3 py-3 text-right font-medium">Environmental</th><th className="px-3 py-3 text-right font-medium">Fixed</th><th className="px-5 py-3 text-right font-medium">Annual bill</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row}><td className="px-5 py-4 font-semibold text-slate-950">{row}</td>{Array.from({length:6},(_,index)=><td className="px-3 py-4 text-right text-xs text-slate-400 last:px-5" key={index}>Awaiting replay</td>)}</tr>)}</tbody></table></div>
    </section>
  );
}

function PreviewHeading({ description, icon: Icon, id, title }: { description: string; icon: typeof LineChart; id: string; title: string }) {
  return <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600"><Icon className="size-4" /></span><div><h3 className="font-semibold text-slate-950" id={id}>{title}</h3><p className="mt-1 text-sm text-slate-500">{description}</p></div></div>;
}

function TemplateField({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-3"><span className="block text-xs text-slate-500">{label}</span><strong className="mt-1 block text-sm text-slate-800">{value}</strong></div>;
}

function Legend({ colour, dashed = false, label }: { colour: string; dashed?: boolean; label: string }) {
  return <span className="flex items-center gap-2"><span className={`h-0.5 w-5 ${dashed ? "border-t-2 border-dashed" : ""}`} style={dashed ? { borderColor: colour } : { backgroundColor: colour }} />{label}</span>;
}

function PlaceholderMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-slate-50 p-3"><span className="block text-xs text-slate-500">{label}</span><strong className="mt-1 block text-sm text-slate-950">{value}</strong></div>;
}

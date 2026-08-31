import {
  BadgeCheck,
  BookOpenText,
  DatabaseZap,
  FileKey2,
  FileSpreadsheet,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiWorkspaceReadinessContract } from "@/features/ci/api/ci-workspace-readiness";
import { CiCatalogWorkspace } from "@/features/ci/ci-financial-workspace";

export function CiGettingStarted({ readiness }: { readiness: CiWorkspaceReadinessContract }) {
  const evidenceReady = readiness.availability === "evidence_limited";
  const [catalogOpen, setCatalogOpen] = useState(false);
  return (
    <section className="scroll-mt-20 space-y-4" id="configuration">
      <div className="premium-section-heading">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Workspace preparation</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold">Configure once, then analyse</h2>
          <Badge variant={evidenceReady ? "secondary" : "warning"}>{evidenceReady ? "Evidence configured" : "Evidence required"}</Badge>
        </div>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          Pricing can be prepared now. Physical and tariff analysis opens only when the private evidence directory contains a validated profile.
        </p>
      </div>

      <details className="group rounded-xl border border-border bg-white" open={!evidenceReady}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
          <span className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><BookOpenText className="size-4" /></span>
            <span><strong className="block">How to use this workspace</strong><span className="mt-0.5 block text-xs text-muted-foreground">From private evidence setup to internal report</span></span>
          </span>
          <span className="text-xs font-semibold text-cyan-800 group-open:hidden">Open guide</span>
          <span className="hidden text-xs font-semibold text-cyan-800 group-open:inline">Hide guide</span>
        </summary>
        <div className="border-t border-border p-5">
          <div className="grid gap-3 lg:grid-cols-4">
            <GuideStep icon={FileKey2} number="01" title="Mount private evidence">
              Put <code>active-tariff-profile.json</code> in a private directory and start Docker with <code>CI_EVIDENCE_ROOT</code> pointing to that directory.
            </GuideStep>
            <GuideStep icon={FileSpreadsheet} number="02" title="Upload matched NEM12">
              Setup accepts either standard NEM12 with E1 or the 30-minute wide export containing NMI, ReadingDateTime and kW/kVA. Formal kVA, power-factor, export, tariff and finance analysis still requires the exact profile-bound five-minute NEM12 with aligned E1, B1, Q1 and K1 streams under 25 MB.
            </GuideStep>
            <GuideStep icon={DatabaseZap} number="03" title="Design & price systems">
              Configure PV and battery ranges, publish a reviewed price catalog, then run the valid PV × battery combinations through Python.
            </GuideStep>
            <GuideStep icon={PlayCircle} number="04" title="Review & report">
              Compare returned physical and financial facts, explicitly pair the three cases, then prepare the private internal-review PDF.
            </GuideStep>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><div><strong>Why analysis can remain locked</strong><p className="mt-1 leading-6 text-amber-900/80">The profile validates tariff structure, rates, evidence identity, periods and bill reconciliation. A blank or guessed tariff is intentionally rejected.</p></div></div>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
              <div className="flex items-start gap-3"><BadgeCheck className="mt-0.5 size-4 shrink-0" /><div><strong>What is safe to configure now</strong><p className="mt-1 leading-6 text-emerald-900/80">The component and pricing catalog is independent of the private NEM12 upload and can be prepared before the evidence gate opens.</p></div></div>
            </div>
          </div>
        </div>
      </details>

      <details
        className="group rounded-xl border border-border bg-white"
        id="catalog"
        onToggle={(event) => setCatalogOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
          <span className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-violet-50 text-violet-800"><DatabaseZap className="size-4" /></span>
            <span><strong className="block">Component &amp; pricing catalog</strong><span className="mt-0.5 block text-xs text-muted-foreground">Maintain governed products, installation costs and size-cost curves before running scenarios</span></span>
          </span>
          <span className="text-xs font-semibold text-violet-800 group-open:hidden">Open catalog</span>
          <span className="hidden text-xs font-semibold text-violet-800 group-open:inline">Hide catalog</span>
        </summary>
        <div className="border-t border-border p-4 sm:p-5">
          {catalogOpen ? <CiCatalogWorkspace /> : <p className="text-sm text-muted-foreground">Open this section to load the governed catalog.</p>}
        </div>
      </details>
    </section>
  );
}

function GuideStep({ children, icon: Icon, number, title }: { children: ReactNode; icon: typeof FileKey2; number: string; title: string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-9 place-items-center rounded-xl bg-white text-cyan-800 shadow-sm"><Icon className="size-4" /></span>
        <span className="text-[10px] font-semibold tracking-[0.18em] text-slate-400">{number}</span>
      </div>
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">{children}</p>
    </article>
  );
}

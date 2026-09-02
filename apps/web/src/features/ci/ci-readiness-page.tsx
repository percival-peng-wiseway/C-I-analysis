import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, BadgeDollarSign, Layers3, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ciProjectsQueryKey,
  ciSavedDesignQueryKey,
  fetchCiSavedDesign,
  generateCiDesignCandidates,
  listCiProjects,
  type CiDesignCandidateResult,
  type CiProject,
} from "@/features/ci/api/ci-projects";
import {
  ciDeviceProfileQueryKey,
  fetchCiDeviceProfile,
} from "@/features/ci/api/ci-device-profile";
import {
  ciProjectEvidenceQueryKey,
  fetchCiProjectEvidence,
} from "@/features/ci/api/ci-evidence-intake";
import {
  ciSavedFeasibilityQueryKey,
  fetchCiSavedFeasibility,
  runCiDesignFeasibility,
  type CiSavedFeasibilityState,
} from "@/features/ci/api/ci-design-feasibility";
import {
  ciDesignPricePreviewQueryKey,
  fetchCiDesignPricePreview,
  type CiDesignPricePreview,
} from "@/features/ci/api/ci-design-price-preview";
import {
  ciAnnualFinancialComparisonQueryKey,
  compareCiAnnualFinancialScenarios,
} from "@/features/ci/api/ci-annual-financial-comparison";
import {
  ciProjectTariffReplayQueryKey,
  runCiProjectTariffReplay,
} from "@/features/ci/api/ci-scenarios";
import {
  ciWorkspaceReadinessQueryKey,
  fetchCiWorkspaceReadiness,
} from "@/features/ci/api/ci-workspace-readiness";
import { CiDesignFeasibility } from "@/features/ci/ci-design-feasibility";
import { CiEvidenceIntake } from "@/features/ci/ci-evidence-intake";
import { CiRebateProfilePanel } from "@/features/ci/ci-rebate-profile-panel";
import { CiScenarioBuilder } from "@/features/ci/ci-scenario-builder";
import { CiTariffReplay } from "@/features/ci/ci-tariff-replay";
import { useCiWorkspace, type CiWorkspaceStage } from "@/features/ci/ci-workspace-context";
import { ModulePrerequisite } from "@/features/ci/ci-workflow-template";

export function CiReadinessPage() {
  const queryClient = useQueryClient();
  const workspace = useCiWorkspace();
  const readiness = useQuery({ queryKey: ciWorkspaceReadinessQueryKey, queryFn: () => fetchCiWorkspaceReadiness() });
  const projects = useQuery({ queryKey: ciProjectsQueryKey, queryFn: () => listCiProjects() });

  if (readiness.isPending || projects.isPending) {
    return <PageState title="Preparing project workflow" description="Loading project records and the four-module workspace." />;
  }
  if (readiness.isError || projects.isError) {
    return <PageState title="Workspace unavailable" description="The project workflow could not be loaded. Check that the C&I API and database are running." />;
  }

  const activeProject = projects.data.find((project) => project.project_id === workspace.activeProject?.projectId) ?? null;
  if (!activeProject) {
    return <PageState title="Select a project" description="Choose a project from the left or create a new project to open the four-module workflow." />;
  }
  return (
    <main className="premium-page ci-workbench-page min-h-screen bg-background p-4 sm:p-6 xl:p-8">
      <div className="premium-content mx-auto flex w-full max-w-[1460px] flex-col gap-6">
        {workspace.stage === "evidence" ? (
          <EvidenceWorkspace
            key={activeProject.project_id}
            onReady={() => {
              queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => current.map((item) => item.project_id === activeProject.project_id ? { ...item, setup_status: "ready", current_stage: "system_design", updated_at: new Date().toISOString() } : item));
              void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
              workspace.openProjectStage({ ...toActiveProject(activeProject), setupReady: true }, "evidence");
            }}
            project={activeProject}
          />
        ) : workspace.stage === "physical_feasibility" ? (
          <PhysicalFeasibilityWorkspace
            key={activeProject.project_id}
            onBack={() => workspace.setStage("evidence")}
            onAnalysisComplete={() => workspace.setStage("tariff_replay")}
            onValidated={(candidateCount) => {
              queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => current.map((item) => item.project_id === activeProject.project_id ? { ...item, current_stage: "system_design", design_status: "ready", design_candidate_count: candidateCount, updated_at: new Date().toISOString() } : item));
              workspace.openProjectStage({ ...toActiveProject(activeProject), designReady: true }, "physical_feasibility");
              void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
            }}
            project={activeProject}
          />
        ) : workspace.stage === "dispatch" ? (
          <DispatchWorkspace key={activeProject.project_id} project={activeProject} />
        ) : (
          <CiTariffReplay
            key={activeProject.project_id}
            onConfigureRebates={() => {
              workspace.setStage("physical_feasibility");
              window.setTimeout(() => {
                const heading = document.getElementById("rebate-profile-title");
                heading?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                heading?.focus();
              }, 0);
            }}
            onConfigureTariff={() => workspace.setStage("evidence")}
            project={activeProject}
          />
        )}
        <ModulePager onNavigate={workspace.setStage} stage={workspace.stage} />
      </div>
    </main>
  );
}

function EvidenceWorkspace({ onReady, project }: { onReady: () => void; project: CiProject }) {
  return <CiEvidenceIntake onReady={onReady} projectId={project.project_id} setupReady={project.setup_status === "ready"} />;
}

function PhysicalFeasibilityWorkspace({ onAnalysisComplete, onBack, onValidated, project }: { onAnalysisComplete: () => void; onBack: () => void; onValidated: (candidateCount: number) => void; project: CiProject }) {
  const queryClient = useQueryClient();
  const savedDesign = useQuery({ queryKey: ciSavedDesignQueryKey(project.project_id), queryFn: () => fetchCiSavedDesign(project.project_id) });
  const evidence = useQuery({ queryKey: ciProjectEvidenceQueryKey(project.project_id), queryFn: () => fetchCiProjectEvidence(project.project_id) });
  const deviceProfile = useQuery({ queryKey: ciDeviceProfileQueryKey, queryFn: () => fetchCiDeviceProfile() });
  const run = useMutation({
    mutationFn: (request: Parameters<typeof generateCiDesignCandidates>[1]) => generateCiDesignCandidates(project.project_id, request),
    onSuccess: (design) => {
      queryClient.setQueryData(ciSavedDesignQueryKey(project.project_id), design);
      onValidated(design.candidate_count);
      void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ciSavedFeasibilityQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciDesignPricePreviewQueryKey(project.project_id) });
    },
  });
  const generatedDesign = run.data ?? savedDesign.data;
  const pricePreview = useQuery({
    queryKey: ciDesignPricePreviewQueryKey(project.project_id),
    queryFn: () => fetchCiDesignPricePreview(project.project_id),
    enabled: Boolean(generatedDesign),
    retry: false,
  });
  const [quotedNetCapex, setQuotedNetCapex] = useState<Record<string, string>>({});
  const quoteRevision = pricePreview.data
    ? `${pricePreview.data.device_profile_sha256}:${pricePreview.data.rebate_profile_sha256 ?? "none"}:${pricePreview.data.solutions.map((solution) => `${solution.scenario_id}:${solution.net_capex_aud_ex_gst}`).join("|")}`
    : "";
  useEffect(() => {
    if (!pricePreview.data) return;
    setQuotedNetCapex(Object.fromEntries(pricePreview.data.solutions.map((solution) => [solution.scenario_id, String(solution.net_capex_aud_ex_gst)])));
  }, [quoteRevision]);
  const analyze = useMutation({
    mutationFn: async () => {
      if (!pricePreview.data) throw new Error("Calculate Net CAPEX before starting analysis.");
      const prices = pricePreview.data.solutions.map((solution) => ({
        scenarioId: solution.scenario_id,
        upfrontCostAudExGst: Number(quotedNetCapex[solution.scenario_id]),
      }));
      if (prices.some((item) => !Number.isFinite(item.upfrontCostAudExGst) || item.upfrontCostAudExGst <= 0)) {
        throw new Error("Every feasible solution needs a positive Net CAPEX quotation.");
      }
      const feasibilityResult = await runCiDesignFeasibility(project.project_id);
      const tariffResult = await runCiProjectTariffReplay(project.project_id);
      const financeResult = await compareCiAnnualFinancialScenarios({
        projectId: project.project_id,
        pricingMode: "manual_quotes",
        prices,
      });
      return { feasibilityResult, tariffResult, financeResult };
    },
    onSuccess: ({ feasibilityResult, financeResult, tariffResult }) => {
      queryClient.setQueryData<CiSavedFeasibilityState>(ciSavedFeasibilityQueryKey(project.project_id), { contract_version: "ci_project_feasibility_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: feasibilityResult });
      queryClient.setQueryData(ciProjectTariffReplayQueryKey(project.project_id), { contract_version: "ci_project_tariff_replay_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: tariffResult });
      queryClient.setQueryData(ciAnnualFinancialComparisonQueryKey(project.project_id), { contract_version: "ci_project_annual_financial_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: financeResult });
      onAnalysisComplete();
    },
  });
  if (project.setup_status !== "ready") {
    return <ModulePrerequisite description="Complete Evidence, then confirm the site-resource assumptions and choose published Solar and Battery profiles." project={project} stage="02" title="Physical feasibility" />;
  }
  if (savedDesign.isPending || evidence.isPending || deviceProfile.isPending) return <PageState title="Loading solution generator" description="Restoring the site evidence, profile library and saved solution search space." />;
  if (savedDesign.isError || evidence.isError || deviceProfile.isError) return <Card><CardHeader><CardTitle as="h2" className="text-xl">Physical feasibility unavailable</CardTitle><CardDescription>The site evidence, profiles or saved technical design could not be loaded safely.</CardDescription></CardHeader><CardContent><Button onClick={onBack} type="button">Return to Evidence</Button></CardContent></Card>;
  const activeDeviceProfile = deviceProfile.data.profile ?? deviceProfile.data.suggested_profile;
  const siteAddress = evidence.data.status === "saved" ? evidence.data.evidence?.inspection.bill.site_address ?? null : null;
  return (
    <CiScenarioBuilder
      beforeConnectionConstraints={<div className="space-y-6"><CiRebateProfilePanel projectId={project.project_id} />{generatedDesign ? <GeneratedDesignSummary design={generatedDesign} /> : null}{generatedDesign ? <GeneratedSolutionQuotes analysisError={analyze.error instanceof Error ? analyze.error.message : null} isAnalysing={analyze.isPending} isLoading={pricePreview.isPending} onAnalyze={() => analyze.mutate()} onQuoteChange={(scenarioId, value) => { analyze.reset(); setQuotedNetCapex((current) => ({ ...current, [scenarioId]: value })); }} onRetry={() => { void pricePreview.refetch(); }} preview={pricePreview.data ?? null} previewError={pricePreview.error instanceof Error ? pricePreview.error.message : null} quotes={quotedNetCapex} /> : null}</div>}
      deviceProfile={activeDeviceProfile}
      error={run.error instanceof Error ? run.error.message : null}
      initialContext={run.data?.design_context ?? savedDesign.data?.design_context ?? undefined}
      initialSolutions={run.data?.candidates ?? savedDesign.data?.candidates}
      isPending={run.isPending}
      onSubmit={(request) => run.mutate(request)}
      siteAddress={siteAddress}
    />
  );
}

function GeneratedDesignSummary({ design }: { design: CiDesignCandidateResult }) {
  const pv = design.candidates.map((item) => item.pv_capacity_kwp_dc);
  const battery = design.candidates.map((item) => item.nominal_capacity_kwh);
  const inverter = design.candidates.map((item) => item.pv_inverter_capacity_kw_ac);
  return (
    <section aria-label="Generated solution summary" className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-emerald-600 text-white"><Layers3 className="size-5" /></span>
          <h2 className="font-semibold text-emerald-950">{design.candidate_count} feasible solutions generated</h2>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800">Ready for 03 + 04</span>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <RangeSummary label="Added PV" unit="kWp" values={pv} />
        <RangeSummary label="Added battery" unit="kWh" values={battery} />
        <RangeSummary label="Hybrid inverter / PCS" unit="kW AC" values={inverter} />
      </dl>
      {design.generation_summary ? <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-emerald-200 bg-white/80 px-4 py-2 text-xs text-emerald-950"><span>{design.generation_summary.requested_count} requested</span><span>{design.generation_summary.deduplicated_count} duplicate sizes removed</span><span>{design.generation_summary.rejected_count} rejected by profile or site constraints</span></div> : null}
    </section>
  );
}

function GeneratedSolutionQuotes({ analysisError, isAnalysing, isLoading, onAnalyze, onQuoteChange, onRetry, preview, previewError, quotes }: {
  analysisError: string | null;
  isAnalysing: boolean;
  isLoading: boolean;
  onAnalyze: () => void;
  onQuoteChange: (scenarioId: string, value: string) => void;
  onRetry: () => void;
  preview: CiDesignPricePreview | null;
  previewError: string | null;
  quotes: Record<string, string>;
}) {
  if (isLoading) return <section className="rounded-xl border border-slate-200 bg-white p-6"><p className="flex items-center gap-2 text-sm text-slate-600"><RefreshCw className="size-4 animate-spin" />Calculating Net CAPEX for every feasible solution…</p></section>;
  if (previewError || !preview) return <section className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-950">Net CAPEX is not ready</h2><p className="mt-1 text-sm leading-6 text-amber-900">{previewError ?? "Save the equipment and rebate assumptions, then try again."}</p><Button className="mt-4" onClick={onRetry} type="button" variant="outline"><RefreshCw className="size-4" />Retry pricing</Button></section>;
  const validQuotes = preview.solutions.every((solution) => {
    const value = Number(quotes[solution.scenario_id]);
    return Number.isFinite(value) && value > 0;
  });
  return (
    <section aria-labelledby="generated-solution-quotes-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5 sm:p-6">
        <div className="flex items-start gap-3"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><BadgeDollarSign className="size-5" /></span><div><h2 className="text-xl font-semibold text-slate-950" id="generated-solution-quotes-title">Feasible solutions &amp; Net CAPEX quotations</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">Python calculated the default Net CAPEX from the saved equipment catalog less approved upfront rebates. Edit the quotation column when the offered price is different.</p></div></div>
        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{preview.candidate_count} feasible</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Solution</th><th className="px-4 py-3">PV</th><th className="px-4 py-3">Battery</th><th className="px-4 py-3">PCS</th><th className="px-4 py-3 text-right">Gross CAPEX</th><th className="px-4 py-3 text-right">Upfront rebates</th><th className="px-4 py-3 text-right">Model Net CAPEX</th><th className="px-4 py-3">Quoted Net CAPEX (ex GST)</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{preview.solutions.map((solution, index) => <tr key={solution.scenario_id}><td className="px-4 py-3"><strong className="text-slate-900">Solution {index + 1}</strong><span className="mt-0.5 block max-w-[190px] truncate text-xs text-slate-500">{solution.label}</span></td><td className="px-4 py-3 tabular-nums">{numberLabel(solution.pv_capacity_kwp_dc)} kWp</td><td className="px-4 py-3 tabular-nums">{numberLabel(solution.battery_capacity_kwh)} kWh</td><td className="px-4 py-3 tabular-nums">{numberLabel(solution.inverter_capacity_kw_ac)} kW</td><td className="px-4 py-3 text-right tabular-nums">{aud(solution.gross_capex_aud_ex_gst)}</td><td className="px-4 py-3 text-right tabular-nums text-emerald-700">−{aud(solution.upfront_rebate_aud_ex_gst)}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{aud(solution.net_capex_aud_ex_gst)}</td><td className="px-4 py-3"><div className="relative"><span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">$</span><input aria-label={`Quoted Net CAPEX for Solution ${index + 1}`} className="h-10 w-full rounded-md border border-slate-300 bg-white pl-7 pr-3 tabular-nums outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" min="0.01" onChange={(event) => onQuoteChange(solution.scenario_id, event.target.value)} step="0.01" type="number" value={quotes[solution.scenario_id] ?? ""} /></div></td></tr>)}</tbody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 bg-slate-50/60 p-5"><div className="max-w-3xl text-xs leading-5 text-slate-600"><strong className="text-slate-800">Quotation basis:</strong> the entered value replaces modelled Net CAPEX; rebates are not deducted a second time. One click runs 03 Dispatch, then 04 tariff replay and Finance using the same saved scenarios.</div><Button disabled={!validQuotes || isAnalysing} onClick={onAnalyze} type="button">{isAnalysing ? <RefreshCw className="size-4 animate-spin" /> : <Play className="size-4" />}{isAnalysing ? "Running 03 + 04…" : "Start analysis · run 03 + 04"}</Button></footer>
      {analysisError ? <p className="border-t border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800" role="alert">{analysisError}</p> : null}
    </section>
  );
}

function RangeSummary({ label, unit, values }: { label: string; unit: string; values: number[] }) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return <div className="rounded-lg bg-white px-4 py-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 font-semibold tabular-nums text-slate-950">{numberLabel(minimum)}–{numberLabel(maximum)} {unit}</dd></div>;
}

function DispatchWorkspace({ project }: { project: CiProject }) {
  const queryClient = useQueryClient();
  const savedDesign = useQuery({ queryKey: ciSavedDesignQueryKey(project.project_id), queryFn: () => fetchCiSavedDesign(project.project_id) });
  const savedFeasibility = useQuery({ queryKey: ciSavedFeasibilityQueryKey(project.project_id), queryFn: () => fetchCiSavedFeasibility(project.project_id) });
  const run = useMutation({
    mutationFn: () => runCiDesignFeasibility(project.project_id),
    onSuccess: (analysis) => queryClient.setQueryData<CiSavedFeasibilityState>(ciSavedFeasibilityQueryKey(project.project_id), { contract_version: "ci_project_feasibility_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: analysis }),
  });
  if (project.design_status !== "ready") {
    return <ModulePrerequisite description="Generate and save the PV and battery solution space in Physical feasibility before running interval dispatch." project={project} stage="03" title="Dispatch" />;
  }
  if (savedDesign.isPending || savedFeasibility.isPending) return <PageState title="Loading dispatch workspace" description="Restoring the generated scenarios and any saved simulation results." />;
  if (savedDesign.isError || !savedDesign.data) return <ModulePrerequisite description="The generated solution space could not be restored. Return to Physical feasibility and generate it again." project={project} stage="03" title="Dispatch" />;
  const analysis = run.data ?? (savedFeasibility.data?.status === "ready" ? savedFeasibility.data.result : null);
  const needsRun = !analysis;
  return (
    <section aria-labelledby="dispatch-workspace-title" className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Activity className="size-5" /></span>
          <h1 className="text-xl font-semibold text-slate-950" id="dispatch-workspace-title">Scenario dispatch analysis</h1>
        </div>
        <Button disabled={run.isPending} onClick={() => run.mutate()} type="button">
          {run.isPending ? <RefreshCw className="size-4 animate-spin" /> : analysis ? <RefreshCw className="size-4" /> : <Play className="size-4" />}
          {run.isPending ? `Analysing ${savedDesign.data.candidate_count} solutions…` : analysis ? "Re-run all solutions" : `Run ${savedDesign.data.candidate_count} solutions`}
        </Button>
      </header>
      {run.error ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{run.error instanceof Error ? run.error.message : "Dispatch analysis failed."}</p> : null}
      {savedFeasibility.data?.status === "stale" && !run.data ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The saved dispatch result is out of date because the design or interval evidence changed. Run all solutions again.</p> : null}
      {needsRun ? <DispatchReadyState design={savedDesign.data} /> : <CiDesignFeasibility projectId={project.project_id} result={analysis} />}
    </section>
  );
}

function DispatchReadyState({ design }: { design: CiDesignCandidateResult }) {
  return (
    <section className="grid overflow-hidden rounded-xl border border-slate-200 bg-white xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50/70 p-4 xl:border-b-0 xl:border-r">
        <p className="text-xs font-semibold uppercase tracking-[.14em] text-slate-500">Generated solutions</p>
        <div className="mt-3 max-h-[540px] space-y-2 overflow-y-auto pr-1">
          {design.candidates.map((scenario, index) => <div className="rounded-lg border border-slate-200 bg-white p-3" key={scenario.scenario_id}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-slate-900">Solution {index + 1}</strong><span className="text-[11px] text-slate-400">Not run</span></div><p className="mt-1 text-xs tabular-nums text-slate-600">{numberLabel(scenario.pv_capacity_kwp_dc)} kWp PV · {numberLabel(scenario.nominal_capacity_kwh)} kWh battery</p><p className="mt-0.5 text-[11px] text-slate-500">{numberLabel(scenario.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS</p></div>)}
        </div>
      </aside>
      <div className="grid min-h-[540px] place-items-center p-8 text-center"><div className="max-w-md"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-cyan-50 text-cyan-800"><Play className="size-6" /></span><h2 className="mt-5 text-xl font-semibold text-slate-950">Ready to simulate every solution</h2><p className="mt-2 text-sm leading-6 text-slate-500">The run creates peak-shaving, interval activity, solar flow, battery SOC and peak-event results for each generated scenario. Tariff and financial calculations remain in later modules.</p></div></div>
    </section>
  );
}

function PageState({ description, title }: { description: string; title: string }) {
  return <main className="p-8"><Card className="mx-auto max-w-xl"><CardHeader><CardTitle as="h2" className="text-xl">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card></main>;
}

const moduleStages: Array<{ label: string; stage: CiWorkspaceStage }> = [
  { label: "Evidence", stage: "evidence" },
  { label: "Solution Generator", stage: "physical_feasibility" },
  { label: "Scenario Analysis", stage: "dispatch" },
  { label: "Finance Analysis", stage: "tariff_replay" },
];

function ModulePager({ onNavigate, stage }: { onNavigate: (stage: CiWorkspaceStage) => void; stage: CiWorkspaceStage }) {
  const currentIndex = moduleStages.findIndex((item) => item.stage === stage);
  const previous = currentIndex > 0 ? moduleStages[currentIndex - 1] : null;
  const next = currentIndex < moduleStages.length - 1 ? moduleStages[currentIndex + 1] : null;
  return (
    <nav aria-label="Adjacent analysis modules" className="mt-2 flex items-center justify-between border-t border-slate-200 pt-5">
      <div>{previous ? <Button aria-label={`Previous: ${previous.label}`} onClick={() => onNavigate(previous.stage)} type="button" variant="outline"><ArrowLeft className="size-4" />{previous.label}</Button> : null}</div>
      <div>{next ? <Button aria-label={`Next: ${next.label}`} onClick={() => onNavigate(next.stage)} type="button">{next.label}<ArrowRight className="size-4" /></Button> : null}</div>
    </nav>
  );
}

function toActiveProject(project: CiProject) {
  return { projectId: project.project_id, displayName: project.display_name, setupReady: project.setup_status === "ready", designReady: project.design_status === "ready" };
}

function numberLabel(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value);
}

function aud(value: number) {
  return new Intl.NumberFormat("en-AU", { currency: "AUD", maximumFractionDigits: 0, style: "currency" }).format(value);
}

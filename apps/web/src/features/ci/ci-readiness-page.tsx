import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, Play, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { invalidateCiCalculationHandbook } from "@/features/ci/api/ci-calculation-handbook";
import {
  ciProjectsQueryKey,
  ciSavedDesignQueryKey,
  addCiCustomDesignCandidate,
  fetchCiSavedDesign,
  generateCiDesignCandidates,
  listCiProjects,
  type CiCustomDesignCandidateRequest,
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
import { ciProjectRebateProfileQueryKey } from "@/features/ci/api/ci-rebate-profile";
import {
  ciAnnualFinancialComparisonQueryKey,
  compareCiAnnualFinancialScenarios,
} from "@/features/ci/api/ci-annual-financial-comparison";
import {
  ciProjectTariffReplayQueryKey,
  fetchCiSavedTariffReplay,
  runCiProjectTariffReplay,
  selectCiTariffReplayScenarios,
} from "@/features/ci/api/ci-scenarios";
import {
  ciWorkspaceReadinessQueryKey,
  fetchCiWorkspaceReadiness,
} from "@/features/ci/api/ci-workspace-readiness";
import { CiDesignFeasibility } from "@/features/ci/ci-design-feasibility";
import { CiEvidenceIntake } from "@/features/ci/ci-evidence-intake";
import { CiRebateProfilePanel, type CiRebateProfilePanelHandle } from "@/features/ci/ci-rebate-profile-panel";
import { CiScenarioBuilder } from "@/features/ci/ci-scenario-builder";
import {
  CI_ANALYSIS_MUTATION_KEY,
  CiTariffReplay,
  formatCiTariffReplayProgressLabel,
} from "@/features/ci/ci-tariff-replay";
import {
  ciAnalysisPriceSnapshotMatchesPreview,
  ciDesignPricePreviewRevision,
  clearCiSolutionWorkspaceDraft,
  loadCiSolutionWorkspaceDraft,
  restoreCiAnalysisPriceSnapshot,
  saveCiSolutionWorkspaceDraft,
  type CiAnalysisPriceSnapshot,
} from "@/features/ci/ci-solution-workspace-storage";
import { useCiWorkspace, type CiWorkspaceStage } from "@/features/ci/ci-workspace-context";
import { ModulePrerequisite } from "@/features/ci/ci-workflow-template";

export function CiReadinessPage() {
  const queryClient = useQueryClient();
  const workspace = useCiWorkspace();
  const activeAnalysisCount = useIsMutating({ mutationKey: CI_ANALYSIS_MUTATION_KEY });
  const analysisBusy = activeAnalysisCount > 0;
  const readiness = useQuery({ queryKey: ciWorkspaceReadinessQueryKey, queryFn: () => fetchCiWorkspaceReadiness() });
  const projects = useQuery({ queryKey: ciProjectsQueryKey, queryFn: () => listCiProjects() });
  const [analysisLaunch, setAnalysisLaunch] = useState<AnalysisLaunch | null>(null);
  const [analysisSnapshotsByProject, setAnalysisSnapshotsByProject] = useState<Record<string, CiAnalysisPriceSnapshot>>({});
  const analysisLaunchSequence = useRef(0);
  const claimedAnalysisLaunches = useRef(new Set<number>());
  const setProjectAnalysisSnapshot = useCallback((projectId: string, snapshot: CiAnalysisPriceSnapshot | null) => {
    setAnalysisSnapshotsByProject((current) => {
      if (snapshot) return { ...current, [projectId]: snapshot };
      if (!Object.hasOwn(current, projectId)) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    if (!snapshot) {
      setAnalysisLaunch((current) => current?.projectId === projectId ? null : current);
    }
  }, []);
  const claimAnalysisLaunch = useCallback((launchId: number) => {
    if (claimedAnalysisLaunches.current.has(launchId)) return false;
    claimedAnalysisLaunches.current.add(launchId);
    setAnalysisLaunch((current) => current?.launchId === launchId ? null : current);
    return true;
  }, []);
  const fullAnalysis = useFullAnalysisRunner(setProjectAnalysisSnapshot);

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
    <main className="premium-page ci-workbench-page min-h-[100dvh] bg-background p-4 sm:p-6 xl:p-8" id="analysis-content" tabIndex={-1}>
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
            analysisPending={analysisBusy}
            key={activeProject.project_id}
            onBack={() => workspace.setStage("evidence")}
            onAnalysisStart={(snapshot) => {
              if (analysisBusy || fullAnalysis.isBusy()) return false;
              setProjectAnalysisSnapshot(activeProject.project_id, snapshot);
              analysisLaunchSequence.current += 1;
              setAnalysisLaunch({ launchId: analysisLaunchSequence.current, projectId: activeProject.project_id, snapshot });
              workspace.setStage("dispatch");
              return true;
            }}
            onValidated={(candidateCount) => {
              setProjectAnalysisSnapshot(activeProject.project_id, null);
              queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => current.map((item) => item.project_id === activeProject.project_id ? { ...item, current_stage: "system_design", design_status: "ready", design_candidate_count: candidateCount, updated_at: new Date().toISOString() } : item));
              workspace.openProjectStage({ ...toActiveProject(activeProject), designReady: true }, "physical_feasibility");
              void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
            }}
            project={activeProject}
          />
        ) : workspace.stage === "dispatch" ? (
          <DispatchWorkspace
            analysisBusy={analysisBusy}
            analysisLaunch={analysisLaunch?.projectId === activeProject.project_id ? analysisLaunch : null}
            analysisSnapshot={analysisSnapshotsByProject[activeProject.project_id] ?? null}
            claimAnalysisLaunch={claimAnalysisLaunch}
            fullAnalysis={fullAnalysis}
            key={activeProject.project_id}
            onAnalysisSnapshotChange={setProjectAnalysisSnapshot}
            project={activeProject}
          />
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

type AnalysisLaunch = { launchId: number; projectId: string; snapshot: CiAnalysisPriceSnapshot };

function PhysicalFeasibilityWorkspace({ analysisPending, onAnalysisStart, onBack, onValidated, project }: { analysisPending: boolean; onAnalysisStart: (snapshot: CiAnalysisPriceSnapshot) => boolean; onBack: () => void; onValidated: (candidateCount: number) => void; project: CiProject }) {
  const queryClient = useQueryClient();
  const stcSettingsRef = useRef<CiRebateProfilePanelHandle>(null);
  const savedDesign = useQuery({ queryKey: ciSavedDesignQueryKey(project.project_id), queryFn: () => fetchCiSavedDesign(project.project_id) });
  const evidence = useQuery({ queryKey: ciProjectEvidenceQueryKey(project.project_id), queryFn: () => fetchCiProjectEvidence(project.project_id) });
  const deviceProfile = useQuery({ queryKey: ciDeviceProfileQueryKey, queryFn: () => fetchCiDeviceProfile() });
  const [quotedNetCapex, setQuotedNetCapex] = useState<Record<string, string>>({});
  const [selectedSolutions, setSelectedSolutions] = useState<Record<string, boolean>>({});
  const [generationRevision, setGenerationRevision] = useState(0);
  const [hydratedQuoteRevision, setHydratedQuoteRevision] = useState("");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async (request: Parameters<typeof generateCiDesignCandidates>[1]) => {
      if (!stcSettingsRef.current) {
        throw new Error("The project STC settings are not ready yet.");
      }
      return generateCiDesignCandidates(
        project.project_id,
        request,
        stcSettingsRef.current.settingsForGeneration(),
      );
    },
    onSuccess: (design) => {
      clearCiSolutionWorkspaceDraft(project.project_id);
      setQuotedNetCapex({});
      setSelectedSolutions({});
      setHydratedQuoteRevision("");
      setGenerationRevision((current) => current + 1);
      queryClient.setQueryData(ciSavedDesignQueryKey(project.project_id), design);
      onValidated(design.candidate_count);
      void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ciSavedFeasibilityQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciProjectTariffReplayQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciAnnualFinancialComparisonQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciProjectRebateProfileQueryKey(project.project_id) });
      void queryClient.resetQueries({
        exact: true,
        queryKey: ciDesignPricePreviewQueryKey(project.project_id),
      });
      void invalidateCiCalculationHandbook(queryClient, project.project_id);
    },
  });
  const generatedDesign = savedDesign.data;
  const pricePreview = useQuery({
    queryKey: ciDesignPricePreviewQueryKey(project.project_id),
    queryFn: () => fetchCiDesignPricePreview(project.project_id),
    enabled: Boolean(generatedDesign),
    retry: false,
  });
  const quoteRevision = pricePreview.data ? ciDesignPricePreviewRevision(pricePreview.data) : "";
  const hydrationKey = quoteRevision ? `${generationRevision}:${quoteRevision}` : "";
  useEffect(() => {
    if (!pricePreview.data || !hydrationKey || hydratedQuoteRevision === hydrationKey) return;
    const persisted = loadCiSolutionWorkspaceDraft(project.project_id);
    const previewScenarioIds = pricePreview.data.solutions.map((solution) => solution.scenario_id);
    const persistedMatches = persisted?.previewRevision === quoteRevision
      && previewScenarioIds.every((scenarioId) => (
        Object.hasOwn(persisted.quotedNetCapex, scenarioId)
        && Object.hasOwn(persisted.selectedSolutions, scenarioId)
      ));
    setQuotedNetCapex((current) => Object.fromEntries(pricePreview.data.solutions.map((solution) => [
      solution.scenario_id,
      persistedMatches
        ? persisted.quotedNetCapex[solution.scenario_id]
        : current[solution.scenario_id] ?? String(solution.net_capex_aud_ex_gst),
    ])));
    setSelectedSolutions((current) => Object.fromEntries(
      pricePreview.data.solutions.map((solution) => [
        solution.scenario_id,
        persistedMatches ? persisted.selectedSolutions[solution.scenario_id] : current[solution.scenario_id] ?? true,
      ]),
    ));
    setHydratedQuoteRevision(hydrationKey);
  }, [hydratedQuoteRevision, hydrationKey, pricePreview.data, project.project_id, quoteRevision]);
  useEffect(() => {
    if (!pricePreview.data || hydratedQuoteRevision !== hydrationKey) return;
    const scenarioIds = new Set(pricePreview.data.solutions.map((solution) => solution.scenario_id));
    saveCiSolutionWorkspaceDraft(project.project_id, {
      previewRevision: quoteRevision,
      quotedNetCapex: Object.fromEntries(Object.entries(quotedNetCapex).filter(([scenarioId]) => scenarioIds.has(scenarioId))),
      selectedSolutions: Object.fromEntries(Object.entries(selectedSolutions).filter(([scenarioId]) => scenarioIds.has(scenarioId))),
    });
  }, [hydratedQuoteRevision, hydrationKey, pricePreview.data, project.project_id, quoteRevision, quotedNetCapex, selectedSolutions]);
  const addCustom = useMutation({
    mutationFn: (request: CiCustomDesignCandidateRequest) => {
      if (!stcSettingsRef.current) {
        throw new Error("The project STC settings are not ready yet.");
      }
      return addCiCustomDesignCandidate(
        project.project_id,
        request,
        stcSettingsRef.current.settingsForGeneration(),
      );
    },
    onSuccess: (design) => {
      setQuotedNetCapex((current) => ({ ...current, [design.added_scenario_id]: String(design.quoted_net_capex_aud_ex_gst) }));
      setSelectedSolutions((current) => ({ ...current, [design.added_scenario_id]: true }));
      queryClient.setQueryData(ciSavedDesignQueryKey(project.project_id), design);
      onValidated(design.candidate_count);
      void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ciSavedFeasibilityQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciProjectTariffReplayQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciAnnualFinancialComparisonQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciProjectRebateProfileQueryKey(project.project_id) });
      void queryClient.invalidateQueries({ queryKey: ciDesignPricePreviewQueryKey(project.project_id) });
      void invalidateCiCalculationHandbook(queryClient, project.project_id);
    },
  });
  const startAnalysis = () => {
    if (analysisPending) {
      setAnalysisError("A full analysis is already running.");
      return;
    }
    if (!pricePreview.data) {
      setAnalysisError("Calculate Net CAPEX before starting analysis.");
      return;
    }
    const prices = pricePreview.data.solutions.filter((solution) => selectedSolutions[solution.scenario_id]).map((solution) => ({
      scenarioId: solution.scenario_id,
      upfrontCostAudExGst: Number(quotedNetCapex[solution.scenario_id]),
    }));
    if (!prices.length) {
      setAnalysisError("Select at least one solution for analysis.");
      return;
    }
    if (prices.some((item) => !Number.isFinite(item.upfrontCostAudExGst) || item.upfrontCostAudExGst <= 0)) {
      setAnalysisError("Every feasible solution needs a positive Net CAPEX quotation.");
      return;
    }
    const started = onAnalysisStart({ previewRevision: quoteRevision, scenarioIds: prices.map((item) => item.scenarioId), prices });
    setAnalysisError(started ? null : "A full analysis is already running.");
  };
  if (project.setup_status !== "ready") {
    return <ModulePrerequisite description="Complete Evidence, then confirm the site-resource assumptions and choose published Solar and Battery profiles." project={project} title="Physical feasibility" />;
  }
  if (savedDesign.isPending || evidence.isPending || deviceProfile.isPending) return <PageState title="Loading solution generator" description="Restoring the site evidence, profile library and saved solution search space." />;
  if (savedDesign.isError || evidence.isError || deviceProfile.isError) {
    const loadErrors: Array<[string, unknown]> = [];
    if (savedDesign.isError) loadErrors.push(["Saved solutions", savedDesign.error]);
    if (evidence.isError) loadErrors.push(["Project evidence", evidence.error]);
    if (deviceProfile.isError) loadErrors.push(["Device profile", deviceProfile.error]);
    const retrying = savedDesign.isFetching || evidence.isFetching || deviceProfile.isFetching;
    return <Card><CardHeader><CardTitle as="h2" className="text-xl">Physical feasibility unavailable</CardTitle><CardDescription>The Solution Generator could not safely restore its saved inputs.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{loadErrors.map(([label, loadError]) => <p key={label}><strong>{label}:</strong> {loadError instanceof Error ? loadError.message : "Unknown loading error."}</p>)}</div><div className="flex flex-wrap gap-3"><Button disabled={retrying} onClick={() => { void Promise.all([savedDesign.refetch(), evidence.refetch(), deviceProfile.refetch()]); }} type="button">{retrying ? <RefreshCw className="size-4 animate-spin" /> : null}{retrying ? "Retrying…" : "Retry loading"}</Button><Button onClick={onBack} type="button" variant="outline">Return to Evidence</Button></div></CardContent></Card>;
  }
  const activeDeviceProfile = deviceProfile.data.profile ?? deviceProfile.data.suggested_profile;
  const siteAddress = evidence.data.status === "saved" ? evidence.data.evidence?.inspection.bill.site_address ?? null : null;
  return <div className="space-y-8">
    <CiScenarioBuilder
        deviceProfile={activeDeviceProfile}
        error={run.error instanceof Error ? run.error.message : null}
        initialContext={generatedDesign?.design_context ?? undefined}
        initialSolutions={generatedDesign?.candidates}
        isPending={run.isPending}
        onSubmit={(request) => run.mutate(request)}
        siteAddress={siteAddress}
        stcSettings={<CiRebateProfilePanel projectId={project.project_id} ref={stcSettingsRef} />}
      />
    {generatedDesign ? <GeneratedSolutionQuotes addCustomError={addCustom.error instanceof Error ? addCustom.error.message : null} analysisError={analysisError} analysisPending={analysisPending} generationSummary={generatedDesign.generation_summary ?? null} isAddingCustom={addCustom.isPending} isLoading={pricePreview.isPending || pricePreview.isFetching} onAddCustom={async (request) => { await addCustom.mutateAsync(request); }} onAnalyze={startAnalysis} onQuoteChange={(scenarioId, value) => { setAnalysisError(null); setQuotedNetCapex((current) => ({ ...current, [scenarioId]: value })); }} onRetry={() => { void pricePreview.refetch(); }} onSelectionChange={(scenarioId, selected) => { setAnalysisError(null); setSelectedSolutions((current) => ({ ...current, [scenarioId]: selected })); }} onSelectAll={(selected) => { setAnalysisError(null); setSelectedSolutions(Object.fromEntries((pricePreview.data?.solutions ?? []).map((solution) => [solution.scenario_id, selected]))); }} preview={pricePreview.data ?? null} previewError={pricePreview.error instanceof Error ? pricePreview.error.message : null} quotes={quotedNetCapex} selectedSolutions={selectedSolutions} siteAcHeadroomKw={generatedDesign.design_context?.technical_options.site_ac_headroom_kw ?? null} /> : null}
  </div>;
}

const MAX_DESIGN_SOLUTIONS = 200;

function GeneratedSolutionQuotes({ addCustomError, analysisError, analysisPending, generationSummary, isAddingCustom, isLoading, onAddCustom, onAnalyze, onQuoteChange, onRetry, onSelectionChange, onSelectAll, preview, previewError, quotes, selectedSolutions, siteAcHeadroomKw }: {
  addCustomError: string | null;
  analysisError: string | null;
  analysisPending: boolean;
  generationSummary: CiDesignCandidateResult["generation_summary"] | null;
  isAddingCustom: boolean;
  isLoading: boolean;
  onAddCustom: (request: CiCustomDesignCandidateRequest) => Promise<void>;
  onAnalyze: () => void;
  onQuoteChange: (scenarioId: string, value: string) => void;
  onRetry: () => void;
  onSelectionChange: (scenarioId: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  preview: CiDesignPricePreview | null;
  previewError: string | null;
  quotes: Record<string, string>;
  selectedSolutions: Record<string, boolean>;
  siteAcHeadroomKw: number | null;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState({ label: "", pv: "", battery: "", inverter: "", capex: "" });
  const [customValidationError, setCustomValidationError] = useState<string | null>(null);
  const customSolutionLimitReached = (preview?.candidate_count ?? 0) >= MAX_DESIGN_SOLUTIONS;
  const submitCustom = async () => {
    setCustomValidationError(null);
    if (customSolutionLimitReached) {
      setCustomValidationError(`Maximum ${MAX_DESIGN_SOLUTIONS} solutions reached.`);
      return;
    }
    const request: CiCustomDesignCandidateRequest = {
      contract_version: "ci_custom_design_candidate_request_v1",
      label: custom.label.trim(),
      pv_capacity_kwp_dc: Number(custom.pv),
      battery_capacity_kwh: Number(custom.battery),
      inverter_capacity_kw_ac: Number(custom.inverter),
      quoted_net_capex_aud_ex_gst: Number(custom.capex),
    };
    if (!request.label || !Number.isFinite(request.pv_capacity_kwp_dc) || request.pv_capacity_kwp_dc <= 0 || !Number.isFinite(request.battery_capacity_kwh) || request.battery_capacity_kwh < 0 || !Number.isFinite(request.inverter_capacity_kw_ac) || request.inverter_capacity_kw_ac <= 0 || !Number.isFinite(request.quoted_net_capex_aud_ex_gst) || request.quoted_net_capex_aud_ex_gst <= 0) {
      setCustomValidationError("Enter a name, positive PV and PCS capacities, a non-negative battery capacity, and a positive Net CAPEX.");
      return;
    }
    if (siteAcHeadroomKw && request.inverter_capacity_kw_ac > siteAcHeadroomKw + 1e-9) {
      setCustomValidationError(`The requested PCS is ${numberLabel(request.inverter_capacity_kw_ac)} kW AC, above the current ${numberLabel(siteAcHeadroomKw)} kW AC Site AC headroom.`);
      return;
    }
    try {
      await onAddCustom(request);
    } catch {
      return;
    }
    setCustom({ label: "", pv: "", battery: "", inverter: "", capex: "" });
    setShowCustom(false);
  };
  if (isLoading) return <section className="rounded-xl border border-slate-200 bg-white p-6"><p className="flex items-center gap-2 text-sm text-slate-600"><RefreshCw className="size-4 animate-spin" />Calculating Net CAPEX for every feasible solution…</p></section>;
  if (previewError || !preview) return <section className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-950">Net CAPEX is not ready</h2><p className="mt-1 text-sm leading-6 text-amber-900">{previewError ?? "Save the equipment and rebate assumptions, then try again."}</p><Button className="mt-4" onClick={onRetry} type="button" variant="outline"><RefreshCw className="size-4" />Retry pricing</Button></section>;
  const addedCustomCount = generationSummary
    ? Math.max(0, preview.candidate_count - generationSummary.generated_candidate_count)
    : 0;
  const feasibleCombinationCount = generationSummary
    ? Math.max(0, generationSummary.requested_count - generationSummary.deduplicated_count - generationSummary.rejected_count)
    : 0;
  const legacyComparisonCount = generationSummary
    ? Math.max(0, generationSummary.generated_candidate_count - feasibleCombinationCount)
    : 0;
  const rejectionTitle = generationSummary?.rejection_reasons
    .map((reason) => `${reason.code}: ${reason.count}`)
    .join("; ");
  const selectedCount = preview.solutions.filter((solution) => selectedSolutions[solution.scenario_id]).length;
  const allSelected = selectedCount === preview.solutions.length;
  const validQuotes = selectedCount > 0 && preview.solutions.filter((solution) => selectedSolutions[solution.scenario_id]).every((solution) => {
    const value = Number(quotes[solution.scenario_id]);
    return Number.isFinite(value) && value > 0;
  });
  const analysisBlocker = selectedCount === 0
    ? "Select at least one solution before starting analysis."
    : !validQuotes
      ? "Enter a positive quoted Net CAPEX for every selected solution."
      : null;
  return (
    <section aria-labelledby="generated-solution-quotes-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5 sm:p-6">
        <div>
          <h3 className="text-xl font-semibold text-slate-950" id="generated-solution-quotes-title">Solutions</h3>
          {generationSummary ? (
            <div aria-label="Solution generation summary" className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
              <span>{generationSummary.requested_count} configured combinations</span>
              {generationSummary.deduplicated_count ? <><span aria-hidden="true">·</span><span>{generationSummary.deduplicated_count} merged from an earlier design</span></> : null}
              {generationSummary.rejected_count ? <><span aria-hidden="true">·</span><span title={rejectionTitle}>{generationSummary.rejected_count} rejected</span></> : null}
              <span aria-hidden="true">·</span>
              <strong className="text-slate-900">{feasibleCombinationCount} feasible</strong>
              {legacyComparisonCount ? <><span aria-hidden="true">+</span><span>{legacyComparisonCount} legacy PV-only {legacyComparisonCount === 1 ? "comparison" : "comparisons"}</span></> : null}
              {addedCustomCount ? <><span aria-hidden="true">+</span><span>{addedCustomCount} custom {addedCustomCount === 1 ? "solution" : "solutions"}</span><span aria-hidden="true">=</span><strong className="text-slate-900">{preview.candidate_count} solutions</strong></> : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{selectedCount} / {preview.candidate_count} selected</span><Button aria-describedby={customSolutionLimitReached ? "custom-solution-limit" : undefined} disabled={customSolutionLimitReached} onClick={() => { setCustomValidationError(null); setShowCustom((current) => !current); }} type="button" variant="outline"><Plus className="size-4" />Add custom solution</Button></div>
          {customSolutionLimitReached ? <p className="text-xs font-medium text-amber-700" id="custom-solution-limit" role="status">Maximum {MAX_DESIGN_SOLUTIONS} solutions reached.</p> : null}
        </div>
      </header>
      {showCustom ? <div className="border-b border-slate-200 bg-cyan-50/40 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="font-semibold text-slate-950">Custom solution &amp; quotation</h3><Button onClick={() => setShowCustom(false)} type="button" variant="outline">Cancel</Button></div><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><label className="text-xs font-medium text-slate-700">Solution name<input aria-label="Custom solution name" className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" maxLength={80} onChange={(event) => setCustom((current) => ({ ...current, label: event.target.value }))} placeholder="e.g. Client option A" value={custom.label} /></label><CustomNumberField label="PV capacity" onChange={(value) => setCustom((current) => ({ ...current, pv: value }))} suffix="kWp" value={custom.pv} /><CustomNumberField label="Battery capacity" min="0" onChange={(value) => setCustom((current) => ({ ...current, battery: value }))} suffix="kWh" value={custom.battery} /><CustomNumberField label="PCS capacity" onChange={(value) => setCustom((current) => ({ ...current, inverter: value }))} suffix="kW AC" value={custom.inverter} /><CustomNumberField label="Quoted Net CAPEX" onChange={(value) => setCustom((current) => ({ ...current, capex: value }))} prefix="$" suffix="ex GST" value={custom.capex} /></div>{customValidationError || addCustomError ? <p className="mt-3 text-sm text-red-700" role="alert">{customValidationError ?? addCustomError}</p> : null}<div className="mt-4 flex justify-end"><Button disabled={isAddingCustom || customSolutionLimitReached} onClick={() => { void submitCustom(); }} type="button">{isAddingCustom ? <RefreshCw className="size-4 animate-spin" /> : <Plus className="size-4" />}{isAddingCustom ? "Validating…" : "Add to comparison"}</Button></div></div> : null}
      <div aria-label="Generated solution pricing table" className="ci-scroll-region overflow-x-auto" role="region" tabIndex={0}>
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="w-12 px-4 py-3"><input aria-label="Select all solutions" checked={allSelected} onChange={(event) => onSelectAll(event.target.checked)} type="checkbox" /></th><th className="px-4 py-3">Solution</th><th className="px-4 py-3">PV</th><th className="px-4 py-3">Battery</th><th className="px-4 py-3">PCS</th><th className="px-4 py-3 text-right">Gross CAPEX</th><th className="px-4 py-3 text-right">Upfront rebates</th><th className="px-4 py-3 text-right">Model Net CAPEX</th><th className="px-4 py-3">Quoted Net CAPEX (ex GST)</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{preview.solutions.map((solution, index) => {
            const rebateStatus = scenarioRebateStatus(solution.rebate_calculation);
            return <tr className={selectedSolutions[solution.scenario_id] ? "" : "opacity-55"} key={solution.scenario_id}><td className="px-4 py-3"><input aria-label={`Select Solution ${index + 1}`} checked={Boolean(selectedSolutions[solution.scenario_id])} onChange={(event) => onSelectionChange(solution.scenario_id, event.target.checked)} type="checkbox" /></td><td className="px-4 py-3"><strong className="text-slate-900">Solution {index + 1}</strong><span className="mt-0.5 block max-w-[190px] truncate text-xs text-slate-500">{solution.label}</span></td><td className="px-4 py-3 tabular-nums">{numberLabel(solution.pv_capacity_kwp_dc)} kWp</td><td className="px-4 py-3 tabular-nums">{numberLabel(solution.battery_capacity_kwh)} kWh</td><td className="px-4 py-3 tabular-nums">{numberLabel(solution.inverter_capacity_kw_ac)} kW</td><td className="px-4 py-3 text-right tabular-nums">{aud(solution.gross_capex_aud_ex_gst)}</td><td className="px-4 py-3 text-right tabular-nums text-emerald-700"><span>−{aud(solution.upfront_rebate_aud_ex_gst)}</span>{rebateStatus ? <span className="mt-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500" title={rebateStatus.title}>{rebateStatus.label}</span> : null}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{aud(solution.net_capex_aud_ex_gst)}</td><td className="px-4 py-3"><div className="relative"><span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">$</span><input aria-label={`Quoted Net CAPEX for Solution ${index + 1}`} className="h-10 w-full rounded-md border border-slate-300 bg-white pl-7 pr-3 tabular-nums outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" min="0.01" onChange={(event) => onQuoteChange(solution.scenario_id, event.target.value)} step="0.01" type="number" value={quotes[solution.scenario_id] ?? ""} /></div></td></tr>;
          })}</tbody>
        </table>
      </div>
      <footer className="flex justify-end border-t border-slate-200 bg-slate-50/60 p-5"><div className="flex flex-col items-end gap-2">{analysisBlocker ? <p className="max-w-md text-right text-xs font-medium text-amber-800" id="analysis-blocker" role="status">{analysisBlocker}</p> : null}<Button aria-describedby={analysisBlocker ? "analysis-blocker" : undefined} className="min-w-36" disabled={!validQuotes || analysisPending} onClick={onAnalyze} type="button">{analysisPending ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Play className="size-4" />}{analysisPending ? "Analysis running…" : "Analysis"}</Button></div></footer>
      {analysisError ? <p className="border-t border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800" role="alert">{analysisError}</p> : null}
    </section>
  );
}

function CustomNumberField({ label, min = "0.01", onChange, prefix, suffix, value }: { label: string; min?: string; onChange: (value: string) => void; prefix?: string; suffix: string; value: string }) {
  return <label className="text-xs font-medium text-slate-700">{label}<div className="relative mt-1"><input aria-label={label} className={`h-10 w-full rounded-md border border-slate-300 bg-white ${prefix ? "pl-7" : "pl-3"} pr-16 text-sm tabular-nums outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100`} min={min} onChange={(event) => onChange(event.target.value)} step={prefix ? "0.01" : "any"} type="number" value={value} />{prefix ? <span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">{prefix}</span> : null}<span className="pointer-events-none absolute right-3 top-2.5 text-[11px] text-slate-400">{suffix}</span></div></label>;
}

function scenarioRebateStatus(calculation: CiDesignPricePreview["solutions"][number]["rebate_calculation"]) {
  const programs = [calculation.programs?.solar_stc, calculation.programs?.battery_stc].filter(Boolean);
  if (!programs.length) return null;
  const selected = programs.filter((program) => program.status !== "disabled");
  if (!selected.length) return { label: "Not selected", title: "No STC program selected." };
  const title = selected.flatMap((program) => program.reason_messages).join(" ");
  if (selected.every((program) => program.status === "ineligible")) return { label: "Ineligible", title };
  if (selected.some((program) => program.status === "ineligible")) return { label: "Partial", title };
  return { label: "Applied", title };
}

type FullAnalysisRequest = { projectId: string; runId: number; snapshot: CiAnalysisPriceSnapshot };

type FullAnalysisResult = {
  projectId: string;
  snapshot: CiAnalysisPriceSnapshot;
  feasibilityResult: Awaited<ReturnType<typeof runCiDesignFeasibility>>;
  tariffResult: Awaited<ReturnType<typeof runCiProjectTariffReplay>>;
  financeResult: Awaited<ReturnType<typeof compareCiAnnualFinancialScenarios>>;
};

type FullAnalysisController = {
  data: FullAnalysisResult | undefined;
  error: Error | null;
  isPending: boolean;
  isSuccess: boolean;
  progress: { projectId: string; percent: number; label: string } | null;
  projectId: string | null;
  isBusy: () => boolean;
  start: (request: Omit<FullAnalysisRequest, "runId">) => boolean;
};

class InvalidAnalysisPriceSnapshotError extends Error {}

function useFullAnalysisRunner(onInvalidSnapshot: (projectId: string, snapshot: null) => void): FullAnalysisController {
  const queryClient = useQueryClient();
  const runSequence = useRef(0);
  const inFlightRunId = useRef<number | null>(null);
  const [progress, setProgress] = useState<{ projectId: string; percent: number; label: string } | null>(null);
  const fullRun = useMutation<FullAnalysisResult, Error, FullAnalysisRequest>({
    mutationKey: CI_ANALYSIS_MUTATION_KEY,
    mutationFn: async ({ projectId, snapshot }) => {
      setProgress({ projectId, percent: 5, label: "Validating Net CAPEX" });
      let preview: CiDesignPricePreview;
      try {
        preview = await queryClient.fetchQuery({
          queryKey: ciDesignPricePreviewQueryKey(projectId),
          queryFn: () => fetchCiDesignPricePreview(projectId),
          retry: false,
          staleTime: 0,
        });
      } catch (error) {
        throw new InvalidAnalysisPriceSnapshotError(error instanceof Error ? error.message : "The Net CAPEX snapshot is unavailable.");
      }
      if (!ciAnalysisPriceSnapshotMatchesPreview(snapshot, preview)) {
        throw new InvalidAnalysisPriceSnapshotError("The Net CAPEX snapshot changed. Return to Solution Generator and confirm the current quotations.");
      }
      const [savedFeasibility, savedTariffReplay] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: ciSavedFeasibilityQueryKey(projectId),
          queryFn: () => fetchCiSavedFeasibility(projectId),
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: ciProjectTariffReplayQueryKey(projectId),
          queryFn: () => fetchCiSavedTariffReplay(projectId),
          staleTime: 0,
        }),
      ]);
      const scenarioIds = snapshot.scenarioIds;
      const feasibilityResult = savedFeasibility.status === "ready"
        && savedFeasibility.result !== null
        && resultCoversScenarios(savedFeasibility.result, scenarioIds)
        ? savedFeasibility.result
        : await (async () => {
          setProgress({ projectId, percent: 12, label: `Running scenario dispatch (0/${scenarioIds.length})` });
          return runCiDesignFeasibility(projectId, fetch, undefined, scenarioIds, {
            onProgress: ({ completedScenarioCount, totalScenarioCount }) => {
              const fraction = totalScenarioCount > 0
                ? completedScenarioCount / totalScenarioCount
                : 0;
              setProgress({
                projectId,
                percent: Math.min(52, 12 + Math.round(fraction * 40)),
                label: `Running scenario dispatch (${completedScenarioCount}/${totalScenarioCount})`,
              });
            },
          });
        })();
      queryClient.setQueryData<CiSavedFeasibilityState>(ciSavedFeasibilityQueryKey(projectId), { contract_version: "ci_project_feasibility_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: feasibilityResult });
      const tariffResult = savedTariffReplay.status === "ready"
        && savedTariffReplay.result !== null
        && resultCoversScenarios(savedTariffReplay.result, scenarioIds)
        ? selectCiTariffReplayScenarios(savedTariffReplay.result, scenarioIds)
        : await (async () => {
          setProgress({ projectId, percent: 52, label: `Reconstructing tariffs (0/${scenarioIds.length})` });
          return runCiProjectTariffReplay(projectId, fetch, undefined, scenarioIds, {
            onProgress: (progress) => {
              const { completedScenarioCount, totalScenarioCount } = progress;
              const fraction = totalScenarioCount > 0
                ? completedScenarioCount / totalScenarioCount
                : 0;
              setProgress({
                projectId,
                percent: Math.min(74, 52 + Math.round(fraction * 22)),
                label: formatCiTariffReplayProgressLabel(progress),
              });
            },
          });
        })();
      queryClient.setQueryData(ciProjectTariffReplayQueryKey(projectId), { contract_version: "ci_project_tariff_replay_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: tariffResult });
      setProgress({ projectId, percent: 74, label: "Revalidating Net CAPEX" });
      let currentPreview: CiDesignPricePreview;
      try {
        currentPreview = await queryClient.fetchQuery({
          queryKey: ciDesignPricePreviewQueryKey(projectId),
          queryFn: () => fetchCiDesignPricePreview(projectId),
          retry: false,
          staleTime: 0,
        });
      } catch (error) {
        throw new InvalidAnalysisPriceSnapshotError(error instanceof Error ? error.message : "The Net CAPEX snapshot is unavailable.");
      }
      if (!ciAnalysisPriceSnapshotMatchesPreview(snapshot, currentPreview)) {
        throw new InvalidAnalysisPriceSnapshotError("The Net CAPEX snapshot changed while analysis was running. Return to Solution Generator and confirm the current quotations.");
      }
      setProgress({ projectId, percent: 78, label: "Calculating financial comparison" });
      const financeResult = await compareCiAnnualFinancialScenarios({
        projectId,
        pricingMode: "manual_quotes",
        prices: snapshot.prices,
      });
      setProgress({ projectId, percent: 100, label: "Analysis complete" });
      return { projectId, snapshot, feasibilityResult, tariffResult, financeResult };
    },
    onSuccess: ({ feasibilityResult, financeResult, projectId, tariffResult }) => {
      queryClient.setQueryData<CiSavedFeasibilityState>(ciSavedFeasibilityQueryKey(projectId), { contract_version: "ci_project_feasibility_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: feasibilityResult });
      queryClient.setQueryData(ciProjectTariffReplayQueryKey(projectId), { contract_version: "ci_project_tariff_replay_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: tariffResult });
      queryClient.setQueryData(ciAnnualFinancialComparisonQueryKey(projectId), { contract_version: "ci_project_annual_financial_state_v1", status: "ready", saved_at: new Date().toISOString(), stale_reasons: [], result: financeResult });
      void invalidateCiCalculationHandbook(queryClient, projectId);
    },
    onError: (error, variables) => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ciSavedFeasibilityQueryKey(variables.projectId) });
      void queryClient.invalidateQueries({ exact: true, queryKey: ciProjectTariffReplayQueryKey(variables.projectId) });
      if (error instanceof InvalidAnalysisPriceSnapshotError) onInvalidSnapshot(variables.projectId, null);
    },
    onSettled: (_data, _error, variables) => {
      if (inFlightRunId.current === variables.runId) inFlightRunId.current = null;
    },
  });
  const mutate = fullRun.mutate;
  const isBusy = useCallback(() => inFlightRunId.current !== null, []);
  const start = useCallback((request: Omit<FullAnalysisRequest, "runId">) => {
    if (isBusy()) return false;
    runSequence.current += 1;
    const runId = runSequence.current;
    inFlightRunId.current = runId;
    mutate({ ...request, runId });
    return true;
  }, [isBusy, mutate]);
  return {
    data: fullRun.data,
    error: fullRun.error,
    isPending: fullRun.isPending,
    isSuccess: fullRun.isSuccess,
    isBusy,
    progress,
    projectId: fullRun.variables?.projectId ?? null,
    start,
  };
}

function DispatchWorkspace({ analysisBusy, analysisLaunch, analysisSnapshot, claimAnalysisLaunch, fullAnalysis, onAnalysisSnapshotChange, project }: {
  analysisBusy: boolean;
  analysisLaunch: AnalysisLaunch | null;
  analysisSnapshot: CiAnalysisPriceSnapshot | null;
  claimAnalysisLaunch: (launchId: number) => boolean;
  fullAnalysis: FullAnalysisController;
  onAnalysisSnapshotChange: (projectId: string, snapshot: CiAnalysisPriceSnapshot | null) => void;
  project: CiProject;
}) {
  const savedDesign = useQuery({ queryKey: ciSavedDesignQueryKey(project.project_id), queryFn: () => fetchCiSavedDesign(project.project_id) });
  const savedFeasibility = useQuery({ queryKey: ciSavedFeasibilityQueryKey(project.project_id), queryFn: () => fetchCiSavedFeasibility(project.project_id) });
  const savedTariffReplay = useQuery({ queryKey: ciProjectTariffReplayQueryKey(project.project_id), queryFn: () => fetchCiSavedTariffReplay(project.project_id), retry: false });
  const pricePreview = useQuery({ queryKey: ciDesignPricePreviewQueryKey(project.project_id), queryFn: () => fetchCiDesignPricePreview(project.project_id), retry: false });
  const autoStarted = useRef(false);
  const sourceSnapshot = analysisLaunch?.snapshot ?? analysisSnapshot;
  const previewReady = !pricePreview.isPending && !pricePreview.isFetching && !pricePreview.isError && Boolean(pricePreview.data);
  const validatedSnapshot = sourceSnapshot && previewReady && pricePreview.data && ciAnalysisPriceSnapshotMatchesPreview(sourceSnapshot, pricePreview.data)
    ? sourceSnapshot
    : null;
  useEffect(() => {
    if (analysisLaunch || analysisSnapshot || !previewReady || !pricePreview.data) return;
    const restored = restoreCiAnalysisPriceSnapshot(project.project_id, pricePreview.data);
    if (restored) onAnalysisSnapshotChange(project.project_id, restored);
  }, [analysisLaunch, analysisSnapshot, onAnalysisSnapshotChange, previewReady, pricePreview.data, project.project_id]);
  useEffect(() => {
    if (!sourceSnapshot || pricePreview.isPending || pricePreview.isFetching) return;
    if (pricePreview.isError || !pricePreview.data || !ciAnalysisPriceSnapshotMatchesPreview(sourceSnapshot, pricePreview.data)) {
      onAnalysisSnapshotChange(project.project_id, null);
    }
  }, [onAnalysisSnapshotChange, pricePreview.data, pricePreview.isError, pricePreview.isFetching, pricePreview.isPending, project.project_id, sourceSnapshot]);
  useEffect(() => {
    if (
      !analysisLaunch
      || autoStarted.current
      || analysisBusy
      || !validatedSnapshot
      || savedDesign.isError
      || savedDesign.isPending
      || savedDesign.isFetching
    ) return;
    autoStarted.current = true;
    const started = fullAnalysis.start({ projectId: project.project_id, snapshot: validatedSnapshot });
    if (!started) {
      autoStarted.current = false;
      return;
    }
    claimAnalysisLaunch(analysisLaunch.launchId);
  }, [
    analysisLaunch,
    analysisBusy,
    claimAnalysisLaunch,
    fullAnalysis.isPending,
    fullAnalysis.start,
    project.project_id,
    savedDesign.isFetching,
    savedDesign.isError,
    savedDesign.isPending,
    validatedSnapshot,
  ]);
  if (project.design_status !== "ready") {
    return <ModulePrerequisite description="Generate and save the PV and battery solution space in Physical feasibility before running interval dispatch." project={project} title="Dispatch" />;
  }
  if (
    savedDesign.isPending
    || savedDesign.isFetching
    || savedFeasibility.isPending
    || savedFeasibility.isFetching
    || savedTariffReplay.isPending
    || savedTariffReplay.isFetching
  ) return <PageState title="Loading dispatch workspace" description="Restoring the generated scenarios and any saved simulation results." />;
  if (savedDesign.isError || !savedDesign.data) return <ModulePrerequisite description="The generated solution space could not be restored. Return to Physical feasibility and generate it again." project={project} title="Dispatch" />;
  const fullRunForProject = fullAnalysis.projectId === project.project_id;
  const fullRunPending = fullRunForProject && fullAnalysis.isPending;
  const fullRunData = fullAnalysis.data?.projectId === project.project_id ? fullAnalysis.data : null;
  const fullRunError = fullRunForProject ? fullAnalysis.error : null;
  const analysisScenarioIds = validatedSnapshot?.scenarioIds ?? fullRunData?.snapshot.scenarioIds ?? [];
  const analysis = fullRunData?.feasibilityResult ?? (!savedFeasibility.isError && savedFeasibility.data?.status === "ready" ? savedFeasibility.data.result : null);
  const needsRun = !analysis;
  const displayedAnalysis = analysis ? selectedFeasibilityResult(analysis, analysisScenarioIds) : null;
  const fullAnalysisBlocked = !validatedSnapshot;
  return (
    <section aria-labelledby="dispatch-workspace-title" className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Activity className="size-5" /></span>
          <h1 className="text-xl font-semibold text-slate-950" id="dispatch-workspace-title">Scenario dispatch analysis</h1>
        </div>
        <Button disabled={analysisBusy || fullAnalysisBlocked} onClick={() => { if (validatedSnapshot) fullAnalysis.start({ projectId: project.project_id, snapshot: validatedSnapshot }); }} type="button">
          {analysisBusy ? <RefreshCw className="size-4 animate-spin" /> : analysis ? <RefreshCw className="size-4" /> : <Play className="size-4" />}
          {fullRunPending ? "Full analysis running…" : analysisBusy ? "Another analysis is running…" : validatedSnapshot ? (analysis ? "Re-run full analysis" : "Run full analysis") : "Select solutions in Solution Generator"}
        </Button>
      </header>
      {fullRunForProject && (fullAnalysis.isPending || fullAnalysis.isSuccess || fullAnalysis.error) && fullAnalysis.progress?.projectId === project.project_id ? <AnalysisProgress progress={fullAnalysis.progress} /> : null}
      {fullRunError ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{fullRunError.message}</p> : null}
      {pricePreview.isError ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The saved Net CAPEX snapshot is unavailable or out of date. Return to Solution Generator and refresh the quotations before running full analysis.</p> : null}
      {!validatedSnapshot && !pricePreview.isPending && !pricePreview.isFetching ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Return to Solution Generator, select the solutions to analyse and confirm their Net CAPEX quotations.</p> : null}
      {savedFeasibility.data?.status === "stale" ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The saved dispatch result is out of date because the design or interval evidence changed. Select the required solutions in Solution Generator, then run Analysis again.</p> : null}
      {fullRunPending ? null : needsRun ? <DispatchReadyState design={savedDesign.data} scenarioIds={analysisScenarioIds} /> : displayedAnalysis ? <CiDesignFeasibility projectId={project.project_id} result={displayedAnalysis} /> : null}
    </section>
  );
}

function DispatchReadyState({ design, scenarioIds }: { design: CiDesignCandidateResult; scenarioIds: string[] }) {
  const selectedIds = new Set(scenarioIds);
  if (!selectedIds.size) {
    return <section className="grid min-h-[320px] place-items-center rounded-xl border border-slate-200 bg-white p-8 text-center"><div className="max-w-md"><h2 className="text-xl font-semibold text-slate-950">Select solutions before analysis</h2><p className="mt-2 text-sm text-slate-600">Return to Solution Generator, choose the required solutions and confirm their Net CAPEX quotations.</p></div></section>;
  }
  const candidates = design.candidates.filter((scenario) => selectedIds.has(scenario.scenario_id));
  return (
    <section className="grid overflow-hidden rounded-xl border border-slate-200 bg-white xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50/70 p-4 xl:border-b-0 xl:border-r">
        <p className="text-xs font-semibold uppercase tracking-[.14em] text-slate-500">Generated solutions</p>
        <div className="mt-3 max-h-[540px] space-y-2 overflow-y-auto pr-1">
          {candidates.map((scenario, index) => <div className="rounded-lg border border-slate-200 bg-white p-3" key={scenario.scenario_id}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-slate-900">Solution {index + 1}</strong><span className="text-[11px] text-slate-400">Not run</span></div><p className="mt-1 text-xs tabular-nums text-slate-600">{numberLabel(scenario.pv_capacity_kwp_dc)} kWp PV · {numberLabel(scenario.nominal_capacity_kwh)} kWh battery</p><p className="mt-0.5 text-[11px] text-slate-500">{numberLabel(scenario.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS</p></div>)}
        </div>
      </aside>
      <div className="grid min-h-[540px] place-items-center p-8 text-center"><div className="max-w-md"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-cyan-50 text-cyan-800"><Play className="size-6" /></span><h2 className="mt-5 text-xl font-semibold text-slate-950">Ready to simulate {candidates.length} selected {candidates.length === 1 ? "solution" : "solutions"}</h2></div></div>
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
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 9 }).format(value);
}

function AnalysisProgress({ progress }: { progress: { percent: number; label: string } }) {
  return <section aria-label="Analysis progress" className="rounded-xl border border-cyan-200 bg-cyan-50 p-5"><div className="flex items-center justify-between gap-4"><p className="text-sm font-semibold text-cyan-950">{progress.label}</p><strong className="text-sm tabular-nums text-cyan-950">{progress.percent}%</strong></div><div aria-label={progress.label} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress.percent} className="mt-4 h-2.5 overflow-hidden rounded-full bg-cyan-100" role="progressbar"><div className="h-full rounded-full bg-cyan-600 transition-[width] duration-500" style={{ width: `${progress.percent}%` }} /></div></section>;
}

function resultCoversScenarios(result: { scenarios: Array<{ scenario_id: string }> }, scenarioIds: string[]) {
  if (!scenarioIds.length) return false;
  const availableScenarioIds = new Set(result.scenarios.map((scenario) => scenario.scenario_id));
  return scenarioIds.every((scenarioId) => availableScenarioIds.has(scenarioId));
}

function selectedFeasibilityResult(result: NonNullable<CiSavedFeasibilityState["result"]>, scenarioIds: string[]) {
  if (!scenarioIds.length) return result;
  const selectedIds = new Set(scenarioIds);
  if (selectedIds.size === result.scenarios.length && result.scenarios.every((scenario) => selectedIds.has(scenario.scenario_id))) return result;
  const scenarios = result.scenarios
    .filter((scenario) => selectedIds.has(scenario.scenario_id))
    .map((scenario, index) => ({ ...scenario, physical_review_rank: index + 1 }));
  return {
    ...result,
    physical_review_order: {
      ...result.physical_review_order,
      shortlist_count: Math.min(10, scenarios.length),
    },
    scenarios,
  };
}

function aud(value: number) {
  return new Intl.NumberFormat("en-AU", { currency: "AUD", maximumFractionDigits: 0, style: "currency" }).format(value);
}

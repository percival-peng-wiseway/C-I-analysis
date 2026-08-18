import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarDays, CheckCircle2, FolderKanban, Grid3X3, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ciProjectsQueryKey,
  ciSavedDesignQueryKey,
  createCiProject,
  fetchCiSavedDesign,
  listCiProjects,
  validateCiDesignCandidates,
  type CiDesignCandidateResult,
  type CiProject,
} from "@/features/ci/api/ci-projects";
import {
  ciSavedFeasibilityQueryKey,
  fetchCiSavedFeasibility,
  runCiDesignFeasibility,
  type CiSavedFeasibilityState,
} from "@/features/ci/api/ci-design-feasibility";
import {
  ciWorkspaceReadinessQueryKey,
  fetchCiWorkspaceReadiness,
} from "@/features/ci/api/ci-workspace-readiness";
import { CiEvidenceIntake } from "@/features/ci/ci-evidence-intake";
import { CiAnnualFinancialWorkspace } from "@/features/ci/ci-annual-financial-workspace";
import { CiScenarioBuilder } from "@/features/ci/ci-scenario-builder";
import { CiDesignFeasibility } from "@/features/ci/ci-design-feasibility";
import { useCiWorkspace } from "@/features/ci/ci-workspace-context";

export function CiReadinessPage() {
  const queryClient = useQueryClient();
  const workspace = useCiWorkspace();
  const bootstrapped = useRef(false);
  const readiness = useQuery({ queryKey: ciWorkspaceReadinessQueryKey, queryFn: () => fetchCiWorkspaceReadiness() });
  const projects = useQuery({ queryKey: ciProjectsQueryKey, queryFn: () => listCiProjects() });
  const createProject = useMutation({
    mutationFn: ({ name }: { name: string; openAfterCreate: boolean }) => createCiProject(name),
    onSuccess: (project, variables) => {
      queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => [project, ...current]);
      if (variables.openAfterCreate) workspace.openProjectStage(toActiveProject(project), "setup");
    },
  });

  useEffect(() => {
    if (projects.data?.length === 0 && !bootstrapped.current && !createProject.isPending) {
      bootstrapped.current = true;
      createProject.mutate({ name: "Commercial feasibility", openAfterCreate: false });
    }
  }, [createProject, projects.data]);

  if (readiness.isPending || projects.isPending || (projects.data?.length === 0 && createProject.isPending)) {
    return <PageState title="Preparing project workspace" description="Loading project records and calculation guardrails." />;
  }
  if (readiness.isError || projects.isError) {
    return <PageState title="Workspace unavailable" description="The project workspace could not be loaded. Check that the C&I API and database are running." />;
  }

  const activeProject = projects.data.find((project) => project.project_id === workspace.activeProject?.projectId) ?? null;
  if (workspace.stage !== "overview" && !activeProject) {
    return <PageState title="Select a project" description="Return to Project overview and open a project before continuing." />;
  }

  return (
    <main className="premium-page ci-workbench-page min-h-screen bg-background p-4 sm:p-8">
      <div className="premium-content mx-auto flex w-full max-w-[1380px] flex-col gap-6">
        {workspace.stage === "overview" ? (
          <ProjectOverview
            createError={createProject.error instanceof Error ? createProject.error.message : null}
            creating={createProject.isPending}
            onCreate={(name) => createProject.mutate({ name, openAfterCreate: true })}
            onOpen={(project) => workspace.openProjectStage(toActiveProject(project), "setup")}
            projects={projects.data}
          />
        ) : activeProject && workspace.stage === "setup" ? (
          <SetupWorkspace
            onContinue={() => workspace.setStage("system_design")}
            onReady={() => {
              queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => current.map((item) => item.project_id === activeProject.project_id ? { ...item, setup_status: "ready", current_stage: "system_design", updated_at: new Date().toISOString() } : item));
              void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
              workspace.openProjectStage(
                { ...toActiveProject(activeProject), setupReady: true },
                "system_design",
              );
            }}
            profileReady={readiness.data.availability === "evidence_limited"}
            project={activeProject}
          />
        ) : activeProject && workspace.stage === "system_design" ? (
          <SystemDesignWorkspace
            onBack={() => workspace.setStage("setup")}
            onValidated={(candidateCount) => {
              queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => current.map((item) => item.project_id === activeProject.project_id ? { ...item, current_stage: "system_design", design_status: "ready", design_candidate_count: candidateCount, updated_at: new Date().toISOString() } : item));
              workspace.openProjectStage({ ...toActiveProject(activeProject), designReady: true }, "system_design");
              void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
            }}
            project={activeProject}
          />
        ) : activeProject && workspace.stage === "financial_simulation" ? (
          <>
            <StageHeader eyebrow="04 · Annual finance" project={activeProject} title="Compare annual energy and financial scenarios" description="Select a saved design, compare no-system, PV-only and PV+battery operation, then project NPV, payback, IRR and annual cashflow from the evidence-bound tariff and published price catalog." />
            <CiAnnualFinancialWorkspace profileReady={readiness.data.availability === "evidence_limited"} onComplete={() => {
              queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => current.map((item) => item.project_id === activeProject.project_id ? { ...item, current_stage: "financial_simulation", updated_at: new Date().toISOString() } : item));
              void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
            }} project={activeProject} />
          </>
        ) : null}
      </div>
    </main>
  );
}

function ProjectOverview({ createError, creating, onCreate, onOpen, projects }: {
  createError: string | null;
  creating: boolean;
  onCreate: (name: string) => void;
  onOpen: (project: CiProject) => void;
  projects: CiProject[];
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  return (
    <>
      <section className="ci-dashboard-hero">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">C&amp;I workspace</p><h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">Project overview</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Each project keeps its own private Setup evidence, inspection results and Python-validated system design count in the local workspace.</p></div>
        <div className="ci-overview-stat"><FolderKanban className="size-5 text-cyan-200" /><span><strong>{projects.length}</strong><small>active {projects.length === 1 ? "project" : "projects"}</small></span></div>
      </section>
      <section aria-labelledby="project-cards-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700">01 · Project overview</p><h2 className="mt-1 text-2xl font-semibold" id="project-cards-title">Your projects</h2></div><p className="text-sm text-muted-foreground">Open a project or start a new one.</p></div>
        <div className="ci-project-grid">
          {projects.map((project) => <ProjectCard key={project.project_id} onOpen={() => onOpen(project)} project={project} />)}
          <Card className="ci-new-project-card">
            {showCreate ? (
              <form className="flex h-full min-h-64 flex-col justify-center p-6" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate(name); }}>
                <span className="grid size-11 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Sparkles className="size-5" /></span>
                <label className="mt-5 grid gap-2 text-sm font-medium">Project name<input autoFocus className="rounded-md border border-border bg-white px-3 py-2" maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="e.g. Warehouse solar + battery" value={name} /></label>
                <div className="mt-4 flex gap-2"><Button disabled={!name.trim() || creating} type="submit">{creating ? "Creating" : "Create & continue"}<ArrowRight className="size-4" /></Button><Button onClick={() => setShowCreate(false)} type="button" variant="ghost">Cancel</Button></div>
                {createError ? <p className="mt-3 text-sm text-destructive">{createError}</p> : null}
              </form>
            ) : (
              <button className="flex min-h-64 w-full flex-col items-center justify-center gap-4 p-6 text-center" onClick={() => setShowCreate(true)} type="button"><span className="grid size-14 place-items-center rounded-full border border-cyan-200 bg-cyan-50 text-cyan-800"><Plus className="size-6" /></span><span><strong className="block text-base">New project</strong><small className="mt-1 block text-sm text-muted-foreground">Create a project and continue to Setup &amp; catalog</small></span></button>
            )}
          </Card>
        </div>
      </section>
    </>
  );
}

function ProjectCard({ onOpen, project }: { onOpen: () => void; project: CiProject }) {
  const setupReady = project.setup_status === "ready";
  return (
    <Card className="ci-project-card overflow-hidden">
      <div className="h-2 bg-gradient-to-r from-cyan-400 via-teal-400 to-emerald-400" />
      <CardHeader className="p-6"><div className="flex items-start justify-between gap-3"><span className="grid size-11 place-items-center rounded-xl bg-slate-900 text-cyan-200"><FolderKanban className="size-5" /></span><Badge variant={setupReady ? "secondary" : "outline"}>{setupReady ? "Setup ready" : "Input required"}</Badge></div><CardTitle as="h3" className="mt-5 text-xl">{project.display_name}</CardTitle><CardDescription className="flex items-center gap-2"><CalendarDays className="size-3.5" />Updated {formatDate(project.updated_at)}</CardDescription></CardHeader>
      <CardContent className="px-6 pb-6"><div className="grid grid-cols-2 gap-3"><ProjectFact label="Current stage" value={stageLabel(project)} /><ProjectFact label="Design candidates" value={String(project.design_candidate_count)} /></div><Button className="mt-6 w-full justify-between" onClick={onOpen} type="button">Open project<ArrowRight className="size-4" /></Button></CardContent>
    </Card>
  );
}

function SetupWorkspace({ onContinue, onReady, profileReady, project }: { onContinue: () => void; onReady: () => void; profileReady: boolean; project: CiProject }) {
  return (
    <>
      <StageHeader eyebrow="02 · Setup & catalog" project={project} title="Verify the project inputs" description="Upload the bill and matching interval file once for this project. Pair checks and the annual source-resolution demand heatmap stay together in this stage." />
      {project.setup_status === "ready" ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"><div><strong>Setup is complete for this project.</strong><p className="mt-1 text-emerald-900/75">Saved evidence is restored below when available. A project completed before local evidence saving was added needs one final re-upload; later visits restore it automatically.</p></div><Button onClick={onContinue} type="button">Open System design<ArrowRight className="size-4" /></Button></div> : null}
      <CiEvidenceIntake onReady={onReady} profileReady={profileReady} projectId={project.project_id} />
    </>
  );
}

function SystemDesignWorkspace({ onBack, onValidated, project }: { onBack: () => void; onValidated: (candidateCount: number) => void; project: CiProject }) {
  const queryClient = useQueryClient();
  const savedDesign = useQuery({
    queryKey: ciSavedDesignQueryKey(project.project_id),
    queryFn: () => fetchCiSavedDesign(project.project_id),
  });
  const savedFeasibility = useQuery({
    queryKey: ciSavedFeasibilityQueryKey(project.project_id),
    queryFn: () => fetchCiSavedFeasibility(project.project_id),
  });
  const feasibility = useMutation({
    mutationFn: () => runCiDesignFeasibility(project.project_id),
    onSuccess: (analysis) => {
      queryClient.setQueryData<CiSavedFeasibilityState>(
        ciSavedFeasibilityQueryKey(project.project_id),
        {
          contract_version: "ci_project_feasibility_state_v1",
          status: "ready",
          saved_at: new Date().toISOString(),
          stale_reasons: [],
          result: analysis,
        },
      );
      void queryClient.invalidateQueries({ queryKey: ciProjectsQueryKey });
    },
  });
  const validation = useMutation({
    mutationFn: (scenarios: Parameters<typeof validateCiDesignCandidates>[1]) => validateCiDesignCandidates(project.project_id, scenarios),
    onSuccess: (result) => {
      feasibility.reset();
      queryClient.setQueryData(ciSavedDesignQueryKey(project.project_id), result);
      void queryClient.invalidateQueries({ queryKey: ciSavedFeasibilityQueryKey(project.project_id) });
      onValidated(result.candidate_count);
    },
  });
  if (project.setup_status !== "ready") {
    return <Card><CardHeader><CardTitle as="h1" className="text-xl">Setup is required</CardTitle><CardDescription>Complete the PDF and NEM12 pair check before defining system designs.</CardDescription></CardHeader><CardContent><Button onClick={onBack} type="button">Go to Setup &amp; catalog</Button></CardContent></Card>;
  }
  if (savedDesign.isPending) {
    return <PageState title="Loading system design" description="Restoring the technical parameters saved to this project." />;
  }
  if (savedDesign.isError) {
    return <Card><CardHeader><CardTitle as="h1" className="text-xl">System design unavailable</CardTitle><CardDescription>The saved technical design could not be loaded safely.</CardDescription></CardHeader><CardContent><Button onClick={onBack} type="button">Return to Setup &amp; catalog</Button></CardContent></Card>;
  }
  const result = validation.data ?? savedDesign.data;
  const restoredAnalysis = feasibility.data ?? (
    savedFeasibility.data?.status === "ready" ? savedFeasibility.data.result : null
  );
  return (
    <>
      <StageHeader eyebrow="03 · System design" project={project} title="Build and test the feasible design search space" description="Set PV, inverter and battery ranges, save every Cartesian combination, then compare measured-period grid import and selected peak-day physical behavior." />
      <div className="rounded-xl border border-cyan-100 bg-cyan-50 p-4 text-sm text-cyan-950"><div className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><p><strong>Scope:</strong> Python validates the technical inputs, then runs a pre-tariff kW/kWh feasibility review from this project’s saved interval data. The result does not infer billing windows, kVA/PF treatment, demand charges, savings, ranking or recommendation.</p></div></div>
      {!result && project.design_candidate_count > 0 ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>Previous validation count retained.</strong><span className="ml-2">This project was validated before complete design saving was available. Enter the technical fields once and use Save &amp; validate to make them reopenable.</span></div> : null}
      {result ? <CandidateResults hasSavedAnalysis={Boolean(restoredAnalysis)} isPending={feasibility.isPending} isRestoring={savedFeasibility.isPending} onRun={() => feasibility.mutate()} result={result} savedNow={Boolean(validation.data)} /> : null}
      {result ? <details className="group rounded-xl border border-border bg-white"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-slate-900"><span>Edit design inputs</span><span className="text-xs font-normal text-slate-500 group-open:hidden">Open PV, inverter and battery ranges</span><span className="hidden text-xs font-normal text-slate-500 group-open:inline">Close editor</span></summary><div className="border-t border-border p-4"><CiScenarioBuilder error={validation.error instanceof Error ? validation.error.message : null} initialSolutions={savedDesign.data?.candidates} isPending={validation.isPending} onSubmit={(scenarios) => validation.mutate(scenarios)} /></div></details> : <CiScenarioBuilder error={validation.error instanceof Error ? validation.error.message : null} initialSolutions={savedDesign.data?.candidates} isPending={validation.isPending} onSubmit={(scenarios) => validation.mutate(scenarios)} />}
      {savedFeasibility.isError ? <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950"><strong>Saved feasibility could not be restored.</strong><span className="ml-2">You can safely run the analysis again.</span></div> : null}
      {savedFeasibility.data?.status === "stale" ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>Saved feasibility is out of date.</strong><span className="ml-2">Setup evidence or design inputs changed after the last run. Run the analysis again to replace it.</span></div> : null}
      {feasibility.error instanceof Error ? <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950"><strong>Feasibility analysis needs attention.</strong><span className="ml-2">{feasibility.error.message}</span></div> : null}
      {savedFeasibility.data?.status === "ready" && !feasibility.data ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"><strong>Saved feasibility restored.</strong><span className="ml-2">This is the project’s last completed analysis. Re-run only when you want to replace it.</span></div> : null}
      {restoredAnalysis ? <CiDesignFeasibility projectId={project.project_id} result={restoredAnalysis} /> : null}
    </>
  );
}

export function CandidateResults({ hasSavedAnalysis = false, isPending, isRestoring = false, onRun, result, savedNow = false }: { hasSavedAnalysis?: boolean; isPending: boolean; isRestoring?: boolean; onRun: () => void; result: CiDesignCandidateResult; savedNow?: boolean }) {
  const pvConfigurations = uniqueBy(result.candidates, (candidate) => candidate.pv_system_id).sort((a, b) => a.pv_capacity_kwp_dc - b.pv_capacity_kwp_dc);
  const batteryConfigurations = uniqueBy(result.candidates, (candidate) => candidate.battery_system_id).sort((a, b) => a.nominal_capacity_kwh - b.nominal_capacity_kwh);
  const durations = batteryConfigurations.filter((candidate) => candidate.max_discharge_kw > 0).map((candidate) => candidate.nominal_capacity_kwh / candidate.max_discharge_kw);
  return (
    <Card className="overflow-hidden border-emerald-200">
      <CardHeader className="border-b border-emerald-100 bg-emerald-50"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white"><CheckCircle2 className="size-5" /></span><div><CardTitle as="h2" className="text-xl text-emerald-950">Design space ready</CardTitle><CardDescription className="mt-1 text-emerald-900/70">{savedNow ? "System design saved." : "Saved system design loaded."} Input guardrails passed; interval dispatch is the next step.</CardDescription></div></div><Button disabled={isPending || isRestoring} onClick={onRun} type="button">{isRestoring ? "Restoring saved analysis…" : isPending ? `Analysing ${candidateLabel(result.candidate_count)}…` : hasSavedAnalysis ? "Re-run analysis" : `Analyse ${candidateLabel(result.candidate_count)}`}<Sparkles className="size-4" /></Button></div></CardHeader>
      <CardContent className="space-y-5 p-5">
        <div className="grid items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr_auto_.8fr]">
          <SearchFactor count={pvConfigurations.length} detail={`${rangeLabel(pvConfigurations.map((candidate) => candidate.pv_capacity_kwp_dc))} kWp · ${rangeLabel(pvConfigurations.map((candidate) => candidate.pv_inverter_capacity_kw_ac))} kW AC`} label="PV configurations" tone="amber" />
          <span className="hidden self-center text-2xl text-slate-300 lg:block">×</span>
          <SearchFactor count={batteryConfigurations.length} detail={`${rangeLabel(batteryConfigurations.map((candidate) => candidate.nominal_capacity_kwh))} kWh · ${rangeLabel(batteryConfigurations.map((candidate) => candidate.max_discharge_kw))} kW`} label="Battery configurations" tone="cyan" />
          <span className="hidden self-center text-2xl text-slate-300 lg:block">=</span>
          <div className="flex items-center gap-3 rounded-xl bg-slate-950 p-4 text-white"><span className="grid size-10 place-items-center rounded-lg bg-white/10 text-cyan-200"><Grid3X3 className="size-5" /></span><span><strong className="block text-2xl tabular-nums">{result.candidate_count}</strong><small className="text-slate-300">{result.candidate_count === 1 ? "case" : "cases"} ready to analyse</small></span></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-slate-500"><span>{durationLabel(durations)} battery duration · all {candidateLabel(result.candidate_count)} are input-valid</span><span>Not yet dispatch-tested or tariff-evaluated</span></div>
      </CardContent>
    </Card>
  );
}

function SearchFactor({ count, detail, label, tone }: { count: number; detail: string; label: string; tone: "amber" | "cyan" }) {
  const color = tone === "amber" ? "bg-amber-400" : "bg-cyan-500";
  return <div className="rounded-xl border border-border bg-slate-50 p-4"><div className="flex items-start justify-between gap-3"><span><strong className="block text-xl tabular-nums text-slate-950">{count}</strong><small className="text-slate-500">{label}</small></span><div aria-label={`${count} ${label}`} className="flex max-w-28 flex-wrap justify-end gap-1" role="img">{Array.from({ length: Math.min(count, 20) }, (_, index) => <span className={`size-2 rounded-[2px] ${color}`} key={index} />)}</div></div><p className="mt-3 text-xs font-medium tabular-nums text-slate-700">{detail}</p></div>;
}

function StageHeader({ description, eyebrow, project, title }: { description: string; eyebrow: string; project: CiProject; title: string }) {
  return <section className="ci-stage-header"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">{eyebrow}</p><h1 className="mt-3 text-3xl font-semibold text-white">{title}</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">{description}</p></div><div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3"><small className="block text-[10px] uppercase tracking-[0.16em] text-slate-400">Project</small><strong className="mt-1 block text-sm text-white">{project.display_name}</strong></div></section>;
}

function ProjectFact({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-slate-50 p-3"><small className="block text-xs text-muted-foreground">{label}</small><strong className="mt-1 block text-sm">{value}</strong></div>; }
function PageState({ description, title }: { description: string; title: string }) { return <main className="p-8"><Card className="mx-auto max-w-xl"><CardHeader><CardTitle as="h1" className="text-xl">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card></main>; }
function toActiveProject(project: CiProject) { return { projectId: project.project_id, displayName: project.display_name, setupReady: project.setup_status === "ready", designReady: project.design_status === "ready" }; }
function stageLabel(project: CiProject) { return project.current_stage === "financial_simulation" ? "Annual finance" : project.setup_status === "ready" ? "System design" : "Setup & catalog"; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)); }
function formatNumber(value: number) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value); }
function rangeLabel(values: number[]) { const minimum = Math.min(...values); const maximum = Math.max(...values); return minimum === maximum ? formatNumber(minimum) : `${formatNumber(minimum)}–${formatNumber(maximum)}`; }
function durationLabel(values: number[]) { if (!values.length) return "No battery"; const range = rangeLabel(values); return `${range} h`; }
function candidateLabel(count: number) { return `${count} candidate${count === 1 ? "" : "s"}`; }
function uniqueBy<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()]; }

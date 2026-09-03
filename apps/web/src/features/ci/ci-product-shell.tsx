import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  BatteryCharging,
  BookOpenText,
  Building2,
  ChevronRight,
  CirclePlus,
  FolderKanban,
  ReceiptText,
  Settings2,
  SunMedium,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ciProjectsQueryKey,
  createCiProject,
  listCiProjects,
  type CiProject,
} from "@/features/ci/api/ci-projects";
import { useCiWorkspace, type CiWorkspaceStage } from "./ci-workspace-context";
import { CiSettingsPanel } from "./ci-settings-panel";

const LazyCiHandbookPanel = lazy(() => import("./ci-handbook-panel").then((module) => ({
  default: module.CiHandbookPanel,
})));

const modules: Array<{ stage: CiWorkspaceStage; label: string; icon: typeof SunMedium }> = [
  { stage: "evidence", label: "Evidence", icon: FolderKanban },
  { stage: "physical_feasibility", label: "Solution Generator", icon: SunMedium },
  { stage: "dispatch", label: "Scenario Analysis", icon: Activity },
  { stage: "tariff_replay", label: "Finance Analysis", icon: ReceiptText },
];

export function CiProductShell({ children }: { children: ReactNode }) {
  const workspace = useCiWorkspace();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ciProjectsQueryKey, queryFn: () => listCiProjects() });
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [handbookOpen, setHandbookOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const createProject = useMutation({
    mutationFn: (name: string) => createCiProject(name),
    onSuccess: (project) => {
      queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => [project, ...current]);
      workspace.openProjectStage(toActiveProject(project));
      setProjectName("");
      setCreating(false);
    },
  });

  useEffect(() => {
    if (!projects.data?.length) return;
    const restoredProject = projects.data.find((project) => project.project_id === workspace.activeProject?.projectId);
    if (!restoredProject) {
      workspace.openProjectStage(toActiveProject(projects.data[0]));
      return;
    }
    const restored = toActiveProject(restoredProject);
    if (
      workspace.activeProject?.displayName !== restored.displayName
      || workspace.activeProject.setupReady !== restored.setupReady
      || workspace.activeProject.designReady !== restored.designReady
    ) {
      workspace.openProjectStage(restored, workspace.stage);
    }
  }, [projects.data, workspace.activeProject, workspace.stage]);

  const active = projects.data?.find((project) => project.project_id === workspace.activeProject?.projectId) ?? null;
  return (
    <div className="ci-app min-h-[100dvh] bg-slate-50 text-slate-950">
      <a className="sr-only fixed left-4 top-3 z-50 rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-lg focus:not-sr-only" href="#analysis-content">Skip to analysis content</a>
      <header className="ci-app-header border-b border-white/10 bg-[#071525] text-white">
        <div className="ci-app-bar mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a className="flex items-center gap-3" href="/" onClick={() => workspace.setStage("evidence")}>
            <span className="relative grid size-10 place-items-center overflow-hidden rounded-lg bg-cyan-300 text-slate-950 shadow-sm shadow-black/20">
              <Building2 className="size-4" />
              <BatteryCharging className="absolute -bottom-1 -right-1 size-4 rounded-full bg-[#071525] p-0.5 text-cyan-200" />
            </span>
            <span className="text-sm font-semibold tracking-wide">E3 C&amp;I Analyzer</span>
          </a>
        </div>
      </header>

      <div className="mx-auto grid min-w-0 max-w-[1800px] grid-cols-[minmax(0,1fr)] lg:grid-cols-[270px_minmax(0,1fr)]">
        <aside aria-label="Project workspace" className="ci-project-sidebar border-b border-slate-200 bg-white lg:sticky lg:top-16 lg:flex lg:h-[calc(100dvh-64px)] lg:min-h-0 lg:self-start lg:flex-col lg:overflow-hidden lg:border-b-0 lg:border-r">
          <div className="ci-project-sidebar-header border-b border-slate-200 px-5 py-5">
            <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Workspace</p><h2 className="mt-1 font-semibold text-slate-950">Projects</h2></div>
          </div>

          <div className="p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-4">
            {creating ? (
              <form className="rounded-xl border border-cyan-200 bg-cyan-50 p-3" onSubmit={(event) => { event.preventDefault(); if (projectName.trim()) createProject.mutate(projectName.trim()); }}>
                <label className="grid gap-1.5 text-xs font-medium text-cyan-950">Project name<input autoFocus className="min-w-0 rounded-md border border-cyan-200 bg-white px-3 py-2 text-sm text-slate-950" maxLength={255} onChange={(event) => setProjectName(event.target.value)} placeholder="New commercial site" value={projectName} /></label>
                <div className="mt-3 flex gap-2"><Button className="h-8 px-3 text-xs" disabled={!projectName.trim() || createProject.isPending} type="submit">{createProject.isPending ? "Creating…" : "Create"}</Button><Button className="h-8 px-3 text-xs" onClick={() => { setCreating(false); setProjectName(""); }} type="button" variant="ghost">Cancel</Button></div>
                {createProject.error instanceof Error ? <p className="mt-2 text-xs text-red-700">{createProject.error.message}</p> : null}
              </form>
            ) : null}

            <nav aria-label="Projects" className={`${creating ? "mt-3" : ""} ci-project-list ci-scroll-row flex gap-2 overflow-x-auto lg:block lg:space-y-2 lg:overflow-visible`}>
              {projects.isPending ? <p className="px-2 py-3 text-xs text-slate-500">Loading projects…</p> : null}
              {projects.isError ? <p className="px-2 py-3 text-xs text-red-700">Projects unavailable.</p> : null}
              {projects.data?.map((project) => {
                const selected = project.project_id === workspace.activeProject?.projectId;
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    aria-label={`Open project ${project.display_name}`}
                    className={`ci-project-link group flex min-w-52 items-center gap-3 rounded-lg border px-3 py-3 text-left transition lg:w-full lg:min-w-0 ${selected ? "border-cyan-200 bg-cyan-50 text-cyan-950 shadow-sm" : "border-transparent bg-white text-slate-700 hover:border-slate-200 hover:bg-slate-50"}`}
                    key={project.project_id}
                    onClick={() => workspace.openProjectStage(toActiveProject(project))}
                    type="button"
                  >
                    <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${selected ? "bg-cyan-100 text-cyan-800" : "bg-slate-100 text-slate-500"}`}><FolderKanban className="size-4" /></span>
                    <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-semibold">{project.display_name}</strong><small className="mt-0.5 block text-[11px] text-slate-500">{project.setup_status === "ready" ? `${project.design_candidate_count} design cases` : "Evidence required"}</small></span>
                    <ChevronRight className={`size-4 shrink-0 ${selected ? "text-cyan-700" : "text-slate-300"}`} />
                  </button>
                );
              })}
              {!projects.isPending && projects.data?.length === 0 ? <p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">No projects yet. Use New project below to create one.</p> : null}
            </nav>

            {!creating ? <button className="mt-3 flex w-full items-center gap-3 rounded-xl border border-dashed border-slate-300 px-3 py-3 text-left text-sm font-medium text-slate-600 transition hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-900" onClick={() => setCreating(true)} type="button"><CirclePlus className="size-5 text-cyan-700" />New project</button> : null}
          </div>
          <div className="border-t border-slate-200 bg-white p-3 lg:shrink-0 lg:p-4">
            <button aria-label="Open settings" className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950" onClick={() => { setHandbookOpen(false); setSettingsOpen(true); }} type="button"><span className="grid size-9 place-items-center rounded-lg bg-slate-100 text-slate-600"><Settings2 className="size-4" /></span><span className="min-w-0 flex-1"><strong className="block text-sm">Settings</strong><small className="mt-0.5 block text-xs font-normal text-slate-500">Device prices &amp; finance</small></span><ChevronRight className="size-4 text-slate-300" /></button>
          </div>
        </aside>

        <div className="min-w-0">
          <section className="ci-project-toolbar border-b border-slate-200 bg-white px-4 pt-4 sm:px-6 sm:pt-5 lg:sticky lg:top-16 lg:z-30">
            <div className="mb-4">
              <div><p className="text-xs font-semibold uppercase tracking-[.12em] text-cyan-700">Active project</p><h1 className="mt-1 text-xl font-semibold tracking-[-0.01em] text-slate-950 sm:text-2xl">{active?.display_name ?? "Select or create a project"}</h1></div>
            </div>
            <div><nav aria-label="Analysis modules" className="ci-module-tabs grid grid-cols-2 gap-2 pb-4 sm:grid-cols-4">
              {modules.map((module) => {
                const Icon = module.icon;
                const selected = workspace.stage === module.stage;
                return (
                  <button aria-current={selected ? "page" : undefined} className={`ci-module-tab relative flex min-h-14 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-cyan-200 bg-cyan-50 text-cyan-950 shadow-sm" : "border-transparent bg-white text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900"}`} disabled={!active} key={module.stage} onClick={() => workspace.setStage(module.stage)} type="button">
                    <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${selected ? "bg-cyan-100 text-cyan-800" : "bg-slate-100 text-slate-500"}`}><Icon className="size-4" /></span>
                    <strong className="min-w-0 text-sm font-semibold leading-5 xl:text-base">{module.label}</strong>
                  </button>
                );
              })}
            </nav></div>
          </section>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
      {active ? <Button aria-label="Open project calculation Handbook" className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 h-11 rounded-xl px-4 shadow-lg shadow-slate-950/20 sm:right-6" onClick={() => { setSettingsOpen(false); setHandbookOpen(true); }} type="button"><BookOpenText className="size-4" />Handbook</Button> : null}
      {settingsOpen ? <CiSettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      {handbookOpen && active ? (
        <Suspense fallback={<HandbookPanelFallback onClose={() => setHandbookOpen(false)} />}>
          <LazyCiHandbookPanel onClose={() => setHandbookOpen(false)} open />
        </Suspense>
      ) : null}
    </div>
  );
}

function HandbookPanelFallback({ onClose }: { onClose: () => void }) {
  return (
    <div aria-label="Loading Handbook" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4 backdrop-blur-[2px]" role="dialog">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center shadow-2xl">
        <BookOpenText className="mx-auto size-7 animate-pulse text-cyan-700 motion-reduce:animate-none" />
        <p aria-live="polite" className="mt-3 text-sm font-semibold text-slate-900">Loading Handbook…</p>
        <Button className="mt-4" onClick={onClose} type="button" variant="outline">Cancel</Button>
      </div>
    </div>
  );
}

function toActiveProject(project: CiProject) {
  return {
    projectId: project.project_id,
    displayName: project.display_name,
    setupReady: project.setup_status === "ready",
    designReady: project.design_status === "ready",
  };
}

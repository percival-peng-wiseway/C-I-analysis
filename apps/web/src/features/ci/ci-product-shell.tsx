import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  BookOpenText,
  Building2,
  ChevronRight,
  ChevronsUpDown,
  Trash2,
  Undo2,
  CirclePlus,
  FolderKanban,
  ReceiptText,
  Search,
  Settings2,
  SunMedium,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  ciProjectsQueryKey,
  createCiProject,
  deleteCiProject,
  restoreCiProject,
  ciDeletedProjectsQueryKey,
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
  const [projectFilter, setProjectFilter] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CiProject | null>(null);
  const otherWrites = useIsMutating({ predicate: (mutation) => mutation.options.mutationKey?.[0] !== "ci-project-lifecycle" });
  const deletedProjects = useQuery({ queryKey: ciDeletedProjectsQueryKey, queryFn: () => listCiProjects(fetch, true), enabled: showTrash, retry: false });
  const lifecycle = useMutation({
    mutationKey: ["ci-project-lifecycle"],
    mutationFn: async ({ project, action }: { project: CiProject; action: "delete" | "restore" }) => {
      if (action === "delete") { await deleteCiProject(project.project_id); return null; }
      return restoreCiProject(project.project_id);
    },
    onSuccess: (restored, { project, action }) => {
      const remaining = (queryClient.getQueryData<CiProject[]>(ciProjectsQueryKey) ?? []).filter((item) => item.project_id !== project.project_id);
      queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, restored ? [restored, ...remaining] : remaining);
      if (action === "delete") {
        queryClient.removeQueries({ predicate: (query) => query.queryKey.includes(project.project_id) });
        if (workspace.activeProject?.projectId === project.project_id) {
          setHandbookOpen(false);
          if (remaining[0]) workspace.openProjectStage(toActiveProject(remaining[0]));
          else workspace.clearProject();
        }
      }
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ciDeletedProjectsQueryKey });
    },
  });
  const projectActionsBusy = lifecycle.isPending || otherWrites > 0;
  const createProject = useMutation({
    mutationFn: (name: string) => createCiProject(name),
    onSuccess: (project) => {
      queryClient.setQueryData<CiProject[]>(ciProjectsQueryKey, (current = []) => [project, ...current]);
      workspace.openProjectStage(toActiveProject(project));
      setProjectName("");
      setProjectFilter("");
      setCreating(false);
      setProjectsOpen(false);
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
  const currentModule = modules.find((module) => module.stage === workspace.stage) ?? modules[0];
  const filteredProjects = projects.data?.filter((project) => project.display_name.toLocaleLowerCase().includes(projectFilter.trim().toLocaleLowerCase())) ?? [];
  return (
    <div className="ci-app min-h-[100dvh] bg-slate-50 text-slate-950">
      <a className="sr-only fixed left-4 top-3 z-50 rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-lg focus:not-sr-only" href="#analysis-content">Skip to analysis content</a>
      <header className="ci-app-header border-b border-slate-200 bg-white text-slate-950">
        <div className="ci-app-bar mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <button className="flex shrink-0 items-center gap-2.5 rounded-lg text-left" onClick={() => workspace.setStage("evidence")} type="button">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-xl bg-primary text-sm font-bold tracking-tight text-primary-foreground">E3</span>
            <span className="text-sm font-semibold tracking-[-0.01em]">E3 C&amp;I Analyzer</span>
          </button>
          <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
            <span className="hidden sm:inline">Workspace</span>
            {active ? <><ChevronRight aria-hidden="true" className="hidden size-3.5 shrink-0 text-slate-300 sm:block" /><span className="max-w-32 truncate rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-700 sm:max-w-64">{active.display_name}</span></> : null}
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-w-0 max-w-[1800px] grid-cols-[minmax(0,1fr)] lg:grid-cols-[272px_minmax(0,1fr)]">
        <aside aria-label="Project workspace" className="ci-project-sidebar border-b border-slate-200 bg-white lg:sticky lg:top-16 lg:flex lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:self-start lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="border-t border-slate-200/80 p-3 lg:order-1 lg:shrink-0 lg:border-t-0 lg:px-4 lg:py-5">
            <div className="mb-3 flex items-center justify-between gap-2 px-2">
              <h2 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Projects{projects.data ? <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums tracking-normal text-slate-500">{projects.data.length}</span> : null}</h2>
              {!creating ? <button aria-label="New project" className="rounded-md p-1.5 text-slate-500 transition hover:bg-cyan-50 hover:text-cyan-800" onClick={() => { setCreating(true); setProjectsOpen(true); setShowTrash(false); }} title="New project" type="button"><CirclePlus aria-hidden="true" className="size-5" /></button> : null}
            </div>
            <details open={projectsOpen} onToggle={(event) => setProjectsOpen(event.currentTarget.open)}>
              <summary aria-label="Switch project" className="flex cursor-pointer list-none items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 marker:hidden hover:border-cyan-300">
                <Building2 aria-hidden="true" className="size-5 shrink-0 text-cyan-700" />
                <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-semibold">{active?.display_name ?? "Select a project"}</strong><span className="mt-1 block text-xs text-slate-500">{projects.data?.length ?? 0} projects · Switch</span></span>
                <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
              </summary>
              <div className="mt-2 rounded-xl border border-slate-200 bg-white p-2">
              <div className="mb-2 flex gap-1"><Button aria-pressed={!showTrash} className="h-8 flex-1 px-2 text-xs" onClick={() => { setShowTrash(false); setDeleteTarget(null); lifecycle.reset(); }} size="sm" type="button" variant="ghost">Projects</Button><Button aria-pressed={showTrash} className="h-8 flex-1 px-2 text-xs" onClick={() => { setShowTrash(true); setDeleteTarget(null); lifecycle.reset(); }} size="sm" type="button" variant="ghost"><Trash2 className="size-3.5" />Deleted</Button></div>
            {projects.data?.length ? <div className="relative mb-3">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-3.5 text-slate-400" />
              <input aria-label="Find a project" className="h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-8 text-xs text-slate-700 placeholder:text-slate-400" onChange={(event) => setProjectFilter(event.target.value)} placeholder="Find a project" type="search" value={projectFilter} />
              {projectFilter ? <button aria-label="Clear project filter" className="absolute right-1.5 top-1.5 rounded p-1 text-slate-500 hover:bg-slate-200" onClick={() => setProjectFilter("")} type="button"><X aria-hidden="true" className="size-3.5" /></button> : null}
            </div> : null}
            {creating ? (
              <form className="rounded-xl border border-cyan-200 bg-cyan-50 p-3" onSubmit={(event) => { event.preventDefault(); if (projectName.trim() && !createProject.isPending) createProject.mutate(projectName.trim()); }}>
                <label className="grid gap-1.5 text-xs font-medium text-cyan-950">Project name<input autoFocus className="min-w-0 rounded-md border border-cyan-200 bg-white px-3 py-2 text-sm text-slate-950" maxLength={255} onChange={(event) => setProjectName(event.target.value)} placeholder="New commercial site" value={projectName} /></label>
                <div className="mt-3 flex gap-2"><Button className="h-8 px-3 text-xs" disabled={!projectName.trim() || createProject.isPending} type="submit">{createProject.isPending ? "Creating…" : "Create"}</Button><Button className="h-8 px-3 text-xs" onClick={() => { setCreating(false); setProjectName(""); }} type="button" variant="ghost">Cancel</Button></div>
                {createProject.error instanceof Error ? <p className="mt-2 text-xs text-red-700" role="alert">{createProject.error.message}</p> : null}
              </form>
            ) : null}

            {!showTrash ? <nav aria-label="Projects" className={`${creating ? "mt-3" : ""} max-h-80 space-y-1 overflow-y-auto`}>
              {projects.isPending ? <p className="px-2 py-3 text-xs text-slate-500">Loading projects…</p> : null}
              {projects.isError ? <p className="px-2 py-3 text-xs text-red-700">Projects unavailable.</p> : null}
              {filteredProjects.map((project) => {
                const selected = project.project_id === workspace.activeProject?.projectId;
                return (
                  <div className={`rounded-lg ${selected ? "bg-cyan-50" : "hover:bg-slate-50"}`} key={project.project_id}><div className="flex items-center gap-1"><button
                    aria-current={selected ? "page" : undefined}
                    aria-label={`Open project ${project.display_name}`}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-3 text-left ${selected ? "text-cyan-900" : "text-slate-700"}`}
                    onClick={() => { workspace.openProjectStage(toActiveProject(project)); setProjectsOpen(false); setDeleteTarget(null); }}
                    type="button"
                  >
                    <span className="min-w-0 flex-1"><strong className="block break-words text-sm font-medium">{project.display_name}</strong><small className="mt-1 block text-xs text-slate-500">{project.setup_status === "ready" ? `${project.design_candidate_count} solutions` : "Evidence required"}</small></span>
                  </button><button aria-label={`Delete project ${project.display_name}`} className="mr-1 grid size-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-40" disabled={projectActionsBusy} onClick={() => { lifecycle.reset(); setDeleteTarget(project); }} title="Move to deleted projects" type="button"><Trash2 aria-hidden="true" className="size-4" /></button></div></div>
                );
              })}
              {!projects.isPending && projects.data?.length === 0 ? <p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">No projects yet. Choose New project to create one.</p> : null}
              {projectFilter.trim() && Boolean(projects.data?.length) && filteredProjects.length === 0 ? <p className="p-3 text-xs text-slate-500" role="status">No projects match “{projectFilter.trim()}”.</p> : null}
            </nav> : <div aria-label="Deleted projects" className="max-h-80 space-y-2 overflow-y-auto" role="region">
              {deletedProjects.isPending ? <p className="p-2 text-sm text-slate-500">Loading deleted projects…</p> : null}
              {deletedProjects.isError ? <div role="alert"><p className="text-sm text-red-700">Deleted projects unavailable.</p><Button onClick={() => void deletedProjects.refetch()} size="sm" variant="ghost">Retry</Button></div> : null}
              {deletedProjects.data?.filter((item) => item.display_name.toLocaleLowerCase().includes(projectFilter.trim().toLocaleLowerCase())).map((project) => <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-2" key={project.project_id}><span className="min-w-0 flex-1 break-words text-sm">{project.display_name}</span><Button aria-label={`Restore project ${project.display_name}`} disabled={projectActionsBusy} onClick={() => lifecycle.mutate({ project, action: "restore" })} size="icon" title="Restore project" variant="ghost"><Undo2 className="size-4" /></Button></div>)}
              {deletedProjects.data?.length === 0 ? <p className="p-2 text-sm text-slate-500">No deleted projects.</p> : null}
            </div>}
            {deleteTarget ? <section aria-label={`Confirm deletion of ${deleteTarget.display_name}`} className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="break-words text-sm font-semibold text-red-900">Delete “{deleteTarget.display_name}”?</p><p className="mt-2 text-xs leading-relaxed text-red-800">Moved to Deleted. Evidence, configuration and results are kept so you can restore it.</p>
              <div className="mt-3 flex flex-wrap gap-2"><Button disabled={projectActionsBusy} onClick={() => lifecycle.mutate({ project: deleteTarget, action: "delete" })} size="sm" type="button">{lifecycle.isPending ? "Deleting…" : "Move to deleted"}</Button><Button disabled={lifecycle.isPending} onClick={() => setDeleteTarget(null)} size="sm" type="button" variant="ghost">Cancel</Button></div>
            </section> : null}
            {lifecycle.error instanceof Error ? <p className="mt-2 break-words text-sm text-red-700" role="alert">{lifecycle.error.message}</p> : null}
            {otherWrites > 0 ? <p className="mt-2 text-xs text-slate-500">Project deletion is paused while saving or analyzing.</p> : null}
            </div></details>

          </div>
          <div className="ci-project-sidebar-header border-t border-slate-200/80 px-3 pb-3 pt-4 lg:order-2 lg:shrink-0 lg:px-4 lg:pb-5 lg:pt-6">
            <p className="mb-3 hidden px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 lg:block">Analysis workspace</p>
            <nav aria-label="Analysis modules" className="ci-module-tabs grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-1">
              {modules.map((module) => {
                const Icon = module.icon;
                const selected = workspace.stage === module.stage;
                return (
                  <button aria-current={selected ? "page" : undefined} className={`ci-module-tab flex min-h-11 items-center gap-3 rounded-full px-3 py-2.5 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "bg-cyan-50 font-semibold text-cyan-800" : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`} disabled={!active} key={module.stage} onClick={() => workspace.setStage(module.stage)} type="button">
                    <Icon aria-hidden="true" className={`size-[18px] shrink-0 ${selected ? "text-cyan-700" : "text-slate-400"}`} />
                    <span className="min-w-0 leading-5">{module.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
          <div className="border-t border-slate-200 p-3 lg:order-3 lg:mt-auto lg:shrink-0 lg:p-4">
            <button aria-label="Open settings" className="flex w-full items-center gap-3 rounded-full px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950" onClick={() => { setHandbookOpen(false); setSettingsOpen(true); }} type="button"><Settings2 aria-hidden="true" className="size-[18px] text-slate-400" /><span className="flex-1">Settings</span><ChevronRight aria-hidden="true" className="size-3.5 text-slate-400" /></button>
          </div>
        </aside>

        <div className="min-w-0">
          <section className="ci-project-toolbar border-b border-slate-200 bg-white px-4 py-5 sm:px-6 lg:sticky lg:top-16 lg:z-30 lg:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0"><p className="mb-1 text-xs font-medium text-slate-500">{currentModule.label}</p><h1 className="break-words text-xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-2xl">{active?.display_name ?? "Select or create a project"}</h1></div>
              {active ? <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600"><span aria-hidden="true" className={`size-1.5 rounded-full ${active.setup_status === "ready" ? "bg-cyan-500" : "bg-amber-500"}`} />{active.setup_status === "ready" ? `${active.design_candidate_count} saved solutions` : "Evidence required"}</span> : null}
            </div>
          </section>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
      {active ? <Button aria-label="Open project calculation Handbook" className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 h-11 rounded-full bg-white px-4 shadow-lg shadow-slate-950/10 sm:right-6" onClick={() => { setSettingsOpen(false); setHandbookOpen(true); }} type="button" variant="outline"><BookOpenText className="size-4 text-cyan-700" />Handbook</Button> : null}
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
    <Drawer description="Loading the saved project calculation ledger." label="Handbook" onClose={onClose} open presentation="fullscreen">
      <div className="grid h-full place-items-center bg-slate-50 p-6">
        <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center">
          <BookOpenText className="mx-auto size-7 animate-pulse text-cyan-700 motion-reduce:animate-none" />
          <p aria-live="polite" className="mt-3 text-sm font-semibold text-slate-900">Loading Handbook...</p>
          <Button className="mt-4" onClick={onClose} type="button" variant="outline">Cancel</Button>
        </div>
      </div>
    </Drawer>
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

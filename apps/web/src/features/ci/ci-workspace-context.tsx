import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type CiWorkspaceStage =
  | "evidence"
  | "physical_feasibility"
  | "dispatch"
  | "tariff_replay";

type ActiveProject = { projectId: string; displayName: string; setupReady: boolean; designReady: boolean } | null;

interface CiWorkspaceState {
  activeProject: ActiveProject;
  stage: CiWorkspaceStage;
  openProjectStage: (project: NonNullable<ActiveProject>, stage?: CiWorkspaceStage) => void;
  setStage: (stage: CiWorkspaceStage) => void;
}

const CiWorkspaceContext = createContext<CiWorkspaceState | null>(null);
const WORKSPACE_STORAGE_KEY = "e3-ci-active-workspace-v1";

export function CiWorkspaceProvider({ children }: { children: ReactNode }) {
  const [restored] = useState(readStoredWorkspace);
  const [activeProject, setActiveProject] = useState<ActiveProject>(restored?.activeProject ?? null);
  const [stage, setStageState] = useState<CiWorkspaceStage>(restored?.stage ?? "evidence");
  const value = useMemo<CiWorkspaceState>(() => ({
    activeProject,
    stage,
    openProjectStage: (project, nextStage = "evidence") => {
      setActiveProject(project);
      setStageState(nextStage);
      storeWorkspace(project, nextStage);
    },
    setStage: (nextStage) => {
      setStageState(nextStage);
      if (activeProject) storeWorkspace(activeProject, nextStage);
    },
  }), [activeProject, stage]);
  return <CiWorkspaceContext.Provider value={value}>{children}</CiWorkspaceContext.Provider>;
}

export function useCiWorkspace() {
  const value = useContext(CiWorkspaceContext);
  if (!value) throw new Error("CiWorkspaceProvider is missing.");
  return value;
}

function readStoredWorkspace(): { activeProject: NonNullable<ActiveProject>; stage: CiWorkspaceStage } | null {
  try {
    const raw = window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { activeProject?: Partial<NonNullable<ActiveProject>>; stage?: string };
    const project = value.activeProject;
    if (
      !project
      || typeof project.projectId !== "string"
      || typeof project.displayName !== "string"
      || typeof project.setupReady !== "boolean"
      || typeof project.designReady !== "boolean"
      || !isCiWorkspaceStage(value.stage)
    ) return null;
    return { activeProject: project as NonNullable<ActiveProject>, stage: value.stage };
  } catch {
    return null;
  }
}

function storeWorkspace(activeProject: NonNullable<ActiveProject>, stage: CiWorkspaceStage) {
  try {
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ activeProject, stage }));
  } catch {
    // The workspace still functions when browser storage is unavailable.
  }
}

function isCiWorkspaceStage(value: unknown): value is CiWorkspaceStage {
  return value === "evidence" || value === "physical_feasibility" || value === "dispatch" || value === "tariff_replay";
}

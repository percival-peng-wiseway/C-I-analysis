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

export function CiWorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeProject, setActiveProject] = useState<ActiveProject>(null);
  const [stage, setStage] = useState<CiWorkspaceStage>("evidence");
  const value = useMemo<CiWorkspaceState>(() => ({
    activeProject,
    stage,
    openProjectStage: (project, nextStage = "evidence") => {
      setActiveProject(project);
      setStage(nextStage);
    },
    setStage,
  }), [activeProject, stage]);
  return <CiWorkspaceContext.Provider value={value}>{children}</CiWorkspaceContext.Provider>;
}

export function useCiWorkspace() {
  const value = useContext(CiWorkspaceContext);
  if (!value) throw new Error("CiWorkspaceProvider is missing.");
  return value;
}

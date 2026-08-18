import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type CiWorkspaceStage = "overview" | "setup" | "system_design" | "financial_simulation";

type ActiveProject = { projectId: string; displayName: string; setupReady: boolean; designReady: boolean } | null;

interface CiWorkspaceState {
  activeProject: ActiveProject;
  stage: CiWorkspaceStage;
  openOverview: () => void;
  openProjectStage: (project: NonNullable<ActiveProject>, stage: Exclude<CiWorkspaceStage, "overview">) => void;
  setStage: (stage: CiWorkspaceStage) => void;
}

const CiWorkspaceContext = createContext<CiWorkspaceState | null>(null);

export function CiWorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeProject, setActiveProject] = useState<ActiveProject>(null);
  const [stage, setStage] = useState<CiWorkspaceStage>("overview");
  const value = useMemo<CiWorkspaceState>(() => ({
    activeProject,
    stage,
    openOverview: () => setStage("overview"),
    openProjectStage: (project, nextStage) => {
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

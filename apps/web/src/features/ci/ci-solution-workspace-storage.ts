export interface CiSolutionWorkspaceDraft {
  previewRevision: string;
  quotedNetCapex: Record<string, string>;
  selectedSolutions: Record<string, boolean>;
}

const STORAGE_PREFIX = "e3-ci-solution-workspace-v1:";

export function loadCiSolutionWorkspaceDraft(projectId: string): CiSolutionWorkspaceDraft | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CiSolutionWorkspaceDraft>;
    if (
      typeof value.previewRevision !== "string"
      || !isStringRecord(value.quotedNetCapex)
      || !isBooleanRecord(value.selectedSolutions)
    ) return null;
    return {
      previewRevision: value.previewRevision,
      quotedNetCapex: value.quotedNetCapex,
      selectedSolutions: value.selectedSolutions,
    };
  } catch {
    return null;
  }
}

export function saveCiSolutionWorkspaceDraft(projectId: string, draft: CiSolutionWorkspaceDraft) {
  try {
    window.sessionStorage.setItem(storageKey(projectId), JSON.stringify(draft));
  } catch {
    // The server-side snapshots remain authoritative when browser storage is unavailable.
  }
}

export function clearCiSolutionWorkspaceDraft(projectId: string) {
  try {
    window.sessionStorage.removeItem(storageKey(projectId));
  } catch {
    // Nothing to clear when browser storage is unavailable.
  }
}

function storageKey(projectId: string) {
  return `${STORAGE_PREFIX}${projectId}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "boolean");
}

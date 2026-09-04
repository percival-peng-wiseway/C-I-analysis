import type { CiDesignPricePreview } from "@/features/ci/api/ci-design-price-preview";

export interface CiSolutionWorkspaceDraft {
  previewRevision: string;
  quotedNetCapex: Record<string, string>;
  selectedSolutions: Record<string, boolean>;
}

export type CiAnalysisPrice = {
  scenarioId: string;
  upfrontCostAudExGst: number;
};

export type CiAnalysisPriceSnapshot = {
  previewRevision: string;
  scenarioIds: string[];
  prices: CiAnalysisPrice[];
};

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

export function restoreCiAnalysisPriceSnapshot(
  projectId: string,
  preview: CiDesignPricePreview,
): CiAnalysisPriceSnapshot | null {
  const draft = loadCiSolutionWorkspaceDraft(projectId);
  const previewIds = preview.solutions.map((solution) => solution.scenario_id);
  if (
    !draft
    || draft.previewRevision !== ciDesignPricePreviewRevision(preview)
    || Object.keys(draft.selectedSolutions).length !== previewIds.length
    || previewIds.some((scenarioId) => (
      !Object.hasOwn(draft.selectedSolutions, scenarioId)
      || !Object.hasOwn(draft.quotedNetCapex, scenarioId)
    ))
  ) return null;

  const prices = previewIds.flatMap((scenarioId) => {
    const selected = draft.selectedSolutions[scenarioId];
    const upfrontCostAudExGst = Number(draft.quotedNetCapex[scenarioId]);
    return selected && Number.isFinite(upfrontCostAudExGst) && upfrontCostAudExGst > 0
      ? [{ scenarioId, upfrontCostAudExGst }]
      : [];
  });
  if (!prices.length) return null;
  return {
    previewRevision: draft.previewRevision,
    scenarioIds: prices.map((price) => price.scenarioId),
    prices,
  };
}

export function ciAnalysisPriceSnapshotMatchesPreview(
  snapshot: CiAnalysisPriceSnapshot,
  preview: CiDesignPricePreview,
) {
  if (snapshot.previewRevision !== ciDesignPricePreviewRevision(preview)) return false;
  if (!snapshot.scenarioIds.length || snapshot.scenarioIds.length !== snapshot.prices.length) return false;
  if (new Set(snapshot.scenarioIds).size !== snapshot.scenarioIds.length) return false;
  const previewIds = new Set(preview.solutions.map((solution) => solution.scenario_id));
  return snapshot.prices.every((price, index) => (
    price.scenarioId === snapshot.scenarioIds[index]
    && previewIds.has(price.scenarioId)
    && Number.isFinite(price.upfrontCostAudExGst)
    && price.upfrontCostAudExGst > 0
  ));
}

export function ciDesignPricePreviewRevision(preview: CiDesignPricePreview) {
  return `${preview.design_candidates_sha256}:${preview.device_profile_sha256}:${preview.rebate_profile_sha256 ?? "none"}:${preview.solutions.map((solution) => `${solution.scenario_id}:${solution.net_capex_aud_ex_gst}`).join("|")}`;
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

import type { CiScenarioInput } from "./ci-scenarios";

export interface CiProject {
  project_id: string;
  display_name: string;
  current_stage: "setup" | "system_design" | "financial_simulation";
  setup_status: "input_required" | "ready";
  design_status: "input_required" | "ready";
  design_candidate_count: number;
  created_at: string;
  updated_at: string;
}

export interface CiDesignCandidateResult {
  contract_version: "ci_design_candidate_validation_v1";
  status: "ready";
  validation_basis: "python_scenario_input_contract_v1";
  candidate_count: number;
  candidates: CiScenarioInput[];
  dispatch_evaluated: false;
  tariff_evaluated: false;
  customer_facing_permission: false;
  recommendation_permitted: false;
  disclaimer: string;
}

export const ciProjectsQueryKey = ["ci-projects"] as const;
export const ciSavedDesignQueryKey = (projectId: string) => ["ci-saved-design", projectId] as const;

export async function listCiProjects(fetcher: typeof fetch = fetch): Promise<CiProject[]> {
  const response = await fetcher("/api/commercial-industrial/projects", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Project list failed with status ${response.status}.`);
  const payload = await response.json() as { contract_version?: string; projects?: CiProject[] };
  if (payload.contract_version !== "ci_project_registry_v1" || !Array.isArray(payload.projects)) {
    throw new Error("Project list returned an unexpected contract.");
  }
  return payload.projects;
}

export async function createCiProject(displayName: string, fetcher: typeof fetch = fetch): Promise<CiProject> {
  const response = await fetcher("/api/commercial-industrial/projects", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Project creation failed."));
  const payload = await response.json() as CiProject & { contract_version?: string };
  if (payload.contract_version !== "ci_project_v1" || !payload.project_id || !payload.display_name) {
    throw new Error("Project creation returned an unexpected contract.");
  }
  return payload;
}

export async function validateCiDesignCandidates(
  projectId: string,
  scenarios: CiScenarioInput[],
  fetcher: typeof fetch = fetch,
): Promise<CiDesignCandidateResult> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-candidates`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ scenarios }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Design validation failed."));
  return assertCiDesignCandidateResult(await response.json());
}

export async function fetchCiSavedDesign(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiDesignCandidateResult | null> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-candidates`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Saved system design could not be loaded."));
  const payload = await response.json() as { contract_version?: string; status?: string; design?: unknown };
  if (payload.contract_version !== "ci_saved_design_state_v1") {
    throw new Error("Saved system design returned an unexpected contract.");
  }
  if (payload.status === "not_saved" && payload.design === null) return null;
  if (payload.status !== "ready") throw new Error("Saved system design returned an unsafe state.");
  return assertCiDesignCandidateResult(payload.design);
}

function assertCiDesignCandidateResult(value: unknown): CiDesignCandidateResult {
  const payload = value as CiDesignCandidateResult;
  if (
    payload.contract_version !== "ci_design_candidate_validation_v1" ||
    payload.status !== "ready" ||
    payload.validation_basis !== "python_scenario_input_contract_v1" ||
    payload.candidate_count !== payload.candidates?.length ||
    payload.dispatch_evaluated !== false ||
    payload.tariff_evaluated !== false ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false
  ) {
    throw new Error("Design validation returned an unsafe contract.");
  }
  return payload;
}

async function errorMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
  return payload?.detail?.message ?? fallback;
}

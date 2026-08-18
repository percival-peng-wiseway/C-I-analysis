export interface CiWorkspaceReadinessContract {
  contract_version: "ci_workspace_readiness_v3";
  product_id: "commercial_and_industrial";
  availability: "unavailable" | "evidence_limited";
  active_profile_id: string | null;
  active_profile_label: string | null;
  blockers: Array<{ code: string; message: string }>;
  workspace_areas: Array<{
    workspace_id: string;
    display_label: string;
    description: string;
    availability: "unavailable" | "input_required" | "evidence_limited";
  }>;
}

const expectedWorkspaceIds = [
  "data_qc",
  "tariff_mapping",
  "peak_shaving",
  "kw_kva_pf_evidence",
  "scenario_ranking",
  "report_preview",
] as const;

export const ciWorkspaceReadinessQueryKey = ["ci-workspace-readiness"] as const;

export async function fetchCiWorkspaceReadiness(
  fetcher: typeof fetch = fetch,
): Promise<CiWorkspaceReadinessContract> {
  const response = await fetcher("/api/commercial-industrial/workspace-readiness", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`C&I workspace readiness request failed with status ${response.status}.`);
  }
  const payload = (await response.json()) as CiWorkspaceReadinessContract;
  if (payload.contract_version !== "ci_workspace_readiness_v3") {
    throw new Error("C&I workspace readiness returned an unexpected contract version.");
  }
  if (
    payload.product_id !== "commercial_and_industrial" ||
    !["unavailable", "evidence_limited"].includes(payload.availability) ||
    !Array.isArray(payload.blockers) ||
    payload.blockers.length === 0 ||
    !Array.isArray(payload.workspace_areas) ||
    payload.workspace_areas.length !== expectedWorkspaceIds.length ||
    payload.workspace_areas.some(
      (area, index) =>
        area.workspace_id !== expectedWorkspaceIds[index] ||
        !["unavailable", "input_required", "evidence_limited"].includes(area.availability) ||
        !area.display_label ||
        !area.description,
    )
  ) {
    throw new Error("C&I workspace readiness returned an unsafe availability contract.");
  }
  const evidenceAreaIds = new Set(["data_qc", "tariff_mapping", "kw_kva_pf_evidence"]);
  if (
    payload.availability === "evidence_limited" &&
    (!payload.active_profile_id ||
      !payload.active_profile_label ||
      payload.workspace_areas.some((area) =>
        evidenceAreaIds.has(area.workspace_id)
          ? area.availability !== "evidence_limited"
          : area.availability !== "input_required",
      ))
  ) {
    throw new Error("C&I workspace readiness returned an unsafe evidence profile.");
  }
  return payload;
}

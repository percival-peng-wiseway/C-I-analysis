import type { CiSiteFactors } from "./ci-projects";

export interface CiSiteFactorsState {
  site_factors: CiSiteFactors | null;
  effective_yield_kwh_per_kwp: number | null;
}

export async function saveCiSiteFactors(projectId: string, factors: CiSiteFactors): Promise<CiSiteFactorsState> {
  const response = await fetch(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/site-factors`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(factors),
  });
  if (!response.ok) throw new Error("Site factors could not be saved. Check the values and try again.");
  const result = await response.json() as CiSiteFactorsState;
  if (!result.site_factors || typeof result.effective_yield_kwh_per_kwp !== "number" || !Number.isFinite(result.effective_yield_kwh_per_kwp)) throw new Error("Site factors returned an invalid calculation result.");
  return result;
}

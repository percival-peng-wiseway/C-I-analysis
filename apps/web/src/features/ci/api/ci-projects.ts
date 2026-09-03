import type { CiScenarioInput } from "./ci-scenarios";
import type { CiBatterySolutionProfile, CiInverterSolutionProfile, CiSolarSolutionProfile } from "./ci-device-profile";

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
  design_context: CiDesignContext | null;
  generation_summary?: CiSolutionGenerationSummary;
}

export interface CiExistingSolarAsset {
  installed: boolean;
  brand: string;
  model: string;
  panel_count: number;
  panel_rating_w: number;
  installed_capacity_kwp_dc: number;
  inverter_brand: string;
  inverter_model: string;
  inverter_capacity_kw_ac: number;
  installation_year: number | null;
  operating_status: "operational" | "limited" | "offline" | "unknown";
  included_in_interval_baseline: boolean;
}

export interface CiExistingBatteryAsset {
  installed: boolean;
  brand: string;
  model: string;
  nominal_capacity_kwh: number;
  usable_capacity_kwh: number;
  power_kw: number;
  installation_year: number | null;
  operating_status: "operational" | "limited" | "offline" | "unknown";
  included_in_interval_baseline: boolean;
}

export interface CiTechnicalOptions {
  annual_specific_yield_kwh_per_kw: number;
  shading_loss_percent: number;
  soiling_loss_percent: number;
  temperature_loss_percent: number;
  wiring_mismatch_loss_percent: number;
  other_system_loss_percent: number;
  system_availability_percent: number;
  effective_derating_percent?: number;
  target_dc_ac_ratio: number;
  inverter_block_size_kw: number;
  inverter_quantity?: number;
  site_ac_headroom_kw: number;
  battery_duration_hours: number;
  charge_efficiency_percent: number;
  discharge_efficiency_percent: number;
  minimum_soc_percent: number;
  maximum_soc_percent: number;
  allow_grid_charging: boolean;
  reactive_support_enabled: boolean;
  reactive_support_max_kvar: number;
  grid_emissions_factor_kg_co2e_per_kwh?: number;
  initial_soc_basis?: "full_soc_physical_upper_bound";
}

export interface CiDesignContextV1 {
  contract_version: "ci_design_context_v1";
  existing_solar: CiExistingSolarAsset;
  existing_battery: CiExistingBatteryAsset;
  technical_options: CiTechnicalOptions;
}

export interface CiSolutionRange {
  minimum: number;
  maximum: number;
  step: number;
}

export interface CiSiteFactors {
  resource_basis: "gross_specific_yield_before_site_losses";
  resource_source: "analyst_assumption" | "site_assessment" | "imported_resource_study";
  resource_label: string;
  annual_specific_yield_kwh_per_kw: number;
  array_azimuth_degrees: number;
  array_tilt_degrees: number;
  shading_loss_percent: number;
  soiling_loss_percent: number;
  temperature_loss_percent: number;
  wiring_mismatch_loss_percent: number;
  other_system_loss_percent: number;
  system_availability_percent: number;
}

export interface CiConnectionOptions {
  inverter_block_size_kw: number;
  inverter_quantity?: number;
  site_ac_headroom_kw: number;
  allow_grid_charging: boolean;
  reactive_support_enabled: boolean;
  reactive_support_max_kvar: number;
  grid_emissions_factor_kg_co2e_per_kwh: number | null;
  initial_soc_basis: "full_soc_physical_upper_bound";
}

export interface CiSolutionGenerationRequest {
  contract_version: "ci_solution_generation_request_v1";
  pv_range: {
    minimum_kwp_dc: number;
    maximum_kwp_dc: number;
    step_kwp_dc: number;
  };
  battery_range: {
    minimum_kwh: number;
    maximum_kwh: number;
    step_kwh: number;
  };
  solar_profile_id: string;
  battery_profile_id: string;
  inverter_profile_id?: string;
  site_factors: CiSiteFactors;
  connection_options: CiConnectionOptions;
}

export interface CiDesignContextV2 {
  contract_version: "ci_design_context_v2";
  existing_solar: CiExistingSolarAsset;
  existing_battery: CiExistingBatteryAsset;
  search_space: {
    pv_range: CiSolutionGenerationRequest["pv_range"];
    battery_range: CiSolutionGenerationRequest["battery_range"];
  };
  site_factors: CiSiteFactors & { effective_derating_percent?: number };
  profile_selection: {
    device_profile_sha256: string | null;
    solar_profile_id: string;
    battery_profile_id: string;
    inverter_profile_id?: string;
    solar_profile: CiSolarSolutionProfile;
    battery_profile: CiBatterySolutionProfile;
    inverter_profile?: CiInverterSolutionProfile;
  };
  technical_options: CiTechnicalOptions;
}

export type CiDesignContext = CiDesignContextV1 | CiDesignContextV2;

export interface CiSolutionGenerationSummary {
  requested_count: number;
  generated_candidate_count: number;
  deduplicated_count: number;
  rejected_count: number;
  rejection_reasons: Array<{ code: string; count: number }>;
}

export interface CiCustomDesignCandidateRequest {
  contract_version: "ci_custom_design_candidate_request_v1";
  label: string;
  pv_capacity_kwp_dc: number;
  battery_capacity_kwh: number;
  inverter_capacity_kw_ac: number;
  quoted_net_capex_aud_ex_gst: number;
}

export interface CiCustomDesignCandidateResult extends CiDesignCandidateResult {
  added_scenario_id: string;
  quoted_net_capex_aud_ex_gst: number;
  normalization: {
    requested_pv_capacity_kwp_dc: number;
    actual_pv_capacity_kwp_dc: number;
    requested_battery_capacity_kwh: number;
    actual_battery_capacity_kwh: number;
    requested_inverter_capacity_kw_ac: number;
    actual_inverter_capacity_kw_ac: number;
  };
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
  designContext: CiDesignContext,
  fetcher: typeof fetch = fetch,
): Promise<CiDesignCandidateResult> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-candidates`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ scenarios, design_context: designContext }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Design validation failed."));
  return assertCiDesignCandidateResult(await response.json());
}

export async function generateCiDesignCandidates(
  projectId: string,
  generationRequest: CiSolutionGenerationRequest,
  fetcher: typeof fetch = fetch,
): Promise<CiDesignCandidateResult> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-candidates`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ generation_request: generationRequest }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Solution generation failed."));
  return assertCiDesignCandidateResult(await response.json());
}

export async function addCiCustomDesignCandidate(
  projectId: string,
  request: CiCustomDesignCandidateRequest,
  fetcher: typeof fetch = fetch,
): Promise<CiCustomDesignCandidateResult> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-candidates/custom`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Custom solution could not be added."));
  const payload = await response.json() as CiCustomDesignCandidateResult;
  assertCiDesignCandidateResult(payload);
  if (!payload.added_scenario_id || !Number.isFinite(payload.quoted_net_capex_aud_ex_gst)) {
    throw new Error("Custom solution returned an unexpected contract.");
  }
  return payload;
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
    || (payload.design_context !== null && !["ci_design_context_v1", "ci_design_context_v2"].includes(payload.design_context?.contract_version))
  ) {
    throw new Error("Design validation returned an unsafe contract.");
  }
  return payload;
}

async function errorMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as { detail?: { message?: string } | string | Array<{ msg?: string }> } | null;
  const detail = payload?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item.msg).filter((item): item is string => Boolean(item));
    if (messages.length) return messages.join(" ");
  }
  if (detail && !Array.isArray(detail) && typeof detail === "object" && typeof detail.message === "string" && detail.message.trim()) return detail.message;
  return fallback;
}

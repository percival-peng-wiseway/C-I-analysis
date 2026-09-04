export interface CiScenarioInput {
  scenario_id: string;
  label: string;
  battery_system_id: string;
  battery_technology_id: "generic_li_ion_ac";
  control_profile_id: "demand_peak_shaving";
  pv_system_id: string;
  pv_profile_id: "generic_normalized_solar_shape_v1";
  pv_capacity_kwp_dc: number;
  pv_inverter_capacity_kw_ac: number;
  shared_ac_headroom_kw: number;
  reactive_support_enabled: boolean;
  reactive_support_max_kvar: number;
  shared_inverter_apparent_power_limit_kva: number | null;
  reactive_capability_curve: "circular_pq";
  reactive_capability_provenance: "analyst_assumption";
  reactive_overcompensation_permitted: false;
  pv_annual_specific_yield_kwh_per_kw: number;
  pv_derating_factor: number;
  nominal_capacity_kwh: number;
  max_charge_kw: number;
  max_discharge_kw: number;
  charge_efficiency: number;
  discharge_efficiency: number;
  min_soc_fraction: number;
  max_soc_fraction: number;
  initial_soc_fraction: number;
  allow_grid_charging: boolean;
  grid_emissions_factor_kg_co2e_per_kwh?: number;
}

export interface CiPhysicalScenarioResult {
  contract_version: "ci_physical_scenario_review_v6";
  calculation_revision: "ci_physical_scenario_planner_limits_primal_simplex_v1";
  analysis_status: "ready";
  analysis_mode: "evidence_limited_internal_review";
  customer_facing_permission: false;
  recommendation_permitted: false;
  currency_values_permitted: true;
  ranking_basis: string;
  baseline: {
    raw_rolling_demand_kva: number;
    chargeable_rolling_demand_kva: number;
    incentive_demand_kva: number;
    billing_period_max_kva: number;
    billing_period_max_kw: number;
  };
  scenarios: Array<{
    scenario_id: string;
    label: string;
    physical_review_rank: number;
    authored_inputs: Omit<CiScenarioInput, "scenario_id" | "label">;
    post_dispatch: {
      authority_source: "ci_peak_shaving_rolling_replay_v2" | "ci_pv_only_shared_pq_v1";
      pv_generation_kwh: number;
      pv_curtailed_kwh: number;
      raw_rolling_demand_kva: number;
      chargeable_rolling_demand_kva: number;
      maximum_reactive_support_kvar: number;
      maximum_post_grid_reactive_kvar: number;
      maximum_shared_inverter_apparent_power_kva: number;
      incentive_demand_kva: number | null;
      billing_period_max_kva: number | null;
      billing_period_max_kw: number | null;
      billing_period_peak_kw_reduction: number | null;
      billing_period_peak_effect: "increase" | "reduction" | "unchanged" | "not_evaluated_disjoint_analysis_period";
      billing_period_peak_change_kw: number | null;
      billing_period_projection_status: "evaluated" | "not_evaluated_disjoint_analysis_period";
    };
    dispatch_review_projection: CiDispatchReviewProjection;
    annual_tariff_value: {
      calculation_method: "representative_year_repeat_v1";
      period_start: string;
      period_end: string;
      rate_basis: string;
      baseline_cost_ex_gst_aud: number;
      scenario_cost_ex_gst_aud: number;
      first_year_value_ex_gst_aud: number;
      baseline_cost_inc_gst_aud: number;
      scenario_cost_inc_gst_aud: number;
      first_year_value_inc_gst_aud: number;
      baseline_categories_ex_gst_aud?: Record<string, number>;
      scenario_categories_ex_gst_aud?: Record<string, number>;
      category_savings_ex_gst_aud: Record<string, number>;
      customer_facing_permission: false;
    };
    planned_demand_limits_kva: Array<{
      component_id: string;
      billing_period_id: string | null;
      rate_aud_per_kva: number;
      planner_limit_kva: number | null;
    }>;
    selected_monthly_thresholds_kw: Array<number | null>;
    optimizer_run_snapshot: {
      contract_version: "ci_optimizer_run_snapshot_v2";
      calculation_revision: "ci_optimizer_run_snapshot_planner_limits_primal_simplex_v1";
      snapshot_sha256: string;
      algorithm_id: "ci_peak_shaving_rolling_replay_v2";
      customer_facing_permission: false;
      recommendation_permitted: false;
      input_projection: Record<string, unknown>;
      physical_assumptions: Record<string, unknown>;
      result_projection: Record<string, unknown>;
    } | null;
    optimizer_audit_projection: {
      contract_version: "ci_optimizer_audit_projection_v2";
      snapshot_sha256: string;
      customer_facing_permission: false;
      recommendation_permitted: false;
    } | null;
  }>;
  report_preview: {
    status: "ready";
    output_kind: "in_app_evidence_preview";
    download_available: false;
    sections: string[];
    disclaimer: string;
  };
  assumptions: string[];
}

export interface CiDispatchReviewPoint {
  interval_timestamp: string;
  local_timestamp: string;
  local_time_label: string;
  baseline_import_kw: number;
  post_dispatch_import_kw: number;
  baseline_kva: number;
  post_dispatch_kva: number;
  site_reactive_import_kvar: number;
  inverter_reactive_support_kvar: number;
  post_grid_reactive_kvar: number;
  grid_charge_kw: number;
  pv_charge_kw: number;
  battery_discharge_kw: number;
  soc_end_kwh: number | null;
}

export interface CiDispatchReviewProjection {
  contract_version: "ci_dispatch_review_projection_v2";
  status: "ready";
  selection_basis: "maximum_post_dispatch_rolling_kva_earliest_timestamp";
  peak_local_date: string;
  peak_interval: Pick<CiDispatchReviewPoint, "interval_timestamp" | "local_timestamp" | "baseline_import_kw" | "post_dispatch_import_kw" | "baseline_kva" | "post_dispatch_kva">;
  coverage: {
    interval_minutes: 15;
    interval_count: number;
    start_local_timestamp: string;
    end_local_timestamp: string;
  };
  units: { active_power: "kW"; apparent_power: "kVA"; reactive_power: "kvar"; stored_energy: "kWh" };
  soc_status: "available" | "not_applicable_no_battery";
  authority_source: "ci_peak_shaving_rolling_replay_v2" | "ci_pv_only_shared_pq_v1";
  optimizer_snapshot_sha256: string | null;
  interval_dispatch_sha256: string | null;
  customer_facing_permission: false;
  recommendation_permitted: false;
  points: CiDispatchReviewPoint[];
  projection_sha256: string;
}

export const ciProjectTariffReplayQueryKey = (projectId: string) =>
  ["ci-project-tariff-replay", projectId] as const;

export interface CiSavedTariffReplayState {
  contract_version: "ci_project_tariff_replay_state_v1";
  status: "not_saved" | "ready" | "stale";
  saved_at: string | null;
  stale_reasons: Array<
    | "design_changed"
    | "interval_evidence_changed"
    | "tariff_profile_changed"
    | "result_contract_unsupported"
    | "result_calculation_revision_unsupported"
    | "result_integrity_failed"
  >;
  result: CiPhysicalScenarioResult | null;
}

export interface CiTariffReplayProgress {
  completedScenarioCount: number;
  totalScenarioCount: number;
}

export interface CiTariffReplayRunOptions {
  batchSize?: number;
  onProgress?: (progress: CiTariffReplayProgress) => void;
}

const DEFAULT_TARIFF_REPLAY_BATCH_SIZE = 3;

export type CiThreeCaseId = "no_system" | "pv_only" | "pv_battery";

export interface CiThreeCasePointValues {
  import_kw: number;
  import_kva: number;
  site_reactive_import_kvar: number;
  reactive_support_kvar: number;
  post_grid_reactive_kvar: number;
  grid_charge_kw: number;
  pv_charge_kw: number;
  battery_discharge_kw: number;
  soc_end_kwh: number | null;
}

export interface CiThreeCaseComparisonResult {
  contract_version: "ci_three_case_peak_day_comparison_v2";
  status: "ready";
  analysis_mode: "evidence_limited_internal_review";
  selection_basis: "pv_battery_maximum_post_dispatch_rolling_kva_earliest_timestamp";
  pairing_basis: "explicit_consultant_selected_exact_pv_match";
  common_local_date: string;
  selected_peak_interval_timestamp: string;
  coverage: {
    interval_minutes: 15;
    interval_count: number;
    start_local_timestamp: string;
    end_local_timestamp: string;
    timestamps_aligned: true;
  };
  units: { active_power: "kW"; apparent_power: "kVA"; reactive_power: "kvar"; stored_energy: "kWh" };
  cases: Array<{
    case_id: CiThreeCaseId;
    label: string;
    scenario_id: string | null;
    authority_source: "ci_evidence_bound_baseline_v1" | "ci_pv_only_shared_pq_v1" | "ci_peak_shaving_rolling_replay_v2";
    soc_status: "available" | "not_applicable_no_battery";
    projection_sha256: string | null;
    optimizer_snapshot_sha256: string | null;
    interval_dispatch_sha256: string | null;
  }>;
  baseline: CiPhysicalScenarioResult["baseline"];
  provenance: {
    source_contract_version: "ci_physical_scenario_review_v6";
    profile_id: string;
    profile_source_version: string;
    source_nem12_sha256: string;
    pv_only_scenario_sha256: string;
    pv_battery_scenario_sha256: string;
  };
  customer_facing_permission: false;
  recommendation_permitted: false;
  eligibility_permitted: false;
  report_available: false;
  download_available: false;
  delivery_permitted: false;
  points: Array<{
    interval_timestamp: string;
    local_timestamp: string;
    local_time_label: string;
    no_system: CiThreeCasePointValues;
    pv_only: CiThreeCasePointValues;
    pv_battery: CiThreeCasePointValues;
  }>;
  comparison_sha256: string;
}

export async function analyzeCiPhysicalScenarios(
  file: File,
  scenarios: CiScenarioInput[],
  fetcher: typeof fetch = fetch,
): Promise<CiPhysicalScenarioResult> {
  const body = new FormData();
  body.append("file", file);
  body.append("scenarios", JSON.stringify(scenarios));
  const response = await fetcher(
    "/api/commercial-industrial/powercor-llvt2-physical-scenarios",
    { method: "POST", headers: { Accept: "application/json" }, body },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: { message?: string } }
      | null;
    throw new Error(
      payload?.detail?.message ??
        `C&I physical scenario request failed with status ${response.status}.`,
    );
  }
  return assertCiPhysicalScenarioResult(await response.json());
}

export async function runCiProjectTariffReplay(
  projectId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  scenarioIds?: string[],
  options: CiTariffReplayRunOptions = {},
): Promise<CiPhysicalScenarioResult> {
  const url = `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/tariff-replay`;
  if (scenarioIds === undefined) {
    return postCiProjectTariffReplayBatch({
      fetcher,
      projectId,
      signal,
      url,
    });
  }
  if (
    scenarioIds.length < 1
    || scenarioIds.length > 200
    || new Set(scenarioIds).size !== scenarioIds.length
  ) {
    throw new Error("Select one to 200 unique solutions before running tariff replay.");
  }
  const batchSize = options.batchSize ?? DEFAULT_TARIFF_REPLAY_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("Tariff replay batch size must be a whole number from one to 200.");
  }

  const saved = await loadCiSavedTariffReplayState(projectId, fetcher, signal, true);
  let latestResult = saved.status === "ready" ? saved.result : null;
  let completedIds = completedRequestedScenarioIds(latestResult, scenarioIds);
  options.onProgress?.({
    completedScenarioCount: completedIds.size,
    totalScenarioCount: scenarioIds.length,
  });
  if (completedIds.size === scenarioIds.length && latestResult) return latestResult;

  const missingIds = scenarioIds.filter((scenarioId) => !completedIds.has(scenarioId));
  const batches = chunkScenarioIds(missingIds, batchSize);
  for (const batch of batches) {
    const expectedCheckpointIds = [...completedIds, ...batch];
    latestResult = await postCiProjectTariffReplayBatch({
      fetcher,
      persistenceMode: "merge_checkpoint",
      projectId,
      recoveryScenarioIds: batch,
      scenarioIds: batch,
      signal,
      url,
    });
    if (!hasScenarioCoverage(latestResult, expectedCheckpointIds)) {
      throw new Error("The tariff replay checkpoint changed while the selected solutions were being calculated.");
    }
    completedIds = completedRequestedScenarioIds(latestResult, scenarioIds);
    options.onProgress?.({
      completedScenarioCount: completedIds.size,
      totalScenarioCount: scenarioIds.length,
    });
  }
  if (!latestResult || !hasScenarioCoverage(latestResult, scenarioIds)) {
    throw new Error("The tariff replay checkpoint did not cover every selected solution.");
  }
  return latestResult;
}

async function postCiProjectTariffReplayBatch({
  fetcher,
  persistenceMode,
  projectId,
  recoveryScenarioIds,
  scenarioIds,
  signal,
  url,
}: {
  fetcher: typeof fetch;
  persistenceMode?: "replace" | "merge_checkpoint";
  projectId: string;
  recoveryScenarioIds?: string[];
  scenarioIds?: string[];
  signal?: AbortSignal;
  url: string;
}): Promise<CiPhysicalScenarioResult> {
  const maximumAttempts = recoveryScenarioIds?.length ? 2 : 1;
  let lastFailure: Error | null = null;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...(scenarioIds === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(scenarioIds === undefined ? {} : {
          body: JSON.stringify({
            scenario_ids: scenarioIds,
            persistence_mode: persistenceMode ?? "replace",
          }),
        }),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const recovered = await restoreCompletedTariffReplay(
        projectId,
        recoveryScenarioIds,
        fetcher,
        signal,
      );
      if (recovered) return recovered;
      lastFailure = error instanceof Error ? error : new Error("The tariff replay connection was interrupted.");
      if (attempt + 1 < maximumAttempts) continue;
      throw lastFailure;
    }
    if (response.ok) return assertCiPhysicalScenarioResult(await response.json());

    const payload = await readCiApiFailure(response);
    lastFailure = new Error(
      payload.message ??
      (response.status === 503
        ? "The cloud analysis service became temporarily unavailable before completion could be confirmed. Wait a moment, then run Analysis again."
        : null) ??
      `C&I tariff replay failed with status ${response.status}.`,
    );
    if (isRetryableInfrastructureFailure(response.status, payload.errorCode)) {
      const recovered = await restoreCompletedTariffReplay(
        projectId,
        recoveryScenarioIds,
        fetcher,
        signal,
      );
      if (recovered) return recovered;
      if (attempt + 1 < maximumAttempts) continue;
    }
    throw lastFailure;
  }
  throw lastFailure ?? new Error("Tariff replay failed before completion could be confirmed.");
}

async function readCiApiFailure(
  response: Response,
): Promise<{ errorCode: string | null; message: string | null }> {
  const body = await response.text().catch(() => "");
  if (!body) return { errorCode: null, message: null };
  try {
    const payload = JSON.parse(body) as {
      detail?: { code?: unknown; message?: unknown } | string;
      error_code?: unknown;
      message?: unknown;
    };
    const detailMessage = typeof payload.detail === "object" && payload.detail !== null
      ? payload.detail.message
      : payload.detail;
    return {
      errorCode: typeof payload.error_code === "string"
        ? payload.error_code
        : typeof payload.detail === "object" && payload.detail !== null && typeof payload.detail.code === "string"
          ? payload.detail.code
          : null,
      message: typeof payload.message === "string"
        ? payload.message
        : typeof detailMessage === "string"
          ? detailMessage
          : null,
    };
  } catch {
    return { errorCode: null, message: null };
  }
}

async function restoreCompletedTariffReplay(
  projectId: string,
  requiredScenarioIds: string[] | undefined,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<CiPhysicalScenarioResult | null> {
  if (!requiredScenarioIds?.length) return null;
  try {
    const saved = await fetchCiSavedTariffReplay(projectId, fetcher, signal);
    if (
      saved.status !== "ready"
      || saved.result === null
      || !hasScenarioCoverage(saved.result, requiredScenarioIds)
    ) return null;
    return saved.result;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

function hasScenarioCoverage(
  result: CiPhysicalScenarioResult,
  scenarioIds: string[],
): boolean {
  const available = new Set(result.scenarios.map((scenario) => scenario.scenario_id));
  return scenarioIds.every((scenarioId) => available.has(scenarioId));
}

function completedRequestedScenarioIds(
  result: CiPhysicalScenarioResult | null,
  scenarioIds: string[],
): Set<string> {
  if (!result) return new Set();
  const requested = new Set(scenarioIds);
  return new Set(
    result.scenarios
      .map((scenario) => scenario.scenario_id)
      .filter((scenarioId) => requested.has(scenarioId)),
  );
}

function chunkScenarioIds(scenarioIds: string[], batchSize: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < scenarioIds.length; index += batchSize) {
    chunks.push(scenarioIds.slice(index, index + batchSize));
  }
  return chunks;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryableInfrastructureFailure(
  status: number,
  errorCode: string | null,
): boolean {
  return status === 503 && (
    errorCode === null ||
    errorCode === "container_provisioning" ||
    errorCode === "container_start_timeout" ||
    errorCode === "container_unavailable"
  );
}

export async function fetchCiSavedTariffReplay(
  projectId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CiSavedTariffReplayState> {
  return loadCiSavedTariffReplayState(projectId, fetcher, signal, false);
}

async function loadCiSavedTariffReplayState(
  projectId: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  retryTransientFailure: boolean,
): Promise<CiSavedTariffReplayState> {
  const maximumAttempts = retryTransientFailure ? 2 : 1;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(
        `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/tariff-replay`,
        { headers: { Accept: "application/json" }, signal },
      );
    } catch (error) {
      if (isAbortError(error) || attempt + 1 >= maximumAttempts) throw error;
      continue;
    }
    if (!response.ok) {
      const failurePayload = await readCiApiFailure(response);
      const failure = new Error(
        failurePayload.message
        ?? `Saved C&I tariff replay request failed with status ${response.status}.`,
      );
      if (
        attempt + 1 < maximumAttempts
        && isRetryableInfrastructureFailure(response.status, failurePayload.errorCode)
      ) continue;
      throw failure;
    }
    const payload = (await response.json()) as CiSavedTariffReplayState;
    if (
      payload.contract_version !== "ci_project_tariff_replay_state_v1" ||
      !["not_saved", "ready", "stale"].includes(payload.status) ||
      !Array.isArray(payload.stale_reasons) ||
      (payload.status === "ready" && payload.result === null) ||
      (payload.status !== "ready" && payload.result !== null)
    ) {
      throw new Error("Saved C&I tariff replay returned an unsafe state contract.");
    }
    if (payload.result !== null) {
      payload.result = assertCiPhysicalScenarioResult(payload.result);
    }
    return payload;
  }
  throw new Error("Saved C&I tariff replay could not be loaded.");
}

export function assertCiPhysicalScenarioResult(value: unknown): CiPhysicalScenarioResult {
  const payload = value as CiPhysicalScenarioResult;
  if (
    payload.contract_version !== "ci_physical_scenario_review_v6" ||
    payload.calculation_revision !== "ci_physical_scenario_planner_limits_primal_simplex_v1" ||
    payload.analysis_status !== "ready" ||
    payload.analysis_mode !== "evidence_limited_internal_review" ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    payload.currency_values_permitted !== true ||
    payload.report_preview?.download_available !== false ||
    !Array.isArray(payload.scenarios) ||
    payload.scenarios.length < 1 ||
    payload.scenarios.length > 200 ||
    payload.scenarios.some((item) =>
      item.selected_monthly_thresholds_kw.length !== 12 ||
      item.selected_monthly_thresholds_kw.some((threshold) =>
        threshold !== null && (!Number.isFinite(threshold) || threshold < 0)
      ) ||
      !Array.isArray(item.planned_demand_limits_kva) ||
      item.planned_demand_limits_kva.some((limit) =>
        !limit.component_id ||
        (limit.billing_period_id !== null && !limit.billing_period_id) ||
        !Number.isFinite(limit.rate_aud_per_kva) ||
        limit.rate_aud_per_kva < 0 ||
        (limit.planner_limit_kva !== null &&
          (!Number.isFinite(limit.planner_limit_kva) || limit.planner_limit_kva < 0)) ||
        (limit.rate_aud_per_kva === 0 && limit.planner_limit_kva !== null)
      ) ||
      !hasSafeScenarioAuthority(item) ||
      !hasSafeDispatchReviewProjection(item) ||
      !hasSafeBillingProjection(item) ||
      item.annual_tariff_value?.calculation_method !== "representative_year_repeat_v1" ||
      item.annual_tariff_value.customer_facing_permission !== false ||
      !Number.isFinite(item.annual_tariff_value.first_year_value_ex_gst_aud) ||
      !Number.isFinite(item.annual_tariff_value.first_year_value_inc_gst_aud) ||
      !hasSafeOptionalCategoryComparison(item.annual_tariff_value)
    )
  ) {
    throw new Error("C&I physical scenarios returned an unsafe result contract.");
  }
  return payload;
}

function isFiniteMoneyMap(value: unknown): value is Record<string, number> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([key, item]) => key.length > 0 && typeof item === "number" && Number.isFinite(item),
    ),
  );
}

function hasSafeOptionalCategoryComparison(
  value: CiPhysicalScenarioResult["scenarios"][number]["annual_tariff_value"],
): boolean {
  const baseline = value.baseline_categories_ex_gst_aud;
  const scenario = value.scenario_categories_ex_gst_aud;
  if (baseline === undefined && scenario === undefined) return true;
  if (!isFiniteMoneyMap(baseline) || !isFiniteMoneyMap(scenario)) return false;
  const baselineKeys = Object.keys(baseline).sort();
  const scenarioKeys = Object.keys(scenario).sort();
  return baselineKeys.length === scenarioKeys.length && baselineKeys.every((key, index) => key === scenarioKeys[index]);
}

export async function analyzeCiThreeCaseComparison(
  file: File,
  scenarios: CiScenarioInput[],
  selection: { pvOnlyScenarioId: string; pvBatteryScenarioId: string },
  fetcher: typeof fetch = fetch,
): Promise<CiThreeCaseComparisonResult> {
  const body = new FormData();
  body.append("file", file);
  body.append("scenarios", JSON.stringify(scenarios));
  body.append("pv_only_scenario_id", selection.pvOnlyScenarioId);
  body.append("pv_battery_scenario_id", selection.pvBatteryScenarioId);
  const response = await fetcher(
    "/api/commercial-industrial/powercor-llvt2-three-case-comparison",
    { method: "POST", headers: { Accept: "application/json" }, body },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: { message?: string } }
      | null;
    throw new Error(
      payload?.detail?.message ??
        `C&I three-case comparison request failed with status ${response.status}.`,
    );
  }
  const payload = (await response.json()) as CiThreeCaseComparisonResult;
  if (!hasSafeThreeCaseComparison(payload, selection)) {
    throw new Error("C&I three-case comparison returned an unsafe result contract.");
  }
  return payload;
}

function hasSafeThreeCaseComparison(
  payload: CiThreeCaseComparisonResult,
  selection: { pvOnlyScenarioId: string; pvBatteryScenarioId: string },
): boolean {
  const sha = (value: string | null) => value === null || /^[0-9a-f]{64}$/.test(value);
  if (
    payload.contract_version !== "ci_three_case_peak_day_comparison_v2" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "evidence_limited_internal_review" ||
    payload.selection_basis !== "pv_battery_maximum_post_dispatch_rolling_kva_earliest_timestamp" ||
    payload.pairing_basis !== "explicit_consultant_selected_exact_pv_match" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(payload.common_local_date) ||
    !Number.isFinite(Date.parse(payload.selected_peak_interval_timestamp)) ||
    payload.coverage?.interval_minutes !== 15 ||
    payload.coverage.timestamps_aligned !== true ||
    !Number.isInteger(payload.coverage.interval_count) ||
    payload.coverage.interval_count < 1 ||
    payload.coverage.interval_count > 100 ||
    payload.coverage.interval_count !== payload.points?.length ||
    !Number.isFinite(Date.parse(payload.coverage.start_local_timestamp)) ||
    !Number.isFinite(Date.parse(payload.coverage.end_local_timestamp)) ||
    payload.units?.active_power !== "kW" ||
    payload.units?.apparent_power !== "kVA" ||
    payload.units?.reactive_power !== "kvar" ||
    payload.units?.stored_energy !== "kWh" ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    payload.eligibility_permitted !== false ||
    payload.report_available !== false ||
    payload.download_available !== false ||
    payload.delivery_permitted !== false ||
    !/^[0-9a-f]{64}$/.test(payload.comparison_sha256) ||
    payload.provenance?.source_contract_version !== "ci_physical_scenario_review_v6" ||
    !payload.provenance.profile_id || !payload.provenance.profile_source_version ||
    ![payload.provenance.source_nem12_sha256, payload.provenance.pv_only_scenario_sha256, payload.provenance.pv_battery_scenario_sha256].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    ![payload.baseline?.raw_rolling_demand_kva, payload.baseline?.chargeable_rolling_demand_kva, payload.baseline?.incentive_demand_kva, payload.baseline?.billing_period_max_kva, payload.baseline?.billing_period_max_kw].every((value) => Number.isFinite(value) && Number(value) >= 0)
  ) return false;
  if (!Array.isArray(payload.cases)) return false;
  const [noSystem, pvOnly, pvBattery] = payload.cases;
  if (
    payload.cases.length !== 3 ||
    noSystem?.case_id !== "no_system" || !noSystem.label || noSystem.scenario_id !== null ||
    noSystem.authority_source !== "ci_evidence_bound_baseline_v1" ||
    noSystem.soc_status !== "not_applicable_no_battery" ||
    [noSystem.projection_sha256, noSystem.optimizer_snapshot_sha256, noSystem.interval_dispatch_sha256].some((value) => value !== null) ||
    pvOnly?.case_id !== "pv_only" || !pvOnly.label || pvOnly.scenario_id !== selection.pvOnlyScenarioId ||
    pvOnly.authority_source !== "ci_pv_only_shared_pq_v1" ||
    pvOnly.soc_status !== "not_applicable_no_battery" ||
    !sha(pvOnly.projection_sha256) || pvOnly.projection_sha256 === null ||
    pvOnly.optimizer_snapshot_sha256 !== null || pvOnly.interval_dispatch_sha256 !== null ||
    pvBattery?.case_id !== "pv_battery" || !pvBattery.label || pvBattery.scenario_id !== selection.pvBatteryScenarioId ||
    pvBattery.authority_source !== "ci_peak_shaving_rolling_replay_v2" ||
    pvBattery.soc_status !== "available" ||
    [pvBattery.projection_sha256, pvBattery.optimizer_snapshot_sha256, pvBattery.interval_dispatch_sha256].some((value) => !sha(value) || value === null)
  ) return false;
  if (
    payload.coverage.start_local_timestamp !== payload.points[0]?.local_timestamp ||
    payload.coverage.end_local_timestamp !== payload.points.at(-1)?.local_timestamp ||
    !payload.points.some((point) => point.interval_timestamp === payload.selected_peak_interval_timestamp)
  ) return false;
  return payload.points.every((point, index) => {
    const cases = [point.no_system, point.pv_only, point.pv_battery];
    return Number.isFinite(Date.parse(point.interval_timestamp)) &&
      Number.isFinite(Date.parse(point.local_timestamp)) &&
      point.local_timestamp.slice(0, 10) === payload.common_local_date &&
      point.local_time_label.length > 0 &&
      (index === 0 || Date.parse(point.interval_timestamp) > Date.parse(payload.points[index - 1].interval_timestamp)) &&
      cases.every((item) => item &&
        [item.import_kw, item.import_kva, item.site_reactive_import_kvar, item.reactive_support_kvar, item.post_grid_reactive_kvar, item.grid_charge_kw, item.pv_charge_kw, item.battery_discharge_kw, ...(item.soc_end_kwh === null ? [] : [item.soc_end_kwh])].every(Number.isFinite) &&
        [item.import_kw, item.import_kva, item.site_reactive_import_kvar, item.reactive_support_kvar, item.post_grid_reactive_kvar, item.grid_charge_kw, item.pv_charge_kw, item.battery_discharge_kw, ...(item.soc_end_kwh === null ? [] : [item.soc_end_kwh])].every((value) => value >= 0) &&
        item.reactive_support_kvar <= item.site_reactive_import_kvar + 1e-6 &&
        Math.abs(item.post_grid_reactive_kvar - (item.site_reactive_import_kvar - item.reactive_support_kvar)) <= 1e-6
      ) &&
      point.no_system.soc_end_kwh === null && point.pv_only.soc_end_kwh === null &&
      [point.no_system, point.pv_only].every((item) => item.grid_charge_kw === 0 && item.pv_charge_kw === 0 && item.battery_discharge_kw === 0) &&
      point.pv_battery.soc_end_kwh !== null;
  });
}

function hasSafeBillingProjection(
  item: CiPhysicalScenarioResult["scenarios"][number],
): boolean {
  const projection = item.post_dispatch;
  const authored = item.authored_inputs;
  const apparentLimit = authored.reactive_support_enabled
    ? authored.shared_inverter_apparent_power_limit_kva
    : authored.shared_ac_headroom_kw;
  if (
    ![
      projection.maximum_reactive_support_kvar,
      projection.maximum_post_grid_reactive_kvar,
      projection.maximum_shared_inverter_apparent_power_kva,
    ].every((value) => Number.isFinite(value) && value >= 0) ||
    projection.maximum_reactive_support_kvar >
      authored.reactive_support_max_kvar + 1e-6 ||
    typeof apparentLimit !== "number" ||
    !Number.isFinite(apparentLimit) ||
    projection.maximum_shared_inverter_apparent_power_kva >
      apparentLimit + 1e-6
  ) return false;
  if (projection.billing_period_projection_status === "not_evaluated_disjoint_analysis_period") {
    return projection.incentive_demand_kva === null &&
      projection.billing_period_max_kva === null &&
      projection.billing_period_max_kw === null &&
      projection.billing_period_peak_kw_reduction === null &&
      projection.billing_period_peak_effect === "not_evaluated_disjoint_analysis_period" &&
      projection.billing_period_peak_change_kw === null;
  }
  return projection.billing_period_projection_status === "evaluated" &&
    Number.isFinite(projection.incentive_demand_kva) &&
    Number.isFinite(projection.billing_period_max_kva) &&
    Number.isFinite(projection.billing_period_max_kw) &&
    Number.isFinite(projection.billing_period_peak_kw_reduction) &&
    projection.billing_period_peak_effect !== "not_evaluated_disjoint_analysis_period" &&
    Number.isFinite(projection.billing_period_peak_change_kw);
}

function hasSafeScenarioAuthority(
  item: CiPhysicalScenarioResult["scenarios"][number],
): boolean {
  const reactive = item.authored_inputs;
  const safeReactive = reactive.reactive_capability_curve === "circular_pq" &&
    reactive.reactive_capability_provenance === "analyst_assumption" &&
    reactive.reactive_overcompensation_permitted === false &&
    (reactive.reactive_support_enabled
      ? Number.isFinite(reactive.reactive_support_max_kvar) && reactive.reactive_support_max_kvar > 0 && typeof reactive.shared_inverter_apparent_power_limit_kva === "number" && Number.isFinite(reactive.shared_inverter_apparent_power_limit_kva) && reactive.shared_inverter_apparent_power_limit_kva > 0
      : reactive.reactive_support_max_kvar === 0 && reactive.shared_inverter_apparent_power_limit_kva === null);
  if (!safeReactive) return false;
  if (item.post_dispatch?.authority_source === "ci_pv_only_shared_pq_v1") {
    return item.authored_inputs.nominal_capacity_kwh === 0 &&
      item.optimizer_run_snapshot === null &&
      item.optimizer_audit_projection === null;
  }
  return item.post_dispatch?.authority_source === "ci_peak_shaving_rolling_replay_v2" &&
    item.optimizer_run_snapshot?.contract_version === "ci_optimizer_run_snapshot_v2" &&
    item.optimizer_run_snapshot.calculation_revision === "ci_optimizer_run_snapshot_planner_limits_primal_simplex_v1" &&
    item.optimizer_run_snapshot.customer_facing_permission === false &&
    item.optimizer_run_snapshot.recommendation_permitted === false &&
    item.optimizer_audit_projection?.contract_version === "ci_optimizer_audit_projection_v2" &&
    item.optimizer_audit_projection.snapshot_sha256 === item.optimizer_run_snapshot.snapshot_sha256 &&
    item.optimizer_audit_projection.customer_facing_permission === false &&
    item.optimizer_audit_projection.recommendation_permitted === false;
}

function hasSafeDispatchReviewProjection(
  item: CiPhysicalScenarioResult["scenarios"][number],
): boolean {
  const projection = item.dispatch_review_projection;
  if (
    !projection ||
    projection.contract_version !== "ci_dispatch_review_projection_v2" ||
    projection.status !== "ready" ||
    projection.selection_basis !== "maximum_post_dispatch_rolling_kva_earliest_timestamp" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(projection.peak_local_date) ||
    projection.coverage?.interval_minutes !== 15 ||
    projection.coverage.interval_count !== projection.points?.length ||
    !Number.isInteger(projection.coverage.interval_count) ||
    !Number.isFinite(Date.parse(projection.coverage.start_local_timestamp)) ||
    !Number.isFinite(Date.parse(projection.coverage.end_local_timestamp)) ||
    projection.coverage.interval_count < 1 ||
    projection.coverage.interval_count > 100 ||
    projection.units?.active_power !== "kW" ||
    projection.units?.apparent_power !== "kVA" ||
    projection.units?.reactive_power !== "kvar" ||
    projection.units?.stored_energy !== "kWh" ||
    projection.customer_facing_permission !== false ||
    projection.recommendation_permitted !== false ||
    !/^[0-9a-f]{64}$/.test(projection.projection_sha256) ||
    !projection.points.every((point) =>
      Number.isFinite(Date.parse(point.interval_timestamp)) &&
      Number.isFinite(Date.parse(point.local_timestamp)) &&
      point.local_timestamp.slice(0, 10) === projection.peak_local_date &&
      point.local_time_label.length > 0 &&
      [point.baseline_import_kw, point.post_dispatch_import_kw, point.baseline_kva, point.post_dispatch_kva, point.site_reactive_import_kvar, point.inverter_reactive_support_kvar, point.post_grid_reactive_kvar, point.grid_charge_kw, point.pv_charge_kw, point.battery_discharge_kw, ...(point.soc_end_kwh === null ? [] : [point.soc_end_kwh])].every(Number.isFinite) &&
      [point.site_reactive_import_kvar, point.inverter_reactive_support_kvar, point.post_grid_reactive_kvar, point.grid_charge_kw, point.pv_charge_kw, point.battery_discharge_kw].every((value) => value >= 0) &&
      point.inverter_reactive_support_kvar <= point.site_reactive_import_kvar + 1e-6 &&
      Math.abs(point.post_grid_reactive_kvar - (point.site_reactive_import_kvar - point.inverter_reactive_support_kvar)) <= 1e-6,
    )
  ) return false;
  if (
    projection.coverage.start_local_timestamp !== projection.points[0]?.local_timestamp ||
    projection.coverage.end_local_timestamp !== projection.points.at(-1)?.local_timestamp
  ) return false;
  const peakPoint = projection.points.find(
    (point) => point.interval_timestamp === projection.peak_interval?.interval_timestamp,
  );
  if (
    !peakPoint ||
    projection.peak_interval.local_timestamp !== peakPoint.local_timestamp ||
    projection.peak_interval.baseline_import_kw !== peakPoint.baseline_import_kw ||
    projection.peak_interval.post_dispatch_import_kw !== peakPoint.post_dispatch_import_kw ||
    projection.peak_interval.baseline_kva !== peakPoint.baseline_kva ||
    projection.peak_interval.post_dispatch_kva !== peakPoint.post_dispatch_kva
  ) return false;
  const battery = item.authored_inputs.nominal_capacity_kwh > 0;
  if (
    projection.soc_status !== (battery ? "available" : "not_applicable_no_battery") ||
    projection.points.some((point) => battery ? point.soc_end_kwh === null : point.soc_end_kwh !== null) ||
    projection.authority_source !== item.post_dispatch.authority_source
  ) return false;
  if (battery) {
    return /^[0-9a-f]{64}$/.test(projection.optimizer_snapshot_sha256 ?? "") &&
      /^[0-9a-f]{64}$/.test(projection.interval_dispatch_sha256 ?? "") &&
      projection.optimizer_snapshot_sha256 === item.optimizer_run_snapshot?.snapshot_sha256 &&
      projection.interval_dispatch_sha256 === item.optimizer_run_snapshot?.result_projection?.interval_dispatch_sha256;
  }
  return projection.optimizer_snapshot_sha256 === null &&
    projection.interval_dispatch_sha256 === null &&
    projection.points.every((point) => point.grid_charge_kw === 0 && point.pv_charge_kw === 0 && point.battery_discharge_kw === 0);
}

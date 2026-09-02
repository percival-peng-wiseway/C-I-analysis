import type { CiScenarioInput } from "./ci-scenarios";

export interface CiFeasibilityEnergyTotals {
  site_import_before_kwh: number;
  grid_import_after_pv_only_kwh: number;
  grid_import_after_kwh: number;
  grid_import_reduction_kwh: number;
  grid_import_reduction_percent: number;
  pv_generation_kwh: number;
  pv_direct_to_load_kwh: number;
  pv_to_battery_kwh: number;
  grid_export_kwh: number;
  pv_clipped_kwh: number;
  pv_self_consumption_percent: number;
  battery_charge_input_kwh: number;
  battery_discharge_output_kwh: number;
  battery_equivalent_full_cycles: number;
  battery_active_days: number;
  battery_active_day_percent: number;
  grid_emissions_factor_kg_co2e_per_kwh?: number;
  baseline_scope_2_emissions_t_co2e?: number;
  post_system_scope_2_emissions_t_co2e?: number;
  avoided_scope_2_emissions_t_co2e?: number;
  scope_2_emissions_reduction_percent?: number;
}

export interface CiFeasibilityPeakEvent {
  rank: number;
  timestamp: string;
  baseline_kw: number;
  pv_only_import_kw: number;
  grid_import_kw: number;
  reduction_kw: number;
  reduction_percent: number;
  mitigated: boolean;
}

export interface CiFeasibilityPerformance {
  dispatch_basis: "pv_first_coverage_dispatch";
  baseline_peak_kw: number;
  pv_only_peak_kw: number;
  grid_import_peak_kw: number;
  grid_import_peak_reduction_kw: number;
  grid_import_peak_reduction_percent: number;
  top_10_event_count: number;
  top_10_events_mitigated: number;
  top_10_event_coverage_percent: number;
  top_20_event_count: number;
  top_20_events_mitigated: number;
  top_20_event_coverage_percent: number;
  battery_duration_at_max_discharge_hours: number;
  battery_power_to_peak_percent: number;
  minimum_observed_soc_kwh: number | null;
  maximum_observed_soc_kwh: number | null;
  top_peak_events: CiFeasibilityPeakEvent[];
}

export interface CiFeasibilityPeakPoint {
  timestamp: string;
  time_label: string;
  baseline_kw: number;
  pv_only_import_kw: number;
  pv_battery_import_kw: number;
  pv_generation_kw: number;
  battery_charge_kw: number;
  battery_discharge_kw: number;
  soc_kwh: number | null;
}

export type CiIntervalActivityDays = 1 | 3 | 7;

export interface CiIntervalActivityPoint {
  timestamp: string;
  time_label: string;
  measured_import_kw: number;
  grid_import_kw: number;
  solar_to_load_kw: number;
  grid_export_kw: number;
}

export interface CiIntervalActivityResult {
  contract_version: "ci_interval_activity_v1";
  status: "ready";
  analysis_mode: "pre_tariff_physical_interval_activity";
  scenario_id: string;
  scenario_label: string;
  interval_minutes: 15 | 30;
  time_basis: string;
  range: {
    requested_start_date: string;
    requested_days: CiIntervalActivityDays;
    effective_start_timestamp: string;
    effective_end_timestamp: string;
    interval_count: number;
    complete: boolean;
  };
  points: CiIntervalActivityPoint[];
  customer_facing_permission: false;
  recommendation_permitted: false;
  tariff_evaluated: false;
  billing_demand_interpretation_permitted: false;
}

export interface CiFeasibilityScenario {
  scenario_id: string;
  label: string;
  physical_review_rank: number;
  authored_inputs: CiScenarioInput;
  energy_dispatch_algorithm_id: "ci_pre_tariff_pv_self_consumption_v1";
  yearly_energy: Array<CiFeasibilityEnergyTotals & { year: number; performance: CiFeasibilityPerformance }>;
  coverage_energy: CiFeasibilityEnergyTotals;
  coverage_performance: CiFeasibilityPerformance;
  initial_soc_kwh: number | null;
  final_soc_kwh: number | null;
  peak_day: {
    algorithm_id: "ci_pre_tariff_peak_day_envelope_v2";
    date: string;
    baseline_peak_kw: number;
    pv_only_peak_kw: number;
    achieved_peak_kw: number;
    sampled_target_kw: number | null;
    peak_reduction_kw: number;
    peak_reduction_percent: number;
    points: CiFeasibilityPeakPoint[];
    grid_charging_permitted: false;
    billing_demand_interpretation_permitted: false;
  };
  customer_facing_permission: false;
  recommendation_permitted: false;
}

export interface CiDesignFeasibilityResult {
  contract_version: "ci_design_feasibility_v5";
  status: "ready";
  analysis_mode: "pre_tariff_physical_feasibility";
  customer_facing_permission: false;
  recommendation_permitted: false;
  tariff_evaluated: false;
  currency_values_permitted: false;
  coverage: {
    input_format: "nem12_standard" | "wide_interval_30_minute";
    interval_minutes: 15 | 30;
    interval_count: number;
    start_timestamp: string;
    end_timestamp: string;
    time_basis: string;
    years: Array<{ year: number; interval_count: number; complete_calendar_year: boolean }>;
    primary_year: number;
  };
  baseline: {
    peak_date: string;
    peak_kw: number;
    peak_timestamp: string;
    daily_profile_cloud: {
      sampled_daily_profiles: Array<{ date: string; values_kw: number[] }>;
      average_day_kw: number[];
      selected_peak_day_kw: number[];
      time_labels: string[];
    };
  };
  physical_review_order: {
    algorithm_id: "ci_pre_tariff_physical_review_order_v2";
    shortlist_count: number;
    basis: string;
    recommendation_permitted: false;
  };
  scenarios: CiFeasibilityScenario[];
  assumptions: string[];
}

export type CiFeasibilityStaleReason =
  | "design_changed"
  | "interval_evidence_changed"
  | "result_contract_unsupported"
  | "result_integrity_failed";

export interface CiSavedFeasibilityState {
  contract_version: "ci_project_feasibility_state_v1";
  status: "not_saved" | "ready" | "stale";
  saved_at: string | null;
  stale_reasons: CiFeasibilityStaleReason[];
  result: CiDesignFeasibilityResult | null;
}

export const ciSavedFeasibilityQueryKey = (projectId: string) => ["ci-project-feasibility", projectId] as const;

export async function runCiDesignFeasibility(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiDesignFeasibilityResult> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-feasibility`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Feasibility analysis failed with status ${response.status}.`);
  }
  return assertCiDesignFeasibility(await response.json());
}

export async function fetchCiSavedFeasibility(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiSavedFeasibilityState> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-feasibility`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Saved feasibility could not be loaded (${response.status}).`);
  }
  return assertCiSavedFeasibilityState(await response.json());
}

export async function fetchCiIntervalActivity(
  projectId: string,
  request: { scenario_id: string; start_date: string; days: CiIntervalActivityDays },
  fetcher: typeof fetch = fetch,
): Promise<CiIntervalActivityResult> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-feasibility/interval-activity`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Interval activity failed with status ${response.status}.`);
  }
  return assertCiIntervalActivity(await response.json());
}

export function assertCiDesignFeasibility(value: unknown): CiDesignFeasibilityResult {
  const payload = value as CiDesignFeasibilityResult;
  if (
    payload.contract_version !== "ci_design_feasibility_v5" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "pre_tariff_physical_feasibility" ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    payload.tariff_evaluated !== false ||
    payload.currency_values_permitted !== false ||
    ![15, 30].includes(payload.coverage?.interval_minutes) ||
    !Number.isInteger(payload.coverage?.interval_count) ||
    payload.coverage.interval_count < 2 ||
    !Number.isFinite(Date.parse(payload.coverage?.start_timestamp)) ||
    !Number.isFinite(Date.parse(payload.coverage?.end_timestamp)) ||
    !Number.isInteger(payload.coverage?.primary_year) ||
    !safeSeries(payload.baseline?.daily_profile_cloud?.average_day_kw) ||
    !safeSeries(payload.baseline?.daily_profile_cloud?.selected_peak_day_kw) ||
    payload.baseline.daily_profile_cloud.average_day_kw.length !== 1440 / payload.coverage.interval_minutes ||
    payload.baseline.daily_profile_cloud.selected_peak_day_kw.length !== 1440 / payload.coverage.interval_minutes ||
    payload.physical_review_order?.algorithm_id !== "ci_pre_tariff_physical_review_order_v2" ||
    payload.physical_review_order.recommendation_permitted !== false ||
    !Number.isInteger(payload.physical_review_order.shortlist_count) ||
    payload.physical_review_order.shortlist_count < 1 ||
    payload.physical_review_order.shortlist_count > 10 ||
    typeof payload.physical_review_order.basis !== "string" ||
    !payload.physical_review_order.basis ||
    !Array.isArray(payload.scenarios) ||
    payload.scenarios.length < 1 ||
    payload.scenarios.length > 200 ||
    payload.physical_review_order.shortlist_count !== Math.min(10, payload.scenarios.length) ||
    payload.scenarios.some((scenario, index) =>
      scenario.physical_review_rank !== index + 1 ||
      scenario.customer_facing_permission !== false ||
      scenario.recommendation_permitted !== false ||
      scenario.energy_dispatch_algorithm_id !== "ci_pre_tariff_pv_self_consumption_v1" ||
      scenario.peak_day?.algorithm_id !== "ci_pre_tariff_peak_day_envelope_v2" ||
      scenario.peak_day.date !== payload.baseline.peak_date ||
      scenario.peak_day.grid_charging_permitted !== false ||
      scenario.peak_day.billing_demand_interpretation_permitted !== false ||
      ![
        scenario.peak_day.baseline_peak_kw,
        scenario.peak_day.pv_only_peak_kw,
        scenario.peak_day.achieved_peak_kw,
        scenario.peak_day.peak_reduction_kw,
        scenario.peak_day.peak_reduction_percent,
      ].every((item) => Number.isFinite(item) && item >= 0) ||
      !Array.isArray(scenario.peak_day.points) ||
      scenario.peak_day.points.length !== 1440 / payload.coverage.interval_minutes ||
      scenario.peak_day.points.some((point) =>
        !Number.isFinite(Date.parse(point.timestamp)) ||
        !safeSeries([
          point.baseline_kw,
          point.pv_only_import_kw,
          point.pv_battery_import_kw,
          point.pv_generation_kw,
          point.battery_charge_kw,
          point.battery_discharge_kw,
        ]) ||
        (point.soc_kwh !== null && (!Number.isFinite(point.soc_kwh) || point.soc_kwh < 0))
      ) ||
      !safeTotals(scenario.coverage_energy) ||
      !safePerformance(scenario.coverage_performance) ||
      !scenario.yearly_energy.every((item) => safeTotals(item) && safePerformance(item.performance))
    )
  ) {
    throw new Error("Feasibility analysis returned an unsafe result contract.");
  }
  return payload;
}

export function assertCiSavedFeasibilityState(value: unknown): CiSavedFeasibilityState {
  const payload = value as CiSavedFeasibilityState;
  const knownReasons = new Set<CiFeasibilityStaleReason>([
    "design_changed",
    "interval_evidence_changed",
    "result_contract_unsupported",
    "result_integrity_failed",
  ]);
  const validSavedAt = typeof payload.saved_at === "string" && Number.isFinite(Date.parse(payload.saved_at));
  if (
    payload.contract_version !== "ci_project_feasibility_state_v1" ||
    !["not_saved", "ready", "stale"].includes(payload.status) ||
    !Array.isArray(payload.stale_reasons) ||
    payload.stale_reasons.some((reason) => !knownReasons.has(reason)) ||
    (payload.status === "not_saved" && (payload.saved_at !== null || payload.result !== null || payload.stale_reasons.length !== 0)) ||
    (payload.status === "stale" && (!validSavedAt || payload.result !== null || payload.stale_reasons.length === 0)) ||
    (payload.status === "ready" && (!validSavedAt || payload.result === null || payload.stale_reasons.length !== 0))
  ) {
    throw new Error("Saved feasibility returned an unsafe state contract.");
  }
  if (payload.status === "ready") assertCiDesignFeasibility(payload.result);
  return payload;
}

export function assertCiIntervalActivity(value: unknown): CiIntervalActivityResult {
  const payload = value as CiIntervalActivityResult;
  const maximumPoints = payload.range?.requested_days * 1440 / payload.interval_minutes;
  if (
    payload.contract_version !== "ci_interval_activity_v1" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "pre_tariff_physical_interval_activity" ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    payload.tariff_evaluated !== false ||
    payload.billing_demand_interpretation_permitted !== false ||
    ![15, 30].includes(payload.interval_minutes) ||
    ![1, 3, 7].includes(payload.range?.requested_days) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(payload.range?.requested_start_date) ||
    !Number.isFinite(Date.parse(payload.range?.effective_start_timestamp)) ||
    !Number.isFinite(Date.parse(payload.range?.effective_end_timestamp)) ||
    !Array.isArray(payload.points) ||
    payload.points.length < 1 ||
    payload.points.length > maximumPoints ||
    payload.range.interval_count !== payload.points.length ||
    typeof payload.range.complete !== "boolean" ||
    payload.points.some((point, index) =>
      !Number.isFinite(Date.parse(point.timestamp)) ||
      (index > 0 && Date.parse(point.timestamp) <= Date.parse(payload.points[index - 1].timestamp)) ||
      !safeSeries([
        point.measured_import_kw,
        point.grid_import_kw,
        point.solar_to_load_kw,
        point.grid_export_kw,
      ])
    )
  ) {
    throw new Error("Interval activity returned an unsafe result contract.");
  }
  return payload;
}

function safeSeries(values: number[]): boolean {
  return Array.isArray(values) && values.every((item) => Number.isFinite(item) && item >= 0);
}

function safeTotals(value: CiFeasibilityEnergyTotals): boolean {
  const nonnegative = [
    value?.site_import_before_kwh,
    value?.grid_import_after_pv_only_kwh,
    value?.grid_import_after_kwh,
    value?.grid_import_reduction_kwh,
    value?.grid_import_reduction_percent,
    value?.pv_generation_kwh,
    value?.pv_direct_to_load_kwh,
    value?.pv_to_battery_kwh,
    value?.grid_export_kwh,
    value?.pv_clipped_kwh,
    value?.pv_self_consumption_percent,
    value?.battery_charge_input_kwh,
    value?.battery_discharge_output_kwh,
    value?.battery_equivalent_full_cycles,
    value?.battery_active_days,
    value?.battery_active_day_percent,
  ].every((item) => Number.isFinite(item) && item >= 0);
  const carbonValues = [
    value.grid_emissions_factor_kg_co2e_per_kwh,
    value.baseline_scope_2_emissions_t_co2e,
    value.post_system_scope_2_emissions_t_co2e,
    value.avoided_scope_2_emissions_t_co2e,
    value.scope_2_emissions_reduction_percent,
  ];
  const carbonSafe = carbonValues.every((item) => item === undefined) || carbonValues.every((item) => Number.isFinite(item) && Number(item) >= 0);
  return nonnegative && carbonSafe &&
    value.grid_import_reduction_percent <= 100 &&
    value.pv_self_consumption_percent <= 100 &&
    value.battery_active_day_percent <= 100 &&
    (value.scope_2_emissions_reduction_percent === undefined || value.scope_2_emissions_reduction_percent <= 100) &&
    Number.isInteger(value.battery_active_days);
}

function safePerformance(value: CiFeasibilityPerformance): boolean {
  if (
    value?.dispatch_basis !== "pv_first_coverage_dispatch" ||
    ![
      value.baseline_peak_kw,
      value.pv_only_peak_kw,
      value.grid_import_peak_kw,
      value.grid_import_peak_reduction_kw,
      value.grid_import_peak_reduction_percent,
      value.top_10_event_count,
      value.top_10_events_mitigated,
      value.top_10_event_coverage_percent,
      value.top_20_event_count,
      value.top_20_events_mitigated,
      value.top_20_event_coverage_percent,
      value.battery_duration_at_max_discharge_hours,
      value.battery_power_to_peak_percent,
    ].every((item) => Number.isFinite(item) && item >= 0) ||
    value.top_10_events_mitigated > value.top_10_event_count ||
    value.top_20_events_mitigated > value.top_20_event_count ||
    ![
      value.top_10_event_count,
      value.top_10_events_mitigated,
      value.top_20_event_count,
      value.top_20_events_mitigated,
    ].every(Number.isInteger) ||
    value.grid_import_peak_reduction_percent > 100 ||
    value.top_10_event_coverage_percent > 100 ||
    value.top_20_event_coverage_percent > 100 ||
    (value.minimum_observed_soc_kwh !== null && (!Number.isFinite(value.minimum_observed_soc_kwh) || value.minimum_observed_soc_kwh < 0)) ||
    (value.maximum_observed_soc_kwh !== null && (!Number.isFinite(value.maximum_observed_soc_kwh) || value.maximum_observed_soc_kwh < 0)) ||
    !Array.isArray(value.top_peak_events) ||
    value.top_peak_events.length > 20 ||
    value.top_peak_events.some((event, index) =>
      event.rank !== index + 1 ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      ![
        event.baseline_kw,
        event.pv_only_import_kw,
        event.grid_import_kw,
        event.reduction_kw,
        event.reduction_percent,
      ].every((item) => Number.isFinite(item) && item >= 0) ||
      event.reduction_percent > 100 ||
      typeof event.mitigated !== "boolean"
    )
  ) return false;
  return true;
}

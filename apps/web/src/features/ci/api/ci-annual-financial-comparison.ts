export interface CiAnnualFinancialComparisonSolution {
  inverter_pricing?: CiInverterPricing | null;
  scenario_id: string;
  label: string;
  physical_review_rank: number;
  financial_review_rank: number;
  pv_capacity_kwp_dc: number;
  battery_capacity_kwh: number;
  inverter_capacity_kw_ac: number;
  dispatch_topology?: "shared_hybrid_dc" | "separate_ac";
  pv_inverter_capacity_kw_ac?: number;
  battery_inverter_capacity_kw_ac?: number | null;
  gross_upfront_cost_aud_ex_gst: number;
  upfront_rebate_aud_ex_gst: number;
  upfront_cost_aud_ex_gst: number;
  rebate_application_status: "applied_to_device_profile_gross_cost" | "not_applied_to_manual_quote";
  rebate_breakdown: CiAnnualFinancialRebateBreakdown[];
  rebate_calculation: CiScenarioRebateCalculation;
  capex_breakdown_aud_ex_gst: {
    pv_aud: number;
    battery_aud: number;
    inverter_aud: number;
  } | null;
  annual_om_cost_aud_ex_gst: number;
  first_year_value_aud_ex_gst: number;
  annual_cost_aud_ex_gst: number;
  metrics: {
    projection_method?: "representative_year_aggregate_value_projection_v1";
    physical_redispatch_each_year?: false;
    internal_rate_of_return_status?: "calculated" | "non_conventional_cashflows" | "no_bracketed_root";
    annual_projection?: Array<{
      year: number;
      value_escalation_factor: number;
      aggregate_value_retention_factor: number;
      projected_tariff_savings_aud: number;
      annual_om_cost_aud: number;
      replacement_cost_aud: number;
      net_cashflow_aud: number;
      discounted_cashflow_aud: number;
      cumulative_cashflow_aud: number;
    }>;
    net_present_value_aud: number;
    payback_period_years: number | null;
    internal_rate_of_return: number | null;
    lifetime_net_value_undiscounted_aud: number;
    annual_cashflows_aud: number[];
  };
  customer_facing_permission: false;
  recommendation_permitted: false;
}

export interface CiInverterPricing {
  basis: string;
  source_product_id: string;
  pv_inverter_aud_ex_gst: number;
  battery_inverter_aud_ex_gst: number;
  shared_inverter_aud_ex_gst: number;
  total_inverter_aud_ex_gst: number;
  disclosure: string;
}

export interface CiAnnualFinancialRebateBreakdown {
  program_id: "solar_stc" | "battery_stc" | "vic_deemed_veec";
  label: string;
  status: "disabled" | "ineligible" | "applied";
  certificate_quantity: number;
  unit_price_aud_ex_gst: number | null;
  rebate_aud_ex_gst: number;
}

export interface CiScenarioRebateProgramResult extends CiAnnualFinancialRebateBreakdown {
  reason_codes: string[];
  reason_messages: string[];
  formula: {
    rule_id: string;
    operands: Record<string, unknown>;
    rounding: string;
  };
  sources: Record<string, string | null>;
}

export interface CiScenarioRebateCalculation {
  contract_version: "ci_scenario_rebate_calculation_v1";
  scenario_id: string;
  ruleset_id: "au_ci_rebates_2026_v1";
  ruleset_sha256: string;
  target_certificate_date: string | null;
  programs: {
    solar_stc: CiScenarioRebateProgramResult;
    battery_stc: CiScenarioRebateProgramResult;
    vic_deemed_veec: CiScenarioRebateProgramResult;
  };
  total_rebate_aud_ex_gst: number;
  eligibility_guaranteed: false;
  customer_facing_permission: false;
}

export interface CiAnnualFinancialComparisonResult {
  contract_version: "ci_annual_financial_comparison_v4";
  status: "ready";
  analysis_mode: "evidence_limited_internal_financial_comparison";
  project_id: string;
  source_tariff_replay_sha256: string;
  profile: { profile_id: string; display_label: string; source_version: string };
  assumptions: {
    currency: "AUD";
    tax_basis: "gst_exclusive";
    price_source: "analyst_entered_total_solution_price" | "workspace_device_profile";
    device_profile_sha256: string | null;
    device_prices: {
      pv_cost_aud_per_kwp_dc: number;
      battery_cost_aud_per_kwh: number;
      inverter_cost_aud_per_kw_ac: number;
    } | null;
    equipment_selection: CiEquipmentSelection | null;
    rebate_profile_sha256: string | null;
    rebate_ruleset_id: "au_ci_rebates_2026_v1";
    rebate_ruleset_sha256: string;
    rebate_application_basis: "deducted_from_workspace_device_profile_gross_cost" | "not_deducted_from_analyst_entered_manual_quote";
    discount_rate: number;
    annual_value_escalation_rate: number;
    annual_value_degradation_rate: number;
    annual_om_fraction_of_capex: number;
    analysis_term_years: number;
    replacement_events_aud: [];
  };
  shortlist_source: {
    algorithm_id: "ci_analyst_selected_tariff_scenarios_v1" | "ci_all_tariff_scenarios_v1";
    available_scenario_count: number;
    shortlist_count: number;
  };
  financial_review_order: {
    algorithm_id: "ci_highest_npv_review_order_v1";
    basis: string;
    leader_scenario_id: string;
    recommendation_permitted: false;
  };
  solutions: CiAnnualFinancialComparisonSolution[];
  currency_values_permitted: true;
  customer_facing_permission: false;
  recommendation_permitted: false;
  disclaimer: string;
}

export interface CiSavedAnnualFinancialState {
  contract_version: "ci_project_annual_financial_state_v1";
  status: "not_saved" | "ready" | "stale";
  saved_at: string | null;
  stale_reasons: Array<"tariff_replay_changed" | "device_profile_changed" | "rebate_profile_changed" | "rebate_profile_approval_required" | "result_contract_unsupported" | "result_integrity_failed">;
  result: CiAnnualFinancialComparisonResult | null;
}

export const ciAnnualFinancialComparisonQueryKey = (projectId: string) =>
  ["ci-project-annual-financial-comparison", projectId] as const;

export async function fetchCiSavedAnnualFinancialComparison(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiSavedAnnualFinancialState> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/annual-financial-comparison`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error("Could not restore the annual financial comparison.");
  const payload = await response.json() as CiSavedAnnualFinancialState;
  const supportedStaleReasons: CiSavedAnnualFinancialState["stale_reasons"] = [
    "tariff_replay_changed",
    "device_profile_changed",
    "rebate_profile_changed",
    "rebate_profile_approval_required",
    "result_contract_unsupported",
    "result_integrity_failed",
  ];
  if (
    payload.contract_version !== "ci_project_annual_financial_state_v1" ||
    !["not_saved", "ready", "stale"].includes(payload.status) ||
    !Array.isArray(payload.stale_reasons) ||
    payload.stale_reasons.some((reason) => !supportedStaleReasons.includes(reason)) ||
    (payload.status === "ready" && payload.result === null) ||
    (payload.status !== "ready" && payload.result !== null)
  ) throw new Error("Saved annual financial comparison returned an unsafe contract.");
  if (payload.result) payload.result = assertCiAnnualFinancialComparison(payload.result, projectId);
  return payload;
}

export async function compareCiAnnualFinancialScenarios(
  input: {
    projectId: string;
    pricingMode?: "manual_quotes" | "device_profile";
    prices?: Array<{ scenarioId: string; upfrontCostAudExGst: number }>;
    equipmentSelection?: CiEquipmentSelection;
    assumptions?: {
      discountRate: number;
      annualValueEscalationRate: number;
      annualValueDegradationRate: number;
      annualOmFractionOfCapex: number;
      analysisTermYears: number;
    };
  },
  fetcher: typeof fetch = fetch,
): Promise<CiAnnualFinancialComparisonResult> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(input.projectId)}/annual-financial-comparison`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        pricing_mode: input.pricingMode ?? "manual_quotes",
        prices: (input.prices ?? []).map((item) => ({
          scenario_id: item.scenarioId,
          upfront_cost_aud_ex_gst: item.upfrontCostAudExGst,
        })),
        equipment_selection: input.equipmentSelection,
        discount_rate: input.assumptions?.discountRate,
        annual_value_escalation_rate: input.assumptions?.annualValueEscalationRate,
        annual_value_degradation_rate: input.assumptions?.annualValueDegradationRate,
        annual_om_fraction_of_capex: input.assumptions?.annualOmFractionOfCapex,
        analysis_term_years: input.assumptions?.analysisTermYears,
      }),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Annual financial comparison failed.");
  }
  return assertCiAnnualFinancialComparison(await response.json(), input.projectId);
}

export function assertCiAnnualFinancialComparison(
  value: unknown,
  projectId: string,
): CiAnnualFinancialComparisonResult {
  const payload = value as CiAnnualFinancialComparisonResult;
  const solutionCount = payload.shortlist_source?.shortlist_count ?? Number.NaN;
  if (
    payload.contract_version !== "ci_annual_financial_comparison_v4" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "evidence_limited_internal_financial_comparison" ||
    payload.project_id !== projectId ||
    !isSha256(payload.source_tariff_replay_sha256) ||
    payload.assumptions?.currency !== "AUD" ||
    payload.assumptions?.tax_basis !== "gst_exclusive" ||
    !["analyst_entered_total_solution_price", "workspace_device_profile"].includes(payload.assumptions?.price_source) ||
    (payload.assumptions?.price_source === "workspace_device_profile" && !validEquipmentSelection(payload.assumptions.equipment_selection)) ||
    (payload.assumptions?.price_source === "analyst_entered_total_solution_price" && payload.assumptions.equipment_selection !== null) ||
    !isOptionalSha256(payload.assumptions?.rebate_profile_sha256) ||
    payload.assumptions?.rebate_ruleset_id !== "au_ci_rebates_2026_v1" ||
    !isSha256(payload.assumptions?.rebate_ruleset_sha256) ||
    !["deducted_from_workspace_device_profile_gross_cost", "not_deducted_from_analyst_entered_manual_quote"].includes(payload.assumptions?.rebate_application_basis) ||
    payload.assumptions.rebate_application_basis !== (payload.assumptions.price_source === "workspace_device_profile"
      ? "deducted_from_workspace_device_profile_gross_cost"
      : "not_deducted_from_analyst_entered_manual_quote") ||
    ![
      payload.assumptions.discount_rate,
      payload.assumptions.annual_value_escalation_rate,
      payload.assumptions.annual_value_degradation_rate,
      payload.assumptions.annual_om_fraction_of_capex,
      payload.assumptions.analysis_term_years,
    ].every(Number.isFinite) ||
    !["ci_analyst_selected_tariff_scenarios_v1", "ci_all_tariff_scenarios_v1"].includes(payload.shortlist_source?.algorithm_id) ||
    !Number.isInteger(payload.shortlist_source.available_scenario_count) ||
    payload.shortlist_source.available_scenario_count < solutionCount ||
    !Number.isInteger(solutionCount) ||
    solutionCount < 1 ||
    solutionCount > 200 ||
    payload.financial_review_order?.algorithm_id !== "ci_highest_npv_review_order_v1" ||
    payload.financial_review_order?.recommendation_permitted !== false ||
    typeof payload.financial_review_order?.basis !== "string" ||
    !payload.financial_review_order.basis ||
    !Array.isArray(payload.solutions) ||
    payload.solutions.length !== solutionCount ||
    payload.solutions[0]?.scenario_id !== payload.financial_review_order.leader_scenario_id ||
    payload.solutions.some((item, index) =>
      item.financial_review_rank !== index + 1 ||
      !Number.isInteger(item.physical_review_rank) ||
      item.physical_review_rank < 1 ||
      item.customer_facing_permission !== false ||
      item.recommendation_permitted !== false ||
      ![
        item.pv_capacity_kwp_dc,
        item.battery_capacity_kwh,
        item.inverter_capacity_kw_ac,
        item.gross_upfront_cost_aud_ex_gst,
        item.upfront_rebate_aud_ex_gst,
        item.upfront_cost_aud_ex_gst,
        item.annual_om_cost_aud_ex_gst,
        item.first_year_value_aud_ex_gst,
        item.annual_cost_aud_ex_gst,
        item.metrics?.net_present_value_aud,
        item.metrics?.lifetime_net_value_undiscounted_aud,
      ].every(Number.isFinite) ||
      item.upfront_cost_aud_ex_gst <= 0 ||
      item.gross_upfront_cost_aud_ex_gst <= 0 ||
      item.upfront_rebate_aud_ex_gst < 0 ||
      Math.abs(item.gross_upfront_cost_aud_ex_gst - item.upfront_rebate_aud_ex_gst - item.upfront_cost_aud_ex_gst) > 0.011 ||
      !validRebateApplication(item, payload.assumptions.price_source, payload.assumptions.rebate_ruleset_sha256) ||
      (item.capex_breakdown_aud_ex_gst !== null && ![
        item.capex_breakdown_aud_ex_gst?.pv_aud,
        item.capex_breakdown_aud_ex_gst?.battery_aud,
        item.capex_breakdown_aud_ex_gst?.inverter_aud,
      ].every(Number.isFinite)) ||
      (item.metrics.payback_period_years !== null && !Number.isFinite(item.metrics.payback_period_years)) ||
      (item.metrics.internal_rate_of_return !== null && !Number.isFinite(item.metrics.internal_rate_of_return)) ||
      !Array.isArray(item.metrics.annual_cashflows_aud) ||
      item.metrics.annual_cashflows_aud.length !== payload.assumptions.analysis_term_years ||
      !item.metrics.annual_cashflows_aud.every(Number.isFinite)
    ) ||
    payload.currency_values_permitted !== true ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    typeof payload.disclaimer !== "string" ||
    !payload.disclaimer
  ) {
    throw new Error("Annual financial comparison returned an unsafe contract.");
  }
  return payload;
}

function validRebateApplication(
  item: CiAnnualFinancialComparisonSolution,
  priceSource: CiAnnualFinancialComparisonResult["assumptions"]["price_source"],
  rulesetSha256: string,
) {
  const expectedStatus = priceSource === "workspace_device_profile"
    ? "applied_to_device_profile_gross_cost"
    : "not_applied_to_manual_quote";
  if (
    item.rebate_application_status !== expectedStatus ||
    !Array.isArray(item.rebate_breakdown) ||
    item.rebate_breakdown.length !== 3 ||
    !validRebateCalculation(item.rebate_calculation, item.scenario_id, rulesetSha256)
  ) return false;
  const breakdownTotal = item.rebate_breakdown.reduce((sum, entry) => sum + entry.rebate_aud_ex_gst, 0);
  const breakdownIds = new Set(item.rebate_breakdown.map((entry) => entry.program_id));
  if (breakdownIds.size !== 3 || !["solar_stc", "battery_stc", "vic_deemed_veec"].every((programId) => breakdownIds.has(programId as CiAnnualFinancialRebateBreakdown["program_id"]))) return false;
  if (Math.abs(breakdownTotal - item.rebate_calculation.total_rebate_aud_ex_gst) > 0.011) return false;
  if (priceSource === "workspace_device_profile") {
    if (Math.abs(item.upfront_rebate_aud_ex_gst - breakdownTotal) > 0.011) return false;
  } else if (item.upfront_rebate_aud_ex_gst !== 0) return false;
  return item.rebate_breakdown.every((entry) => {
    const audit = item.rebate_calculation.programs[entry.program_id];
    return validRebateBreakdown(entry) &&
      audit.status === entry.status &&
      audit.certificate_quantity === entry.certificate_quantity &&
      audit.unit_price_aud_ex_gst === entry.unit_price_aud_ex_gst &&
      Math.abs(audit.rebate_aud_ex_gst - entry.rebate_aud_ex_gst) <= 0.011;
  });
}

function validRebateCalculation(value: unknown, scenarioId: string, rulesetSha256: string): value is CiScenarioRebateCalculation {
  const calculation = value as CiScenarioRebateCalculation;
  if (
    !calculation ||
    calculation.contract_version !== "ci_scenario_rebate_calculation_v1" ||
    calculation.scenario_id !== scenarioId ||
    calculation.ruleset_id !== "au_ci_rebates_2026_v1" ||
    calculation.ruleset_sha256 !== rulesetSha256 ||
    (calculation.target_certificate_date !== null && !isIsoDate(calculation.target_certificate_date)) ||
    calculation.eligibility_guaranteed !== false ||
    calculation.customer_facing_permission !== false ||
    !Number.isFinite(calculation.total_rebate_aud_ex_gst) ||
    calculation.total_rebate_aud_ex_gst < 0 ||
    !calculation.programs
  ) return false;
  const entries = Object.entries(calculation.programs);
  const calculatedTotal = entries.reduce((sum, [, entry]) => sum + entry.rebate_aud_ex_gst, 0);
  return Math.abs(calculatedTotal - calculation.total_rebate_aud_ex_gst) <= 0.011 && entries.length === 3 && entries.every(([programId, entry]) =>
    ["solar_stc", "battery_stc", "vic_deemed_veec"].includes(programId) &&
    entry.program_id === programId &&
    validRebateBreakdown(entry) &&
    Array.isArray(entry.reason_codes) && entry.reason_codes.every((reason) => typeof reason === "string" && reason.length > 0) &&
    Array.isArray(entry.reason_messages) && entry.reason_messages.every((reason) => typeof reason === "string" && reason.length > 0) &&
    entry.reason_codes.length === entry.reason_messages.length &&
    typeof entry.formula?.rule_id === "string" && entry.formula.rule_id.length > 0 &&
    typeof entry.formula?.rounding === "string" && entry.formula.rounding.length > 0 &&
    isRecord(entry.formula?.operands) && isRecord(entry.sources)
  );
}

function validRebateBreakdown(value: unknown): value is CiAnnualFinancialRebateBreakdown {
  const entry = value as CiAnnualFinancialRebateBreakdown;
  return Boolean(
    entry &&
    ["solar_stc", "battery_stc", "vic_deemed_veec"].includes(entry.program_id) &&
    typeof entry.label === "string" && entry.label.length > 0 &&
    ["disabled", "ineligible", "applied"].includes(entry.status) &&
    Number.isInteger(entry.certificate_quantity) && entry.certificate_quantity >= 0 &&
    (entry.unit_price_aud_ex_gst === null || (Number.isFinite(entry.unit_price_aud_ex_gst) && entry.unit_price_aud_ex_gst >= 0)) &&
    Number.isFinite(entry.rebate_aud_ex_gst) && entry.rebate_aud_ex_gst >= 0
  );
}

function isSha256(value: unknown) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function isOptionalSha256(value: unknown) { return value === null || isSha256(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isIsoDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }

function validEquipmentSelection(value: unknown): value is CiEquipmentSelection {
  const selection = value as CiEquipmentSelection;
  return Boolean(
    selection
    && selection.pv_product_id === "astronergy_astro_n7_600_630w"
    && selection.battery_product_id === "fox_ess_cq7_ci"
    && selection.inverter_product_id === "fox_ess_h3_plus_125kw"
  );
}
import type { CiEquipmentSelection } from "@/features/ci/api/ci-device-profile";

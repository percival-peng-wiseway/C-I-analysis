export interface CiAnnualFinancialComparisonSolution {
  scenario_id: string;
  label: string;
  physical_review_rank: number;
  financial_review_rank: number;
  pv_capacity_kwp_dc: number;
  battery_capacity_kwh: number;
  inverter_capacity_kw_ac: number;
  upfront_cost_aud_ex_gst: number;
  capex_breakdown_aud_ex_gst: {
    pv_aud: number;
    battery_aud: number;
    inverter_aud: number;
  } | null;
  annual_om_cost_aud_ex_gst: number;
  first_year_value_aud_ex_gst: number;
  annual_cost_aud_ex_gst: number;
  metrics: {
    net_present_value_aud: number;
    payback_period_years: number | null;
    internal_rate_of_return: number | null;
    lifetime_net_value_undiscounted_aud: number;
    annual_cashflows_aud: number[];
  };
  customer_facing_permission: false;
  recommendation_permitted: false;
}

export interface CiAnnualFinancialComparisonResult {
  contract_version: "ci_annual_financial_comparison_v3";
  status: "ready";
  analysis_mode: "evidence_limited_internal_financial_comparison";
  project_id: string;
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
  stale_reasons: Array<"tariff_replay_changed" | "device_profile_changed" | "result_contract_unsupported" | "result_integrity_failed">;
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
  if (
    payload.contract_version !== "ci_project_annual_financial_state_v1" ||
    !["not_saved", "ready", "stale"].includes(payload.status) ||
    !Array.isArray(payload.stale_reasons) ||
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
    payload.contract_version !== "ci_annual_financial_comparison_v3" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "evidence_limited_internal_financial_comparison" ||
    payload.project_id !== projectId ||
    payload.assumptions?.currency !== "AUD" ||
    payload.assumptions?.tax_basis !== "gst_exclusive" ||
    !["analyst_entered_total_solution_price", "workspace_device_profile"].includes(payload.assumptions?.price_source) ||
    (payload.assumptions?.price_source === "workspace_device_profile" && !validEquipmentSelection(payload.assumptions.equipment_selection)) ||
    (payload.assumptions?.price_source === "analyst_entered_total_solution_price" && payload.assumptions.equipment_selection !== null) ||
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
        item.upfront_cost_aud_ex_gst,
        item.annual_om_cost_aud_ex_gst,
        item.first_year_value_aud_ex_gst,
        item.annual_cost_aud_ex_gst,
        item.metrics?.net_present_value_aud,
        item.metrics?.lifetime_net_value_undiscounted_aud,
      ].every(Number.isFinite) ||
      item.upfront_cost_aud_ex_gst <= 0 ||
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

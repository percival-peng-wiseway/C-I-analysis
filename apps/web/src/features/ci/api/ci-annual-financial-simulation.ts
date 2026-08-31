export type CiAnnualFinancialValueBasis = "battery_incremental" | "whole_solution";

export interface CiAnnualFinancialSimulationResult {
  contract_version: "ci_annual_financial_simulation_v1";
  status: "ready";
  analysis_mode: "evidence_limited_internal_review";
  project_id: string;
  selected_design_id: string;
  profile: { profile_id: string; display_label: string; source_version: string };
  value_basis: CiAnnualFinancialValueBasis;
  cases: Array<{
    case_id: "no_system" | "pv_only" | "pv_battery";
    label: string;
    scenario_id: string | null;
    annual_cost_ex_gst_aud: number;
    annual_cost_inc_gst_aud: number;
    first_year_value_ex_gst_aud: number;
    first_year_value_inc_gst_aud: number;
    raw_rolling_demand_kva: number;
  }>;
  battery_incremental_value: { ex_gst_aud: number; inc_gst_aud: number };
  financial_projection: {
    assumptions: {
      upfront_cost_aud: number;
      first_year_net_value_aud: number;
      annual_om_cost_aud: number;
      replacement_events_aud: Array<{ year: number; amount_aud: number }>;
      discount_rate: number;
      annual_value_degradation_rate: number;
      analysis_term_years: number;
      currency: "AUD";
      value_source: string;
      pricing_resolution: {
        tax_basis: "gst_inclusive" | "gst_exclusive";
        resolved_upfront_cost_aud: number;
        resolved_annual_om_cost_aud: number;
      };
    };
    metrics: {
      net_present_value_aud: number;
      payback_period_years: number | null;
      internal_rate_of_return: number | null;
      lifetime_net_value_undiscounted_aud: number;
      annual_cashflows_aud: number[];
    };
  };
  currency_values_permitted: true;
  customer_facing_permission: false;
  recommendation_permitted: false;
  disclaimer: string;
}

export async function simulateCiAnnualFinancialScenario(
  input: {
    projectId: string;
    file: File;
    scenarioId: string;
    valueBasis: CiAnnualFinancialValueBasis;
    pricingCatalogVersionId: string;
    productIds: string[];
    installationItemIds: string[];
    discountRate: number;
    degradationRate: number;
    termYears: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<CiAnnualFinancialSimulationResult> {
  const body = new FormData();
  body.append("file", input.file);
  body.append("payload", JSON.stringify({
    scenario_id: input.scenarioId,
    value_basis: input.valueBasis,
    pricing_catalog_version_id: input.pricingCatalogVersionId,
    product_ids: input.productIds,
    installation_item_ids: input.installationItemIds,
    discount_rate: input.discountRate,
    annual_value_degradation_rate: input.degradationRate,
    analysis_term_years: input.termYears,
  }));
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(input.projectId)}/annual-financial-simulation`,
    { method: "POST", headers: { Accept: "application/json" }, body },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Annual financial simulation failed.");
  }
  const payload = await response.json() as CiAnnualFinancialSimulationResult;
  if (
    payload.contract_version !== "ci_annual_financial_simulation_v1" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "evidence_limited_internal_review" ||
    payload.project_id !== input.projectId ||
    payload.selected_design_id !== input.scenarioId ||
    payload.value_basis !== input.valueBasis ||
    payload.currency_values_permitted !== true ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    payload.cases?.length !== 3 ||
    payload.cases[0]?.case_id !== "no_system" ||
    payload.cases[1]?.case_id !== "pv_only" ||
    payload.cases[2]?.case_id !== "pv_battery" ||
    !payload.cases.every((item) => [item.annual_cost_ex_gst_aud, item.annual_cost_inc_gst_aud, item.first_year_value_ex_gst_aud, item.first_year_value_inc_gst_aud, item.raw_rolling_demand_kva].every(Number.isFinite)) ||
    !Number.isFinite(payload.financial_projection?.metrics?.net_present_value_aud) ||
    !Array.isArray(payload.financial_projection?.metrics?.annual_cashflows_aud)
  ) throw new Error("Annual financial simulation returned an unsafe contract.");
  return payload;
}

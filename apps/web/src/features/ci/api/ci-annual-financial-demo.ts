export interface CiAnnualFinancialDemoMetrics {
  net_present_value_aud: number;
  payback_period_years: number | null;
  internal_rate_of_return: number | null;
  lifetime_net_value_undiscounted_aud: number;
  annual_cashflows_aud: number[];
}

export interface CiAnnualFinancialDemoPhysicalOutcome {
  energy_year: number;
  grid_import_reduction_kwh: number;
  grid_import_reduction_percent: number;
  pv_generation_kwh: number;
  pv_self_consumption_percent: number;
  battery_discharge_output_kwh: number;
  battery_equivalent_full_cycles: number;
  baseline_peak_kw: number;
  post_system_peak_kw: number;
  peak_reduction_kw: number;
  peak_reduction_percent: number;
  avoided_emissions_t_co2e: number;
}

export interface CiAnnualFinancialDemoSolution {
  scenario_id: string;
  label: string;
  financial_review_rank: number;
  pv_capacity_kwp_dc: number;
  battery_capacity_kwh: number;
  inverter_unit_count: number;
  inverter_unit_capacity_kw_ac: number;
  inverter_capacity_kw_ac: number;
  upfront_cost_aud: number;
  capex_breakdown: {
    solar_component_aud: number;
    battery_component_aud: number;
    battery_inverter_aud: number;
    balance_of_system_and_delivery_aud: number;
    total_aud: number;
  };
  annual_om_cost_aud: number;
  first_year_value_aud: number;
  annualised_post_system_cost_aud: number;
  annualised_bill_reduction_percent: number;
  metrics: CiAnnualFinancialDemoMetrics;
  conservative_sensitivity: {
    first_year_value_aud: number;
    metrics: CiAnnualFinancialDemoMetrics;
  };
  physical_outcome: CiAnnualFinancialDemoPhysicalOutcome;
  customer_facing_permission: false;
  recommendation_permitted: false;
}

export interface CiAnnualFinancialDemoResult {
  contract_version: "ci_annual_financial_demo_v2";
  status: "ready";
  analysis_mode: "invoice_derived_demo_financial_comparison";
  project_id: string;
  demo_only: true;
  analysis_modules: Array<{
    module_id: "evidence" | "physical" | "tariff" | "finance" | "connection" | "compliance";
    label: string;
    status: "ready" | "demo_ready" | "input_required";
    detail: string;
  }>;
  common_system: {
    pv_capacity_kwp_dc: number;
    pv_annual_specific_yield_kwh_per_kw: number;
    pv_derating_factor: number;
    inverter_unit_count: number;
    inverter_unit_capacity_kw_ac: number;
    inverter_capacity_kw_ac: number;
    battery_power_assumption_kw: number;
    battery_round_trip_efficiency: number;
    minimum_soc_fraction: number;
    maximum_soc_fraction: number;
    export_limit_kw: number;
    export_rate_aud_per_kwh: number;
  };
  evidence_basis: {
    retailer: string;
    billing_period_start: string;
    billing_period_end: string;
    billing_days: number;
    invoice_consumption_kwh: number;
    invoice_subtotal_ex_gst_aud: number;
    annualised_consumption_kwh: number;
    annualised_baseline_cost_aud: number;
    measured_energy_year: number;
  };
  value_cases: {
    bill_blended: {
      label: string;
      rate_aud_per_kwh: number;
      included_bill_components: string;
      formal_tariff_result: false;
    };
    conservative_energy_only: {
      label: string;
      rate_aud_per_kwh: number;
      included_bill_components: string;
      formal_tariff_result: false;
    };
  };
  tariff_inputs: {
    status: "awaiting_approved_window_mapping";
    rates_applied_to_finance: false;
    demand_savings_applied: false;
    demand_savings_realisation_fraction: number;
    retail_peak_c_per_kwh: number;
    retail_off_peak_c_per_kwh: number;
    mlf: number;
    dlf: number;
    network_peak_c_per_kwh: number;
    network_off_peak_c_per_kwh: number;
    rolling_demand_aud_per_kva_month: number;
    incentive_demand_aud_per_kva_month: number;
    boundary: string;
  };
  assumptions: {
    currency: "AUD";
    tax_basis: "supplied_total_assumed_ex_gst_for_demo";
    price_source: "user_supplied_total_solution_prices";
    discount_rate: number;
    annual_value_degradation_rate: number;
    annual_value_escalation_rate: number;
    analysis_term_years: number;
    solar_om_fraction_of_component_capex: number;
    battery_om_fraction_of_component_capex: number;
    solar_unit_cost_aud_per_kw: number;
    battery_unit_cost_aud_per_kwh: number;
    battery_inverter_total_aud: number;
    emissions_factor_kg_co2e_per_kwh: number;
    replacement_events_aud: [];
  };
  financial_review_order: {
    algorithm_id: "ci_demo_highest_bill_blended_npv_v2";
    basis: string;
    leader_scenario_id: string;
    recommendation_permitted: false;
  };
  commercial_readout: {
    headline: string;
    tradeoff: string;
    decision_boundary: string;
  };
  baseline_case: {
    label: "No system";
    annualised_cost_aud: number;
    annualised_grid_import_kwh: number;
  };
  solar_only_case: {
    scenario_id: "chefq-demo-solar-only";
    label: "Solar only";
    pv_capacity_kwp_dc: number;
    battery_capacity_kwh: 0;
    first_year_value_aud: number;
    annualised_post_system_cost_aud: number;
    physical_outcome: CiAnnualFinancialDemoPhysicalOutcome;
    pricing_status: "installed_price_required";
    financial_metrics_permitted: false;
    customer_facing_permission: false;
    recommendation_permitted: false;
  };
  solutions: CiAnnualFinancialDemoSolution[];
  currency_values_permitted: true;
  customer_facing_permission: false;
  recommendation_permitted: false;
  disclaimer: string;
}

export const ciAnnualFinancialDemoQueryKey = (projectId: string) => [
  "ci-project-annual-financial-demo",
  projectId,
] as const;

export async function fetchCiAnnualFinancialDemo(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiAnnualFinancialDemoResult> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/annual-financial-demo`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Annual finance demo failed.");
  }
  return assertCiAnnualFinancialDemo(await response.json(), projectId);
}

export function assertCiAnnualFinancialDemo(
  value: unknown,
  projectId: string,
): CiAnnualFinancialDemoResult {
  const payload = value as CiAnnualFinancialDemoResult;
  const term = payload.assumptions?.analysis_term_years ?? Number.NaN;
  const moduleIds = payload.analysis_modules?.map((item) => item.module_id);
  if (
    payload.contract_version !== "ci_annual_financial_demo_v2" ||
    payload.status !== "ready" ||
    payload.analysis_mode !== "invoice_derived_demo_financial_comparison" ||
    payload.project_id !== projectId ||
    payload.demo_only !== true ||
    !validModules(payload.analysis_modules) ||
    moduleIds?.join(",") !== "evidence,physical,tariff,finance,connection,compliance" ||
    payload.common_system?.pv_capacity_kwp_dc !== 141.7 ||
    payload.common_system?.pv_annual_specific_yield_kwh_per_kw !== 1450 ||
    payload.common_system?.inverter_unit_count !== 2 ||
    payload.common_system?.inverter_unit_capacity_kw_ac !== 125 ||
    payload.common_system?.inverter_capacity_kw_ac !== 250 ||
    payload.common_system?.battery_round_trip_efficiency !== 0.9 ||
    payload.common_system?.minimum_soc_fraction !== 0.1 ||
    payload.common_system?.maximum_soc_fraction !== 0.9 ||
    payload.common_system?.export_limit_kw !== 0 ||
    payload.common_system?.export_rate_aud_per_kwh !== 0 ||
    payload.tariff_inputs?.status !== "awaiting_approved_window_mapping" ||
    payload.tariff_inputs?.rates_applied_to_finance !== false ||
    payload.tariff_inputs?.demand_savings_applied !== false ||
    !validFiniteValues(Object.values(payload.tariff_inputs ?? {}).filter((item) => typeof item === "number")) ||
    !payload.tariff_inputs?.boundary ||
    payload.assumptions?.currency !== "AUD" ||
    payload.assumptions?.tax_basis !== "supplied_total_assumed_ex_gst_for_demo" ||
    payload.assumptions?.price_source !== "user_supplied_total_solution_prices" ||
    !Number.isInteger(term) ||
    term < 1 ||
    !validFiniteValues([
      payload.assumptions?.discount_rate,
      payload.assumptions?.annual_value_degradation_rate,
      payload.assumptions?.annual_value_escalation_rate,
      payload.assumptions?.solar_om_fraction_of_component_capex,
      payload.assumptions?.battery_om_fraction_of_component_capex,
      payload.assumptions?.emissions_factor_kg_co2e_per_kwh,
      payload.baseline_case?.annualised_cost_aud,
      payload.baseline_case?.annualised_grid_import_kwh,
    ]) ||
    payload.baseline_case?.label !== "No system" ||
    !validSolarOnly(payload.solar_only_case) ||
    payload.financial_review_order?.algorithm_id !== "ci_demo_highest_bill_blended_npv_v2" ||
    payload.financial_review_order?.recommendation_permitted !== false ||
    !Array.isArray(payload.solutions) ||
    payload.solutions.length !== 3 ||
    payload.solutions[0]?.scenario_id !== payload.financial_review_order.leader_scenario_id ||
    payload.solutions.some((item, index) => !validSolution(item, index, term)) ||
    payload.currency_values_permitted !== true ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    typeof payload.disclaimer !== "string" ||
    !payload.disclaimer
  ) {
    throw new Error("Annual finance demo returned an unsafe contract.");
  }
  return payload;
}

function validModules(modules: CiAnnualFinancialDemoResult["analysis_modules"] | undefined) {
  return Array.isArray(modules) && modules.length === 6 && modules.every((item) =>
    ["ready", "demo_ready", "input_required"].includes(item.status) &&
    typeof item.label === "string" && Boolean(item.label) &&
    typeof item.detail === "string" && Boolean(item.detail));
}

function validSolarOnly(item: CiAnnualFinancialDemoResult["solar_only_case"] | undefined) {
  if (!item) return false;
  return item.scenario_id === "chefq-demo-solar-only" &&
    item.battery_capacity_kwh === 0 &&
    item.pricing_status === "installed_price_required" &&
    item.financial_metrics_permitted === false &&
    item.customer_facing_permission === false &&
    item.recommendation_permitted === false &&
    validFiniteValues([item.first_year_value_aud, item.annualised_post_system_cost_aud]) &&
    validPhysical(item.physical_outcome);
}

function validSolution(item: CiAnnualFinancialDemoSolution, index: number, term: number) {
  const breakdown = item.capex_breakdown;
  return item.financial_review_rank === index + 1 &&
    item.pv_capacity_kwp_dc === 141.7 &&
    item.inverter_unit_count === 2 &&
    item.inverter_unit_capacity_kw_ac === 125 &&
    item.inverter_capacity_kw_ac === 250 &&
    item.customer_facing_permission === false &&
    item.recommendation_permitted === false &&
    validFiniteValues([
      item.battery_capacity_kwh,
      item.upfront_cost_aud,
      item.annual_om_cost_aud,
      item.first_year_value_aud,
      item.annualised_post_system_cost_aud,
      item.annualised_bill_reduction_percent,
      item.metrics?.net_present_value_aud,
      item.metrics?.lifetime_net_value_undiscounted_aud,
      item.conservative_sensitivity?.first_year_value_aud,
      item.conservative_sensitivity?.metrics?.net_present_value_aud,
      breakdown?.solar_component_aud,
      breakdown?.battery_component_aud,
      breakdown?.battery_inverter_aud,
      breakdown?.balance_of_system_and_delivery_aud,
      breakdown?.total_aud,
    ]) &&
    item.upfront_cost_aud > 0 &&
    item.annual_om_cost_aud >= 0 &&
    Math.abs(breakdown.total_aud - item.upfront_cost_aud) < 0.01 &&
    validMetrics(item.metrics, term) &&
    validMetrics(item.conservative_sensitivity.metrics, term) &&
    validPhysical(item.physical_outcome);
}

function validMetrics(metrics: CiAnnualFinancialDemoMetrics, term: number) {
  return Boolean(metrics) &&
    (metrics.payback_period_years === null || Number.isFinite(metrics.payback_period_years)) &&
    (metrics.internal_rate_of_return === null || Number.isFinite(metrics.internal_rate_of_return)) &&
    Array.isArray(metrics.annual_cashflows_aud) &&
    metrics.annual_cashflows_aud.length === term &&
    metrics.annual_cashflows_aud.every(Number.isFinite);
}

function validPhysical(item: CiAnnualFinancialDemoPhysicalOutcome | undefined) {
  return Boolean(item) && validFiniteValues([
    item?.grid_import_reduction_kwh,
    item?.grid_import_reduction_percent,
    item?.pv_generation_kwh,
    item?.pv_self_consumption_percent,
    item?.battery_discharge_output_kwh,
    item?.battery_equivalent_full_cycles,
    item?.baseline_peak_kw,
    item?.post_system_peak_kw,
    item?.peak_reduction_kw,
    item?.peak_reduction_percent,
    item?.avoided_emissions_t_co2e,
  ]);
}

function validFiniteValues(values: unknown[]) {
  return values.every((item) => typeof item === "number" && Number.isFinite(item));
}

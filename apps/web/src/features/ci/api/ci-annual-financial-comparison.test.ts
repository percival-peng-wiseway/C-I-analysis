import { expect, it, vi } from "vitest";

import { compareCiAnnualFinancialScenarios } from "./ci-annual-financial-comparison";

it("posts explicit Top 10 prices and accepts the fail-closed comparison contract", async () => {
  const payload = {
    contract_version: "ci_annual_financial_comparison_v3",
    status: "ready",
    analysis_mode: "evidence_limited_internal_financial_comparison",
    project_id: "project-1",
    profile: { profile_id: "profile", display_label: "Evidence", source_version: "v1" },
    assumptions: { currency: "AUD", tax_basis: "gst_exclusive", price_source: "analyst_entered_total_solution_price", device_profile_sha256: null, device_prices: null, equipment_selection: null, discount_rate: 0.08, annual_value_escalation_rate: 0.025, annual_value_degradation_rate: 0.005, annual_om_fraction_of_capex: 0.015, analysis_term_years: 2, replacement_events_aud: [] },
    shortlist_source: { algorithm_id: "ci_analyst_selected_tariff_scenarios_v1", available_scenario_count: 20, shortlist_count: 1 },
    financial_review_order: { algorithm_id: "ci_highest_npv_review_order_v1", basis: "Highest NPV; internal only.", leader_scenario_id: "scenario-1", recommendation_permitted: false },
    solutions: [{
      scenario_id: "scenario-1", label: "Solution 1", physical_review_rank: 1, financial_review_rank: 1,
      pv_capacity_kwp_dc: 100, battery_capacity_kwh: 200, inverter_capacity_kw_ac: 80,
      upfront_cost_aud_ex_gst: 60000, capex_breakdown_aud_ex_gst: null, annual_om_cost_aud_ex_gst: 900, first_year_value_aud_ex_gst: 10000, annual_cost_aud_ex_gst: 90000,
      metrics: { net_present_value_aud: -42167.35, payback_period_years: null, internal_rate_of_return: null, lifetime_net_value_undiscounted_aud: -40000, annual_cashflows_aud: [10000, 10000] },
      customer_facing_permission: false, recommendation_permitted: false,
    }],
    currency_values_permitted: true,
    customer_facing_permission: false,
    recommendation_permitted: false,
    disclaimer: "Internal only.",
  };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ pricing_mode: "manual_quotes", prices: [{ scenario_id: "scenario-1", upfront_cost_aud_ex_gst: 60000 }], discount_rate: 0.08, annual_value_escalation_rate: 0.025, annual_value_degradation_rate: 0.005, annual_om_fraction_of_capex: 0.015, analysis_term_years: 15 });
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  await expect(compareCiAnnualFinancialScenarios({
    projectId: "project-1",
    prices: [{ scenarioId: "scenario-1", upfrontCostAudExGst: 60000 }],
    assumptions: { discountRate: 0.08, annualValueEscalationRate: 0.025, annualValueDegradationRate: 0.005, annualOmFractionOfCapex: 0.015, analysisTermYears: 15 },
  }, fetcher)).resolves.toMatchObject({ project_id: "project-1" });
});

it("rejects a response that grants recommendation permission", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    contract_version: "ci_annual_financial_comparison_v3",
    status: "ready",
    analysis_mode: "evidence_limited_internal_financial_comparison",
    project_id: "project-1",
    recommendation_permitted: true,
  }), { status: 200 }));
  await expect(compareCiAnnualFinancialScenarios({
    projectId: "project-1",
    prices: [{ scenarioId: "scenario-1", upfrontCostAudExGst: 60000 }],
    assumptions: { discountRate: 0.08, annualValueEscalationRate: 0.025, annualValueDegradationRate: 0.005, annualOmFractionOfCapex: 0.015, analysisTermYears: 15 },
  }, fetcher)).rejects.toThrow("unsafe contract");
});

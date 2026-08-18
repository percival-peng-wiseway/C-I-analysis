import { describe, expect, it, vi } from "vitest";

import { simulateCiAnnualFinancialScenario } from "./ci-annual-financial-simulation";

describe("C&I annual financial simulation API", () => {
  it("submits the saved design selection and accepts only the bounded result", async () => {
    const result = {
      contract_version: "ci_annual_financial_simulation_v1",
      status: "ready",
      analysis_mode: "evidence_limited_internal_review",
      project_id: "project-1",
      selected_design_id: "scenario-1",
      profile: { profile_id: "profile", display_label: "Profile", source_version: "v1" },
      value_basis: "battery_incremental",
      cases: ["no_system", "pv_only", "pv_battery"].map((case_id) => ({ case_id, label: case_id, scenario_id: case_id === "no_system" ? null : case_id, annual_cost_ex_gst_aud: 100, annual_cost_inc_gst_aud: 110, first_year_value_ex_gst_aud: 10, first_year_value_inc_gst_aud: 11, raw_rolling_demand_kva: 200 })),
      battery_incremental_value: { ex_gst_aud: 10, inc_gst_aud: 11 },
      financial_projection: { assumptions: { upfront_cost_aud: 100, first_year_net_value_aud: 10, annual_om_cost_aud: 0, replacement_events_aud: [], discount_rate: 0.08, annual_value_degradation_rate: 0, analysis_term_years: 10, currency: "AUD", value_source: "test", pricing_resolution: { tax_basis: "gst_exclusive", resolved_upfront_cost_aud: 100, resolved_annual_om_cost_aud: 0 } }, metrics: { net_present_value_aud: 20, payback_period_years: 5, internal_rate_of_return: 0.1, lifetime_net_value_undiscounted_aud: 30, annual_cashflows_aud: [10] } },
      currency_values_permitted: true,
      customer_facing_permission: false,
      recommendation_permitted: false,
      disclaimer: "Internal only.",
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    await expect(simulateCiAnnualFinancialScenario({ projectId: "project-1", file: new File(["x"], "nem12.csv"), scenarioId: "scenario-1", valueBasis: "battery_incremental", pricingCatalogVersionId: "catalog-1", productIds: ["battery"], installationItemIds: [], discountRate: 0.08, degradationRate: 0, termYears: 10 }, fetcher)).resolves.toMatchObject({ project_id: "project-1" });
    const submitted = JSON.parse((fetcher.mock.calls[0][1].body as FormData).get("payload") as string);
    expect(submitted).toMatchObject({ scenario_id: "scenario-1", value_basis: "battery_incremental", discount_rate: 0.08 });
  });
});

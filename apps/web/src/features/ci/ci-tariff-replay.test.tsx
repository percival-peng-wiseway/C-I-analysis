// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { CiPhysicalScenarioResult } from "./api/ci-scenarios";
import type { CiAnnualFinancialComparisonResult } from "./api/ci-annual-financial-comparison";
import { CiTariffReplayResult } from "./ci-tariff-replay";

const result = {
  assumptions: ["Representative-year tariff quantities use the approved bill rates."],
  baseline: { raw_rolling_demand_kva: 320, chargeable_rolling_demand_kva: 320, billing_period_max_kva: 300, billing_period_max_kw: 275 },
  scenarios: [{
    scenario_id: "case-1",
    label: "Case 1",
    physical_review_rank: 1,
    authored_inputs: { pv_capacity_kwp_dc: 141.7, nominal_capacity_kwh: 300, pv_inverter_capacity_kw_ac: 250 },
    annual_tariff_value: {
      period_start: "2025-01-01", period_end: "2025-12-31",
      rate_basis: "active_bill_rates_with_evidence_bound_seasonal_incentive",
      calculation_method: "representative_year_repeat_v1",
      baseline_cost_ex_gst_aud: 120000, scenario_cost_ex_gst_aud: 83000,
      first_year_value_ex_gst_aud: 37000,
      baseline_categories_ex_gst_aud: { energy_charges: 70000, demand_charges: 50000 },
      scenario_categories_ex_gst_aud: { energy_charges: 48000, demand_charges: 35000 },
      category_savings_ex_gst_aud: { energy_charges: 22000, demand_charges: 15000 },
    },
    post_dispatch: { raw_rolling_demand_kva: 250, chargeable_rolling_demand_kva: 250, billing_period_max_kva: 238, billing_period_max_kw: 220, billing_period_peak_effect: "reduction", billing_period_peak_change_kw: 55 },
    selected_monthly_thresholds_kw: [210, 205, 208, 200, 195, 190, 188, 192, 198, 202, 207, 211],
    dispatch_review_projection: {
      peak_local_date: "2025-02-17",
      points: [
        { local_time_label: "16:00", baseline_kva: 250, post_dispatch_kva: 220 },
        { local_time_label: "16:15", baseline_kva: 300, post_dispatch_kva: 238 },
      ],
    },
  }],
} as unknown as CiPhysicalScenarioResult;

const comparisonResult = {
  ...result,
  scenarios: [
    result.scenarios[0]!,
    {
      ...result.scenarios[0]!,
      scenario_id: "case-2",
      label: "Case 2",
      physical_review_rank: 2,
      authored_inputs: { pv_capacity_kwp_dc: 130, nominal_capacity_kwh: 250, pv_inverter_capacity_kw_ac: 200 },
      annual_tariff_value: {
        ...result.scenarios[0]!.annual_tariff_value,
        scenario_cost_ex_gst_aud: 89000,
        first_year_value_ex_gst_aud: 31000,
      },
      post_dispatch: {
        ...result.scenarios[0]!.post_dispatch,
        raw_rolling_demand_kva: 270,
      },
    },
  ],
} as CiPhysicalScenarioResult;

const financeResult = {
  contract_version: "ci_annual_financial_comparison_v3",
  status: "ready",
  analysis_mode: "evidence_limited_internal_financial_comparison",
  project_id: "project-1",
  profile: { profile_id: "llvt", display_label: "Approved LLVT profile", source_version: "test" },
  assumptions: { currency: "AUD", tax_basis: "gst_exclusive", price_source: "workspace_device_profile", device_profile_sha256: "a".repeat(64), device_prices: { pv_cost_aud_per_kwp_dc: 530, battery_cost_aud_per_kwh: 413, inverter_cost_aud_per_kw_ac: 80 }, equipment_selection: { pv_product_id: "astronergy_astro_n7_600_630w", battery_product_id: "fox_ess_cq7_ci", inverter_product_id: "fox_ess_h3_plus_125kw" }, discount_rate: .08, annual_value_escalation_rate: .025, annual_value_degradation_rate: .005, annual_om_fraction_of_capex: .015, analysis_term_years: 15, replacement_events_aud: [] },
  shortlist_source: { algorithm_id: "ci_all_tariff_scenarios_v1", available_scenario_count: 2, shortlist_count: 2 },
  financial_review_order: { algorithm_id: "ci_highest_npv_review_order_v1", basis: "Highest NPV", leader_scenario_id: "case-1", recommendation_permitted: false },
  solutions: comparisonResult.scenarios.map((scenario, index) => ({ scenario_id: scenario.scenario_id, label: scenario.label, physical_review_rank: scenario.physical_review_rank, financial_review_rank: index + 1, pv_capacity_kwp_dc: scenario.authored_inputs.pv_capacity_kwp_dc, battery_capacity_kwh: scenario.authored_inputs.nominal_capacity_kwh, inverter_capacity_kw_ac: scenario.authored_inputs.pv_inverter_capacity_kw_ac, upfront_cost_aud_ex_gst: 210000 - index * 10000, capex_breakdown_aud_ex_gst: { pv_aud: 75000, battery_aud: 115000, inverter_aud: 20000 }, annual_om_cost_aud_ex_gst: 3150, first_year_value_aud_ex_gst: scenario.annual_tariff_value.first_year_value_ex_gst_aud, annual_cost_aud_ex_gst: scenario.annual_tariff_value.scenario_cost_ex_gst_aud, metrics: { net_present_value_aud: 90000 - index * 20000, payback_period_years: 6.2 + index, internal_rate_of_return: .14 - index * .01, lifetime_net_value_undiscounted_aud: 150000, annual_cashflows_aud: Array(15).fill(33000) }, customer_facing_permission: false, recommendation_permitted: false })),
  currency_values_permitted: true,
  customer_facing_permission: false,
  recommendation_permitted: false,
  disclaimer: "Internal only.",
} as CiAnnualFinancialComparisonResult;

afterEach(cleanup);

describe("Tariff replay result workspace", () => {
  it("shows selectable evidence-bound bill, charge, demand and interval analysis", async () => {
    const user = userEvent.setup();
    render(<CiTariffReplayResult evidenceCode="LLVTOU" financeResult={financeResult} profileLabel="Approved LLVT profile" result={comparisonResult} />);

    expect(screen.getByRole("heading", { name: "NPV and payback across all solutions" })).toBeTruthy();
    expect(screen.queryByLabelText("Comparison metric")).toBeNull();
    expect(screen.getByRole("heading", { name: "Open a solution to inspect the full analysis" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^View details for solution 1:/ }));
    expect(screen.getByRole("heading", { name: "141.7 kWp PV · 300 kWh battery · 250 kW hybrid inverter / PCS" })).toBeTruthy();
    expect(screen.getAllByText("$83,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$37,000").length).toBeGreaterThan(0);
    expect(screen.getByText("Solar PV")).toBeTruthy();
    expect(screen.getByText("Hybrid inverter / PCS")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Select solution analysis" }), "case-2");
    expect(screen.getByRole("heading", { name: "130 kWp PV · 250 kWh battery · 200 kW hybrid inverter / PCS" })).toBeTruthy();
    expect(screen.getAllByText("$31,000").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /^Financial$/ }));
    expect(screen.getByRole("heading", { name: "Cost composition" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Annual cash flow" })).toBeTruthy();
    expect(screen.getByText("0 · Investment")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Bills" }));
    expect(screen.getByRole("heading", { name: "Bill before & after" })).toBeTruthy();
    expect(screen.getByText("Demand charges")).toBeTruthy();
    expect(screen.getByText("$15,000 saved")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Demand" }));
    expect(screen.getByRole("heading", { name: "Selected monthly demand thresholds" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Intervals" }));
    expect(screen.getByRole("img", { name: "Tariff interval demand replay" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Assumptions" }));
    expect(screen.getByText("LLVTOU")).toBeTruthy();
    expect(screen.getByText("Internal evidence review only")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back to all solutions" }));
    expect(screen.getByRole("heading", { name: "Open a solution to inspect the full analysis" })).toBeTruthy();
  });
});

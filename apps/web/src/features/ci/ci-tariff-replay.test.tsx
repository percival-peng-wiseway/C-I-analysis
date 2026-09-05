// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { CiPhysicalScenarioResult } from "./api/ci-scenarios";
import type { CiDesignFeasibilityResult } from "./api/ci-design-feasibility";
import type { CiAnnualFinancialComparisonResult, CiAnnualFinancialRebateBreakdown, CiSavedAnnualFinancialState, CiScenarioRebateCalculation } from "./api/ci-annual-financial-comparison";
import {
  CiTariffReplayResult,
  formatCiTariffReplayProgressLabel,
  resolveCiFinanceAnalysisSelection,
} from "./ci-tariff-replay";

describe("formatCiTariffReplayProgressLabel", () => {
  it("keeps the active batch and elapsed wait visible while tariff replay is synchronous", () => {
    expect(formatCiTariffReplayProgressLabel({
      completedScenarioCount: 0,
      totalScenarioCount: 6,
      phase: "running_batch",
      activeBatchScenarioCount: 1,
      elapsedSeconds: 75,
    })).toBe("Reconstructing tariffs (0/6) · current batch: 1 solution · 1m 15s elapsed");
    expect(formatCiTariffReplayProgressLabel({
      completedScenarioCount: 2,
      totalScenarioCount: 6,
      phase: "confirming_checkpoint",
      activeBatchScenarioCount: 1,
      elapsedSeconds: 630,
    })).toBe("Reconstructing tariffs (2/6) · confirming saved checkpoint · 10m 30s elapsed");
  });
});

const result = {
  assumptions: ["Representative-year tariff quantities use the approved bill rates."],
  baseline: { raw_rolling_demand_kva: 320, chargeable_rolling_demand_kva: 320, billing_period_max_kva: 300, billing_period_max_kw: 275 },
  scenarios: [{
    scenario_id: "case-1",
    label: "Case 1",
    physical_review_rank: 1,
    authored_inputs: {
      pv_capacity_kwp_dc: 141.123456789,
      nominal_capacity_kwh: 300.987654321,
      pv_inverter_capacity_kw_ac: 250.111222333,
      reactive_support_enabled: true,
      reactive_support_max_kvar: 82.5,
      shared_inverter_apparent_power_limit_kva: 275,
    },
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
    post_dispatch: {
      raw_rolling_demand_kva: 250,
      chargeable_rolling_demand_kva: 250,
      billing_period_max_kva: 238,
      billing_period_max_kw: 220,
      billing_period_peak_effect: "reduction",
      billing_period_peak_change_kw: 55,
      maximum_reactive_support_kvar: 47.625,
      maximum_post_grid_reactive_kvar: 31.375,
    },
    selected_monthly_thresholds_kw: [210, 205, 208, 200, 195, 190, 188, 192, 198, 202, 207, 211],
    dispatch_review_projection: {
      peak_local_date: "2025-02-17",
      points: [
        { local_time_label: "16:00", baseline_import_kw: 241.4, post_dispatch_import_kw: 217.75, baseline_kva: 250, post_dispatch_kva: 220, site_reactive_import_kvar: 65, inverter_reactive_support_kvar: 33.625, post_grid_reactive_kvar: 31.375, battery_discharge_kw: 0, grid_charge_kw: 0, pv_charge_kw: 0, soc_end_kwh: 180 },
        { local_time_label: "16:15", baseline_import_kw: 289.1, post_dispatch_import_kw: 235.78, baseline_kva: 300, post_dispatch_kva: 238, site_reactive_import_kvar: 80, inverter_reactive_support_kvar: 47.625, post_grid_reactive_kvar: 32.375, battery_discharge_kw: 0, grid_charge_kw: 0, pv_charge_kw: 0, soc_end_kwh: 180 },
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
      authored_inputs: {
        pv_capacity_kwp_dc: 130,
        nominal_capacity_kwh: 250,
        pv_inverter_capacity_kw_ac: 200,
        reactive_support_enabled: false,
        reactive_support_max_kvar: 0,
        shared_inverter_apparent_power_limit_kva: null,
      },
      annual_tariff_value: {
        ...result.scenarios[0]!.annual_tariff_value,
        scenario_cost_ex_gst_aud: 88999.75,
        first_year_value_ex_gst_aud: 31000.25,
      },
      post_dispatch: {
        ...result.scenarios[0]!.post_dispatch,
        raw_rolling_demand_kva: 270.125,
        maximum_reactive_support_kvar: 0,
        maximum_post_grid_reactive_kvar: 80.125,
      },
    },
  ],
} as CiPhysicalScenarioResult;

const feasibilityResult = {
  scenarios: comparisonResult.scenarios.map((scenario) => ({
    scenario_id: scenario.scenario_id,
    peak_day: {
      date: "2024-12-16",
      sampled_target_kw: 200,
      points: [
        { time_label: "16:00", baseline_kw: 300, pv_only_import_kw: 250, pv_battery_import_kw: 200, battery_discharge_kw: 50 },
        { time_label: "16:15", baseline_kw: 305, pv_only_import_kw: 255, pv_battery_import_kw: 200, battery_discharge_kw: 55 },
      ],
    },
  })),
} as unknown as CiDesignFeasibilityResult;

function rebateCalculation(scenarioId: string): CiScenarioRebateCalculation {
  return {
    contract_version: "ci_scenario_rebate_calculation_v1",
    scenario_id: scenarioId,
    ruleset_id: "au_ci_rebates_2026_v1",
    ruleset_sha256: "c".repeat(64),
    target_certificate_date: "2026-09-02",
    programs: {
      solar_stc: {
        program_id: "solar_stc", label: "Solar STCs", status: "applied", reason_codes: [], reason_messages: [],
        certificate_quantity: 100, unit_price_aud_ex_gst: 39, rebate_aud_ex_gst: 3900,
        formula: { rule_id: "cer_solar_stc_2026_2030_v1", operands: { postcode_zone_rating: 1.382, deeming_years: 5 }, rounding: "floor_after_multiplication" },
        sources: { eligibility_source_label: "CER eligibility review", price_source_label: "Net certificate price", price_as_of_date: "2026-09-02", zone_source_label: "CER postcode zone table" },
      },
      battery_stc: {
        program_id: "battery_stc", label: "Battery STCs", status: "ineligible",
        reason_codes: ["battery_stc_nominal_capacity_out_of_range"], reason_messages: ["Battery STCs require total nominal capacity from 5 kWh through 100 kWh."],
        certificate_quantity: 0, unit_price_aud_ex_gst: 39, rebate_aud_ex_gst: 0,
        formula: { rule_id: "cer_battery_stc_2025_2030_v1", operands: { nominal_capacity_kwh: 300, certified_usable_capacity_fraction: 0.9 }, rounding: "floor_after_all_tiers_summed" },
        sources: { eligibility_source_label: "CER eligibility review", price_source_label: "Net certificate price", price_as_of_date: "2026-09-02", capacity_source_label: "Approved product datasheet" },
      },
      vic_deemed_veec: {
        program_id: "vic_deemed_veec", label: "Victorian deemed VEECs", status: "applied", reason_codes: [], reason_messages: [],
        certificate_quantity: 20, unit_price_aud_ex_gst: 70, rebate_aud_ex_gst: 1400,
        formula: { rule_id: "vic_veu_part47_v25_2026_v1", operands: { victoria_region: "metropolitan", regional_factor: 0.98, inverter_apparent_power_kva_per_kw_ac: 1.25 }, rounding: "floor_after_multiplication" },
        sources: { eligibility_source_label: "VEU Part 47 review", price_source_label: "Net certificate price", price_as_of_date: "2026-09-02", inverter_apparent_power_source_label: "Approved inverter datasheet" },
      },
    },
    total_rebate_aud_ex_gst: 5300,
    eligibility_guaranteed: false,
    customer_facing_permission: false,
  };
}

function rebateBreakdown(calculation: CiScenarioRebateCalculation): CiAnnualFinancialRebateBreakdown[] {
  return Object.values(calculation.programs).map((program) => ({
    program_id: program.program_id, label: program.label, status: program.status,
    certificate_quantity: program.certificate_quantity, unit_price_aud_ex_gst: program.unit_price_aud_ex_gst,
    rebate_aud_ex_gst: program.rebate_aud_ex_gst,
  }));
}

const financeResult: CiAnnualFinancialComparisonResult = {
  contract_version: "ci_annual_financial_comparison_v4",
  status: "ready",
  analysis_mode: "evidence_limited_internal_financial_comparison",
  project_id: "project-1",
  source_tariff_replay_sha256: "d".repeat(64),
  profile: { profile_id: "llvt", display_label: "Approved LLVT profile", source_version: "test" },
  assumptions: { currency: "AUD", tax_basis: "gst_exclusive", price_source: "workspace_device_profile", device_profile_sha256: "a".repeat(64), device_prices: { pv_cost_aud_per_kwp_dc: 530, battery_cost_aud_per_kwh: 413, inverter_cost_aud_per_kw_ac: 80 }, equipment_selection: { pv_product_id: "astronergy_astro_n7_600_630w", battery_product_id: "fox_ess_cq7_ci", inverter_product_id: "fox_ess_h3_plus_125kw" }, rebate_profile_sha256: "b".repeat(64), rebate_ruleset_id: "au_ci_rebates_2026_v1", rebate_ruleset_sha256: "c".repeat(64), rebate_application_basis: "deducted_from_workspace_device_profile_gross_cost", discount_rate: .08, annual_value_escalation_rate: .025, annual_value_degradation_rate: .005, annual_om_fraction_of_capex: .015, analysis_term_years: 15, replacement_events_aud: [] },
  shortlist_source: { algorithm_id: "ci_all_tariff_scenarios_v1", available_scenario_count: 2, shortlist_count: 2 },
  financial_review_order: { algorithm_id: "ci_highest_npv_review_order_v1", basis: "Highest NPV", leader_scenario_id: "case-1", recommendation_permitted: false },
  solutions: comparisonResult.scenarios.map((scenario, index) => {
    const grossUpfront = 210000 - index * 10000;
    const calculation = rebateCalculation(scenario.scenario_id);
    return { scenario_id: scenario.scenario_id, label: scenario.label, physical_review_rank: scenario.physical_review_rank, financial_review_rank: index + 1, pv_capacity_kwp_dc: scenario.authored_inputs.pv_capacity_kwp_dc, battery_capacity_kwh: scenario.authored_inputs.nominal_capacity_kwh, inverter_capacity_kw_ac: scenario.authored_inputs.pv_inverter_capacity_kw_ac, gross_upfront_cost_aud_ex_gst: grossUpfront, upfront_rebate_aud_ex_gst: calculation.total_rebate_aud_ex_gst, upfront_cost_aud_ex_gst: grossUpfront - calculation.total_rebate_aud_ex_gst, rebate_application_status: "applied_to_device_profile_gross_cost", rebate_breakdown: rebateBreakdown(calculation), rebate_calculation: calculation, capex_breakdown_aud_ex_gst: { pv_aud: 75000, battery_aud: 115000 - index * 10000, inverter_aud: 20000 }, annual_om_cost_aud_ex_gst: grossUpfront * .015, first_year_value_aud_ex_gst: scenario.annual_tariff_value.first_year_value_ex_gst_aud, annual_cost_aud_ex_gst: scenario.annual_tariff_value.scenario_cost_ex_gst_aud, metrics: { net_present_value_aud: 90000 - index * 20000, payback_period_years: 6.2 + index, internal_rate_of_return: .14 - index * .01, lifetime_net_value_undiscounted_aud: 150000, annual_cashflows_aud: Array(15).fill(33000) }, customer_facing_permission: false, recommendation_permitted: false };
  }),
  currency_values_permitted: true,
  customer_facing_permission: false,
  recommendation_permitted: false,
  disclaimer: "Internal only.",
};

afterEach(cleanup);

describe("Tariff replay result workspace", () => {
  it("uses the current Solution Generator selection instead of defaulting to every design", () => {
    expect(resolveCiFinanceAnalysisSelection({
      candidates: [
        { scenario_id: "case-1" },
        { scenario_id: "case-2" },
      ],
    } as never, null, {
      previewRevision: "current-preview",
      scenarioIds: ["case-2"],
      prices: [{ scenarioId: "case-2", upfrontCostAudExGst: 195000 }],
    })).toEqual({
      scenarioIds: ["case-2"],
      savedManualPrices: [{ scenarioId: "case-2", upfrontCostAudExGst: 195000 }],
    });
  });

  it("fails closed instead of analysing every design when no selection is saved", () => {
    expect(() => resolveCiFinanceAnalysisSelection({
      candidates: [
        { scenario_id: "case-1" },
        { scenario_id: "case-2" },
      ],
    } as never, null)).toThrow("Return to Solution Generator, select the solutions to analyse");
  });

  it("re-runs exactly the saved manual-quotation subset", () => {
    const savedFinance: CiSavedAnnualFinancialState = {
      contract_version: "ci_project_annual_financial_state_v1",
      status: "ready",
      saved_at: "2026-09-04T00:00:00Z",
      stale_reasons: [],
      result: {
        ...financeResult,
        assumptions: {
          ...financeResult.assumptions,
          price_source: "analyst_entered_total_solution_price",
          device_profile_sha256: null,
          device_prices: null,
          equipment_selection: null,
          rebate_application_basis: "not_deducted_from_analyst_entered_manual_quote",
        },
        shortlist_source: { ...financeResult.shortlist_source, shortlist_count: 1 },
        solutions: [financeResult.solutions[0]!],
      },
    };

    expect(resolveCiFinanceAnalysisSelection({
      candidates: [
        { scenario_id: "case-1" },
        { scenario_id: "case-2" },
      ],
    } as never, savedFinance)).toEqual({
      scenarioIds: ["case-1"],
      savedManualPrices: [{
        scenarioId: "case-1",
        upfrontCostAudExGst: financeResult.solutions[0]!.upfront_cost_aud_ex_gst,
      }],
    });
  });

  it("fails closed when a saved manual quotation is outside the current design", () => {
    const savedFinance: CiSavedAnnualFinancialState = {
      contract_version: "ci_project_annual_financial_state_v1",
      status: "ready",
      saved_at: "2026-09-04T00:00:00Z",
      stale_reasons: [],
      result: {
        ...financeResult,
        assumptions: {
          ...financeResult.assumptions,
          price_source: "analyst_entered_total_solution_price",
          device_profile_sha256: null,
          device_prices: null,
          equipment_selection: null,
          rebate_application_basis: "not_deducted_from_analyst_entered_manual_quote",
        },
        shortlist_source: { ...financeResult.shortlist_source, shortlist_count: 1 },
        solutions: [{ ...financeResult.solutions[0]!, scenario_id: "removed-case" }],
      },
    };

    expect(() => resolveCiFinanceAnalysisSelection({
      candidates: [{ scenario_id: "case-1" }],
    } as never, savedFinance)).toThrow("saved quotation selection no longer matches the current solution design");
  });

  it("fails closed when Finance and tariff replay contain different scenario IDs", () => {
    render(<CiTariffReplayResult
      evidenceCode="LLVTOU"
      financeResult={{
        ...financeResult,
        solutions: financeResult.solutions.map((solution, index) => (
          index === 0 ? { ...solution, scenario_id: "stale-case" } : solution
        )),
      }}
      profileLabel="Approved LLVT profile"
      result={comparisonResult}
    />);

    expect(screen.getByRole("alert").textContent).toContain("does not match the current tariff replay");
    expect(screen.queryByRole("heading", { name: "Open a solution to inspect the full analysis" })).toBeNull();
  });

  it("fails closed when paired Finance values came from an older tariff replay", () => {
    render(<CiTariffReplayResult
      evidenceCode="LLVTOU"
      financeResult={{
        ...financeResult,
        solutions: financeResult.solutions.map((solution, index) => (
          index === 0
            ? { ...solution, first_year_value_aud_ex_gst: solution.first_year_value_aud_ex_gst + 1 }
            : solution
        )),
      }}
      profileLabel="Approved LLVT profile"
      result={comparisonResult}
    />);

    expect(screen.getByRole("alert").textContent).toContain("Finance values do not match");
    expect(screen.queryByRole("heading", { name: "Open a solution to inspect the full analysis" })).toBeNull();
  });

  it("shows selectable evidence-bound bill, charge, demand and interval analysis", async () => {
    const user = userEvent.setup();
    render(<CiTariffReplayResult evidenceCode="LLVTOU" feasibilityResult={feasibilityResult} financeResult={financeResult} profileLabel="Approved LLVT profile" result={comparisonResult} />);

    expect(screen.getByRole("heading", { name: "NPV and payback across all solutions" })).toBeTruthy();
    expect(screen.queryByLabelText("Comparison metric")).toBeNull();
    expect(screen.getByRole("heading", { name: "Open a solution to inspect the full analysis" })).toBeTruthy();
    expect(screen.getByText("Reactive On · 82.5 kvar cap")).toBeTruthy();
    expect(screen.getByText("Reactive Off")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^View details for solution 1:/ }));
    expect(screen.getByRole("heading", { name: "141.123456789 kWp PV · 300.987654321 kWh battery · 250.111222333 kW hybrid inverter / PCS" })).toBeTruthy();
    expect(screen.getAllByText("$83,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$37,000.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Solar PV")).toBeTruthy();
    expect(screen.getByText("Hybrid inverter / PCS")).toBeTruthy();
    const reactiveDiagnostics = screen.getByRole("region", { name: "Reactive support diagnostics" });
    expect(within(reactiveDiagnostics).getByText("On")).toBeTruthy();
    expect(within(reactiveDiagnostics).getByText("82.5 kvar")).toBeTruthy();
    expect(within(reactiveDiagnostics).getByText("47.625 kvar")).toBeTruthy();
    expect(within(reactiveDiagnostics).getByText("31.375 kvar")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Select solution analysis" }), "case-2");
    expect(screen.getByRole("heading", { name: "130 kWp PV · 250 kWh battery · 200 kW hybrid inverter / PCS" })).toBeTruthy();
    expect(screen.getAllByText("$31,000.25").length).toBeGreaterThan(0);
    const disabledReactiveDiagnostics = screen.getByRole("region", { name: "Reactive support diagnostics" });
    expect(within(disabledReactiveDiagnostics).getByText("Off")).toBeTruthy();
    expect(within(disabledReactiveDiagnostics).getAllByText("0 kvar")).toHaveLength(2);
    expect(within(disabledReactiveDiagnostics).getByText("80.125 kvar")).toBeTruthy();
    expect(screen.getByText("49.875 kVA")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Financial$/ }));
    expect(screen.getByRole("heading", { name: "Cost composition" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Annual cash flow" })).toBeTruthy();
    expect(screen.getAllByText("Gross CAPEX").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Upfront rebates").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Net upfront cost").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Rebate calculation audit" })).toBeTruthy();
    expect(screen.getByText("Applied to device-profile gross cost")).toBeTruthy();
    expect(screen.getByText("Solar STCs")).toBeTruthy();
    expect(screen.getByText("Battery STCs")).toBeTruthy();
    expect(screen.getByText("Victorian deemed VEECs")).toBeTruthy();
    expect(screen.getByText("$5,300.00")).toBeTruthy();
    expect(screen.getByText("0 · Investment")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Bills" }));
    expect(screen.getByRole("heading", { name: "Bill before & after" })).toBeTruthy();
    expect(screen.getByText("Demand charges")).toBeTruthy();
    expect(screen.getByText("$15,000.00 saved")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Demand" }));
    expect(screen.getByRole("heading", { name: "Optimized monthly demand ceilings" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Intervals" }));
    expect(screen.getByRole("img", { name: "Tariff interval demand replay" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Scenario Analysis active-power peak shaving replay" })).toBeNull();
    expect(screen.getByRole("button", { name: "Optimized dispatch" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: "Tariff battery charge and discharge" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Tariff battery state of charge" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Active import · kW" }));
    expect(within(screen.getByRole("img", { name: "Tariff interval demand replay" })).getByText("16:00 · Post-dispatch import kW: 217.75 kW")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Technical screening · kW" }));
    expect(screen.getByRole("img", { name: "Scenario Analysis active-power peak shaving replay" })).toBeTruthy();
    expect(screen.getByText("2 intervals at target")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Optimized dispatch" }));
    expect(screen.getByRole("img", { name: "Tariff interval demand replay" })).toBeTruthy();
    expect(screen.getByText("Battery idle on this day")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Assumptions" }));
    expect(screen.getByText("LLVTOU")).toBeTruthy();
    expect(screen.getByText("Internal evidence review only")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back to all solutions" }));
    expect(screen.getByRole("heading", { name: "Open a solution to inspect the full analysis" })).toBeTruthy();
  });
});

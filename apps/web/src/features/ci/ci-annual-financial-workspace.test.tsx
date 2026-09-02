// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { CiAnnualFinancialComparisonResult, CiAnnualFinancialRebateBreakdown, CiScenarioRebateCalculation } from "./api/ci-annual-financial-comparison";
import { CiAnnualFinancialWorkspace } from "./ci-annual-financial-workspace";

const fixtures = vi.hoisted(() => {
  const rebateCalculation = (scenarioId: string): CiScenarioRebateCalculation => ({
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
        formula: { rule_id: "cer_battery_stc_2025_2030_v1", operands: { nominal_capacity_kwh: 390, certified_usable_capacity_fraction: 0.9 }, rounding: "floor_after_all_tiers_summed" },
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
  });
  const rebateBreakdown = (calculation: CiScenarioRebateCalculation): CiAnnualFinancialRebateBreakdown[] => Object.values(calculation.programs).map((program) => ({
    program_id: program.program_id, label: program.label, status: program.status,
    certificate_quantity: program.certificate_quantity, unit_price_aud_ex_gst: program.unit_price_aud_ex_gst,
    rebate_aud_ex_gst: program.rebate_aud_ex_gst,
  }));
  const scenarios = [
    ["scenario-1", 146, 390, 150, 38852, 178351],
    ["scenario-2", 142, 390, 145, 38073, 179130],
    ["scenario-3", 138, 360, 140, 36536, 180667],
    ["scenario-4", 134, 330, 135, 34998, 182205],
  ].map(([id, pv, battery, inverter, value, bill], index) => ({
    scenario_id: String(id),
    label: `Solution ${index + 1}`,
    physical_review_rank: index + 1,
    authored_inputs: { pv_capacity_kwp_dc: Number(pv), nominal_capacity_kwh: Number(battery), pv_inverter_capacity_kw_ac: Number(inverter) },
    annual_tariff_value: { first_year_value_ex_gst_aud: Number(value), scenario_cost_ex_gst_aud: Number(bill) },
  }));
  const comparison: CiAnnualFinancialComparisonResult = {
    contract_version: "ci_annual_financial_comparison_v4",
    status: "ready",
    analysis_mode: "evidence_limited_internal_financial_comparison",
    project_id: "project-1",
    source_tariff_replay_sha256: "d".repeat(64),
    profile: { profile_id: "llvt", display_label: "Approved LLVT profile", source_version: "test" },
    assumptions: { currency: "AUD", tax_basis: "gst_exclusive", price_source: "workspace_device_profile", device_profile_sha256: "a".repeat(64), device_prices: { pv_cost_aud_per_kwp_dc: 530, battery_cost_aud_per_kwh: 413, inverter_cost_aud_per_kw_ac: 80 }, equipment_selection: { pv_product_id: "astronergy_astro_n7_600_630w", battery_product_id: "fox_ess_cq7_ci", inverter_product_id: "fox_ess_h3_plus_125kw" }, rebate_profile_sha256: "b".repeat(64), rebate_ruleset_id: "au_ci_rebates_2026_v1", rebate_ruleset_sha256: "c".repeat(64), rebate_application_basis: "deducted_from_workspace_device_profile_gross_cost", discount_rate: 0.08, annual_value_escalation_rate: 0.025, annual_value_degradation_rate: 0.005, annual_om_fraction_of_capex: 0.015, analysis_term_years: 15, replacement_events_aud: [] },
    shortlist_source: { algorithm_id: "ci_all_tariff_scenarios_v1", available_scenario_count: 4, shortlist_count: 3 },
    financial_review_order: { algorithm_id: "ci_highest_npv_review_order_v1", basis: "Highest NPV", leader_scenario_id: "scenario-1", recommendation_permitted: false },
    solutions: scenarios.slice(0, 3).map((item, index) => {
      const grossUpfront = 250000 + index * 20000;
      const calculation = rebateCalculation(item.scenario_id);
      return { scenario_id: item.scenario_id, label: item.label, physical_review_rank: item.physical_review_rank, financial_review_rank: index + 1, pv_capacity_kwp_dc: item.authored_inputs.pv_capacity_kwp_dc, battery_capacity_kwh: item.authored_inputs.nominal_capacity_kwh, inverter_capacity_kw_ac: item.authored_inputs.pv_inverter_capacity_kw_ac, gross_upfront_cost_aud_ex_gst: grossUpfront, upfront_rebate_aud_ex_gst: calculation.total_rebate_aud_ex_gst, upfront_cost_aud_ex_gst: grossUpfront - calculation.total_rebate_aud_ex_gst, rebate_application_status: "applied_to_device_profile_gross_cost", rebate_breakdown: rebateBreakdown(calculation), rebate_calculation: calculation, capex_breakdown_aud_ex_gst: { pv_aud: 70000, battery_aud: 160000 + index * 20000, inverter_aud: 20000 }, annual_om_cost_aud_ex_gst: 3750 + index * 300, first_year_value_aud_ex_gst: item.annual_tariff_value.first_year_value_ex_gst_aud, annual_cost_aud_ex_gst: item.annual_tariff_value.scenario_cost_ex_gst_aud, metrics: { net_present_value_aud: 90000 - index * 10000, payback_period_years: 6.8 + index, internal_rate_of_return: 0.13 - index * 0.01, lifetime_net_value_undiscounted_aud: 150000, annual_cashflows_aud: Array(15).fill(35000) }, customer_facing_permission: false, recommendation_permitted: false };
    }),
    currency_values_permitted: true,
    customer_facing_permission: false,
    recommendation_permitted: false,
    disclaimer: "Internal only.",
  };
  return { scenarios, comparison, compare: vi.fn(async (_input: unknown) => comparison) };
});

vi.mock("./api/ci-scenarios", () => ({
  ciProjectTariffReplayQueryKey: (projectId: string) => ["tariff", projectId],
  fetchCiSavedTariffReplay: async (projectId: string) => projectId === "chef-q" ? ({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }) : ({ contract_version: "ci_project_tariff_replay_state_v1", status: "ready", saved_at: "2026-08-19", stale_reasons: [], result: { scenarios: fixtures.scenarios } }),
}));

vi.mock("./api/ci-annual-financial-comparison", () => ({
  ciAnnualFinancialComparisonQueryKey: (projectId: string) => ["finance", projectId],
  fetchCiSavedAnnualFinancialComparison: async () => ({ contract_version: "ci_project_annual_financial_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }),
  compareCiAnnualFinancialScenarios: fixtures.compare,
}));

vi.mock("./api/ci-device-profile", () => ({
  ciDeviceProfileQueryKey: ["device-profile"],
  fetchCiDeviceProfile: async () => ({
    contract_version: "ci_device_profile_state_v1",
    status: "ready",
    updated_at: "2026-08-19",
    profile_sha256: "a".repeat(64),
    profile: { contract_version: "ci_device_profile_v1", profile_id: "workspace_device_profile", currency: "AUD", tax_basis: "gst_exclusive", pv_cost_aud_per_kwp_dc: 530, battery_cost_aud_per_kwh: 413, inverter_cost_aud_per_kw_ac: 80, discount_rate: 0.08, annual_value_escalation_rate: 0.025, annual_value_degradation_rate: 0.005, annual_om_fraction_of_capex: 0.015, analysis_term_years: 15 },
    suggested_profile: null,
  }),
}));

const project = { project_id: "project-1", display_name: "Factory", current_stage: "system_design" as const, setup_status: "ready" as const, design_status: "ready" as const, design_candidate_count: 4, created_at: "2026-08-17T00:00:00Z", updated_at: "2026-08-17T00:00:00Z" };
const chefQProject = { ...project, project_id: "chef-q", display_name: "Chef Q" };

afterEach(() => { cleanup(); fixtures.compare.mockClear(); });

it("applies the shared Device profile to all tariff scenarios", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CiAnnualFinancialWorkspace onComplete={() => undefined} profileReady project={project} /></QueryClientProvider>);

  expect(await screen.findByRole("heading", { name: "Compare every replayed solution" })).toBeTruthy();
  expect(await screen.findByText("$530 / kWp")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Run 4 solutions" }));

  await waitFor(() => expect(fixtures.compare).toHaveBeenCalledTimes(1));
  expect(fixtures.compare.mock.calls[0]?.[0]).toMatchObject({ pricingMode: "device_profile" });
  expect(await screen.findByRole("heading", { name: "NPV and payback across all solutions" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "All solution NPV and payback comparison" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "All solution financial metrics" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Cumulative cash flow comparison" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Financial review leader" })).toBeNull();
  expect(screen.getAllByText("+$90,000").length).toBeGreaterThan(0);
});

it("shows the supplied Chef Q Top 3 report snapshot when replay is not ready", async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CiAnnualFinancialWorkspace onComplete={() => undefined} profileReady project={chefQProject} /></QueryClientProvider>);

  expect(await screen.findByRole("heading", { name: "Commercial comparison snapshot" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Highest NPV option" })).toBeNull();
  expect(screen.getByRole("heading", { name: "250 kWh battery" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Top 3 financial return comparison" })).toBeTruthy();
  expect(screen.getAllByText("$417,782.55").length).toBeGreaterThan(0);
  expect(screen.getAllByText("375.84 kWh battery").length).toBeGreaterThan(0);
  expect(screen.getByText("+$1,542.68/yr")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Run finance/ })).toBeNull();
});

// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { CiAnnualFinancialWorkspace } from "./ci-annual-financial-workspace";

const project = { project_id: "project-1", display_name: "Factory", current_stage: "system_design" as const, setup_status: "ready" as const, design_status: "ready" as const, design_candidate_count: 1, created_at: "2026-08-17T00:00:00Z", updated_at: "2026-08-17T00:00:00Z" };
const candidate = { scenario_id: "scenario-1", label: "100 kWp + 200 kWh", battery_system_id: "battery-1", battery_technology_id: "generic_li_ion_ac", control_profile_id: "demand_peak_shaving", pv_system_id: "pv-1", pv_profile_id: "generic_normalized_solar_shape_v1", pv_capacity_kwp_dc: 100, pv_inverter_capacity_kw_ac: 80, shared_ac_headroom_kw: 250, reactive_support_enabled: false, reactive_support_max_kvar: 0, shared_inverter_apparent_power_limit_kva: null, reactive_capability_curve: "circular_pq", reactive_capability_provenance: "analyst_assumption", reactive_overcompensation_permitted: false, pv_annual_specific_yield_kwh_per_kw: 1500, pv_derating_factor: 0.88, nominal_capacity_kwh: 200, max_charge_kw: 100, max_discharge_kw: 100, charge_efficiency: 0.95, discharge_efficiency: 0.95, min_soc_fraction: 0.1, max_soc_fraction: 1, initial_soc_fraction: 1, allow_grid_charging: false };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("selects a saved design and renders annual bill and cashflow charts", async () => {
  const result = { contract_version: "ci_annual_financial_simulation_v1", status: "ready", analysis_mode: "evidence_limited_internal_review", project_id: "project-1", selected_design_id: "scenario-1", profile: { profile_id: "profile", display_label: "Evidence profile", source_version: "v1" }, value_basis: "battery_incremental", cases: [
    { case_id: "no_system", label: "No system", scenario_id: null, annual_cost_ex_gst_aud: 100000, annual_cost_inc_gst_aud: 110000, first_year_value_ex_gst_aud: 0, first_year_value_inc_gst_aud: 0, raw_rolling_demand_kva: 300 },
    { case_id: "pv_only", label: "PV only", scenario_id: "pv-only", annual_cost_ex_gst_aud: 70000, annual_cost_inc_gst_aud: 77000, first_year_value_ex_gst_aud: 30000, first_year_value_inc_gst_aud: 33000, raw_rolling_demand_kva: 250 },
    { case_id: "pv_battery", label: "PV + battery", scenario_id: "scenario-1", annual_cost_ex_gst_aud: 60000, annual_cost_inc_gst_aud: 66000, first_year_value_ex_gst_aud: 40000, first_year_value_inc_gst_aud: 44000, raw_rolling_demand_kva: 220 },
  ], battery_incremental_value: { ex_gst_aud: 10000, inc_gst_aud: 11000 }, financial_projection: { assumptions: { upfront_cost_aud: 60000, first_year_net_value_aud: 10000, annual_om_cost_aud: 500, replacement_events_aud: [], discount_rate: 0.08, annual_value_degradation_rate: 0, analysis_term_years: 3, currency: "AUD", value_source: "battery_incremental", pricing_resolution: { tax_basis: "gst_exclusive", resolved_upfront_cost_aud: 60000, resolved_annual_om_cost_aud: 500 } }, metrics: { net_present_value_aud: -35000, payback_period_years: null, internal_rate_of_return: null, lifetime_net_value_undiscounted_aud: -31500, annual_cashflows_aud: [9500, 9500, 9500] } }, currency_values_permitted: true, customer_facing_permission: false, recommendation_permitted: false, disclaimer: "Internal only." };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/design-candidates")) return new Response(JSON.stringify({ contract_version: "ci_saved_design_state_v1", status: "ready", design: { contract_version: "ci_design_candidate_validation_v1", status: "ready", validation_basis: "python_scenario_input_contract_v1", candidate_count: 1, candidates: [candidate], dispatch_evaluated: false, tariff_evaluated: false, customer_facing_permission: false, recommendation_permitted: false, disclaimer: "inputs" } }), { status: 200 });
    if (path.endsWith("/pricing-catalog")) return new Response(JSON.stringify({ versions: [{ catalog_version_id: "catalog-1", version_number: 1, status: "published", catalog_hash: "a".repeat(64), catalog: { contract_version: "ci_pricing_catalog_v1", catalog_id: "ci_solution_pricing", currency: "AUD", tax_basis: "gst_exclusive", products: [{ item_id: "battery", label: "Battery", category: "battery", pricing_basis: "fixed", unit_price_aud: 60000, effective_status: "active" }], installation_items: [] } }] }), { status: 200 });
    if (path.endsWith("/annual-financial-simulation") && init?.method === "POST") return new Response(JSON.stringify(result), { status: 200 });
    throw new Error(`Unexpected request: ${path}`);
  }));
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><CiAnnualFinancialWorkspace onComplete={() => undefined} profileReady project={project} /></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Annual scenario setup" })).toBeTruthy();
  await user.upload(screen.getByLabelText("Matching NEM12 CSV"), new File(["x"], "nem12.csv", { type: "text/csv" }));
  await user.click(screen.getByRole("checkbox", { name: "Battery" }));
  await user.click(screen.getByRole("button", { name: "Run annual financial simulation" }));
  expect(await screen.findByRole("heading", { name: "Annual bill comparison" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Cumulative project cashflow chart" })).toBeTruthy();
  expect(screen.getByText("Battery incremental value ex GST")).toBeTruthy();
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDesignFeasibilityResult } from "./api/ci-design-feasibility";
import { CiDesignFeasibility } from "./ci-design-feasibility";

const points = Array.from({ length: 48 }, (_, index) => ({ timestamp: `2026-01-01T${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00+10:00`, time_label: `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`, baseline_kw: 100, pv_only_import_kw: 80, pv_battery_import_kw: 60, pv_generation_kw: 20, battery_charge_kw: 0, battery_discharge_kw: 20, soc_kwh: 50 }));
const totals = { site_import_before_kwh: 1000, grid_import_after_pv_only_kwh: 780, grid_import_after_kwh: 700, grid_import_reduction_kwh: 300, grid_import_reduction_percent: 30, pv_generation_kwh: 400, pv_direct_to_load_kwh: 250, pv_to_battery_kwh: 100, grid_export_kwh: 50, pv_clipped_kwh: 0, pv_self_consumption_percent: 87.5, battery_charge_input_kwh: 100, battery_discharge_output_kwh: 90, battery_equivalent_full_cycles: 0.45, battery_active_days: 2, battery_active_day_percent: 100, grid_emissions_factor_kg_co2e_per_kwh: 0.79, baseline_scope_2_emissions_t_co2e: 0.79, post_system_scope_2_emissions_t_co2e: 0.553, avoided_scope_2_emissions_t_co2e: 0.237, scope_2_emissions_reduction_percent: 30 };
const performance = { dispatch_basis: "pv_first_coverage_dispatch", baseline_peak_kw: 100, pv_only_peak_kw: 80, grid_import_peak_kw: 60, grid_import_peak_reduction_kw: 40, grid_import_peak_reduction_percent: 40, top_10_event_count: 2, top_10_events_mitigated: 2, top_10_event_coverage_percent: 100, top_20_event_count: 2, top_20_events_mitigated: 2, top_20_event_coverage_percent: 100, battery_duration_at_max_discharge_hours: 1.7, battery_power_to_peak_percent: 50, minimum_observed_soc_kwh: 20, maximum_observed_soc_kwh: 190, top_peak_events: [{ rank: 1, timestamp: "2026-01-01T12:00:00+10:00", baseline_kw: 100, pv_only_import_kw: 80, grid_import_kw: 60, reduction_kw: 40, reduction_percent: 40, mitigated: true }, { rank: 2, timestamp: "2026-01-02T12:00:00+10:00", baseline_kw: 95, pv_only_import_kw: 75, grid_import_kw: 55, reduction_kw: 40, reduction_percent: 42.1, mitigated: true }] } as const;

const scenarios = Array.from({ length: 12 }, (_, index) => scenario({ id: `solution-${index + 1}`, label: `Solution ${index + 1}`, rank: index + 1, pv: index === 0 ? 100.123456789 : 100 + index * 5, inverter: index === 0 ? 80.111222333 : 80 + index * 4, battery: index === 0 ? 200.987654321 : 200 + index * 10, reduction: 30 + index }));
const result = {
  contract_version: "ci_design_feasibility_v5", status: "ready", analysis_mode: "pre_tariff_physical_feasibility", customer_facing_permission: false, recommendation_permitted: false, tariff_evaluated: false, currency_values_permitted: false,
  coverage: { input_format: "wide_interval_30_minute", interval_minutes: 30, interval_count: 96, start_timestamp: "2026-01-01T00:00:00+10:00", end_timestamp: "2026-01-02T23:30:00+10:00", time_basis: "source", years: [{ year: 2026, interval_count: 96, complete_calendar_year: false }], primary_year: 2026 },
  baseline: { peak_date: "2026-01-01", peak_kw: 100, peak_timestamp: "2026-01-01T12:00:00+10:00", daily_profile_cloud: { sampled_daily_profiles: [{ date: "2026-01-02", values_kw: Array(48).fill(40) }], average_day_kw: Array(48).fill(50), selected_peak_day_kw: Array(48).fill(100), time_labels: points.map((point) => point.time_label) } },
  physical_review_order: { algorithm_id: "ci_pre_tariff_physical_review_order_v2", shortlist_count: 10, basis: "Highest measured grid-import reduction first.", recommendation_permitted: false },
  scenarios, assumptions: [],
} as unknown as CiDesignFeasibilityResult;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("C&I design feasibility visuals", () => {
  it("shows every generated solution on the left and selectable dispatch metrics on the right", async () => {
    const user = userEvent.setup();
    render(<CiDesignFeasibility projectId="project-1" result={result} />);

    expect(screen.getByText(/Pre-tariff physical screening only/)).toBeTruthy();

    expect(screen.getByRole("heading", { name: "12 simulated scenarios" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "100.123456789 kWp PV · 200.987654321 kWh battery · 80.111222333 kW hybrid inverter / PCS" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Annual grid import comparison" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open solution 12: 155 kWp PV · 310 kWh battery · 124 kW hybrid inverter / PCS" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open solution 12: 155 kWp PV · 310 kWh battery · 124 kW hybrid inverter / PCS" }));
    expect(screen.getByRole("heading", { name: "155 kWp PV · 310 kWh battery · 124 kW hybrid inverter / PCS" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Peak shaving" }));
    expect(screen.getByRole("img", { name: "Peak day active power chart" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Peak-day outcome" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Energy & SOC" }));
    expect(screen.getByRole("img", { name: "Battery state of charge and power chart" })).toBeTruthy();
    expect(screen.getByText("2026-01-01 · highest measured interval day across the uploaded data.")).toBeTruthy();
    expect(screen.getAllByText("Highest measured interval").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Measured daily demand context" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Carbon" }));
    expect(screen.getByRole("heading", { name: "Operational Scope 2 comparison" })).toBeTruthy();
    expect(screen.getByText("0.79 kg/kWh")).toBeTruthy();
    expect(screen.getByText("Accounting boundary:")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Scenario list metric"), "post_system_peak");
    expect((screen.getByLabelText("Scenario list metric") as HTMLSelectElement).value).toBe("post_system_peak");
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});

function scenario(input: { id: string; label: string; rank: number; pv: number; inverter: number; battery: number; reduction: number }) {
  const scenarioTotals = { ...totals, grid_import_after_kwh: 1000 * (1 - input.reduction / 100), grid_import_reduction_kwh: 10 * input.reduction, grid_import_reduction_percent: input.reduction };
  return { scenario_id: input.id, label: input.label, physical_review_rank: input.rank, authored_inputs: { pv_capacity_kwp_dc: input.pv, pv_inverter_capacity_kw_ac: input.inverter, nominal_capacity_kwh: input.battery, max_discharge_kw: input.battery / 2 }, energy_dispatch_algorithm_id: "ci_pre_tariff_pv_self_consumption_v1", yearly_energy: [{ year: 2026, ...scenarioTotals, performance }], coverage_energy: scenarioTotals, coverage_performance: performance, initial_soc_kwh: input.battery, final_soc_kwh: input.battery / 2, peak_day: { algorithm_id: "ci_pre_tariff_peak_day_envelope_v2", date: "2026-01-01", baseline_peak_kw: 100, pv_only_peak_kw: 80, achieved_peak_kw: 60, sampled_target_kw: 60, peak_reduction_kw: 40, peak_reduction_percent: 40, points, grid_charging_permitted: false, billing_demand_interpretation_permitted: false }, customer_facing_permission: false, recommendation_permitted: false };
}

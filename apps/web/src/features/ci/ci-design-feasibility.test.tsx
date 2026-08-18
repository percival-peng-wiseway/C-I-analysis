// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDesignFeasibilityResult } from "./api/ci-design-feasibility";
import { CiDesignFeasibility } from "./ci-design-feasibility";

const points = Array.from({ length: 48 }, (_, index) => ({ timestamp: `2026-01-01T${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00+10:00`, time_label: `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`, baseline_kw: 100, pv_only_import_kw: 80, pv_battery_import_kw: 60, pv_generation_kw: 20, battery_charge_kw: 0, battery_discharge_kw: 20, soc_kwh: 50 }));
const totals = { site_import_before_kwh: 1000, grid_import_after_pv_only_kwh: 780, grid_import_after_kwh: 700, grid_import_reduction_kwh: 300, grid_import_reduction_percent: 30, pv_generation_kwh: 400, pv_direct_to_load_kwh: 250, pv_to_battery_kwh: 100, grid_export_kwh: 50, pv_clipped_kwh: 0, pv_self_consumption_percent: 87.5, battery_charge_input_kwh: 100, battery_discharge_output_kwh: 90, battery_equivalent_full_cycles: 0.45, battery_active_days: 2, battery_active_day_percent: 100 };
const performance = { dispatch_basis: "pv_first_coverage_dispatch", baseline_peak_kw: 100, pv_only_peak_kw: 80, grid_import_peak_kw: 60, grid_import_peak_reduction_kw: 40, grid_import_peak_reduction_percent: 40, top_10_event_count: 2, top_10_events_mitigated: 2, top_10_event_coverage_percent: 100, top_20_event_count: 2, top_20_events_mitigated: 2, top_20_event_coverage_percent: 100, battery_duration_at_max_discharge_hours: 1.7, battery_power_to_peak_percent: 50, minimum_observed_soc_kwh: 20, maximum_observed_soc_kwh: 190, top_peak_events: [{ rank: 1, timestamp: "2026-01-01T12:00:00+10:00", baseline_kw: 100, pv_only_import_kw: 80, grid_import_kw: 60, reduction_kw: 40, reduction_percent: 40, mitigated: true }, { rank: 2, timestamp: "2026-01-02T12:00:00+10:00", baseline_kw: 95, pv_only_import_kw: 75, grid_import_kw: 55, reduction_kw: 40, reduction_percent: 42.1, mitigated: true }] } as const;
const result = {
  contract_version: "ci_design_feasibility_v2", status: "ready", analysis_mode: "pre_tariff_physical_feasibility", customer_facing_permission: false, recommendation_permitted: false, tariff_evaluated: false, currency_values_permitted: false,
  coverage: { input_format: "wide_interval_30_minute", interval_minutes: 30, interval_count: 96, start_timestamp: "2026-01-01T00:00:00+10:00", end_timestamp: "2026-01-02T23:30:00+10:00", time_basis: "source", years: [{ year: 2026, interval_count: 96, complete_calendar_year: false }], primary_year: 2026 },
  baseline: { peak_date: "2026-01-01", peak_kw: 100, peak_timestamp: "2026-01-01T12:00:00+10:00", daily_profile_cloud: { sampled_daily_profiles: [{ date: "2026-01-02", values_kw: Array(48).fill(40) }], average_day_kw: Array(48).fill(50), selected_peak_day_kw: Array(48).fill(100), time_labels: points.map((point) => point.time_label) } },
  scenarios: [{ scenario_id: "one", label: "100 kWp + 200 kWh", authored_inputs: { pv_capacity_kwp_dc: 100, pv_inverter_capacity_kw_ac: 80, nominal_capacity_kwh: 200, max_discharge_kw: 100 }, energy_dispatch_algorithm_id: "ci_pre_tariff_pv_self_consumption_v1", yearly_energy: [{ year: 2026, ...totals, performance }], coverage_energy: totals, coverage_performance: performance, initial_soc_kwh: 200, final_soc_kwh: 100, peak_day: { algorithm_id: "ci_pre_tariff_peak_day_envelope_v1", date: "2026-01-01", baseline_peak_kw: 100, pv_only_peak_kw: 80, achieved_peak_kw: 60, sampled_target_kw: 60, peak_reduction_kw: 40, peak_reduction_percent: 40, points, billing_demand_interpretation_permitted: false }, customer_facing_permission: false, recommendation_permitted: false }],
  assumptions: [],
} as unknown as CiDesignFeasibilityResult;

describe("C&I design feasibility visuals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows scenario KPIs, interval activity and both peak visual contexts without tariff claims", async () => {
    const activityPoints = Array.from({ length: 144 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index * 30)).toISOString(),
      time_label: `01 Jan ${String(Math.floor(index / 2) % 24).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
      measured_import_kw: 100,
      grid_import_kw: 60,
      solar_to_load_kw: 30,
      grid_export_kw: 10,
    }));
    const activity = {
      contract_version: "ci_interval_activity_v1",
      status: "ready",
      analysis_mode: "pre_tariff_physical_interval_activity",
      scenario_id: "one",
      scenario_label: "100 kWp + 200 kWh",
      interval_minutes: 30,
      time_basis: "source",
      range: { requested_start_date: "2026-01-01", requested_days: 3, effective_start_timestamp: activityPoints[0].timestamp, effective_end_timestamp: activityPoints.at(-1)?.timestamp, interval_count: 144, complete: true },
      points: activityPoints,
      customer_facing_permission: false,
      recommendation_permitted: false,
      tariff_evaluated: false,
      billing_demand_interpretation_permitted: false,
    };
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(activity), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    render(<CiDesignFeasibility projectId="project-1" result={result} />);
    expect(screen.getByRole("heading", { name: "Physical feasibility explorer" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Annual grid import comparison" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Solar generation disposition" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Peak day active power chart" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Top measured peak event comparison" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Battery capacity and peak reduction sizing map" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Daily measured demand profile cloud" })).toBeTruthy();
    expect(screen.getByText("Top measured peaks improved")).toBeTruthy();
    expect(screen.getByText("Power and energy fit")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("img", { name: /3-day interval activity chart/i })).toBeTruthy());
    expect(screen.getByRole("group", { name: "Interval activity duration" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1));
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ days: 7, scenario_id: "one" });
    expect(screen.getByText("Physical peak reduction")).toBeTruthy();
    expect(screen.getByText(/this is not chargeable demand/i)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});

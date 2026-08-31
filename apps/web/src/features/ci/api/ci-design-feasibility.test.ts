import { describe, expect, it, vi } from "vitest";

import { fetchCiIntervalActivity, fetchCiSavedFeasibility, runCiDesignFeasibility } from "./ci-design-feasibility";

const totals = {
  site_import_before_kwh: 1000, grid_import_after_pv_only_kwh: 780, grid_import_after_kwh: 700,
  grid_import_reduction_kwh: 300, grid_import_reduction_percent: 30,
  pv_generation_kwh: 400, pv_direct_to_load_kwh: 250,
  pv_to_battery_kwh: 100, grid_export_kwh: 50, pv_clipped_kwh: 0,
  pv_self_consumption_percent: 87.5,
  battery_charge_input_kwh: 100, battery_discharge_output_kwh: 90,
  battery_equivalent_full_cycles: 0.45, battery_active_days: 2,
  battery_active_day_percent: 100,
};
const performance = {
  dispatch_basis: "pv_first_coverage_dispatch",
  baseline_peak_kw: 100, pv_only_peak_kw: 90, grid_import_peak_kw: 70,
  grid_import_peak_reduction_kw: 30, grid_import_peak_reduction_percent: 30,
  top_10_event_count: 2, top_10_events_mitigated: 2, top_10_event_coverage_percent: 100,
  top_20_event_count: 2, top_20_events_mitigated: 2, top_20_event_coverage_percent: 100,
  battery_duration_at_max_discharge_hours: 1.7, battery_power_to_peak_percent: 50,
  minimum_observed_soc_kwh: 20, maximum_observed_soc_kwh: 190,
  top_peak_events: [
    { rank: 1, timestamp: "2026-01-01T12:00:00+10:00", baseline_kw: 100, pv_only_import_kw: 90, grid_import_kw: 70, reduction_kw: 30, reduction_percent: 30, mitigated: true },
    { rank: 2, timestamp: "2026-01-02T12:00:00+10:00", baseline_kw: 95, pv_only_import_kw: 85, grid_import_kw: 65, reduction_kw: 30, reduction_percent: 31.58, mitigated: true },
  ],
};

function payload() {
  const point = { timestamp: "2026-01-01T00:00:00+10:00", time_label: "00:00", baseline_kw: 100, pv_only_import_kw: 90, pv_battery_import_kw: 70, pv_generation_kw: 10, battery_charge_kw: 0, battery_discharge_kw: 20, soc_kwh: 100 };
  return {
    contract_version: "ci_design_feasibility_v4", status: "ready",
    analysis_mode: "pre_tariff_physical_feasibility",
    customer_facing_permission: false, recommendation_permitted: false,
    tariff_evaluated: false, currency_values_permitted: false,
    coverage: { input_format: "wide_interval_30_minute", interval_minutes: 30, interval_count: 96, start_timestamp: point.timestamp, end_timestamp: "2026-01-02T23:30:00+10:00", time_basis: "source", years: [{ year: 2026, interval_count: 96, complete_calendar_year: false }], primary_year: 2026 },
    baseline: { peak_date: "2026-01-01", peak_kw: 100, peak_timestamp: point.timestamp, daily_profile_cloud: { sampled_daily_profiles: [], average_day_kw: Array(48).fill(50), selected_peak_day_kw: Array(48).fill(100), time_labels: Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`) } },
    physical_review_order: { algorithm_id: "ci_pre_tariff_physical_review_order_v2", shortlist_count: 1, basis: "Physical review only.", recommendation_permitted: false },
    scenarios: [{ scenario_id: "one", label: "One", physical_review_rank: 1, authored_inputs: {}, energy_dispatch_algorithm_id: "ci_pre_tariff_pv_self_consumption_v1", yearly_energy: [{ year: 2026, ...totals, performance: { ...performance, top_peak_events: performance.top_peak_events.map((event) => ({ ...event })) } }], coverage_energy: { ...totals }, coverage_performance: { ...performance, top_peak_events: performance.top_peak_events.map((event) => ({ ...event })) }, initial_soc_kwh: 100, final_soc_kwh: 50, peak_day: { algorithm_id: "ci_pre_tariff_peak_day_envelope_v1", date: "2026-01-01", baseline_peak_kw: 100, pv_only_peak_kw: 90, achieved_peak_kw: 70, sampled_target_kw: 70, peak_reduction_kw: 30, peak_reduction_percent: 30, points: Array.from({ length: 48 }, () => ({ ...point })), billing_demand_interpretation_permitted: false }, customer_facing_permission: false, recommendation_permitted: false }],
    assumptions: [],
  };
}

describe("C&I design feasibility API", () => {
  it("accepts only the bounded no-tariff contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload()), { status: 200 }));
    await expect(runCiDesignFeasibility("project-1", fetcher)).resolves.toMatchObject({ status: "ready" });
    expect(fetcher).toHaveBeenCalledWith("/api/commercial-industrial/projects/project-1/design-feasibility", expect.objectContaining({ method: "POST" }));

    const unsafe = payload();
    unsafe.currency_values_permitted = true;
    const unsafeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(unsafe), { status: 200 }));
    await expect(runCiDesignFeasibility("project-1", unsafeFetch)).rejects.toThrow("unsafe result contract");

    const invalidPercentage = payload();
    invalidPercentage.scenarios[0].coverage_performance.top_10_event_coverage_percent = 101;
    const invalidPercentageFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(invalidPercentage), { status: 200 }));
    await expect(runCiDesignFeasibility("project-1", invalidPercentageFetch)).rejects.toThrow("unsafe result contract");
  });

  it("restores a saved project result and fails closed on stale state shape", async () => {
    const ready = {
      contract_version: "ci_project_feasibility_state_v1",
      status: "ready",
      saved_at: "2026-08-18T04:00:00+00:00",
      stale_reasons: [],
      result: payload(),
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(ready), { status: 200 }));
    await expect(fetchCiSavedFeasibility("project-1", fetcher)).resolves.toMatchObject({ status: "ready" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/commercial-industrial/projects/project-1/design-feasibility",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );

    const stale = {
      ...ready,
      status: "stale",
      stale_reasons: ["design_changed"],
      result: null,
    };
    await expect(fetchCiSavedFeasibility(
      "project-1",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(stale), { status: 200 })),
    )).resolves.toMatchObject({ status: "stale", result: null });

    const unsafe = { ...stale, stale_reasons: [], result: payload() };
    await expect(fetchCiSavedFeasibility(
      "project-1",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(unsafe), { status: 200 })),
    )).rejects.toThrow("unsafe state contract");
  });

  it("loads only bounded physical interval activity without billing meaning", async () => {
    const points = Array.from({ length: 144 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, 2, 0, index * 30)).toISOString(),
      time_label: `02 Jan ${String(Math.floor(index / 2) % 24).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
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
      scenario_label: "One",
      interval_minutes: 30,
      time_basis: "source",
      range: {
        requested_start_date: "2026-01-02",
        requested_days: 3,
        effective_start_timestamp: points[0].timestamp,
        effective_end_timestamp: points.at(-1)?.timestamp,
        interval_count: points.length,
        complete: true,
      },
      points,
      customer_facing_permission: false,
      recommendation_permitted: false,
      tariff_evaluated: false,
      billing_demand_interpretation_permitted: false,
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(activity), { status: 200 }));

    await expect(fetchCiIntervalActivity("project-1", { scenario_id: "one", start_date: "2026-01-02", days: 3 }, fetcher)).resolves.toMatchObject({ status: "ready" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/commercial-industrial/projects/project-1/design-feasibility/interval-activity",
      expect.objectContaining({ method: "POST" }),
    );

    activity.billing_demand_interpretation_permitted = true;
    const unsafe = vi.fn().mockResolvedValue(new Response(JSON.stringify(activity), { status: 200 }));
    await expect(fetchCiIntervalActivity("project-1", { scenario_id: "one", start_date: "2026-01-02", days: 3 }, unsafe)).rejects.toThrow("unsafe result contract");
  });
});

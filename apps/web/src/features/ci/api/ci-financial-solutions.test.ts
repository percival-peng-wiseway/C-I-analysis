import { describe, expect, it } from "vitest";

import { saveCiFinancialSolution, setCiFinancialSolutionStarred } from "./ci-financial-solutions";

const scenario = {
  scenario_id: "scenario-a",
  label: "Scenario A",
  physical_review_rank: 1,
  authored_inputs: {
    battery_system_id: "battery-a",
    battery_technology_id: "generic_li_ion_ac" as const,
    control_profile_id: "demand_peak_shaving" as const,
    pv_system_id: "pv-a",
    pv_profile_id: "generic_normalized_solar_shape_v1" as const,
    pv_capacity_kwp_dc: 100,
    pv_inverter_capacity_kw_ac: 80,
    shared_ac_headroom_kw: 250,
    reactive_support_enabled: false,
    reactive_support_max_kvar: 0,
    shared_inverter_apparent_power_limit_kva: null,
    reactive_capability_curve: "circular_pq" as const,
    reactive_capability_provenance: "analyst_assumption" as const,
    reactive_overcompensation_permitted: false as const,
    pv_annual_specific_yield_kwh_per_kw: 1200,
    pv_derating_factor: 0.9,
    nominal_capacity_kwh: 500,
    max_charge_kw: 250,
    max_discharge_kw: 250,
    charge_efficiency: 0.95,
    discharge_efficiency: 0.95,
    min_soc_fraction: 0.1,
    max_soc_fraction: 1,
    initial_soc_fraction: 1,
    allow_grid_charging: true,
  },
  post_dispatch: {
    authority_source: "ci_peak_shaving_rolling_replay_v2" as const,
    pv_generation_kwh: 100000,
    pv_curtailed_kwh: 0,
    raw_rolling_demand_kva: 400,
    chargeable_rolling_demand_kva: 400,
    maximum_reactive_support_kvar: 0,
    maximum_post_grid_reactive_kvar: 100,
    maximum_shared_inverter_apparent_power_kva: 80,
    incentive_demand_kva: 380,
    billing_period_max_kva: 390,
    billing_period_max_kw: 350,
    billing_period_peak_kw_reduction: 50,
    billing_period_peak_effect: "reduction" as const,
    billing_period_peak_change_kw: 50,
    billing_period_projection_status: "evaluated" as const,
  },
  dispatch_review_projection: {
    contract_version: "ci_dispatch_review_projection_v2" as const,
    status: "ready" as const,
    selection_basis: "maximum_post_dispatch_rolling_kva_earliest_timestamp" as const,
    peak_local_date: "2026-02-02",
    peak_interval: { interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", baseline_import_kw: 400, post_dispatch_import_kw: 350, baseline_kva: 440, post_dispatch_kva: 400 },
    coverage: { interval_minutes: 15 as const, interval_count: 1, start_local_timestamp: "2026-02-02T17:00:00+11:00", end_local_timestamp: "2026-02-02T17:00:00+11:00" },
    units: { active_power: "kW" as const, apparent_power: "kVA" as const, reactive_power: "kvar" as const, stored_energy: "kWh" as const },
    soc_status: "available" as const,
    authority_source: "ci_peak_shaving_rolling_replay_v2" as const,
    optimizer_snapshot_sha256: "a".repeat(64),
    interval_dispatch_sha256: "b".repeat(64),
    customer_facing_permission: false as const,
    recommendation_permitted: false as const,
    points: [{ interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", local_time_label: "17:00 AEDT", baseline_import_kw: 400, post_dispatch_import_kw: 350, baseline_kva: 440, post_dispatch_kva: 400, site_reactive_import_kvar: 100, inverter_reactive_support_kvar: 0, post_grid_reactive_kvar: 100, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 50, soc_end_kwh: 450 }],
    projection_sha256: "c".repeat(64),
  },
  annual_tariff_value: {
    calculation_method: "representative_year_repeat_v1" as const,
    period_start: "2025-06-01",
    period_end: "2026-05-31",
    rate_basis: "synthetic",
    baseline_cost_ex_gst_aud: 100000,
    scenario_cost_ex_gst_aud: 75000,
    first_year_value_ex_gst_aud: 25000,
    baseline_cost_inc_gst_aud: 110000,
    scenario_cost_inc_gst_aud: 82500,
    first_year_value_inc_gst_aud: 27500,
    category_savings_ex_gst_aud: { energy_charges: 25000 },
    customer_facing_permission: false as const,
  },
  planned_demand_limits_kva: [{ component_id: "annual_rolling_kva", billing_period_id: null, rate_aud_per_kva: 12, planner_limit_kva: 350 }],
  selected_monthly_thresholds_kw: Array(12).fill(350),
  optimizer_run_snapshot: {
    contract_version: "ci_optimizer_run_snapshot_v2" as const,
    calculation_revision: "ci_optimizer_run_snapshot_planner_primary_seed_v2" as const,
    snapshot_sha256: "a".repeat(64),
    algorithm_id: "ci_peak_shaving_rolling_replay_v2" as const,
    customer_facing_permission: false as const,
    recommendation_permitted: false as const,
    input_projection: {},
    physical_assumptions: {},
    result_projection: { interval_dispatch_sha256: "b".repeat(64) },
  },
  optimizer_audit_projection: {
    contract_version: "ci_optimizer_audit_projection_v2" as const,
    snapshot_sha256: "a".repeat(64),
    customer_facing_permission: false as const,
    recommendation_permitted: false as const,
  },
};

describe("C&I financial solution API", () => {
  it("sends the NEM12 and physical scenario without an authored annual value", async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect((form.get("file") as File).name).toBe("synthetic.csv");
      const body = JSON.parse(String(form.get("payload")));
      expect(body.scenario_id).toBe("scenario-a");
      expect(body.source_physical_scenario.post_dispatch.raw_rolling_demand_kva).toBe(400);
      expect(body.assumptions.discount_rate).toBe(0.08);
      expect(body.assumptions.first_year_net_value_aud).toBeUndefined();
      expect(body.product_ids).toEqual(["battery"]);
      return new Response(JSON.stringify({ solution_id: "saved" }), { status: 201 });
    };
    await expect(saveCiFinancialSolution({
      file: new File(["synthetic"], "synthetic.csv"), label: "Saved A", scenario,
      discountRate: 0.08,
      degradationRate: 0.01, termYears: 15,
      pricingCatalogVersionId: "catalog", productIds: ["battery"], installationItemIds: ["install"],
    }, fetcher as typeof fetch)).resolves.toMatchObject({ solution_id: "saved" });
  });

  it("persists star state through the backend", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/financial-solutions/saved/star");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ starred: true });
      return new Response(JSON.stringify({ solution_id: "saved", starred: true }), { status: 200 });
    };
    await expect(setCiFinancialSolutionStarred("saved", true, fetcher as typeof fetch)).resolves.toMatchObject({ starred: true });
  });
});

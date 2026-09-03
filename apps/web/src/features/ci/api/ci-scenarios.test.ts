import { describe, expect, it } from "vitest";

import { analyzeCiPhysicalScenarios, analyzeCiThreeCaseComparison, fetchCiSavedTariffReplay, runCiProjectTariffReplay, type CiScenarioInput } from "./ci-scenarios";

const scenarios: CiScenarioInput[] = ["a", "b"].map((id) => ({
  scenario_id: id,
  label: `Scenario ${id}`,
  battery_system_id: `battery-${id}`,
  battery_technology_id: "generic_li_ion_ac",
  control_profile_id: "demand_peak_shaving",
  pv_system_id: "pv-one",
  pv_profile_id: "generic_normalized_solar_shape_v1",
  pv_capacity_kwp_dc: 100,
  pv_inverter_capacity_kw_ac: 80,
  shared_ac_headroom_kw: 250,
  reactive_support_enabled: false,
  reactive_support_max_kvar: 0,
  shared_inverter_apparent_power_limit_kva: null,
  reactive_capability_curve: "circular_pq",
  reactive_capability_provenance: "analyst_assumption",
  reactive_overcompensation_permitted: false,
  pv_annual_specific_yield_kwh_per_kw: 1200,
  pv_derating_factor: 0.9,
  nominal_capacity_kwh: 100,
  max_charge_kw: 50,
  max_discharge_kw: 50,
  charge_efficiency: 0.95,
  discharge_efficiency: 0.95,
  min_soc_fraction: 0.1,
  max_soc_fraction: 1,
  initial_soc_fraction: 1,
  allow_grid_charging: false,
}));

const reviewProjection = (battery: boolean, index = 0) => ({
  contract_version: "ci_dispatch_review_projection_v2",
  status: "ready",
  selection_basis: "maximum_post_dispatch_rolling_kva_earliest_timestamp",
  peak_local_date: "2026-02-02",
  peak_interval: { interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", baseline_import_kw: 100, post_dispatch_import_kw: 90, baseline_kva: 110, post_dispatch_kva: 100 },
  coverage: { interval_minutes: 15, interval_count: 1, start_local_timestamp: "2026-02-02T17:00:00+11:00", end_local_timestamp: "2026-02-02T17:00:00+11:00" },
  units: { active_power: "kW", apparent_power: "kVA", reactive_power: "kvar", stored_energy: "kWh" },
  soc_status: battery ? "available" : "not_applicable_no_battery",
  authority_source: battery ? "ci_peak_shaving_rolling_replay_v2" : "ci_pv_only_shared_pq_v1",
  optimizer_snapshot_sha256: battery ? `${index}`.padStart(64, "0") : null,
  interval_dispatch_sha256: battery ? "b".repeat(64) : null,
  customer_facing_permission: false,
  recommendation_permitted: false,
  projection_sha256: "c".repeat(64),
  points: [{ interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", local_time_label: "17:00 AEDT", baseline_import_kw: 100, post_dispatch_import_kw: 90, baseline_kva: 110, post_dispatch_kva: 100, site_reactive_import_kvar: 45.8, inverter_reactive_support_kvar: 0, post_grid_reactive_kvar: 45.8, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: battery ? 10 : 0, soc_end_kwh: battery ? 90 : null }],
});

describe("analyzeCiPhysicalScenarios", () => {
  it("keeps project tariff replay fail-closed when the API rejects the evidence", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/tariff-replay");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ scenario_ids: ["b", "a"] }));
      return new Response(JSON.stringify({ detail: { message: "Approved tariff evidence is required." } }), { status: 409 });
    };
    await expect(runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["b", "a"])).rejects.toThrow("Approved tariff evidence is required.");
  });

  it("restores the project tariff replay state without starting a new run", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/tariff-replay");
      expect(init?.method).toBeUndefined();
      return new Response(JSON.stringify({
        contract_version: "ci_project_tariff_replay_state_v1",
        status: "not_saved",
        saved_at: null,
        stale_reasons: [],
        result: null,
      }), { status: 200 });
    };
    await expect(fetchCiSavedTariffReplay("project-1", fetcher as typeof fetch)).resolves.toMatchObject({ status: "not_saved" });
  });

  it("posts explicit scenarios and accepts only the fail-closed contract", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/powercor-llvt2-physical-scenarios");
      expect((init?.body as FormData).get("scenarios")).toBe(JSON.stringify(scenarios));
      return new Response(JSON.stringify({
        contract_version: "ci_physical_scenario_review_v6",
        analysis_status: "ready",
        analysis_mode: "evidence_limited_internal_review",
        customer_facing_permission: false,
        recommendation_permitted: false,
        currency_values_permitted: true,
        ranking_basis: "Physical order only",
        baseline: {},
        scenarios: scenarios.map((scenario, index) => ({
          scenario_id: scenario.scenario_id,
          label: scenario.label,
          physical_review_rank: index + 1,
          authored_inputs: scenario,
          post_dispatch: {
            authority_source: "ci_peak_shaving_rolling_replay_v2",
            incentive_demand_kva: 10,
            billing_period_max_kva: 10,
            billing_period_max_kw: 8,
            maximum_reactive_support_kvar: 0,
            maximum_post_grid_reactive_kvar: 45.8,
            maximum_shared_inverter_apparent_power_kva: 80,
            billing_period_peak_kw_reduction: 2,
            billing_period_peak_effect: "reduction",
            billing_period_peak_change_kw: 2,
            billing_period_projection_status: "evaluated",
          },
          annual_tariff_value: {
            calculation_method: "representative_year_repeat_v1",
            first_year_value_ex_gst_aud: 1000,
            first_year_value_inc_gst_aud: 1100,
            customer_facing_permission: false,
          },
          selected_monthly_thresholds_kw: Array(12).fill(1),
          optimizer_run_snapshot: {
            contract_version: "ci_optimizer_run_snapshot_v2",
            snapshot_sha256: `${index}`.padStart(64, "0"),
            algorithm_id: "ci_peak_shaving_rolling_replay_v2",
            customer_facing_permission: false,
            recommendation_permitted: false,
            input_projection: {},
            physical_assumptions: {},
            result_projection: { interval_dispatch_sha256: "b".repeat(64) },
          },
          optimizer_audit_projection: {
            contract_version: "ci_optimizer_audit_projection_v2",
            snapshot_sha256: `${index}`.padStart(64, "0"),
            customer_facing_permission: false,
            recommendation_permitted: false,
          },
          dispatch_review_projection: reviewProjection(true, index),
        })),
        report_preview: {
          status: "ready",
          output_kind: "in_app_evidence_preview",
          download_available: false,
          sections: [],
          disclaimer: "Internal only",
        },
        assumptions: [],
      }), { status: 200 });
    };

    await expect(
      analyzeCiPhysicalScenarios(new File(["synthetic"], "synthetic.csv"), scenarios, fetcher as typeof fetch),
    ).resolves.toMatchObject({ recommendation_permitted: false });

    for (const unsafeSummary of [
      { maximum_reactive_support_kvar: 1 },
      { maximum_shared_inverter_apparent_power_kva: 251 },
    ]) {
      const unsafeFetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetcher(input, init);
        const payload = await response.json();
        Object.assign(payload.scenarios[0].post_dispatch, unsafeSummary);
        return new Response(JSON.stringify(payload), { status: 200 });
      };
      await expect(
        analyzeCiPhysicalScenarios(new File(["synthetic"], "synthetic.csv"), scenarios, unsafeFetcher as typeof fetch),
      ).rejects.toThrow("unsafe result contract");
    }
  });

  it("rejects a contract that grants recommendation permission", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      contract_version: "ci_physical_scenario_review_v6",
      analysis_status: "ready",
      analysis_mode: "evidence_limited_internal_review",
      customer_facing_permission: false,
      recommendation_permitted: true,
      currency_values_permitted: true,
      scenarios: [],
      report_preview: { download_available: false },
    }), { status: 200 });
    await expect(
      analyzeCiPhysicalScenarios(new File([], "synthetic.csv"), scenarios, fetcher as typeof fetch),
    ).rejects.toThrow("unsafe result contract");
  });

  it("accepts an explicit zero-battery PV-only authority without optimizer evidence", async () => {
    const noBattery = {
      ...scenarios[0],
      nominal_capacity_kwh: 0,
      max_charge_kw: 0,
      max_discharge_kw: 0,
    };
    const fetcher = async () => new Response(JSON.stringify({
      contract_version: "ci_physical_scenario_review_v6",
      analysis_status: "ready",
      analysis_mode: "evidence_limited_internal_review",
      customer_facing_permission: false,
      recommendation_permitted: false,
      currency_values_permitted: true,
      scenarios: [{
        scenario_id: noBattery.scenario_id,
        label: noBattery.label,
        authored_inputs: noBattery,
        post_dispatch: {
          authority_source: "ci_pv_only_shared_pq_v1",
          incentive_demand_kva: 10,
          billing_period_max_kva: 10,
          billing_period_max_kw: 8,
          maximum_reactive_support_kvar: 0,
          maximum_post_grid_reactive_kvar: 45.8,
          maximum_shared_inverter_apparent_power_kva: 80,
          billing_period_peak_kw_reduction: 2,
          billing_period_peak_effect: "reduction",
          billing_period_peak_change_kw: 2,
          billing_period_projection_status: "evaluated",
        },
        annual_tariff_value: {
          calculation_method: "representative_year_repeat_v1",
          first_year_value_ex_gst_aud: 1,
          first_year_value_inc_gst_aud: 1.1,
          customer_facing_permission: false,
        },
        selected_monthly_thresholds_kw: Array(12).fill(null),
        optimizer_run_snapshot: null,
        optimizer_audit_projection: null,
        dispatch_review_projection: reviewProjection(false),
      }],
      report_preview: { download_available: false },
    }), { status: 200 });

    await expect(
      analyzeCiPhysicalScenarios(new File([], "synthetic.csv"), [noBattery], fetcher as typeof fetch),
    ).resolves.toMatchObject({ scenarios: [{ optimizer_run_snapshot: null }] });
  });
});

const comparisonPayload = {
  contract_version: "ci_three_case_peak_day_comparison_v2",
  status: "ready",
  analysis_mode: "evidence_limited_internal_review",
  selection_basis: "pv_battery_maximum_post_dispatch_rolling_kva_earliest_timestamp",
  pairing_basis: "explicit_consultant_selected_exact_pv_match",
  common_local_date: "2026-02-02",
  selected_peak_interval_timestamp: "2026-02-02T17:00:00+11:00",
  coverage: { interval_minutes: 15, interval_count: 1, start_local_timestamp: "2026-02-02T17:00:00+11:00", end_local_timestamp: "2026-02-02T17:00:00+11:00", timestamps_aligned: true },
  units: { active_power: "kW", apparent_power: "kVA", reactive_power: "kvar", stored_energy: "kWh" },
  cases: [
    { case_id: "no_system", label: "No system", scenario_id: null, authority_source: "ci_evidence_bound_baseline_v1", soc_status: "not_applicable_no_battery", projection_sha256: null, optimizer_snapshot_sha256: null, interval_dispatch_sha256: null },
    { case_id: "pv_only", label: "PV only", scenario_id: "a", authority_source: "ci_pv_only_shared_pq_v1", soc_status: "not_applicable_no_battery", projection_sha256: "a".repeat(64), optimizer_snapshot_sha256: null, interval_dispatch_sha256: null },
    { case_id: "pv_battery", label: "PV and battery", scenario_id: "b", authority_source: "ci_peak_shaving_rolling_replay_v2", soc_status: "available", projection_sha256: "b".repeat(64), optimizer_snapshot_sha256: "c".repeat(64), interval_dispatch_sha256: "d".repeat(64) },
  ],
  baseline: { raw_rolling_demand_kva: 110, chargeable_rolling_demand_kva: 110, incentive_demand_kva: 108, billing_period_max_kva: 112, billing_period_max_kw: 100 },
  provenance: { source_contract_version: "ci_physical_scenario_review_v6", profile_id: "synthetic", profile_source_version: "v1", source_nem12_sha256: "e".repeat(64), pv_only_scenario_sha256: "f".repeat(64), pv_battery_scenario_sha256: "0".repeat(64) },
  customer_facing_permission: false,
  recommendation_permitted: false,
  eligibility_permitted: false,
  report_available: false,
  download_available: false,
  delivery_permitted: false,
  points: [{
    interval_timestamp: "2026-02-02T17:00:00+11:00",
    local_timestamp: "2026-02-02T17:00:00+11:00",
    local_time_label: "17:00 AEDT",
    no_system: { import_kw: 100, import_kva: 110, site_reactive_import_kvar: 45.8, reactive_support_kvar: 0, post_grid_reactive_kvar: 45.8, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 0, soc_end_kwh: null },
    pv_only: { import_kw: 90, import_kva: 100, site_reactive_import_kvar: 43.6, reactive_support_kvar: 0, post_grid_reactive_kvar: 43.6, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 0, soc_end_kwh: null },
    pv_battery: { import_kw: 75, import_kva: 85, site_reactive_import_kvar: 40.4, reactive_support_kvar: 0, post_grid_reactive_kvar: 40.4, grid_charge_kw: 0, pv_charge_kw: 2, battery_discharge_kw: 15, soc_end_kwh: 80 },
  }],
  comparison_sha256: "1".repeat(64),
};

describe("analyzeCiThreeCaseComparison", () => {
  it("posts explicit identities and accepts one aligned Python-owned comparison", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/powercor-llvt2-three-case-comparison");
      const body = init?.body as FormData;
      expect(body.get("scenarios")).toBe(JSON.stringify(scenarios));
      expect(body.get("pv_only_scenario_id")).toBe("a");
      expect(body.get("pv_battery_scenario_id")).toBe("b");
      return new Response(JSON.stringify(comparisonPayload), { status: 200 });
    };
    await expect(analyzeCiThreeCaseComparison(
      new File([], "synthetic.csv"), scenarios,
      { pvOnlyScenarioId: "a", pvBatteryScenarioId: "b" }, fetcher as typeof fetch,
    )).resolves.toMatchObject({ common_local_date: "2026-02-02", recommendation_permitted: false });
  });

  it("fails closed on misaligned or permission-bearing comparison data", async () => {
    const unsafe = { ...comparisonPayload, customer_facing_permission: true };
    const fetcher = async () => new Response(JSON.stringify(unsafe), { status: 200 });
    await expect(analyzeCiThreeCaseComparison(
      new File([], "synthetic.csv"), scenarios,
      { pvOnlyScenarioId: "a", pvBatteryScenarioId: "b" }, fetcher as typeof fetch,
    )).rejects.toThrow("unsafe result contract");
  });

  it("fails closed when a returned point is outside the common local date", async () => {
    const unsafe = structuredClone(comparisonPayload);
    unsafe.points[0].local_timestamp = "2026-02-03T17:00:00+11:00";
    unsafe.coverage.start_local_timestamp = unsafe.points[0].local_timestamp;
    unsafe.coverage.end_local_timestamp = unsafe.points[0].local_timestamp;
    const fetcher = async () => new Response(JSON.stringify(unsafe), { status: 200 });
    await expect(analyzeCiThreeCaseComparison(
      new File([], "synthetic.csv"), scenarios,
      { pvOnlyScenarioId: "a", pvBatteryScenarioId: "b" }, fetcher as typeof fetch,
    )).rejects.toThrow("unsafe result contract");
  });
});

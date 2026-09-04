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

const physicalResultFor = (inputs: CiScenarioInput[]) => ({
  contract_version: "ci_physical_scenario_review_v6",
  calculation_revision: "ci_physical_scenario_planner_limits_primal_simplex_v1",
  analysis_status: "ready",
  analysis_mode: "evidence_limited_internal_review",
  customer_facing_permission: false,
  recommendation_permitted: false,
  currency_values_permitted: true,
  ranking_basis: "Physical order only",
  baseline: {},
  scenarios: inputs.map((scenario, index) => ({
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
    planned_demand_limits_kva: [{ component_id: "annual_rolling_kva", billing_period_id: null, rate_aud_per_kva: 12, planner_limit_kva: 1 }],
    selected_monthly_thresholds_kw: Array(12).fill(1),
    optimizer_run_snapshot: {
      contract_version: "ci_optimizer_run_snapshot_v2",
      calculation_revision: "ci_optimizer_run_snapshot_planner_limits_primal_simplex_v1",
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
});

describe("analyzeCiPhysicalScenarios", () => {
  it("keeps project tariff replay fail-closed when the API rejects the evidence", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/tariff-replay");
      if (!init?.method) {
        return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
      }
      expect(init.method).toBe("POST");
      expect(init?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ scenario_ids: ["b", "a"], persistence_mode: "merge_checkpoint" }));
      return new Response(JSON.stringify({ detail: { message: "Approved tariff evidence is required." } }), { status: 409 });
    };
    await expect(runCiProjectTariffReplay(
      "project-1",
      fetcher as typeof fetch,
      undefined,
      ["b", "a"],
      { batchSize: 2 },
    )).rejects.toThrow("Approved tariff evidence is required.");
  });

  it("retries an uncommitted idempotent batch only once and reports an actionable 503", async () => {
    const calls: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") return new Response("Backend container unavailable", { status: 503 });
      return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).rejects.toThrow(
      "The cloud analysis service became temporarily unavailable before completion could be confirmed. Wait a moment, then run Analysis again.",
    );
    expect(calls).toEqual(["GET", "POST", "GET", "POST", "GET"]);
  });

  it("shows the structured Worker recovery message for a container 503", async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
      return new Response(JSON.stringify({
        error_code: "ci_backend_container_starting",
        message: "The analysis service is starting. Please run Analysis again shortly.",
        request_id: "request-1",
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).rejects.toThrow("The analysis service is starting. Please run Analysis again shortly.");
  });

  it("does not retry a non-transient Worker configuration 503", async () => {
    const calls: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (!init?.method) return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
      return new Response(JSON.stringify({
        error_code: "backend_unconfigured",
        message: "The analysis service is not configured.",
        request_id: "request-1",
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).rejects.toThrow("The analysis service is not configured.");
    expect(calls).toEqual(["GET", "POST"]);
  });

  it("recovers a committed batch by GET after a 503 without repeating the POST", async () => {
    const calls: string[] = [];
    let committed = false;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        committed = true;
        return new Response("Backend container unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        contract_version: "ci_project_tariff_replay_state_v1",
        status: committed ? "ready" : "not_saved",
        saved_at: committed ? "2026-09-04T00:00:00+00:00" : null,
        stale_reasons: [],
        result: committed ? physicalResultFor(scenarios) : null,
      }), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay(
        "project-1",
        fetcher as typeof fetch,
        undefined,
        ["b", "a"],
        { batchSize: 2 },
      ),
    ).resolves.toMatchObject({ scenarios: [{ scenario_id: "a" }, { scenario_id: "b" }] });
    expect(calls).toEqual(["GET", "POST", "GET"]);
  });

  it("retries the same merge batch once when the first 503 did not commit", async () => {
    const calls: string[] = [];
    let postCount = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        postCount += 1;
        if (postCount === 1) return new Response("Backend container unavailable", { status: 503 });
        expect(JSON.parse(String(init.body))).toEqual({
          scenario_ids: ["a"],
          persistence_mode: "merge_checkpoint",
        });
        return new Response(JSON.stringify(physicalResultFor([scenarios[0]])), { status: 200 });
      }
      return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).resolves.toMatchObject({ scenarios: [{ scenario_id: "a" }] });
    expect(calls).toEqual(["GET", "POST", "GET", "POST"]);
  });

  it.each([
    "container_provisioning",
    "container_start_timeout",
    "container_unavailable",
    null,
  ] as const)("retries the initial checkpoint GET once for recoverable 503 code %s", async (errorCode) => {
    const calls: string[] = [];
    let getCount = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (!init?.method) {
        getCount += 1;
        if (getCount === 1) {
          return new Response(JSON.stringify({
            ...(errorCode === null ? {} : { error_code: errorCode }),
            message: "The analysis container is temporarily unavailable.",
          }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          contract_version: "ci_project_tariff_replay_state_v1",
          status: "not_saved",
          saved_at: null,
          stale_reasons: [],
          result: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify(physicalResultFor([scenarios[0]])), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).resolves.toMatchObject({ scenarios: [{ scenario_id: "a" }] });
    expect(calls).toEqual(["GET", "GET", "POST"]);
  });

  it("retries the initial checkpoint GET once after a non-abort network error", async () => {
    const calls: string[] = [];
    let getCount = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (!init?.method) {
        getCount += 1;
        if (getCount === 1) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({
          contract_version: "ci_project_tariff_replay_state_v1",
          status: "not_saved",
          saved_at: null,
          stale_reasons: [],
          result: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify(physicalResultFor([scenarios[0]])), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).resolves.toMatchObject({ scenarios: [{ scenario_id: "a" }] });
    expect(calls).toEqual(["GET", "GET", "POST"]);
  });

  it("preserves an initial structured configuration error without retrying", async () => {
    const calls: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return new Response(JSON.stringify({
        error_code: "backend_unconfigured",
        message: "The analysis service is not configured.",
        request_id: "request-1",
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).rejects.toThrow("The analysis service is not configured.");
    expect(calls).toEqual(["GET"]);
  });

  it("does not retry an aborted initial checkpoint GET", async () => {
    const calls: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["GET"]);
  });

  it("resumes a partial checkpoint, batches missing scenarios, and reports progress", async () => {
    const requested = ["a", "b", "c", "d", "e"].map((scenarioId) => ({
      ...scenarios[0],
      scenario_id: scenarioId,
      label: `Scenario ${scenarioId}`,
    }));
    const completed = new Set(["a"]);
    const postedBatches: Array<{ persistence_mode: string; scenario_ids: string[] }> = [];
    const progress: Array<[number, number]> = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { persistence_mode: string; scenario_ids: string[] };
        postedBatches.push(body);
        body.scenario_ids.forEach((scenarioId) => completed.add(scenarioId));
        const included = requested.filter((scenario) => completed.has(scenario.scenario_id));
        return new Response(JSON.stringify(physicalResultFor(included)), { status: 200 });
      }
      const included = requested.filter((scenario) => completed.has(scenario.scenario_id));
      return new Response(JSON.stringify({
        contract_version: "ci_project_tariff_replay_state_v1",
        status: "ready",
        saved_at: "2026-09-04T00:00:00+00:00",
        stale_reasons: [],
        result: physicalResultFor(included),
      }), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay(
        "project-1",
        fetcher as typeof fetch,
        undefined,
        requested.map((scenario) => scenario.scenario_id),
        {
          batchSize: 2,
          onProgress: ({ completedScenarioCount, totalScenarioCount }) => progress.push([completedScenarioCount, totalScenarioCount]),
        },
      ),
    ).resolves.toMatchObject({ scenarios: requested.map((scenario) => ({ scenario_id: scenario.scenario_id })) });
    expect(postedBatches).toEqual([
      { persistence_mode: "merge_checkpoint", scenario_ids: ["b", "c"] },
      { persistence_mode: "merge_checkpoint", scenario_ids: ["d", "e"] },
    ]);
    expect(progress).toEqual([[1, 5], [3, 5], [5, 5]]);
  });

  it("checkpoints up to three tariff scenarios per request by default", async () => {
    const requested = ["a", "b"].map((scenarioId) => ({
      ...scenarios[0],
      scenario_id: scenarioId,
      label: `Scenario ${scenarioId}`,
    }));
    const completed = new Set<string>();
    const postedBatches: string[][] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { scenario_ids: string[] };
        postedBatches.push(body.scenario_ids);
        body.scenario_ids.forEach((scenarioId) => completed.add(scenarioId));
      }
      const included = requested.filter((scenario) => completed.has(scenario.scenario_id));
      if (init?.method === "POST") {
        return new Response(JSON.stringify(physicalResultFor(included)), { status: 200 });
      }
      return new Response(JSON.stringify({
        contract_version: "ci_project_tariff_replay_state_v1",
        status: "not_saved",
        saved_at: null,
        stale_reasons: [],
        result: null,
      }), { status: 200 });
    };

    await runCiProjectTariffReplay(
      "project-1",
      fetcher as typeof fetch,
      undefined,
      requested.map((scenario) => scenario.scenario_id),
    );

    expect(postedBatches).toEqual([["a", "b"]]);
  });

  it("uses the same read-only recovery after a non-abort network disconnect", async () => {
    const calls: string[] = [];
    let committed = false;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        committed = true;
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({
        contract_version: "ci_project_tariff_replay_state_v1",
        status: committed ? "ready" : "not_saved",
        saved_at: committed ? "2026-09-04T00:00:00+00:00" : null,
        stale_reasons: [],
        result: committed ? physicalResultFor([scenarios[0]]) : null,
      }), { status: 200 });
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).resolves.toMatchObject({ scenarios: [{ scenario_id: "a" }] });
    expect(calls).toEqual(["GET", "POST", "GET"]);
  });

  it("does not recover or retry an explicitly aborted tariff replay", async () => {
    const calls: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (!init?.method) return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    };

    await expect(
      runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a"]),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["GET", "POST"]);
  });

  it("returns an already complete current checkpoint without starting a POST", async () => {
    const calls: string[] = [];
    const progress: number[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return new Response(JSON.stringify({
        contract_version: "ci_project_tariff_replay_state_v1",
        status: "ready",
        saved_at: "2026-09-04T00:00:00+00:00",
        stale_reasons: [],
        result: physicalResultFor(scenarios),
      }), { status: 200 });
    };

    await expect(runCiProjectTariffReplay("project-1", fetcher as typeof fetch, undefined, ["a", "b"], {
      onProgress: ({ completedScenarioCount }) => progress.push(completedScenarioCount),
    })).resolves.toMatchObject({ scenarios: [{ scenario_id: "a" }, { scenario_id: "b" }] });
    expect(calls).toEqual(["GET"]);
    expect(progress).toEqual([2]);
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
      return new Response(JSON.stringify(physicalResultFor(scenarios)), { status: 200 });
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
      calculation_revision: "ci_physical_scenario_planner_limits_primal_simplex_v1",
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
      calculation_revision: "ci_physical_scenario_planner_limits_primal_simplex_v1",
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
        planned_demand_limits_kva: [],
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

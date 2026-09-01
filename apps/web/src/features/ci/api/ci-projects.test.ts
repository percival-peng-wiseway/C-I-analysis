import { describe, expect, it, vi } from "vitest";

import { createCiProject, fetchCiSavedDesign, generateCiDesignCandidates, listCiProjects, validateCiDesignCandidates, type CiDesignContext, type CiSolutionGenerationRequest } from "./ci-projects";
import type { CiScenarioInput } from "./ci-scenarios";

const project = {
  project_id: "project-1", display_name: "Factory", current_stage: "setup" as const,
  setup_status: "input_required" as const, design_status: "input_required" as const, design_candidate_count: 0,
  created_at: "2026-08-17T00:00:00Z", updated_at: "2026-08-17T00:00:00Z",
};

describe("C&I project API", () => {
  it("lists and creates project records", async () => {
    const listFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contract_version: "ci_project_registry_v1", projects: [project] }), { status: 200 }));
    await expect(listCiProjects(listFetch)).resolves.toEqual([project]);
    expect(listFetch).toHaveBeenCalledWith("/api/commercial-industrial/projects", expect.anything());

    const createFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contract_version: "ci_project_v1", ...project }), { status: 201 }));
    await expect(createCiProject("Factory", createFetch)).resolves.toMatchObject({ project_id: "project-1" });
    expect(JSON.parse(createFetch.mock.calls[0][1].body)).toEqual({ display_name: "Factory" });
  });

  it("accepts only the bounded Python design-validation contract", async () => {
    const candidate = { scenario_id: "one", label: "One" } as CiScenarioInput;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contract_version: "ci_design_candidate_validation_v1",
      status: "ready",
      validation_basis: "python_scenario_input_contract_v1",
      candidate_count: 1,
      candidates: [candidate],
      dispatch_evaluated: false,
      tariff_evaluated: false,
      customer_facing_permission: false,
      recommendation_permitted: false,
      disclaimer: "Input guardrails only.",
      design_context: designContext,
    }), { status: 200 }));
    await expect(validateCiDesignCandidates("project-1", [candidate], designContext, fetcher)).resolves.toMatchObject({ candidate_count: 1 });
    expect(fetcher.mock.calls[0][0]).toBe("/api/commercial-industrial/projects/project-1/design-candidates");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).design_context).toEqual(designContext);
  });

  it("requests Python-owned candidate generation without sending authored scenarios", async () => {
    const candidate = { scenario_id: "generated", label: "Generated" } as CiScenarioInput;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contract_version: "ci_design_candidate_validation_v1",
      status: "ready",
      validation_basis: "python_scenario_input_contract_v1",
      candidate_count: 1,
      candidates: [candidate],
      dispatch_evaluated: false,
      tariff_evaluated: false,
      customer_facing_permission: false,
      recommendation_permitted: false,
      disclaimer: "Python generated candidates.",
      design_context: designContext,
      generation_summary: { requested_count: 1, deduplicated_count: 0, rejected_count: 0, generated_candidate_count: 1, rejection_reasons: [] },
    }), { status: 200 }));

    await expect(generateCiDesignCandidates("project-1", generationRequest, fetcher)).resolves.toMatchObject({ candidate_count: 1 });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toEqual({ generation_request: generationRequest });
    expect(body).not.toHaveProperty("scenarios");
  });

  it("loads a saved design and represents a project with no design as null", async () => {
    const candidate = { scenario_id: "one", label: "One" } as CiScenarioInput;
    const design = {
      contract_version: "ci_design_candidate_validation_v1", status: "ready",
      validation_basis: "python_scenario_input_contract_v1", candidate_count: 1,
      candidates: [candidate], dispatch_evaluated: false, tariff_evaluated: false,
      customer_facing_permission: false, recommendation_permitted: false,
      disclaimer: "Input guardrails only.", design_context: designContext,
    };
    const savedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contract_version: "ci_saved_design_state_v1", status: "ready", design }), { status: 200 }));
    await expect(fetchCiSavedDesign("project-1", savedFetch)).resolves.toMatchObject({ candidate_count: 1 });
    expect(savedFetch).toHaveBeenCalledWith("/api/commercial-industrial/projects/project-1/design-candidates", expect.objectContaining({ headers: { Accept: "application/json" } }));

    const emptyFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contract_version: "ci_saved_design_state_v1", status: "not_saved", design: null }), { status: 200 }));
    await expect(fetchCiSavedDesign("project-1", emptyFetch)).resolves.toBeNull();
  });
});

const designContext: CiDesignContext = {
  contract_version: "ci_design_context_v1",
  existing_solar: { installed: false, brand: "", model: "", panel_count: 0, panel_rating_w: 0, installed_capacity_kwp_dc: 0, inverter_brand: "", inverter_model: "", inverter_capacity_kw_ac: 0, installation_year: null, operating_status: "unknown", included_in_interval_baseline: false },
  existing_battery: { installed: false, brand: "", model: "", nominal_capacity_kwh: 0, usable_capacity_kwh: 0, power_kw: 0, installation_year: null, operating_status: "unknown", included_in_interval_baseline: false },
  technical_options: { annual_specific_yield_kwh_per_kw: 1500, shading_loss_percent: 3, soiling_loss_percent: 2, temperature_loss_percent: 5, wiring_mismatch_loss_percent: 2, other_system_loss_percent: 0, system_availability_percent: 99, effective_derating_percent: 87.6, target_dc_ac_ratio: 1.15, inverter_block_size_kw: 5, site_ac_headroom_kw: 250, battery_duration_hours: 2, charge_efficiency_percent: 95, discharge_efficiency_percent: 95, minimum_soc_percent: 10, maximum_soc_percent: 100, allow_grid_charging: false, reactive_support_enabled: false, reactive_support_max_kvar: 0 },
};

const generationRequest: CiSolutionGenerationRequest = {
  contract_version: "ci_solution_generation_request_v1",
  pv_range: { minimum_kwp_dc: 100, maximum_kwp_dc: 100, step_kwp_dc: 10 },
  battery_range: { minimum_kwh: 0, maximum_kwh: 0, step_kwh: 100 },
  solar_profile_id: "generic_crystalline_pv_v1",
  battery_profile_id: "generic_lfp_ac_2h_v1",
  site_factors: {
    resource_basis: "gross_specific_yield_before_site_losses",
    resource_source: "analyst_assumption",
    resource_label: "Screening assumption",
    annual_specific_yield_kwh_per_kw: 1500,
    array_azimuth_degrees: 0,
    array_tilt_degrees: 20,
    shading_loss_percent: 3,
    soiling_loss_percent: 2,
    temperature_loss_percent: 5,
    wiring_mismatch_loss_percent: 2,
    other_system_loss_percent: 0,
    system_availability_percent: 99,
  },
  connection_options: {
    inverter_block_size_kw: 5,
    site_ac_headroom_kw: 250,
    allow_grid_charging: false,
    reactive_support_enabled: false,
    reactive_support_max_kvar: 0,
    grid_emissions_factor_kg_co2e_per_kwh: null,
    initial_soc_basis: "full_soc_physical_upper_bound",
  },
};

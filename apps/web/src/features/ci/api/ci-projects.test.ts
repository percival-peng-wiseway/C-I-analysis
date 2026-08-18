import { describe, expect, it, vi } from "vitest";

import { createCiProject, fetchCiSavedDesign, listCiProjects, validateCiDesignCandidates } from "./ci-projects";
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
    }), { status: 200 }));
    await expect(validateCiDesignCandidates("project-1", [candidate], fetcher)).resolves.toMatchObject({ candidate_count: 1 });
    expect(fetcher.mock.calls[0][0]).toBe("/api/commercial-industrial/projects/project-1/design-candidates");
  });

  it("loads a saved design and represents a project with no design as null", async () => {
    const candidate = { scenario_id: "one", label: "One" } as CiScenarioInput;
    const design = {
      contract_version: "ci_design_candidate_validation_v1", status: "ready",
      validation_basis: "python_scenario_input_contract_v1", candidate_count: 1,
      candidates: [candidate], dispatch_evaluated: false, tariff_evaluated: false,
      customer_facing_permission: false, recommendation_permitted: false,
      disclaimer: "Input guardrails only.",
    };
    const savedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contract_version: "ci_saved_design_state_v1", status: "ready", design }), { status: 200 }));
    await expect(fetchCiSavedDesign("project-1", savedFetch)).resolves.toMatchObject({ candidate_count: 1 });
    expect(savedFetch).toHaveBeenCalledWith("/api/commercial-industrial/projects/project-1/design-candidates", expect.objectContaining({ headers: { Accept: "application/json" } }));

    const emptyFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contract_version: "ci_saved_design_state_v1", status: "not_saved", design: null }), { status: 200 }));
    await expect(fetchCiSavedDesign("project-1", emptyFetch)).resolves.toBeNull();
  });
});

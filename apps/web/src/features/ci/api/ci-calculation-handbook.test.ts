import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  assertCiCalculationHandbook,
  ciCalculationHandbookQueryKey,
  fetchCiCalculationHandbook,
  invalidateAllCiCalculationHandbooks,
  invalidateCiCalculationHandbook,
} from "./ci-calculation-handbook";

function handbookFixture(projectId = "project-1") {
  const module = (moduleId: string, label: string) => ({
    module_id: moduleId,
    label,
    description: `${label} calculation ledger.`,
    status: "not_saved",
    saved_at: null,
    parameters: [],
    calculations: [{
      calculation_id: `${moduleId}.formula`,
      label: `${label} formula`,
      formula: "result = input",
      description: "Deterministic formula.",
      inputs: ["input"],
      source_reference: "solar_battery/example.py::calculate",
      current_example: null,
    }],
    models: [],
    result_sets: [{
      result_set_id: `${moduleId}.results`,
      label: `${label} results`,
      columns: [{ key: "value", label: "Value", unit: null }],
      rows: [],
    }],
    boundaries: ["No saved result."],
  });
  return {
    contract_version: "ci_project_handbook_v1",
    project: { project_id: projectId, display_name: "Test project", snapshot_at: "2026-09-04T00:00:00Z" },
    authority: {
      calculation_authority: "python",
      presentation_authority: "handbook_projection_only",
      mutation_policy: "controlled_existing_module_inputs",
      statement: "The Handbook reads saved inputs and results.",
    },
    parameter_management: {
      mode: "edit_at_source",
      stable_parameter_ids: true,
      supports_generic_formula_mutation: false,
      statement: "Inputs are edited at their governed source.",
    },
    modules: [
      module("evidence", "Evidence"),
      module("solution_generator", "Solution Generator"),
      module("scenario_analysis", "Scenario Analysis"),
      module("finance_analysis", "Finance Analysis"),
    ],
    summary: { module_count: 4, parameter_count: 0, calculation_count: 4, model_count: 0, result_row_count: 0 },
  };
}

describe("calculation Handbook API", () => {
  it("loads and validates the project-scoped read-only contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(handbookFixture()), { status: 200 }));

    const result = await fetchCiCalculationHandbook("project-1", fetcher);

    expect(result.modules).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/commercial-industrial/projects/project-1/calculation-handbook",
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
  });

  it("fails closed when formula identities are duplicated", () => {
    const payload = handbookFixture();
    payload.modules[1].calculations[0].calculation_id = payload.modules[0].calculations[0].calculation_id;

    expect(() => assertCiCalculationHandbook(payload, "project-1")).toThrow("unsafe or incomplete");
  });

  it("fails closed when the response belongs to another project", () => {
    expect(() => assertCiCalculationHandbook(handbookFixture("project-2"), "project-1")).toThrow("unsafe or incomplete");
  });

  it("invalidates only the requested project's cached Handbook", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ciCalculationHandbookQueryKey("project-1"), handbookFixture("project-1"));
    queryClient.setQueryData(ciCalculationHandbookQueryKey("project-2"), handbookFixture("project-2"));
    queryClient.setQueryData(["unrelated-query", "project-1"], { ready: true });

    await invalidateCiCalculationHandbook(queryClient, "project-1");

    expect(queryClient.getQueryState(ciCalculationHandbookQueryKey("project-1"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(ciCalculationHandbookQueryKey("project-2"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["unrelated-query", "project-1"])?.isInvalidated).toBe(false);
  });

  it("invalidates all Handbook snapshots without touching unrelated queries", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ciCalculationHandbookQueryKey("project-1"), handbookFixture("project-1"));
    queryClient.setQueryData(ciCalculationHandbookQueryKey("project-2"), handbookFixture("project-2"));
    queryClient.setQueryData(["unrelated-query"], { ready: true });

    await invalidateAllCiCalculationHandbooks(queryClient);

    expect(queryClient.getQueryState(ciCalculationHandbookQueryKey("project-1"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(ciCalculationHandbookQueryKey("project-2"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["unrelated-query"])?.isInvalidated).toBe(false);
  });
});

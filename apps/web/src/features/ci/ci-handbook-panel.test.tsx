// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiCalculationHandbook, CiHandbookModule } from "./api/ci-calculation-handbook";
import { CiHandbookPanel } from "./ci-handbook-panel";
import { createCiQueryClient } from "./ci-query-client";
import { CiWorkspaceProvider } from "./ci-workspace-context";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("CiHandbookPanel", () => {
  it("changes Handbook modules without refetching or sending a POST", async () => {
    const user = userEvent.setup();
    const fetchMock = mockHandbookApi();
    renderPanel();

    expect(await screen.findByText("Evidence formula")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Solution Generator/i }));
    expect(await screen.findByText("Solution Generator formula")).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("reuses the cached project snapshot when the drawer closes and reopens", async () => {
    const user = userEvent.setup();
    const fetchMock = mockHandbookApi();
    renderPanel();

    expect(await screen.findByText("Evidence formula")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Handbook - Test project" }));
    expect(screen.queryByRole("dialog", { name: "Handbook - Test project" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen Handbook" }));
    expect(await screen.findByText("Evidence formula")).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a calculation disclosure at the user's chosen state after a parent rerender", async () => {
    const user = userEvent.setup();
    mockHandbookApi();
    renderPanel();

    const formulaLabel = await screen.findByText("Evidence formula");
    const disclosure = formulaLabel.closest("details") as HTMLDetailsElement;
    const summary = disclosure.querySelector("summary");
    expect(disclosure.open).toBe(true);
    expect(summary).toBeTruthy();

    await user.click(summary!);
    await waitFor(() => expect(disclosure.open).toBe(false));
    await user.type(screen.getByRole("searchbox", { name: "Search current Handbook module" }), "Evidence");

    expect(disclosure.open).toBe(false);
  });
});

function renderPanel() {
  window.sessionStorage.setItem("e3-ci-active-workspace-v1", JSON.stringify({
    activeProject: {
      projectId: "project-1",
      displayName: "Test project",
      setupReady: true,
      designReady: true,
    },
    stage: "evidence",
  }));
  const queryClient = createCiQueryClient();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)} type="button">Reopen Handbook</button>
        {open ? <CiHandbookPanel onClose={() => setOpen(false)} open /> : null}
      </>
    );
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <CiWorkspaceProvider><Harness /></CiWorkspaceProvider>
    </QueryClientProvider>,
  );
}

function mockHandbookApi() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(handbookFixture()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function handbookFixture(): CiCalculationHandbook {
  const module = (moduleId: CiHandbookModule["module_id"], label: string): CiHandbookModule => ({
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
    project: { project_id: "project-1", display_name: "Test project", snapshot_at: "2026-09-04T00:00:00Z" },
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

// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiCalculationHandbook, CiHandbookModule } from "./api/ci-calculation-handbook";
import { CiHandbookPanel } from "./ci-handbook-panel";
import { guideFixture } from "./api/ci-calculation-guide.test-data";
import { createCiQueryClient } from "./ci-query-client";
import { CiWorkspaceProvider } from "./ci-workspace-context";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("CiHandbookPanel", () => {
  it("opens a populated teaching guide and switches chapters without loading project calculations", async () => {
    const user = userEvent.setup();
    const fetchMock = mockHandbookApi();
    renderPanel();
    expect(await screen.findByText("200 kW average demand")).toBeTruthy();
    expect(screen.getByText(/Synthetic teaching example only/)).toBeTruthy();
    await user.click(screen.getByRole("button", {name: "5. stc"}));
    expect(screen.getByText("174 × $39")).toBeTruthy();
    expect(screen.getByText("$6,786.00 worksheet estimate")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/calculation-guide");
  });

  it("keeps a visible guide header and retry when the guide request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", {status: 503})));
    renderPanel();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", {name: "How this system calculates"})).toBeTruthy();
    expect(screen.getByRole("button", {name: "Retry guide"})).toBeTruthy();
  });

  it("matches the selected scenario across saved results and withholds stale finance", async () => {
    const payload = handbookFixture();
    for (const module of payload.modules) {
      module.status = module.module_id === "finance_analysis" ? "stale" : "ready";
      if (module.module_id === "evidence") continue;
      module.result_sets = [{result_set_id: module.module_id === "solution_generator" ? "solution.solutions" : `${module.module_id}.results`, label: `${module.label} matched results`,
        columns: [{key: "pv_capacity", label: "PV capacity", unit: "kWp"}, {key: "battery_capacity", label: "Battery capacity", unit: "kWh"}],
        rows: [{result_id: "a", label: "Solution A", values: {pv_capacity: 140, battery_capacity: 210}}, {result_id: "b", label: "Solution B", values: {pv_capacity: 200, battery_capacity: 294}}]}];
    }
    payload.summary.result_row_count = payload.modules.reduce((sum, m) => sum + m.result_sets.reduce((n, s) => n + s.rows.length, 0), 0);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/calculation-guide") ? guideFixture() : payload)));
    vi.stubGlobal("fetch", fetcher);
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", {name: "Saved solution walkthrough"}));
    const select = await screen.findByLabelText("Solution to explain");
    expect(screen.getByText("Matching saved scenario ID: a")).toBeTruthy();
    await user.selectOptions(select, "b");
    expect(screen.getByText("Matching saved scenario ID: b")).toBeTruthy();
    expect(screen.queryByText("Matching saved scenario ID: a")).toBeNull();
    expect(screen.getByText(/Current results are withheld/)).toBeTruthy();
    expect(screen.queryByText("Finance Analysis matched results")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("explains an empty solution list instead of displaying a blank walkthrough", async () => {
    mockHandbookApi();
    renderPanel();
    await userEvent.click(screen.getByRole("button", {name: "Saved solution walkthrough"}));
    expect(await screen.findByText(/No saved solution yet/)).toBeTruthy();
  });

  it("changes Handbook modules without refetching or sending a POST", async () => {
    const user = userEvent.setup();
    const fetchMock = mockHandbookApi();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Project ledger" }));

    expect(await screen.findByRole("heading", { name: "Module overview" })).toBeTruthy();
    const sectionNavigation = screen.getByRole("navigation", { name: "Handbook sections" });
    await user.click(within(sectionNavigation).getByRole("button", { name: /Formulas 1/i }));
    expect(await screen.findByText("Evidence formula")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Solution Generator/i }));
    await user.click(within(sectionNavigation).getByRole("button", { name: /Formulas 1/i }));
    expect(await screen.findByText("Solution Generator formula")).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("reuses the cached project snapshot when the drawer closes and reopens", async () => {
    const user = userEvent.setup();
    const fetchMock = mockHandbookApi();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Project ledger" }));

    expect(await screen.findByRole("heading", { name: "Module overview" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Handbook - Test project" }));
    expect(screen.queryByRole("dialog", { name: "Handbook - Test project" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen Handbook" }));
    await user.click(screen.getByRole("button", { name: "Project ledger" }));
    expect(await screen.findByRole("heading", { name: "Module overview" })).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a full-screen dialog with clear module and section navigation", async () => {
    const user = userEvent.setup();
    mockHandbookApi();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Project ledger" }));

    const dialog = await screen.findByRole("dialog", { name: "Handbook - Test project" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector('[data-presentation="fullscreen"]')).toBeTruthy();
    expect(await screen.findByRole("navigation", { name: "Handbook modules" })).toBeTruthy();
    const sectionNavigation = screen.getByRole("navigation", { name: "Handbook sections" });
    expect(sectionNavigation).toBeTruthy();
    expect(screen.queryByText("Evidence formula")).toBeNull();

    await user.click(within(sectionNavigation).getByRole("button", { name: /Formulas 1/i }));
    expect(await screen.findByText("Evidence formula")).toBeTruthy();
    expect(screen.getAllByText("result = input").length).toBeGreaterThan(0);
  });

  it("closes on Escape, restores page scrolling and returns focus to the opener", async () => {
    const user = userEvent.setup();
    mockHandbookApi();
    renderPanel(false);

    const opener = screen.getByRole("button", { name: "Reopen Handbook" });
    opener.focus();
    await user.click(opener);
    expect(await screen.findByRole("dialog", { name: "Handbook - Test project" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Handbook - Test project" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("keeps a calculation disclosure at the user's chosen state after a parent rerender", async () => {
    const user = userEvent.setup();
    mockHandbookApi();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Project ledger" }));

    const sectionNavigation = await screen.findByRole("navigation", { name: "Handbook sections" });
    await user.click(within(sectionNavigation).getByRole("button", { name: /Formulas 1/i }));
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

function renderPanel(initiallyOpen = true) {
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
    const [open, setOpen] = useState(initiallyOpen);
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
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).endsWith("/calculation-guide") ? guideFixture() : handbookFixture()), { status: 200 }));
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

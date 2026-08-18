// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDesignCandidateResult } from "./api/ci-projects";
import type { CiScenarioInput } from "./api/ci-scenarios";
import { CandidateResults, CiReadinessPage } from "./ci-readiness-page";
import { CiWorkspaceProvider } from "./ci-workspace-context";

const readiness = {
  contract_version: "ci_workspace_readiness_v3",
  product_id: "commercial_and_industrial",
  availability: "evidence_limited",
  active_profile_id: "private-profile",
  active_profile_label: "Private profile",
  blockers: [{ code: "ci_evidence_gate_issue_5", message: "Evidence-limited internal review." }],
  workspace_areas: [
    ["data_qc", "Data QC"], ["tariff_mapping", "Tariff"], ["peak_shaving", "Peak"],
    ["kw_kva_pf_evidence", "Power"], ["scenario_ranking", "Ranking"], ["report_preview", "Report"],
  ].map(([workspace_id, display_label], index) => ({
    workspace_id,
    display_label,
    description: display_label,
    availability: ([0, 1, 3].includes(index) ? "evidence_limited" : "input_required"),
  })),
};

const project = {
  project_id: "project-1",
  display_name: "Commercial feasibility",
  current_stage: "setup",
  setup_status: "input_required",
  design_status: "input_required",
  design_candidate_count: 0,
  created_at: "2026-08-17T00:00:00+00:00",
  updated_at: "2026-08-17T00:00:00+00:00",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPage() {
  render(<QueryClientProvider client={new QueryClient()}><CiWorkspaceProvider><CiReadinessPage /></CiWorkspaceProvider></QueryClientProvider>);
}

function mockApi(projects = [project]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/workspace-readiness")) return new Response(JSON.stringify(readiness), { status: 200 });
    if (path.endsWith("/evidence-intake")) return new Response(JSON.stringify({ contract_version: "ci_project_evidence_state_v1", status: "not_saved", evidence: null }), { status: 200 });
    if (path.endsWith("/projects") && init?.method === "POST") return new Response(JSON.stringify({ contract_version: "ci_project_v1", ...project, project_id: "project-new", display_name: JSON.parse(String(init.body)).display_name }), { status: 201 });
    if (path.endsWith("/projects")) return new Response(JSON.stringify({ contract_version: "ci_project_registry_v1", projects }), { status: 200 });
    throw new Error(`Unexpected request: ${path}`);
  }));
}

describe("C&I project workspace", () => {
  it("shows existing projects as cards and keeps the plus card last", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole("heading", { name: "Project overview" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Commercial feasibility" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New project/ })).toBeTruthy();
  });

  it("creates a project from the plus card and moves directly to setup", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /New project/ }));
    await user.type(screen.getByLabelText("Project name"), "Warehouse B");
    await user.click(screen.getByRole("button", { name: /Create & continue/ }));
    expect(await screen.findByRole("heading", { name: "Verify the project inputs" })).toBeTruthy();
    expect(screen.getByText("Warehouse B")).toBeTruthy();
    expect(screen.getByLabelText("Electricity bill PDF")).toBeTruthy();
    expect(screen.getByLabelText("Matching interval CSV / NEM12")).toBeTruthy();
  });

  it("opens a setup-complete project in Setup before allowing System design", async () => {
    const user = userEvent.setup();
    mockApi([{ ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 12 }]);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("heading", { name: "Verify the project inputs" })).toBeTruthy();
    expect(screen.getByText("Setup is complete for this project.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open System design/ })).toBeTruthy();
  });

  it("summarises a validated search space without an always-visible candidate table", async () => {
    const onRun = vi.fn();
    const candidates = [
      scenario("pv-1", "battery-1", 100, 200, 50),
      scenario("pv-1", "battery-2", 100, 400, 100),
      scenario("pv-2", "battery-1", 150, 200, 50),
      scenario("pv-2", "battery-2", 150, 400, 100),
    ];
    const result = { contract_version: "ci_design_candidate_validation_v1", status: "ready", validation_basis: "python_scenario_input_contract_v1", candidate_count: 4, candidates, dispatch_evaluated: false, tariff_evaluated: false, customer_facing_permission: false, recommendation_permitted: false, disclaimer: "Input-valid only." } satisfies CiDesignCandidateResult;

    render(<CandidateResults isPending={false} onRun={onRun} result={result} />);

    expect(screen.getByRole("heading", { name: "Design space ready" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 PV configurations" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 Battery configurations" })).toBeTruthy();
    expect(screen.getByText("cases ready to analyse")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Analyse 4 candidates/ }));
    expect(onRun).toHaveBeenCalledOnce();
  });
});

function scenario(pvSystemId: string, batterySystemId: string, pvCapacity: number, batteryCapacity: number, batteryPower: number): CiScenarioInput {
  return {
    scenario_id: `${pvSystemId}__${batterySystemId}`,
    label: `${pvCapacity} kWp + ${batteryCapacity} kWh`,
    battery_system_id: batterySystemId,
    battery_technology_id: "generic_li_ion_ac",
    control_profile_id: "demand_peak_shaving",
    pv_system_id: pvSystemId,
    pv_profile_id: "generic_normalized_solar_shape_v1",
    pv_capacity_kwp_dc: pvCapacity,
    pv_inverter_capacity_kw_ac: pvCapacity / 1.25,
    shared_ac_headroom_kw: 250,
    reactive_support_enabled: false,
    reactive_support_max_kvar: 0,
    shared_inverter_apparent_power_limit_kva: null,
    reactive_capability_curve: "circular_pq",
    reactive_capability_provenance: "analyst_assumption",
    reactive_overcompensation_permitted: false,
    pv_annual_specific_yield_kwh_per_kw: 1500,
    pv_derating_factor: 0.88,
    nominal_capacity_kwh: batteryCapacity,
    max_charge_kw: batteryPower,
    max_discharge_kw: batteryPower,
    charge_efficiency: 0.95,
    discharge_efficiency: 0.95,
    min_soc_fraction: 0.1,
    max_soc_fraction: 1,
    initial_soc_fraction: 1,
    allow_grid_charging: false,
  };
}

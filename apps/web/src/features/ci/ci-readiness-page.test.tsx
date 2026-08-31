// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CiReadinessPage } from "./ci-readiness-page";
import { CiProductShell } from "./ci-product-shell";
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

const generatedDesign = {
  contract_version: "ci_design_candidate_validation_v1",
  status: "ready",
  validation_basis: "python_scenario_input_contract_v1",
  candidate_count: 2,
  candidates: [
    { scenario_id: "pv-1__battery-1", pv_capacity_kwp_dc: 100, nominal_capacity_kwh: 200, pv_inverter_capacity_kw_ac: 90, max_discharge_kw: 100 },
    { scenario_id: "pv-2__battery-1", pv_capacity_kwp_dc: 150, nominal_capacity_kwh: 200, pv_inverter_capacity_kw_ac: 130, max_discharge_kw: 100 },
  ],
  dispatch_evaluated: false,
  tariff_evaluated: false,
  customer_facing_permission: false,
  recommendation_permitted: false,
  disclaimer: "Inputs only.",
  design_context: null,
};

const deviceProfileFixture = {
  contract_version: "ci_device_profile_v2", profile_id: "workspace_device_profile", currency: "AUD", tax_basis: "gst_exclusive", pv_cost_aud_per_kwp_dc: 530, battery_cost_aud_per_kwh: 413, inverter_cost_aud_per_kw_ac: 80,
  equipment_catalog: {
    pv_products: [{ product_id: "astronergy_astro_n7_600_630w", manufacturer: "Astronergy", model: "ASTRO N7 600–630W", rated_power_min_w: 600, rated_power_max_w: 630, capital_cost_aud_per_kwp_dc: 530, replacement_cost_aud_per_kwp_dc: 530, annual_om_aud: 0 }],
    battery_products: [{ product_id: "fox_ess_cq7_ci", manufacturer: "Fox ESS", model: "CQ7 C&I", chemistry: "LFP", module_capacity_kwh: 7, cost_curve: [{ quantity: 30, capital_cost_aud: 77578, replacement_cost_aud: 57456, annual_om_aud: 0 }, { quantity: 36, capital_cost_aud: 91866, replacement_cost_aud: 69660, annual_om_aud: 0 }, { quantity: 42, capital_cost_aud: 106154, replacement_cost_aud: 81864, annual_om_aud: 0 }] }],
    inverter_products: [{ product_id: "fox_ess_h3_plus_125kw", manufacturer: "Fox ESS", model: "H3 Plus Hybrid Inverter", sizing_unit_kw_ac: 125, cost_curve: [{ capacity_kw_ac: 80, capital_cost_aud: 9000, replacement_cost_aud: 9000, annual_om_aud: 0 }, { capacity_kw_ac: 100, capital_cost_aud: 9500, replacement_cost_aud: 9500, annual_om_aud: 0 }, { capacity_kw_ac: 125, capital_cost_aud: 10000, replacement_cost_aud: 10000, annual_om_aud: 0 }] }],
  },
  default_equipment_selection: { pv_product_id: "astronergy_astro_n7_600_630w", battery_product_id: "fox_ess_cq7_ci", inverter_product_id: "fox_ess_h3_plus_125kw" },
  discount_rate: .08, annual_value_escalation_rate: .025, annual_value_degradation_rate: .005, annual_om_fraction_of_capex: .015, analysis_term_years: 15,
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPage() {
  render(<QueryClientProvider client={new QueryClient()}><CiWorkspaceProvider><CiProductShell><CiReadinessPage /></CiProductShell></CiWorkspaceProvider></QueryClientProvider>);
}

function mockApi(projects = [project], savedDesign: typeof generatedDesign | null = null) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/settings/device-profile")) {
      const suggested = deviceProfileFixture;
      if (init?.method === "PUT") return new Response(JSON.stringify({ contract_version: "ci_device_profile_state_v1", status: "ready", updated_at: "2026-08-19", profile_sha256: "a".repeat(64), profile: JSON.parse(String(init.body)), suggested_profile: suggested }), { status: 200 });
      return new Response(JSON.stringify({ contract_version: "ci_device_profile_state_v1", status: "not_configured", updated_at: null, profile_sha256: null, profile: null, suggested_profile: suggested }), { status: 200 });
    }
    if (path.endsWith("/workspace-readiness")) return new Response(JSON.stringify(readiness), { status: 200 });
    if (path.endsWith("/site-material")) return new Response(JSON.stringify({ contract_version: "ci_project_site_material_v1", photos: [] }), { status: 200 });
    if (path.endsWith("/evidence-intake")) return new Response(JSON.stringify({ contract_version: "ci_project_evidence_state_v1", status: "not_saved", evidence: null }), { status: 200 });
    if (path.endsWith("/design-candidates")) return new Response(JSON.stringify(savedDesign ? { contract_version: "ci_saved_design_state_v1", status: "ready", design: savedDesign } : { contract_version: "ci_saved_design_state_v1", status: "not_saved", design: null }), { status: 200 });
    if (path.endsWith("/design-feasibility")) return new Response(JSON.stringify({ contract_version: "ci_project_feasibility_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    if (path.endsWith("/tariff-replay")) return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    if (path.endsWith("/annual-financial-comparison")) return new Response(JSON.stringify({ contract_version: "ci_project_annual_financial_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    if (path.endsWith("/projects") && init?.method === "POST") return new Response(JSON.stringify({ contract_version: "ci_project_v1", ...project, project_id: "project-new", display_name: JSON.parse(String(init.body)).display_name }), { status: 201 });
    if (path.endsWith("/projects")) return new Response(JSON.stringify({ contract_version: "ci_project_registry_v1", projects }), { status: 200 });
    throw new Error(`Unexpected request: ${path}`);
  }));
}

describe("C&I project workspace", () => {
  it("shows projects on the left and all four analysis modules on top", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole("region", { name: "Evidence sources" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open project Commercial feasibility" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Project workspace" }).className).toContain("lg:sticky");
    expect(screen.getAllByRole("button", { name: "New project" }).length).toBeGreaterThan(0);
    for (const [index, label] of ["Evidence", "Solution Generator", "Scenario Analysis", "Finance Analysis"].entries()) {
      expect(screen.getByRole("button", { name: `${String(index + 1).padStart(2, "0")} ${label}` })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /Comparison/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Next: Solution Generator" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Previous:/ })).toBeNull();
  });

  it("creates a project from the left rail and opens its Evidence module", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });
    await user.click(screen.getAllByRole("button", { name: "New project" })[0]);
    await user.type(screen.getByLabelText("Project name"), "Warehouse B");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("heading", { name: "Warehouse B" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Evidence sources" })).toBeTruthy();
    expect(screen.getByLabelText("Electricity bill PDF")).toBeTruthy();
    expect(screen.getByLabelText("Matching interval CSV / NEM12")).toBeTruthy();
  });

  it("opens the shared Device profile from Settings in the lower left rail", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Device profile" })).toBeTruthy();
    expect(screen.queryByText("Device profile could not be loaded.")).toBeNull();
    expect(await screen.findByText("Supported equipment")).toBeTruthy();
    expect((screen.getByLabelText("Per kWp DC capital") as HTMLInputElement).value).toBe("530");
    expect((screen.getByLabelText("30 capital") as HTMLInputElement).value).toBe("77578");
    expect((screen.getByLabelText("125 kW capital") as HTMLInputElement).value).toBe("10000");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText(/Device profile saved/)).toBeTruthy();
  });

  it("keeps every module available and opens Physical feasibility from Evidence", async () => {
    const user = userEvent.setup();
    mockApi([{ ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 12 }]);
    renderPage();
    expect(await screen.findByRole("region", { name: "Evidence sources" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next: Solution Generator" }));
    expect(screen.getByRole("heading", { name: "Build the system search space" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous: Evidence" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next: Scenario Analysis" })).toBeTruthy();
  });

  it("keeps later templates accessible when Dispatch prerequisites are missing", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: /03 Scenario Analysis/ }));
    expect(await screen.findByRole("heading", { name: "Dispatch" })).toBeTruthy();
    expect(screen.getByText(/Generate and save the PV and battery solution space/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /04 Finance Analysis/ }));
    expect(await screen.findByRole("heading", { name: "Annual bill reconstruction" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tariff replay needs project inputs" })).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();

    expect(screen.getByRole("button", { name: "Previous: Scenario Analysis" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next:/ })).toBeNull();
  });

  it("opens generated solutions in the Dispatch left-and-right workspace", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: /03 Scenario Analysis/ }));
    expect(await screen.findByRole("heading", { name: "Scenario dispatch analysis" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run 2 solutions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ready to simulate every solution" })).toBeTruthy();
    expect(screen.getByText("Solution 1")).toBeTruthy();
    expect(screen.getByText("Solution 2")).toBeTruthy();
  });

});

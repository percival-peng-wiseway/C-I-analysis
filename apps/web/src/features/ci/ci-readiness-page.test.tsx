// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CiReadinessPage } from "./ci-readiness-page";
import { CiProductShell } from "./ci-product-shell";
import { createCiQueryClient } from "./ci-query-client";
import { CiWorkspaceProvider } from "./ci-workspace-context";
import type { CiProjectRebateProfile, CiProjectRebateProfileState } from "./api/ci-rebate-profile";

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
    { scenario_id: "pv-1__battery-1", label: "Option 1", pv_capacity_kwp_dc: 100, nominal_capacity_kwh: 200, pv_inverter_capacity_kw_ac: 90, max_discharge_kw: 100 },
    { scenario_id: "pv-2__battery-1", label: "Option 2", pv_capacity_kwp_dc: 150, nominal_capacity_kwh: 200, pv_inverter_capacity_kw_ac: 130, max_discharge_kw: 100 },
  ],
  dispatch_evaluated: false,
  tariff_evaluated: false,
  customer_facing_permission: false,
  recommendation_permitted: false,
  disclaimer: "Inputs only.",
  generation_summary: {
    requested_count: 2,
    deduplicated_count: 0,
    rejected_count: 0,
    generated_candidate_count: 2,
    rejection_reasons: [],
  },
  design_context: {
    contract_version: "ci_design_context_v1",
    existing_solar: { installed: false, brand: "", model: "", panel_count: 0, panel_rating_w: 0, installed_capacity_kwp_dc: 0, inverter_brand: "", inverter_model: "", inverter_capacity_kw_ac: 0, installation_year: null, operating_status: "unknown", included_in_interval_baseline: false },
    existing_battery: { installed: false, brand: "", model: "", nominal_capacity_kwh: 0, usable_capacity_kwh: 0, power_kw: 0, installation_year: null, operating_status: "unknown", included_in_interval_baseline: false },
    technical_options: { annual_specific_yield_kwh_per_kw: 1500, shading_loss_percent: 3, soiling_loss_percent: 2, temperature_loss_percent: 5, wiring_mismatch_loss_percent: 2, other_system_loss_percent: 0, system_availability_percent: 99, effective_derating_percent: 87.6, target_dc_ac_ratio: 1.15, inverter_block_size_kw: 125, site_ac_headroom_kw: 250, battery_duration_hours: 2, charge_efficiency_percent: 95, discharge_efficiency_percent: 95, minimum_soc_percent: 10, maximum_soc_percent: 100, allow_grid_charging: false, reactive_support_enabled: false, reactive_support_max_kvar: 0 },
  },
};

const deviceProfileFixture = {
  contract_version: "ci_device_profile_v5", profile_id: "workspace_device_profile", currency: "AUD", tax_basis: "gst_exclusive", pv_cost_aud_per_kwp_dc: 530, battery_cost_aud_per_kwh: 413, inverter_cost_aud_per_kw_ac: 80,
  equipment_catalog: {
    pv_products: [{ product_id: "astronergy_astro_n7_600_630w", manufacturer: "Astronergy", model: "ASTRO N7 600–630W", rated_power_min_w: 600, rated_power_max_w: 630, capital_cost_aud_per_kwp_dc: 530, replacement_cost_aud_per_kwp_dc: 530, annual_om_aud: 0 }],
    battery_products: [{ product_id: "fox_ess_cq7_ci", manufacturer: "Fox ESS", model: "CQ7 C&I", chemistry: "LFP", module_capacity_kwh: 7, cost_curve: [{ quantity: 30, capital_cost_aud: 77578, replacement_cost_aud: 57456, annual_om_aud: 0 }, { quantity: 36, capital_cost_aud: 91866, replacement_cost_aud: 69660, annual_om_aud: 0 }, { quantity: 42, capital_cost_aud: 106154, replacement_cost_aud: 81864, annual_om_aud: 0 }] }],
    inverter_products: [{ product_id: "fox_ess_h3_plus_125kw", manufacturer: "Fox ESS", model: "H3 Plus Hybrid Inverter", sizing_unit_kw_ac: 125, cost_curve: [{ capacity_kw_ac: 80, capital_cost_aud: 9000, replacement_cost_aud: 9000, annual_om_aud: 0 }, { capacity_kw_ac: 100, capital_cost_aud: 9500, replacement_cost_aud: 9500, annual_om_aud: 0 }, { capacity_kw_ac: 125, capital_cost_aud: 10000, replacement_cost_aud: 10000, annual_om_aud: 0 }] }],
  },
  default_equipment_selection: { pv_product_id: "astronergy_astro_n7_600_630w", battery_product_id: "fox_ess_cq7_ci", inverter_product_id: "fox_ess_h3_plus_125kw" },
  solution_profiles: {
    solar_profiles: [{ profile_id: "generic_crystalline_pv_v1", version: 1, status: "published", name: "Generic crystalline PV screening profile", manufacturer: "Generic", model: "Screening assumption", module_technology: "monocrystalline", rated_power_w: 600, module_efficiency_percent: 22, temperature_coefficient_percent_per_c: -0.35, annual_degradation_percent: 0.5, default_dc_ac_ratio: 1.15, source_type: "analyst_assumption", source_label: "Generic screening assumption", source_date: null }],
    battery_profiles: [{ profile_id: "generic_lfp_ac_2h_v1", version: 1, status: "published", name: "Generic LFP AC 2-hour screening profile", manufacturer: "Generic", model: "Screening assumption", chemistry: "LFP", coupling: "ac", nominal_capacity_kwh_per_unit: 100, continuous_power_kw_per_unit: 50, round_trip_efficiency_percent: 90, power_conversion_efficiency_percent: 95, usable_depth_of_discharge_percent: 90, standby_loss_percent_per_month: 1, annual_capacity_degradation_percent: 2, minimum_units: 1, maximum_units: 10000, source_type: "analyst_assumption", source_label: "Generic screening assumption", source_date: null }],
      inverter_profiles: [{ profile_id: "fox_h3_125_plus_v1", version: 1, status: "published", name: "H3-125-Plus evidence", manufacturer: "Fox ESS", model: "H3-125-Plus", rated_active_power_kw: 125, rated_apparent_power_kva: 137.5, reactive_support_enabled: true, maximum_reactive_power_kvar: 82.5, power_factor_leading_limit: 0.8, power_factor_lagging_limit: 0.8, pq_capability_curve_available: false, reactive_power_at_zero_active_power: true, night_reactive_capability: true, european_efficiency_percent: 98.1, maximum_efficiency_percent: 98.5, source_type: "supplier_data", source_label: "Supplied C&I device workbook", source_date: null }],
  },
  default_solution_profile_selection: { solar_profile_id: "generic_crystalline_pv_v1", battery_profile_id: "generic_lfp_ac_2h_v1" },
  discount_rate: .08, annual_value_escalation_rate: .025, annual_value_degradation_rate: .005, annual_om_fraction_of_capex: .015, analysis_term_years: 15,
};

const rebateProfileFixture: CiProjectRebateProfile = {
  contract_version: "ci_project_rebate_profile_v1",
  target_certificate_date: "2026-09-02",
  site_state_code: "",
  site_postcode: "",
  site_location_confirmed: false,
  site_location_source_label: "",
  stacking_confirmed: false,
  programs: {
    solar_stc: { enabled: false, eligibility_confirmed: false, eligibility_source_label: "", certificate_price_aud_ex_gst: 39, price_source_label: "", price_as_of_date: "2026-09-02", postcode_zone_rating: null, zone_source_label: "" },
    battery_stc: { enabled: false, eligibility_confirmed: false, eligibility_source_label: "", certificate_price_aud_ex_gst: 39, price_source_label: "", price_as_of_date: "2026-09-02", certified_usable_capacity_fraction: null, capacity_source_label: "" },
    vic_deemed_veec: { enabled: false, eligibility_confirmed: false, eligibility_source_label: "", certificate_price_aud_ex_gst: 70, price_source_label: "", price_as_of_date: "2026-09-02", victoria_region: null, inverter_apparent_power_kva_per_kw_ac: null, inverter_apparent_power_source_label: "" },
  },
};

const rebateStateFixture: CiProjectRebateProfileState = {
  contract_version: "ci_project_rebate_profile_state_v1",
  status: "not_configured",
  updated_at: null,
  approved_at: null,
  profile_sha256: null,
  profile: null,
  suggested_profile: rebateProfileFixture,
  site_evidence: { detected_site_address: null, state_code: null, postcode: null },
  blockers: [],
  ruleset: { ruleset_id: "au_ci_rebates_2026_v1", ruleset_sha256: "b".repeat(64), official_sources: [{ source_id: "cer-stc", label: "Clean Energy Regulator · STCs", url: "https://cer.gov.au/", status: "authoritative" }] },
};

const approvedSolarStcState: CiProjectRebateProfileState = {
  ...rebateStateFixture,
  status: "approved",
  updated_at: "2026-09-02T00:00:00Z",
  approved_at: "2026-09-02T00:00:00Z",
  profile_sha256: "d".repeat(64),
  profile: {
    ...rebateProfileFixture,
    site_state_code: "VIC",
    site_postcode: "3000",
    site_location_confirmed: true,
    site_location_source_label: "Current bill evidence",
    programs: {
      ...rebateProfileFixture.programs,
      solar_stc: {
        ...rebateProfileFixture.programs.solar_stc,
        enabled: true,
        eligibility_confirmed: true,
        eligibility_source_label: "Analyst confirmed",
        price_source_label: "Analyst entered",
        postcode_zone_rating: 1.185,
        zone_source_label: "Zone 4",
      },
    },
  },
  site_evidence: { detected_site_address: "10 Collins Street Melbourne VIC, 3000", state_code: "VIC", postcode: "3000" },
};

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); });

function renderPage() {
  return render(<QueryClientProvider client={createCiQueryClient()}><CiWorkspaceProvider><CiProductShell><CiReadinessPage /></CiProductShell></CiWorkspaceProvider></QueryClientProvider>);
}

type MockApiOverrides = {
  feasibilityPost?: () => Response | Promise<Response>;
  pricePreview?: (readNumber: number, payload: Record<string, unknown>) => Response | Promise<Response>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function fullAnalysisPosts(fetchMock: ReturnType<typeof vi.fn>) {
  const suffixes = ["/design-feasibility", "/tariff-replay", "/annual-financial-comparison"];
  return fetchMock.mock.calls.filter(([input, init]) => (
    init?.method === "POST" && suffixes.some((suffix) => String(input).endsWith(suffix))
  ));
}

function mockApi(projects = [project], savedDesign: typeof generatedDesign | null = null, rebateState: CiProjectRebateProfileState = rebateStateFixture, holdAnalysis = false, failStcSave = false, nextGeneratedDesign: typeof generatedDesign | null = null, overrides: MockApiOverrides = {}) {
  let currentSavedDesign = savedDesign;
  let currentRebateState = rebateState;
  let pricePreviewReads = 0;
  const applyStcSettings = (body: Record<string, unknown>) => {
    const nextProfile = structuredClone(currentRebateState.profile ?? currentRebateState.suggested_profile);
    nextProfile.programs.solar_stc.enabled = Boolean(body.solar_stc_enabled);
    nextProfile.programs.solar_stc.certificate_price_aud_ex_gst = Number(body.solar_stc_price_aud_ex_gst);
    nextProfile.programs.battery_stc.enabled = Boolean(body.battery_stc_enabled);
    nextProfile.programs.battery_stc.certificate_price_aud_ex_gst = Number(body.battery_stc_price_aud_ex_gst);
    currentRebateState = {
      ...currentRebateState,
      status: "approved",
      updated_at: "2026-09-03T00:00:00Z",
      approved_at: "2026-09-03T00:00:00Z",
      profile_sha256: "d".repeat(64),
      profile: nextProfile,
    };
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/settings/device-profile")) {
      const suggested = deviceProfileFixture;
      if (init?.method === "PUT") return new Response(JSON.stringify({ contract_version: "ci_device_profile_state_v1", status: "ready", updated_at: "2026-08-19", profile_sha256: "a".repeat(64), profile: JSON.parse(String(init.body)), suggested_profile: suggested }), { status: 200 });
      return new Response(JSON.stringify({ contract_version: "ci_device_profile_state_v1", status: "not_configured", updated_at: null, profile_sha256: null, profile: null, suggested_profile: suggested }), { status: 200 });
    }
    if (path.endsWith("/workspace-readiness")) return new Response(JSON.stringify(readiness), { status: 200 });
    if (path.endsWith("/site-material")) return new Response(JSON.stringify({ contract_version: "ci_project_site_material_v1", photos: [] }), { status: 200 });
    if (path.endsWith("/evidence-intake")) return new Response(JSON.stringify({ contract_version: "ci_project_evidence_state_v1", status: "not_saved", evidence: null }), { status: 200 });
    if (path.endsWith("/design-candidates/custom") && init?.method === "POST" && currentSavedDesign) {
      const request = JSON.parse(String(init.body));
      if (failStcSave) return new Response(JSON.stringify({ detail: { message: "Synthetic STC save failed." } }), { status: 422 });
      if (request.stc_settings) applyStcSettings(request.stc_settings);
      const scenarioId = "pv-custom__battery-custom";
      currentSavedDesign = { ...currentSavedDesign, candidate_count: currentSavedDesign.candidate_count + 1, candidates: [...currentSavedDesign.candidates, { scenario_id: scenarioId, label: request.label, pv_capacity_kwp_dc: request.pv_capacity_kwp_dc, nominal_capacity_kwh: request.battery_capacity_kwh, pv_inverter_capacity_kw_ac: request.inverter_capacity_kw_ac, max_discharge_kw: request.battery_capacity_kwh / 2 }] };
      return new Response(JSON.stringify({ ...currentSavedDesign, added_scenario_id: scenarioId, quoted_net_capex_aud_ex_gst: request.quoted_net_capex_aud_ex_gst, normalization: { requested_pv_capacity_kwp_dc: request.pv_capacity_kwp_dc, actual_pv_capacity_kwp_dc: request.pv_capacity_kwp_dc, requested_battery_capacity_kwh: request.battery_capacity_kwh, actual_battery_capacity_kwh: request.battery_capacity_kwh, requested_inverter_capacity_kw_ac: request.inverter_capacity_kw_ac, actual_inverter_capacity_kw_ac: request.inverter_capacity_kw_ac } }), { status: 200 });
    }
    if (path.endsWith("/design-candidates") && init?.method === "POST" && currentSavedDesign) {
      const body = JSON.parse(String(init.body)) as { stc_settings?: Record<string, unknown> };
      if (failStcSave) return new Response(JSON.stringify({ detail: { message: "Synthetic STC save failed." } }), { status: 422 });
      if (body.stc_settings) applyStcSettings(body.stc_settings);
      if (nextGeneratedDesign) currentSavedDesign = nextGeneratedDesign;
      return new Response(JSON.stringify(currentSavedDesign), { status: 200 });
    }
    if (path.endsWith("/design-candidates")) return new Response(JSON.stringify(currentSavedDesign ? { contract_version: "ci_saved_design_state_v1", status: "ready", design: currentSavedDesign } : { contract_version: "ci_saved_design_state_v1", status: "not_saved", design: null }), { status: 200 });
    if (path.endsWith("/design-price-preview") && currentSavedDesign) {
      const payload = {
        contract_version: "ci_design_price_preview_v1",
        project_id: path.includes("project-2") ? "project-2" : "project-1",
        status: "ready",
        pricing_basis: "workspace_device_profile_less_approved_rebates",
        design_candidates_sha256: "b".repeat(64),
        device_profile_sha256: "c".repeat(64),
        rebate_profile_sha256: currentRebateState.status === "approved" ? "d".repeat(64) : null,
        equipment_selection: deviceProfileFixture.default_equipment_selection,
        candidate_count: currentSavedDesign.candidate_count,
        solutions: currentSavedDesign.candidates.map((candidate, index) => ({
          scenario_id: candidate.scenario_id,
          label: candidate.label ?? `Option ${index + 1}`,
          pv_capacity_kwp_dc: candidate.pv_capacity_kwp_dc,
          battery_capacity_kwh: candidate.nominal_capacity_kwh,
          inverter_capacity_kw_ac: candidate.pv_inverter_capacity_kw_ac,
          gross_capex_aud_ex_gst: 100_000 + index * 10_000,
          upfront_rebate_aud_ex_gst: 10_000,
          net_capex_aud_ex_gst: 90_000 + index * 10_000,
          capex_breakdown_aud_ex_gst: { pv_aud: 50_000 + index * 10_000, battery_aud: 40_000, inverter_aud: 10_000 },
          rebate_calculation: { scenario_id: candidate.scenario_id, customer_facing_permission: false },
        })),
        quotation_override_basis: "Entered quotation replaces modelled Net CAPEX.",
        currency_values_permitted: true,
        customer_facing_permission: false,
        recommendation_permitted: false,
      };
      pricePreviewReads += 1;
      return overrides.pricePreview?.(pricePreviewReads, payload) ?? new Response(JSON.stringify(payload), { status: 200 });
    }
    if (path.endsWith("/design-feasibility")) {
      if (init?.method === "POST" && overrides.feasibilityPost) return overrides.feasibilityPost();
      if (init?.method === "POST" && holdAnalysis) return new Promise<Response>((resolve) => window.setTimeout(() => resolve(new Response(JSON.stringify({ detail: { message: "Synthetic delayed analysis stopped." } }), { status: 422 })), 500));
      return new Response(JSON.stringify({ contract_version: "ci_project_feasibility_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    }
    if (path.endsWith("/tariff-profile")) return new Response(JSON.stringify({ contract_version: "ci_project_tariff_profile_state_v1", status: "not_available", updated_at: null, approved_at: null, profile_sha256: null, profile: null, suggested_profile: null, evidence_basis: null, blockers: [{ code: "tariff_profile_evidence_required", message: "Upload and review bill evidence before approving a tariff profile." }] }), { status: 200 });
    if (path.endsWith("/rebate-profile/stc-settings") && init?.method === "PUT") {
      if (failStcSave) return new Response(JSON.stringify({ detail: { message: "Synthetic STC save failed." } }), { status: 422 });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      applyStcSettings(body);
      return new Response(JSON.stringify(currentRebateState), { status: 200 });
    }
    if (path.endsWith("/rebate-profile")) return new Response(JSON.stringify(currentRebateState), { status: 200 });
    if (path.endsWith("/tariff-replay")) return new Response(JSON.stringify({ contract_version: "ci_project_tariff_replay_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    if (path.endsWith("/annual-financial-comparison")) return new Response(JSON.stringify({ contract_version: "ci_project_annual_financial_state_v1", status: "not_saved", saved_at: null, stale_reasons: [], result: null }), { status: 200 });
    if (path.endsWith("/projects") && init?.method === "POST") return new Response(JSON.stringify({ contract_version: "ci_project_v1", ...project, project_id: "project-new", display_name: JSON.parse(String(init.body)).display_name }), { status: 201 });
    if (path.endsWith("/projects")) return new Response(JSON.stringify({ contract_version: "ci_project_registry_v1", projects }), { status: 200 });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("C&I project workspace", () => {
  it("shows projects on the left and all four analysis modules on top", async () => {
    const fetchMock = mockApi();
    renderPage();
    expect(await screen.findByRole("region", { name: "Evidence sources" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open project Commercial feasibility" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Project workspace" }).className).toContain("lg:sticky");
    expect(screen.getAllByRole("button", { name: "New project" }).length).toBeGreaterThan(0);
    for (const label of ["Evidence", "Solution Generator", "Scenario Analysis", "Finance Analysis"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /Comparison/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Open project calculation Handbook" })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/calculation-handbook"))).toBe(false);
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
    expect(await screen.findByText("Solution profile library")).toBeTruthy();
    expect(screen.getByText("Generic crystalline PV screening profile")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Equipment & finance" }));
    expect(await screen.findByRole("heading", { name: "Equipment & finance" })).toBeTruthy();
    expect((screen.getByLabelText("Per kWp DC capital") as HTMLInputElement).value).toBe("530");
    expect((screen.getByLabelText("210 kWh capital") as HTMLInputElement).value).toBe("77578");
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
    expect(screen.getByRole("heading", { name: "Configure solutions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous: Evidence" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next: Scenario Analysis" })).toBeTruthy();
  });

  it("resets the generator form when switching projects", async () => {
    const user = userEvent.setup();
    const first = { ...project, setup_status: "ready", project_id: "project-1" };
    const second = { ...project, setup_status: "ready", project_id: "project-2", display_name: "Warehouse two" };
    mockApi([first, second]);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    const firstPvMinimum = screen.getAllByRole("spinbutton", { name: "Minimum" })[0] as HTMLInputElement;
    await user.clear(firstPvMinimum);
    await user.type(firstPvMinimum, "321");
    expect(firstPvMinimum.value).toBe("321");

    await user.click(screen.getByRole("button", { name: "Open project Warehouse two" }));
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    expect((screen.getAllByRole("spinbutton", { name: "Minimum" })[0] as HTMLInputElement).value).toBe("100");
  });

  it("keeps later templates accessible when Dispatch prerequisites are missing", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    expect(await screen.findByRole("heading", { name: "Dispatch" })).toBeTruthy();
    expect(screen.getByText(/Generate and save the PV and battery solution space/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Finance Analysis" }));
    expect(await screen.findByRole("heading", { name: "Annual bill reconstruction" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tariff replay needs project inputs" })).toBeTruthy();
    expect(screen.getByText("Upload and review bill evidence before approving a tariff profile.")).toBeTruthy();
    expect(screen.getByText("365 consecutive-day annual interval")).toBeTruthy();
    expect(screen.getByText("Upload at least 365 consecutive complete days of interval data.")).toBeTruthy();
    const runButton = screen.getByRole("button", { name: "Start analysis" });
    expect(runButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Review tariff profile in Evidence" })).toBeTruthy();
    expect(screen.getByText("No rebate programs selected; Finance will use $0 upfront rebates.")).toBeTruthy();

    expect(screen.getByRole("button", { name: "Previous: Scenario Analysis" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next:/ })).toBeNull();
  });

  it("keeps Finance visible but blocks a selected rebate program until its draft is approved", async () => {
    const user = userEvent.setup();
    const enabledProfile = {
      ...rebateProfileFixture,
      programs: {
        ...rebateProfileFixture.programs,
        solar_stc: { ...rebateProfileFixture.programs.solar_stc, enabled: true },
      },
    };
    mockApi([project], null, {
      ...rebateStateFixture,
      status: "draft",
      updated_at: "2026-09-02T00:00:00Z",
      profile_sha256: "a".repeat(64),
      profile: enabledProfile,
      suggested_profile: enabledProfile,
      blockers: [{ code: "solar_stc_price_source_required", message: "Solar STCs require a current price and source before approval." }],
    });
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Finance Analysis" }));
    expect(await screen.findByText("Solar STCs require a current price and source before approval.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review rebates in Solution Generator" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start analysis" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not default Dispatch to every generated solution without a saved selection", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    expect(await screen.findByRole("heading", { name: "Scenario dispatch analysis" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select solutions in Solution Generator" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("heading", { name: "Select solutions before analysis" })).toBeTruthy();
    expect(screen.queryByText("Solution 1")).toBeNull();
    expect(screen.queryByText("Solution 2")).toBeNull();
  });

  it("keeps saved module data cached while navigating without an explicit action", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    const designReads = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-candidates") && !init?.method).length;
    const priceReads = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-price-preview") && !init?.method).length;

    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    await screen.findByRole("heading", { name: "Scenario dispatch analysis" });
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });

    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-candidates") && !init?.method)).toHaveLength(designReads);
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-price-preview") && !init?.method)).toHaveLength(priceReads);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("restores solution selections and quotations after module navigation and refresh", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign);
    const firstRender = renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });

    await user.click(screen.getByLabelText("Select Solution 2"));
    const quote = screen.getByLabelText("Quoted Net CAPEX for Solution 1") as HTMLInputElement;
    await user.clear(quote);
    await user.type(quote, "123456");
    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    await screen.findByRole("heading", { name: "Scenario dispatch analysis" });
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    expect((screen.getByLabelText("Select Solution 2") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Quoted Net CAPEX for Solution 1") as HTMLInputElement).value).toBe("123456");

    firstRender.unmount();
    renderPage();
    await screen.findByRole("heading", { name: "Solutions" });
    expect((screen.getByLabelText("Select Solution 2") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Quoted Net CAPEX for Solution 1") as HTMLInputElement).value).toBe("123456");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("lists every feasible Net CAPEX quotation after STC settings", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    const rebateHeading = await screen.findByRole("heading", { name: "STC" });
    const quoteHeading = screen.getByRole("heading", { name: "Solutions" });
    expect(screen.getByLabelText("Solution generation summary").textContent).toBe("2 configured combinations·2 feasible");
    expect(screen.queryByRole("heading", { name: "Solution preview & quotations" })).toBeNull();
    expect(screen.getByText("2 / 2 selected")).toBeTruthy();
    expect((screen.getByLabelText("Quoted Net CAPEX for Solution 1") as HTMLInputElement).value).toBe("90000");
    expect((screen.getByLabelText("Quoted Net CAPEX for Solution 2") as HTMLInputElement).value).toBe("100000");
    await user.click(screen.getByRole("button", { name: "Add custom solution" }));
    expect(screen.getByRole("heading", { name: "Custom solution & quotation" })).toBeTruthy();
    expect(screen.getByLabelText("Custom solution name")).toBeTruthy();
    expect(screen.getByLabelText("PV capacity")).toBeTruthy();
    expect(screen.getByLabelText("Battery capacity")).toBeTruthy();
    expect(screen.getByLabelText("PCS capacity")).toBeTruthy();
    expect(screen.getByLabelText("Quoted Net CAPEX")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to comparison" })).toBeTruthy();
    await user.type(screen.getByLabelText("Custom solution name"), "Client option A");
    await user.type(screen.getByLabelText("PV capacity"), "120");
    await user.type(screen.getByLabelText("Battery capacity"), "200");
    await user.type(screen.getByLabelText("PCS capacity"), "110");
    await user.type(screen.getByLabelText("Quoted Net CAPEX"), "245000");
    await user.click(screen.getByRole("button", { name: "Add to comparison" }));
    expect(await screen.findByText("3 / 3 selected")).toBeTruthy();
    expect(screen.getByText("Client option A")).toBeTruthy();
    expect((screen.getByLabelText("Quoted Net CAPEX for Solution 3") as HTMLInputElement).value).toBe("245000");
    await user.click(screen.getByRole("button", { name: "Add custom solution" }));
    await user.type(screen.getByLabelText("Custom solution name"), "Above headroom");
    await user.type(screen.getByLabelText("PV capacity"), "141");
    await user.type(screen.getByLabelText("Battery capacity"), "390");
    await user.type(screen.getByLabelText("PCS capacity"), "290");
    await user.type(screen.getByLabelText("Quoted Net CAPEX"), "290000");
    await user.click(screen.getByRole("button", { name: "Add to comparison" }));
    expect(await screen.findByText(/290 kW AC, above the current 250 kW AC Site AC headroom/)).toBeTruthy();
    expect(screen.getByText("3 / 3 selected")).toBeTruthy();
    expect(Boolean(rebateHeading.compareDocumentPosition(quoteHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await user.clear(screen.getByLabelText("Quoted Net CAPEX for Solution 2"));
    await user.type(screen.getByLabelText("Quoted Net CAPEX for Solution 2"), "123456");
    expect((screen.getByLabelText("Quoted Net CAPEX for Solution 2") as HTMLInputElement).value).toBe("123456");
    expect(screen.getByRole("button", { name: "Analysis" }).hasAttribute("disabled")).toBe(false);
    await user.click(screen.getByLabelText("Select Solution 2"));
    expect(screen.getByText("2 / 3 selected")).toBeTruthy();
    await user.click(screen.getByLabelText("Select all solutions"));
    expect(screen.getByText("3 / 3 selected")).toBeTruthy();
    await user.click(screen.getByLabelText("Select all solutions"));
    expect(screen.getByText("0 / 3 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analysis" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByLabelText("Select all solutions"));
    expect(screen.getByText("3 / 3 selected")).toBeTruthy();
  });

  it("disables custom additions when the 200-solution limit is reached", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 200 } as const;
    const cappedCandidates = Array.from({ length: 200 }, (_, index) => ({
      ...generatedDesign.candidates[index % generatedDesign.candidates.length],
      scenario_id: `capped-solution-${index + 1}`,
      label: `Capped solution ${index + 1}`,
    }));
    const cappedDesign = {
      ...generatedDesign,
      candidate_count: 200,
      candidates: cappedCandidates,
      generation_summary: {
        ...generatedDesign.generation_summary,
        requested_count: 200,
        generated_candidate_count: 200,
      },
    };
    const fetchMock = mockApi([readyProject], cappedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    const addCustom = await screen.findByRole("button", { name: "Add custom solution" }, { timeout: 5_000 });
    expect(addCustom.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Maximum 200 solutions reached.");
    await user.click(addCustom);
    expect(screen.queryByRole("heading", { name: "Custom solution & quotation" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-candidates/custom") && init?.method === "POST")).toHaveLength(0);
  });

  it("keeps an approved enabled STC profile price-ready after adding a custom solution", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign, approvedSolarStcState);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByText("2 / 2 selected");
    await user.click(screen.getByRole("button", { name: "Add custom solution" }));
    await user.type(screen.getByLabelText("Custom solution name"), "STC-bound option");
    await user.type(screen.getByLabelText("PV capacity"), "120");
    await user.type(screen.getByLabelText("Battery capacity"), "200");
    await user.type(screen.getByLabelText("PCS capacity"), "110");
    await user.type(screen.getByLabelText("Quoted Net CAPEX"), "245000");
    await user.click(screen.getByRole("button", { name: "Add to comparison" }));

    expect(await screen.findByText("3 / 3 selected")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Net CAPEX is not ready" })).toBeNull();
    expect(screen.getByLabelText("Solution generation summary").textContent).toContain("+1 custom solution=3 solutions");
    const customSave = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/design-candidates/custom") && init?.method === "POST");
    expect(JSON.parse(String(customSave?.[1]?.body)).stc_settings).toEqual({
      solar_stc_enabled: true,
      solar_stc_price_aud_ex_gst: 39,
      battery_stc_enabled: false,
      battery_stc_price_aud_ex_gst: 39,
    });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/rebate-profile") && !init?.method)).toHaveLength(2));
  });

  it("restores model quotes and default selections after regenerating the same solutions", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    await user.click(screen.getByLabelText("Select Solution 2"));
    const editedQuote = screen.getByLabelText("Quoted Net CAPEX for Solution 1") as HTMLInputElement;
    await user.clear(editedQuote);
    await user.type(editedQuote, "123456");
    await user.click(screen.getByRole("button", { name: /Save configuration & generate/ }));

    await waitFor(() => {
      expect((screen.getByLabelText("Quoted Net CAPEX for Solution 1") as HTMLInputElement).value).toBe("90000");
      expect((screen.getByLabelText("Quoted Net CAPEX for Solution 2") as HTMLInputElement).value).toBe("100000");
      expect(screen.getByText("2 / 2 selected")).toBeTruthy();
    });
  });

  it("replaces the solution list with the result generated from the latest configuration", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const regeneratedDesign = {
      ...generatedDesign,
      candidate_count: 1,
      candidates: [{ scenario_id: "pv-new__battery-none", label: "Latest configuration", pv_capacity_kwp_dc: 120, nominal_capacity_kwh: 0, pv_inverter_capacity_kw_ac: 110, max_discharge_kw: 0 }],
      generation_summary: { requested_count: 1, deduplicated_count: 0, rejected_count: 0, generated_candidate_count: 1, rejection_reasons: [] },
    };
    const fetchMock = mockApi([readyProject], generatedDesign, rebateStateFixture, false, false, regeneratedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByText("2 / 2 selected");
    const minimums = screen.getAllByRole("spinbutton", { name: "Minimum" });
    await user.clear(minimums[0]);
    await user.type(minimums[0], "120");
    await user.click(screen.getByRole("button", { name: "Save configuration & generate solutions" }));

    expect(await screen.findByText("1 / 1 selected")).toBeTruthy();
    expect(screen.getAllByText("120 kWp").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Select Solution 2")).toBeNull();
    const designSave = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/design-candidates") && init?.method === "POST");
    expect(JSON.parse(String(designSave?.[1]?.body)).generation_request.pv_range.minimum_kwp_dc).toBe(120);
  });

  it("saves the current STC settings atomically with generated solutions", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "STC" });
    await user.click(screen.getByLabelText("Include Solar STCs"));
    await user.click(screen.getByRole("button", { name: /Save configuration & generate/ }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/design-candidates") && init?.method === "POST")).toBe(true));
    const designSave = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/design-candidates") && init?.method === "POST");
    expect(designSave).toBeTruthy();
    expect(JSON.parse(String(designSave?.[1]?.body)).stc_settings).toEqual({
      solar_stc_enabled: true,
      solar_stc_price_aud_ex_gst: 39,
      battery_stc_enabled: false,
      battery_stc_price_aud_ex_gst: 39,
    });
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/rebate-profile/stc-settings") && init?.method === "PUT")).toHaveLength(0);
  });

  it("keeps the current solutions when the atomic configuration save fails", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign, rebateStateFixture, false, true);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "STC" });
    await user.click(screen.getByLabelText("Include Solar STCs"));
    await user.click(screen.getByRole("button", { name: /Save configuration & generate/ }));

    expect(await screen.findAllByText("Synthetic STC save failed.")).not.toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/rebate-profile/stc-settings") && init?.method === "PUT")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-candidates") && init?.method === "POST")).toHaveLength(1);
    expect(screen.getByText("2 / 2 selected")).toBeTruthy();
  });

  it("runs and remembers only the solutions selected for analysis", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    await user.click(screen.getByLabelText("Select Solution 2"));
    await user.click(screen.getByRole("button", { name: "Analysis" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/design-feasibility") && init?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        scenario_ids: ["pv-1__battery-1"],
        persistence_mode: "merge_checkpoint",
      });
    });
    expect(await screen.findByRole("heading", { name: "Ready to simulate 1 selected solution" })).toBeTruthy();
    expect(screen.queryByText("Solution 2")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Finance Analysis" }));
    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    expect(await screen.findByRole("heading", { name: "Ready to simulate 1 selected solution" })).toBeTruthy();
    expect(screen.queryByText("Solution 2")).toBeNull();
  });

  it("drops queued and remembered prices when the current Net CAPEX revision changes", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi(
      [readyProject],
      generatedDesign,
      rebateStateFixture,
      false,
      false,
      null,
      {
        pricePreview: (readNumber, payload) => new Response(JSON.stringify(
          readNumber === 1 ? payload : { ...payload, design_candidates_sha256: "e".repeat(64) },
        ), { status: 200 }),
      },
    );
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });

    const quote = screen.getByLabelText("Quoted Net CAPEX for Solution 1");
    await user.clear(quote);
    await user.type(quote, "123456");
    await user.click(screen.getByRole("button", { name: "Analysis" }));

    expect(await screen.findByText("The Net CAPEX snapshot changed. Return to Solution Generator and confirm the current quotations.")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-price-preview") && !init?.method)).toHaveLength(2);
    expect(fullAnalysisPosts(fetchMock)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Finance Analysis" }));
    await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
    await screen.findByRole("heading", { name: "Scenario dispatch analysis" });

    expect(screen.queryByRole("button", { name: /Run full analysis/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Select solutions in Solution Generator" }).hasAttribute("disabled")).toBe(true);
    expect(fullAnalysisPosts(fetchMock)).toHaveLength(0);
  });

  it("clears a launch without POSTing when the current Net CAPEX snapshot returns 409", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi(
      [readyProject],
      generatedDesign,
      rebateStateFixture,
      false,
      false,
      null,
      {
        pricePreview: (readNumber, payload) => readNumber === 1
          ? new Response(JSON.stringify(payload), { status: 200 })
          : new Response(JSON.stringify({ detail: { code: "ci_design_price_preview_stale", message: "Equipment, rebate, evidence or solution inputs changed." } }), { status: 409 }),
      },
    );
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    await user.click(screen.getByRole("button", { name: "Analysis" }));

    expect(await screen.findByText("Equipment, rebate, evidence or solution inputs changed.")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-price-preview") && !init?.method)).toHaveLength(2);
    expect(fullAnalysisPosts(fetchMock)).toHaveLength(0);
    expect((await screen.findByRole("button", { name: "Select solutions in Solution Generator" })).hasAttribute("disabled")).toBe(true);
  });

  it("opens Scenario Analysis immediately and displays analysis progress", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    mockApi([readyProject], generatedDesign, rebateStateFixture, true);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    await user.click(screen.getByRole("button", { name: "Analysis" }));

    expect(await screen.findByRole("heading", { name: "Scenario dispatch analysis" })).toBeTruthy();
    expect((await screen.findByRole("progressbar", { name: "Running scenario dispatch (0/2)" })).getAttribute("aria-valuenow")).toBe("12");
    expect(screen.queryByText(/Processing 2 saved solutions/)).toBeNull();
  });

  it("keeps an in-flight full analysis pending across module remounts", async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi(
      [readyProject],
      generatedDesign,
      rebateStateFixture,
      false,
      false,
      null,
      {
        feasibilityPost: async () => {
          await gate.promise;
          return new Response(JSON.stringify({ detail: { message: "Synthetic delayed analysis stopped." } }), { status: 422 });
        },
      },
    );
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });
    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    await user.click(screen.getByRole("button", { name: "Analysis" }));
    await screen.findByRole("progressbar", { name: "Running scenario dispatch (0/2)" });
    await waitFor(() => expect(fullAnalysisPosts(fetchMock)).toHaveLength(1));

    try {
      await user.click(screen.getByRole("button", { name: "Solution Generator" }));
      await screen.findByRole("heading", { name: "Solutions" });
      const generatorButton = screen.getByRole("button", { name: "Analysis running…" });
      expect(generatorButton.hasAttribute("disabled")).toBe(true);
      await user.click(generatorButton);
      expect(fullAnalysisPosts(fetchMock)).toHaveLength(1);

      await user.click(screen.getByRole("button", { name: "Finance Analysis" }));
      const financePendingButton = await screen.findByRole("button", { name: "Analysis running…" });
      expect(financePendingButton.hasAttribute("disabled")).toBe(true);
      await user.click(financePendingButton);
      expect(fullAnalysisPosts(fetchMock)).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Scenario Analysis" }));
      expect(await screen.findByRole("progressbar", { name: "Running scenario dispatch (0/2)" })).toBeTruthy();
      const pendingButton = screen.getByRole("button", { name: "Full analysis running…" });
      expect(pendingButton.hasAttribute("disabled")).toBe(true);
      await user.click(pendingButton);
      expect(fullAnalysisPosts(fetchMock)).toHaveLength(1);
    } finally {
      gate.resolve(undefined);
    }

    expect(await screen.findByText("Synthetic delayed analysis stopped.")).toBeTruthy();
    expect(fullAnalysisPosts(fetchMock)).toHaveLength(1);
  });

  it("can retry the complete analysis after a failed stage", async () => {
    const user = userEvent.setup();
    const readyProject = { ...project, setup_status: "ready", design_status: "ready", current_stage: "system_design", design_candidate_count: 2 } as const;
    const fetchMock = mockApi([readyProject], generatedDesign);
    renderPage();
    await screen.findByRole("region", { name: "Evidence sources" });

    await user.click(screen.getByRole("button", { name: "Solution Generator" }));
    await screen.findByRole("heading", { name: "Solutions" });
    await user.click(screen.getByRole("button", { name: "Analysis" }));

    expect(await screen.findByText("Feasibility analysis returned an unsafe result contract.")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Running scenario dispatch (0/2)" }).getAttribute("aria-valuenow")).toBe("12");
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/design-feasibility") && !init?.method
    )).length).toBeGreaterThanOrEqual(4));
    const retry = screen.getByRole("button", { name: "Run full analysis" });
    await user.click(retry);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/design-feasibility") && init?.method === "POST")).toHaveLength(2));
  });

});

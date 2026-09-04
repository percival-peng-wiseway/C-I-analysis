// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compareFinance: vi.fn(),
  fetchDesign: vi.fn(),
  fetchDeviceProfile: vi.fn(),
  fetchEvidence: vi.fn(),
  fetchFeasibility: vi.fn(),
  fetchFinance: vi.fn(),
  fetchPricePreview: vi.fn(),
  fetchRebateProfile: vi.fn(),
  fetchTariffProfile: vi.fn(),
  fetchTariffReplay: vi.fn(),
  runFeasibility: vi.fn(),
  runTariffReplay: vi.fn(),
}));

vi.mock("@/features/ci/api/ci-calculation-handbook", () => ({
  invalidateCiCalculationHandbook: vi.fn(),
}));
vi.mock("@/features/ci/api/ci-evidence-intake", () => ({
  ciProjectEvidenceQueryKey: (projectId: string) => ["evidence", projectId],
  fetchCiProjectEvidence: mocks.fetchEvidence,
}));
vi.mock("@/features/ci/api/ci-design-feasibility", () => ({
  ciSavedFeasibilityQueryKey: (projectId: string) => ["feasibility", projectId],
  fetchCiSavedFeasibility: mocks.fetchFeasibility,
  runCiDesignFeasibility: mocks.runFeasibility,
}));
vi.mock("@/features/ci/api/ci-projects", () => ({
  ciSavedDesignQueryKey: (projectId: string) => ["design", projectId],
  fetchCiSavedDesign: mocks.fetchDesign,
}));
vi.mock("@/features/ci/api/ci-design-price-preview", () => ({
  ciDesignPricePreviewQueryKey: (projectId: string) => ["price-preview", projectId],
  fetchCiDesignPricePreview: mocks.fetchPricePreview,
}));
vi.mock("@/features/ci/api/ci-scenarios", () => ({
  ciProjectTariffReplayQueryKey: (projectId: string) => ["tariff-replay", projectId],
  fetchCiSavedTariffReplay: mocks.fetchTariffReplay,
  runCiProjectTariffReplay: mocks.runTariffReplay,
}));
vi.mock("@/features/ci/api/ci-annual-financial-comparison", () => ({
  ciAnnualFinancialComparisonQueryKey: (projectId: string) => ["finance", projectId],
  compareCiAnnualFinancialScenarios: mocks.compareFinance,
  fetchCiSavedAnnualFinancialComparison: mocks.fetchFinance,
}));
vi.mock("@/features/ci/api/ci-device-profile", () => ({
  ciDeviceProfileQueryKey: ["device-profile"],
  fetchCiDeviceProfile: mocks.fetchDeviceProfile,
}));
vi.mock("@/features/ci/api/ci-tariff-profile", () => ({
  ciProjectTariffProfileQueryKey: (projectId: string) => ["tariff-profile", projectId],
  fetchCiProjectTariffProfile: mocks.fetchTariffProfile,
}));
vi.mock("@/features/ci/api/ci-rebate-profile", () => ({
  ciProjectRebateProfileQueryKey: (projectId: string) => ["rebate-profile", projectId],
  fetchCiProjectRebateProfile: mocks.fetchRebateProfile,
}));
vi.mock("@/features/ci/ci-annual-financial-workspace", () => ({
  CiPortfolioReturnChart: () => null,
}));

import { createCiQueryClient } from "./ci-query-client";
import { ciDesignPricePreviewRevision, saveCiSolutionWorkspaceDraft } from "./ci-solution-workspace-storage";
import { CiTariffReplay } from "./ci-tariff-replay";

const project = {
  project_id: "project-1",
  display_name: "Test project",
  current_stage: "system_design",
  setup_status: "ready",
  design_status: "ready",
  design_candidate_count: 2,
  created_at: "2026-09-04T00:00:00Z",
  updated_at: "2026-09-04T00:00:00Z",
} as const;

const design = {
  candidate_count: 2,
  candidates: [
    { scenario_id: "case-1", label: "Case 1" },
    { scenario_id: "case-2", label: "Case 2" },
  ],
};

const pricePreview = {
  design_candidates_sha256: "b".repeat(64),
  device_profile_sha256: "a".repeat(64),
  rebate_profile_sha256: null,
  solutions: [
    { scenario_id: "case-1", net_capex_aud_ex_gst: 200000 },
    { scenario_id: "case-2", net_capex_aud_ex_gst: 210000 },
  ],
};

const notSavedFeasibility = {
  contract_version: "ci_project_feasibility_state_v1",
  status: "not_saved",
  saved_at: null,
  stale_reasons: [],
  result: null,
};

const notSavedTariffReplay = {
  contract_version: "ci_project_tariff_replay_state_v1",
  status: "not_saved",
  saved_at: null,
  stale_reasons: [],
  result: null,
};

const notSavedFinance = {
  contract_version: "ci_project_annual_financial_state_v1",
  status: "not_saved",
  saved_at: null,
  stale_reasons: [],
  result: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, reject, resolve };
}

function renderReplay(client = createCiQueryClient(), onConfigureTariff = vi.fn()) {
  return {
    client,
    onConfigureTariff,
    ...render(
      <QueryClientProvider client={client}>
        <CiTariffReplay onConfigureRebates={vi.fn()} onConfigureTariff={onConfigureTariff} project={project as never} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchEvidence.mockResolvedValue({
    status: "ready",
    evidence: {
      inspection: {
        bill: { review_status: "analyst_confirmed", network_tariff_code: "LLVT" },
        nem12: { full_tariff_analysis_ready: true },
        annual_bill_estimate: { status: "estimated", coverage_start: "2025-01-01", coverage_end: "2025-12-31" },
      },
    },
  });
  mocks.fetchDesign.mockResolvedValue(design);
  mocks.fetchPricePreview.mockResolvedValue(pricePreview);
  mocks.fetchFeasibility.mockResolvedValue(notSavedFeasibility);
  mocks.fetchTariffReplay.mockResolvedValue(notSavedTariffReplay);
  mocks.fetchFinance.mockResolvedValue(notSavedFinance);
  mocks.fetchDeviceProfile.mockResolvedValue({
    status: "ready",
    profile_sha256: "a".repeat(64),
    profile: {
      default_equipment_selection: {
        pv_product_id: "pv-one",
        battery_product_id: "battery-one",
        inverter_product_id: "inverter-one",
      },
      equipment_catalog: {
        pv_products: [
          { product_id: "pv-one", manufacturer: "PV", model: "One", capital_cost_aud_per_kwp_dc: 500 },
          { product_id: "pv-two", manufacturer: "PV", model: "Two", capital_cost_aud_per_kwp_dc: 550 },
        ],
        battery_products: [{ product_id: "battery-one", manufacturer: "Battery", model: "One" }],
        inverter_products: [{ product_id: "inverter-one", manufacturer: "PCS", model: "One" }],
      },
    },
  });
  mocks.fetchTariffProfile.mockResolvedValue({
    status: "approved",
    profile: { display_label: "Approved tariff" },
    suggested_profile: null,
    blockers: [],
  });
  mocks.fetchRebateProfile.mockResolvedValue({
    status: "not_configured",
    profile: null,
    suggested_profile: { programs: { solar_stc: { enabled: false }, battery_stc: { enabled: false }, vic_deemed_veec: { enabled: false } } },
    blockers: [],
  });
  mocks.runTariffReplay.mockResolvedValue(null);
  mocks.compareFinance.mockResolvedValue(null);
  saveCiSolutionWorkspaceDraft(project.project_id, {
    previewRevision: ciDesignPricePreviewRevision(pricePreview as never),
    quotedNetCapex: { "case-1": "200000", "case-2": "210000" },
    selectedSolutions: { "case-1": true, "case-2": true },
  });
});

afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe("Finance analysis runner", () => {
  it("explains zero kVA demand-rate impact when a saved solution has battery or reactive control", async () => {
    const user = userEvent.setup();
    const onConfigureTariff = vi.fn();
    mocks.fetchDesign.mockResolvedValue({
      ...design,
      candidates: design.candidates.map((candidate, index) => ({
        ...candidate,
        reactive_support_enabled: index === 0,
        reactive_support_max_kvar: index === 0 ? 82.5 : 0,
      })),
    });
    mocks.fetchTariffProfile.mockResolvedValue({
      status: "approved",
      profile: {
        display_label: "Approved zero-demand tariff",
        rates: {
          rolling_demand_aud_per_kva_month: 0,
          incentive_demand_aud_per_kva_month: 0,
        },
      },
      suggested_profile: null,
      blockers: [],
    });

    renderReplay(createCiQueryClient(), onConfigureTariff);

    const notice = await screen.findByRole("region", { name: "Demand optimisation tariff impact" });
    expect(notice.textContent).toContain("technical Scenario Analysis may still show a battery peak-shaving plateau");
    expect(notice.textContent).toContain("neither effect changes the modelled bill or NPV");
    await user.click(screen.getByRole("button", { name: "Review demand rates in Evidence" }));
    expect(onConfigureTariff).toHaveBeenCalledTimes(1);
  });

  it("does not show the zero demand-rate warning for PV-only solutions without reactive support", async () => {
    mocks.fetchDesign.mockResolvedValue({
      ...design,
      candidates: design.candidates.map((candidate) => ({
        ...candidate,
        nominal_capacity_kwh: 0,
        reactive_support_enabled: false,
        reactive_support_max_kvar: 0,
      })),
    });
    mocks.fetchTariffProfile.mockResolvedValue({
      status: "approved",
      profile: {
        display_label: "Approved zero-demand tariff",
        rates: {
          rolling_demand_aud_per_kva_month: 0,
          incentive_demand_aud_per_kva_month: 0,
        },
      },
      suggested_profile: null,
      blockers: [],
    });

    renderReplay();

    await screen.findByRole("button", { name: "Start analysis" });
    expect(screen.queryByRole("region", { name: "Demand optimisation tariff impact" })).toBeNull();
  });

  it("runs only the Solution Generator selection when Finance has no prior result", async () => {
    const user = userEvent.setup();
    saveCiSolutionWorkspaceDraft(project.project_id, {
      previewRevision: ciDesignPricePreviewRevision(pricePreview as never),
      quotedNetCapex: { "case-1": "200000", "case-2": "210000" },
      selectedSolutions: { "case-1": true, "case-2": false },
    });
    mocks.runFeasibility.mockResolvedValue({});
    mocks.runTariffReplay.mockResolvedValue({});
    mocks.compareFinance.mockResolvedValue(null);
    renderReplay();

    const start = await screen.findByRole("button", { name: "Start analysis" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await user.click(start);

    await waitFor(() => expect(mocks.compareFinance).toHaveBeenCalledTimes(1));
    expect(mocks.runFeasibility.mock.calls[0]?.[3]).toEqual(["case-1"]);
    expect(mocks.runTariffReplay.mock.calls[0]?.[3]).toEqual(["case-1"]);
    expect(mocks.compareFinance).toHaveBeenCalledWith({
      projectId: "project-1",
      pricingMode: "manual_quotes",
      prices: [{ scenarioId: "case-1", upfrontCostAudExGst: 200000 }],
    });
  });

  it("does not default to all designs when no solution selection is saved", async () => {
    window.sessionStorage.clear();
    renderReplay();

    const start = await screen.findByRole("button", { name: "Start analysis" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(true));
    expect(screen.getAllByText(/Return to Solution Generator, select the solutions to analyse/).length).toBeGreaterThan(0);
    expect(mocks.runFeasibility).not.toHaveBeenCalled();
    expect(mocks.runTariffReplay).not.toHaveBeenCalled();
    expect(mocks.compareFinance).not.toHaveBeenCalled();
  });

  it("keeps the shared analysis lock after Finance unmounts and disables equipment inputs", async () => {
    const user = userEvent.setup();
    const gate = deferred<never>();
    mocks.runFeasibility.mockImplementation((_projectId, _fetcher, _signal, scenarioIds, options) => {
      options?.onProgress?.({ completedScenarioCount: 0, totalScenarioCount: scenarioIds.length });
      return gate.promise;
    });
    const first = renderReplay();
    const start = await screen.findByRole("button", { name: "Start analysis" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await user.click(start);

    const pending = await screen.findByRole("button", { name: "Analysis running…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("combobox", { name: "PV" }) as HTMLSelectElement).disabled).toBe(true);

    const client = first.client;
    first.unmount();
    const second = renderReplay(client);
    const restoredPending = await screen.findByRole("button", { name: "Analysis running…" });
    expect(restoredPending.hasAttribute("disabled")).toBe(true);
    await user.click(restoredPending);
    expect(mocks.runFeasibility).toHaveBeenCalledTimes(1);

    second.unmount();
    gate.reject(new Error("Synthetic stop."));
    await Promise.resolve();
  });

  it("removes an older Finance result before caching a replacement tariff replay", async () => {
    const user = userEvent.setup();
    const financeGate = deferred<never>();
    const previousFinance = {
      contract_version: "ci_project_annual_financial_state_v1",
      status: "ready",
      saved_at: "2026-09-04T00:00:00Z",
      stale_reasons: [],
      result: {
        assumptions: { price_source: "analyst_entered_total_solution_price" },
        solutions: [
          { scenario_id: "case-1", upfront_cost_aud_ex_gst: 200000 },
          { scenario_id: "case-2", upfront_cost_aud_ex_gst: 210000 },
        ],
      },
    };
    mocks.fetchFinance.mockResolvedValue(previousFinance);
    mocks.runFeasibility.mockResolvedValue({});
    mocks.runTariffReplay.mockResolvedValue({
      scenarios: [{ scenario_id: "case-1", authored_inputs: { reactive_support_enabled: false } }],
    });
    mocks.compareFinance.mockReturnValue(financeGate.promise);
    const view = renderReplay();

    const start = await screen.findByRole("button", { name: "Start analysis" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await user.click(start);
    await waitFor(() => expect(mocks.compareFinance).toHaveBeenCalledTimes(1));

    expect(view.client.getQueryData(["finance", "project-1"])).toEqual(notSavedFinance);
    expect(view.client.getQueryData(["tariff-replay", "project-1"])).toMatchObject({
      status: "ready",
      result: { scenarios: [{ scenario_id: "case-1", authored_inputs: { reactive_support_enabled: false } }] },
    });

    view.unmount();
    financeGate.reject(new Error("Synthetic stop."));
    await Promise.resolve();
  });

  it("keeps checkpoint progress visible after failure and refreshes persisted checkpoint queries", async () => {
    const user = userEvent.setup();
    mocks.runFeasibility.mockImplementation(async (_projectId, _fetcher, _signal, _scenarioIds, options) => {
      options?.onProgress?.({ completedScenarioCount: 1, totalScenarioCount: 2 });
      throw new Error("Synthetic batch failure.");
    });
    renderReplay();
    const start = await screen.findByRole("button", { name: "Start analysis" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await user.click(start);

    expect((await screen.findByRole("alert")).textContent).toContain("Synthetic batch failure.");
    expect(screen.getByRole("progressbar", { name: "Running scenario dispatch (1/2)" }).getAttribute("aria-valuenow")).toBe("32");
    expect(screen.getByText("Completed checkpoints are saved. Run Analysis again to resume the remaining solutions.")).toBeTruthy();
    await waitFor(() => {
      expect(mocks.fetchFeasibility.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.fetchTariffReplay.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.fetchFinance.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("clears a completed progress state when equipment selection changes", async () => {
    const user = userEvent.setup();
    mocks.runFeasibility.mockImplementation(async (_projectId, _fetcher, _signal, scenarioIds, options) => {
      options?.onProgress?.({ completedScenarioCount: scenarioIds.length, totalScenarioCount: scenarioIds.length });
      return {};
    });
    mocks.runTariffReplay.mockImplementation(async (_projectId, _fetcher, _signal, scenarioIds, options) => {
      options?.onProgress?.({ completedScenarioCount: scenarioIds.length, totalScenarioCount: scenarioIds.length });
      return null;
    });
    renderReplay();
    const start = await screen.findByRole("button", { name: "Start analysis" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await user.click(start);

    expect(await screen.findByRole("progressbar", { name: "Analysis complete" })).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "PV" }), "pv-two");
    expect(screen.queryByRole("progressbar", { name: "Analysis complete" })).toBeNull();
  });
});

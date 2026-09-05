// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compareFinance: vi.fn(), fetchFinance: vi.fn(), fetchDevice: vi.fn(),
  runFeasibility: vi.fn(), runTariff: vi.fn(),
  snapshot: { scenarioIds: ["case-1"], prices: [{ scenarioId: "case-1", upfrontCostAudExGst: 200000 }] },
}));

vi.mock("./ci-workspace-context", () => ({
  useCiWorkspace: () => ({ activeProject: { projectId: "project-1" }, stage: "dispatch", setStage: vi.fn() }),
}));
vi.mock("./api/ci-workspace-readiness", () => ({
  ciWorkspaceReadinessQueryKey: ["readiness"], fetchCiWorkspaceReadiness: async () => ({}),
}));
vi.mock("./api/ci-projects", () => ({
  ciProjectsQueryKey: ["projects"], ciSavedDesignQueryKey: (id: string) => ["design", id],
  listCiProjects: async () => [{ project_id: "project-1", display_name: "Test project", design_status: "ready" }],
  fetchCiSavedDesign: async () => ({ candidates: [{ scenario_id: "case-1", pv_capacity_kwp_dc: 100, nominal_capacity_kwh: 200, pv_inverter_capacity_kw_ac: 100 }] }),
}));
vi.mock("./api/ci-design-price-preview", () => ({
  ciDesignPricePreviewQueryKey: (id: string) => ["prices", id], fetchCiDesignPricePreview: async () => ({}),
}));
vi.mock("./api/ci-design-feasibility", () => ({
  ciSavedFeasibilityQueryKey: (id: string) => ["feasibility", id],
  fetchCiSavedFeasibility: async () => ({ status: "not_saved", result: null }),
  runCiDesignFeasibility: mocks.runFeasibility,
}));
vi.mock("./api/ci-scenarios", () => ({
  ciProjectTariffReplayQueryKey: (id: string) => ["tariff", id],
  fetchCiSavedTariffReplay: async () => ({ status: "not_saved", result: null }),
  runCiProjectTariffReplay: mocks.runTariff,
}));
vi.mock("./api/ci-annual-financial-comparison", () => ({
  ciAnnualFinancialComparisonQueryKey: (id: string) => ["finance", id],
  fetchCiSavedAnnualFinancialComparison: mocks.fetchFinance,
  compareCiAnnualFinancialScenarios: mocks.compareFinance,
}));
vi.mock("./api/ci-device-profile", () => ({
  ciDeviceProfileQueryKey: ["device"], fetchCiDeviceProfile: mocks.fetchDevice,
}));
vi.mock("./api/ci-calculation-handbook", () => ({ invalidateCiCalculationHandbook: vi.fn() }));
vi.mock("./ci-solution-workspace-storage", () => ({
  ciAnalysisPriceSnapshotMatchesPreview: () => true,
  restoreCiAnalysisPriceSnapshot: () => mocks.snapshot,
}));
vi.mock("./ci-design-feasibility", () => ({ CiDesignFeasibility: () => null }));
vi.mock("./ci-tariff-replay", () => ({
  CI_ANALYSIS_MUTATION_KEY: ["analysis"], formatCiTariffReplayProgressLabel: () => "Tariff replay",
}));
// These unrelated editing panels are not part of this one-click workflow test.
vi.mock("./ci-evidence-intake", () => ({ CiEvidenceIntake: () => null }));
vi.mock("./ci-rebate-profile-panel", () => ({ CiRebateProfilePanel: () => null }));
vi.mock("./ci-scenario-builder", () => ({ CiScenarioBuilder: () => null }));

import { createCiQueryClient } from "./ci-query-client";
import { CiReadinessPage } from "./ci-readiness-page";

const defaults = {
  discount_rate: 0.09, annual_value_escalation_rate: 0.04,
  annual_value_degradation_rate: 0.01, annual_om_fraction_of_capex: 0.025,
  analysis_term_years: 12,
};
const saved = { ...defaults, discount_rate: 0.06, analysis_term_years: 20, replacement_events_aud: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchFinance.mockResolvedValue({ status: "not_saved", result: null });
  mocks.fetchDevice.mockResolvedValue({ status: "ready", profile: defaults });
  mocks.runFeasibility.mockResolvedValue({ scenarios: [{ scenario_id: "case-1" }] });
  mocks.runTariff.mockResolvedValue({ scenarios: [{ scenario_id: "case-1" }] });
  mocks.compareFinance.mockRejectedValue(new Error("Synthetic stop after finance request"));
});
afterEach(cleanup);

it.each([false, true])("forwards the correct explicit finance basis through full analysis (saved=%s)", async (hasSaved) => {
  if (hasSaved) mocks.fetchFinance.mockResolvedValue({ status: "ready", result: { assumptions: saved } });
  const user = userEvent.setup();
  render(<QueryClientProvider client={createCiQueryClient()}><CiReadinessPage /></QueryClientProvider>);
  await user.click(await screen.findByRole("button", { name: "Run full analysis" }));
  await waitFor(() => expect(mocks.compareFinance).toHaveBeenCalledOnce());
  expect(mocks.compareFinance).toHaveBeenCalledWith({
    projectId: "project-1", pricingMode: "manual_quotes", prices: mocks.snapshot.prices,
    assumptions: {
      discountRate: hasSaved ? 0.06 : 0.09,
      annualValueEscalationRate: 0.04, annualValueDegradationRate: 0.01,
      annualOmFractionOfCapex: 0.025, analysisTermYears: hasSaved ? 20 : 12,
    },
  });
  expect(mocks.fetchFinance.mock.invocationCallOrder[0]).toBeLessThan(mocks.runTariff.mock.invocationCallOrder[0]);
  expect(mocks.runFeasibility.mock.calls[0][3]).toEqual(["case-1"]);
  expect(mocks.runTariff.mock.calls[0][3]).toEqual(["case-1"]);
  expect(await screen.findByText("Synthetic stop after finance request")).toBeTruthy();
});

it("requires a configured finance basis before starting any expensive dispatch", async () => {
  mocks.fetchDevice.mockResolvedValue({ status: "not_configured", profile: null });
  const user = userEvent.setup();
  render(<QueryClientProvider client={createCiQueryClient()}><CiReadinessPage /></QueryClientProvider>);
  await user.click(await screen.findByRole("button", { name: "Run full analysis" }));
  expect(await screen.findByText("Save finance defaults in Settings before running financial analysis.")).toBeTruthy();
  expect(mocks.runFeasibility).not.toHaveBeenCalled();
  expect(mocks.runTariff).not.toHaveBeenCalled();
  expect(mocks.compareFinance).not.toHaveBeenCalled();
});

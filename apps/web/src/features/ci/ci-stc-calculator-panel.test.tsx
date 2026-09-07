// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CiStcCalculatorPanel } from "./ci-stc-calculator-panel";
import type { StcCalculatorInput, StcCalculatorState } from "./api/ci-stc-calculator";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("calculates and saves independently, collapses, hides stale totals and restores the worksheet", async () => {
  let stored: StcCalculatorState = { contract_version: "ci_stc_calculator_state_v3", project_id: "project-1", draft_inputs: null, legacy_capacity_reset: false, requires_recalculation: false, estimate: null };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const inputs = JSON.parse(String(init.body)) as StcCalculatorInput;
      stored = { ...stored, draft_inputs: inputs, estimate: { contract_version: "ci_stc_manual_estimate_v3", inputs,
        solar_deeming_years: 6, solar_zone_factor: 1.185,
        solar_calculated_quantity: 995.4, battery_calculated_quantity: 174,
        solar_rebate_aud: 38820.6, battery_rebate_aud: 6786, total_rebate_aud: 45606.6,
        applied_to_solutions: false, applied_to_finance: false, customer_facing_permission: false } };
    }
    return new Response(JSON.stringify(stored));
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidations = vi.spyOn(client, "invalidateQueries");
  const submit = vi.fn(e => e.preventDefault());
  const view = render(<QueryClientProvider client={client}><form onSubmit={submit}><CiStcCalculatorPanel projectId="project-1" /></form></QueryClientProvider>);
  const user = userEvent.setup();
  await screen.findByLabelText("Solar installation year");
  await user.selectOptions(screen.getByLabelText("Solar installation year"), "2025");
  await user.selectOptions(screen.getByLabelText("Solar zone"), "4");
  await user.type(screen.getByLabelText("PV capacity (kWp)"), "140");
  expect(screen.getByLabelText("Battery STC count (certificates)")).toHaveProperty("value", "174");
  expect(screen.queryByLabelText("Battery usable capacity (kWh)")).toBeNull();
  expect(screen.queryByLabelText("Battery installation period")).toBeNull();
  expect(screen.getByText("STC count × price")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Calculate & save STC estimate" }));
  expect(await screen.findByText("Solar rebate: $38,820.60")).toBeTruthy();
  expect(screen.getByText("Battery rebate: $6,786.00")).toBeTruthy();
  expect(screen.getByText("174 × 39")).toBeTruthy();
  expect(screen.getByText("Saved total rebate estimate: $45,606.60")).toBeTruthy();
  const request = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body));
  expect(request).toEqual({ solar_installation_year: 2025, solar_zone: 4, pv_capacity_kwp: 140,
    solar_certificate_price: 39, battery_stc_count: 174, battery_certificate_price: 39 });
  expect(invalidations).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.every(([url]) => url.endsWith("/stc-calculator"))).toBe(true);
  const summary = screen.getByText(/^STC calculator/);
  await user.click(summary);
  expect(summary.closest("details")?.open).toBe(false);
  await user.click(summary);
  fireEvent.change(screen.getByLabelText("PV capacity (kWp)"), { target: { value: "141" } });
  expect(screen.queryByText("Solar rebate: $38,820.60")).toBeNull();
  fireEvent.change(screen.getByLabelText("PV capacity (kWp)"), { target: { value: "-1" } });
  expect(screen.getByRole("button", { name: "Calculate & save STC estimate" })).toHaveProperty("disabled", true);
  // Independent inputs must not participate in the enclosing generation form's validation.
  expect((screen.getByLabelText("PV capacity (kWp)") as HTMLInputElement).form).toBeNull();
  view.unmount();
  render(<QueryClientProvider client={new QueryClient()}><CiStcCalculatorPanel projectId="project-1" /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByLabelText("PV capacity (kWp)")).toHaveProperty("value", "140"));
  expect(screen.getByText("Saved total rebate estimate: $45,606.60")).toBeTruthy();
  expect(screen.getByLabelText("Battery STC count (certificates)")).toHaveProperty("value", "174");
});

it("loads legacy worksheets as an editable count draft without showing the old rebate", async () => {
  const draft = { solar_installation_year: 2025, solar_zone: 4, pv_capacity_kwp: 140,
    solar_certificate_price: 39, battery_stc_count: 174, battery_certificate_price: 39 };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ contract_version: "ci_stc_calculator_state_v3", project_id: "legacy", draft_inputs: draft, legacy_capacity_reset: true, requires_recalculation: true, estimate: null }))));
  render(<QueryClientProvider client={new QueryClient()}><CiStcCalculatorPanel projectId="legacy" /></QueryClientProvider>);
  expect(await screen.findByLabelText("Battery STC count (certificates)")).toHaveProperty("value", "174");
  expect(screen.getByLabelText("PV capacity (kWp)")).toHaveProperty("value", "140");
  expect(screen.getByRole("status").textContent).toContain("previous battery capacity was not converted");
  expect(screen.queryByText(/Saved total rebate estimate:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Calculate & save STC estimate" })).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Battery STC count (certificates)"), { target: { value: "200" } });
  expect(screen.getByLabelText("Battery STC count (certificates)")).toHaveProperty("value", "200");
});

it("retains an old factor worksheet's count and price but requires a fresh calculation", async () => {
  const draft = { solar_installation_year: 2025, solar_zone: 4, pv_capacity_kwp: 140,
    solar_certificate_price: 39, battery_stc_count: 200, battery_certificate_price: 40 };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ contract_version: "ci_stc_calculator_state_v3", project_id: "old-factor", draft_inputs: draft, legacy_capacity_reset: false, requires_recalculation: true, estimate: null }))));
  render(<QueryClientProvider client={new QueryClient()}><CiStcCalculatorPanel projectId="old-factor" /></QueryClientProvider>);
  expect(await screen.findByLabelText("Battery STC count (certificates)")).toHaveProperty("value", "200");
  expect(screen.getByLabelText("Battery STC price (AUD / certificate)")).toHaveProperty("value", "40");
  expect(screen.queryByLabelText("Battery installation period")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("without an installation-period factor");
  expect(screen.queryByText(/Battery rebate:/)).toBeNull();
  expect(screen.queryByText(/Saved total rebate estimate:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Calculate & save STC estimate" })).toHaveProperty("disabled", false);
});

it("reports a save failure without displaying an unsaved estimate", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method === "PUT" ? new Response("", { status: 500 }) : new Response(JSON.stringify({ contract_version: "ci_stc_calculator_state_v3", project_id: "project-1", draft_inputs: null, legacy_capacity_reset: false, requires_recalculation: false, estimate: null }))));
  render(<QueryClientProvider client={new QueryClient()}><CiStcCalculatorPanel projectId="project-1" /></QueryClientProvider>);
  await screen.findByLabelText("PV capacity (kWp)");
  fireEvent.change(screen.getByLabelText("PV capacity (kWp)"), { target: { value: "140" } });
  fireEvent.change(screen.getByLabelText("Battery STC count (certificates)"), { target: { value: "0" } });
  await userEvent.click(screen.getByRole("button", { name: "Calculate & save STC estimate" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/Saved total rebate estimate:/)).toBeNull();
});

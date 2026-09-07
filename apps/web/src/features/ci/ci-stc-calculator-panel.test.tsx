// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CiStcCalculatorPanel } from "./ci-stc-calculator-panel";
import type { StcCalculatorInput, StcCalculatorState } from "./api/ci-stc-calculator";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("calculates and saves independently, collapses, hides stale totals and restores the worksheet", async () => {
  let stored: StcCalculatorState = { contract_version: "ci_stc_calculator_state_v1", project_id: "project-1", estimate: null };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const inputs = JSON.parse(String(init.body)) as StcCalculatorInput;
      stored = { ...stored, estimate: { contract_version: "ci_stc_manual_estimate_v1", inputs,
        solar_deeming_years: 6, solar_zone_factor: 1.185, battery_factor: 6.8,
        solar_calculated_quantity: 995.4, battery_calculated_quantity: 680,
        solar_rebate_aud: 38820.6, battery_rebate_aud: 26520, total_rebate_aud: 65340.6,
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
  await user.type(screen.getByLabelText("Battery usable capacity (kWh)"), "100");
  await user.click(screen.getByRole("button", { name: "Calculate & save STC estimate" }));
  expect(await screen.findByText("Solar rebate: $38,820.60")).toBeTruthy();
  expect(screen.getByText("Battery rebate: $26,520.00")).toBeTruthy();
  expect(screen.getByText("Saved total rebate estimate: $65,340.60")).toBeTruthy();
  const request = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body));
  expect(request).toEqual({ solar_installation_year: 2025, solar_zone: 4, pv_capacity_kwp: 140,
    solar_certificate_price: 39, battery_installation_period: "2026-05_12", battery_usable_capacity_kwh: 100, battery_certificate_price: 39 });
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
  expect(screen.getByText("Saved total rebate estimate: $65,340.60")).toBeTruthy();
});

it("reports a save failure without displaying an unsaved estimate", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method === "PUT" ? new Response("", { status: 500 }) : new Response(JSON.stringify({ contract_version: "ci_stc_calculator_state_v1", project_id: "project-1", estimate: null }))));
  render(<QueryClientProvider client={new QueryClient()}><CiStcCalculatorPanel projectId="project-1" /></QueryClientProvider>);
  await screen.findByLabelText("PV capacity (kWp)");
  fireEvent.change(screen.getByLabelText("PV capacity (kWp)"), { target: { value: "140" } });
  fireEvent.change(screen.getByLabelText("Battery usable capacity (kWh)"), { target: { value: "0" } });
  await userEvent.click(screen.getByRole("button", { name: "Calculate & save STC estimate" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/Saved total rebate estimate:/)).toBeNull();
});

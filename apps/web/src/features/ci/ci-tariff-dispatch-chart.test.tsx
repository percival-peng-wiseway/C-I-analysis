// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDispatchReviewProjection } from "./api/ci-scenarios";
import { CiTariffDispatchChart } from "./ci-tariff-dispatch-chart";

const projection = {
  peak_local_date: "2025-01-03",
  soc_status: "available",
  points: [
    { interval_timestamp: "2025-01-03T00:00:00Z", local_time_label: "11:00 AEDT", baseline_import_kw: 150.5, post_dispatch_import_kw: 100.125, baseline_kva: 170.25, post_dispatch_kva: 102.625, grid_charge_kw: 0, pv_charge_kw: 5.25, battery_discharge_kw: 0, soc_end_kwh: 84.125, inverter_reactive_support_kvar: 31.5 },
    { interval_timestamp: "2025-01-03T00:15:00Z", local_time_label: "11:15 AEDT", baseline_import_kw: 250.5, post_dispatch_import_kw: 100.125, baseline_kva: 270.25, post_dispatch_kva: 102.625, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 75.625, soc_end_kwh: 64.5, inverter_reactive_support_kvar: 34.625 },
    { interval_timestamp: "2025-01-03T00:30:00Z", local_time_label: "11:30 AEDT", baseline_import_kw: 25.5, post_dispatch_import_kw: 50.75, baseline_kva: 40.25, post_dispatch_kva: 55.625, grid_charge_kw: 25.25, pv_charge_kw: 0, battery_discharge_kw: 0, soc_end_kwh: 70.25, inverter_reactive_support_kvar: 0 },
  ],
} as CiDispatchReviewProjection;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("saved tariff dispatch charts", () => {
  it("uses the saved kVA, kW, battery flows and SOC without rerunning calculations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    render(<CiTariffDispatchChart projection={projection} />);
    expect(screen.getByRole("button", { name: "Apparent demand · kVA" }).getAttribute("aria-pressed")).toBe("true");
    const demand = screen.getByRole("img", { name: "Tariff interval demand replay" });
    expect(within(demand).getByText("11:00 AEDT · Post-dispatch kVA: 102.625 kVA")).toBeTruthy();
    expect(screen.getByText("3 battery-active intervals")).toBeTruthy();
    expect(screen.getByText("Reactive support up to 34.625 kvar")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Active import · kW" }));
    expect(within(demand).getByText("11:00 AEDT · Post-dispatch import kW: 100.125 kW")).toBeTruthy();
    expect(within(screen.getByRole("img", { name: "Tariff battery charge and discharge" })).getByText("11:15 AEDT · Battery discharge: 75.625 kW")).toBeTruthy();
    expect(within(screen.getByRole("img", { name: "Tariff battery state of charge" })).getByText("11:00 AEDT · Stored energy: 84.125 kWh")).toBeTruthy();
    await user.click(screen.getByText("Saved interval values"));
    expect(screen.getByRole("table").textContent).toContain("84.125");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not invent zero SOC for a solar-only projection", () => {
    render(<CiTariffDispatchChart projection={{ ...projection, soc_status: "not_applicable_no_battery", points: projection.points.map((point) => ({ ...point, soc_end_kwh: null, battery_discharge_kw: 0, pv_charge_kw: 0, grid_charge_kw: 0 })) }} />);
    expect(screen.queryByRole("img", { name: "Tariff battery state of charge" })).toBeNull();
    expect(screen.getByText("Solar-only solution · no battery SOC applies.")).toBeTruthy();
    expect(screen.getByText("Battery idle on this day")).toBeTruthy();
  });

  it("breaks the SOC path at missing intervals instead of filling them", () => {
    render(<CiTariffDispatchChart projection={{ ...projection, points: projection.points.map((point, index) => ({ ...point, soc_end_kwh: index === 1 ? null : point.soc_end_kwh })) }} />);
    const path = screen.getByRole("img", { name: "Tariff battery state of charge" }).querySelector("path")?.getAttribute("d");
    expect(path?.match(/M/g)).toHaveLength(2);
    expect(path).not.toMatch(/NaN/);
  });
});

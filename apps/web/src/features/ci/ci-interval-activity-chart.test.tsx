// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertCiIntervalActivity, type CiIntervalActivityResult } from "./api/ci-design-feasibility";
import { formatIntervalMeterTime, IntervalActivityPlot } from "./ci-interval-activity-chart";

function activity(days: 1 | 3 | 7 = 1): CiIntervalActivityResult {
  const points = Array.from({ length: days * 96 }, (_, index) => ({
    timestamp: `${new Date(Date.UTC(2025, 2, 19, 0, index * 15)).toISOString().slice(0, 19)}+10:00`,
    time_label: "unused legacy label",
    measured_import_kw: 100,
    grid_import_kw: 60,
    solar_to_load_kw: 30,
    grid_export_kw: 0,
    battery_charge_kw: 0,
    battery_discharge_kw: 10,
  }));
  return {
    contract_version: "ci_interval_activity_v1", status: "ready",
    analysis_mode: "pre_tariff_physical_interval_activity",
    scenario_id: "synthetic", scenario_label: "Synthetic test system",
    interval_minutes: 15, time_basis: "fixed_aest_meter_time",
    range: {
      requested_start_date: "2025-03-19", requested_days: days,
      effective_start_timestamp: points[0].timestamp,
      effective_end_timestamp: points.at(-1)!.timestamp,
      interval_count: points.length, complete: true,
    },
    points, customer_facing_permission: false, recommendation_permitted: false,
    tariff_evaluated: false, billing_demand_interpretation_permitted: false,
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Interval activity meter time and flows", () => {
  it("explicitly fixes formatting timezone, including midnight and DST dates", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    expect(formatIntervalMeterTime("2025-03-19T00:00:00+10:00", true)).toBe("19 Mar, 00:00");
    expect(formatIntervalMeterTime("2025-03-19T23:45:00+10:00", true)).toBe("19 Mar, 23:45");
    expect(formatIntervalMeterTime("2025-10-05T02:30:00+10:00")).toBe("02:30");
    expect(formatter).toHaveBeenCalledWith("en-AU", expect.objectContaining({ timeZone: "UTC" }));
  });

  it.each([1, 3, 7] as const)("uses the same source dates in %i-day axes and interval details", (days) => {
    const data = activity(days);
    const { container } = render(<IntervalActivityPlot activity={data} />);
    const chart = screen.getByRole("img");
    expect(chart.textContent).toContain("19 Mar, 00:00");
    expect(chart.textContent).toContain(formatIntervalMeterTime(data.points.at(-1)!.timestamp, true));
    expect(screen.getByText("19 Mar, 00:00 · AEST · UTC+10")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Inspect interval" }), { target: { value: "49" } });
    expect(screen.getByText("19 Mar, 12:15 · AEST · UTC+10")).toBeTruthy();
    expect(container.querySelectorAll("path[data-series]")).toHaveLength(4);
    for (const path of container.querySelectorAll("path[data-series]")) expect(path.getAttribute("fill")).toBe("none");
    expect(container.querySelectorAll('rect[data-series="battery_discharge_kw"]')).toHaveLength(days * 96);
    expect(screen.getByText("10 kW")).toBeTruthy();
    expect(screen.queryByText("unused legacy label")).toBeNull();
  });

  it("draws charge below zero and discharge above zero", () => {
    const data = activity();
    data.points[0].battery_discharge_kw = 0;
    data.points[0].battery_charge_kw = 12;
    const { container } = render(<IntervalActivityPlot activity={data} />);
    const charge = container.querySelector('rect[data-series="battery_charge_kw"]')!;
    const discharge = container.querySelectorAll('rect[data-series="battery_discharge_kw"]')[1];
    expect(Number(charge.getAttribute("height"))).toBeGreaterThan(0);
    expect(Number(discharge.getAttribute("y"))).toBeLessThan(Number(charge.getAttribute("y")));
  });

  it("handles older servers without inventing zero battery flow", () => {
    const data = activity();
    data.points.forEach((point) => { delete point.battery_charge_kw; delete point.battery_discharge_kw; });
    expect(assertCiIntervalActivity(data)).toBe(data);
    const { container } = render(<IntervalActivityPlot activity={data} />);
    expect(screen.getByText("Battery interval data is unavailable from this server.")).toBeTruthy();
    expect(container.querySelector('rect[data-series="battery_discharge_kw"]')).toBeNull();
  });

  it.each([-1, NaN, Infinity, undefined])("rejects invalid/incomplete battery fields (%s)", (value) => {
    const data = activity();
    data.points[0].battery_charge_kw = value;
    expect(() => assertCiIntervalActivity(data)).toThrow("unsafe result contract");
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioPeakReplay } from "./ci-scenario-peak-replay";
import type { CiFeasibilityScenario } from "./api/ci-design-feasibility";

afterEach(cleanup);
const point = (time_label: string, pv: number, discharge = 0) => ({
  timestamp: `2024-12-16T${time_label}:00+10:00`, time_label,
  baseline_kw: 200, pv_generation_kw: pv, pv_only_import_kw: 200 - pv,
  pv_battery_import_kw: 200 - pv - discharge, battery_discharge_kw: discharge,
  battery_charge_kw: 0, soc_kwh: 150,
});
const scenario = { scenario_id: "synthetic", peak_day: { date: "2024-12-16", sampled_target_kw: 150,
  points: [point("00:00", 0), point("05:30", 10), point("06:00", 20), point("12:00", 100), point("14:00", 30, 20), point("18:00", 5), point("23:45", 0)],
} } as CiFeasibilityScenario;

describe("Technical screening replay", () => {
  it("shows morning PV independently and preserves overlapping import values", async () => {
    const user = userEvent.setup();
    render(<ScenarioPeakReplay scenario={scenario} />);
    expect(screen.getByText("Modelled PV above 0.001 kW: 05:30 to 18:00")).toBeTruthy();
    const plot = screen.getByRole("img", { name: "Scenario Analysis active-power peak shaving replay" });
    const pvLine = plot.querySelector('[data-series="pv_only_import_kw"]')!;
    const batteryLine = plot.querySelector('[data-series="pv_battery_import_kw"]')!;
    expect(batteryLine.getAttribute("stroke-dasharray")).toBe("7 5");
    expect(pvLine.getAttribute("d")!.split("L")[2]).toBe(batteryLine.getAttribute("d")!.split("L")[2]);
    // 06:00 is exactly one quarter of the meter-time axis, not one quarter of point count.
    expect(pvLine.getAttribute("d")!.split("L")[2].split(",")[0]).toBe("269.00");
    const originalPath = pvLine.getAttribute("d");
    await user.click(screen.getByRole("button", { name: "PV + battery" }));
    expect(plot.querySelector('[data-series="pv_battery_import_kw"]')).toBeNull();
    expect(pvLine.getAttribute("d")).toBe(originalPath);
    fireEvent.change(screen.getByRole("slider", { name: "Inspect replay interval" }), { target: { value: "2" } });
    const readings = screen.getByLabelText("Selected interval values");
    expect(within(readings).getAllByText("180 kW")).toHaveLength(2);
    expect(within(readings).getByText("20 kW")).toBeTruthy();
    expect(screen.getByText(/overlap at this interval/)).toBeTruthy();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "4" } });
    expect(screen.getByText(/different grid import at this interval/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "PV generation" }));
    expect(screen.queryByRole("img", { name: "Technical screening PV generation" })).toBeNull();
  });

  it("supports no PV, no battery and empty data without inventing generation", () => {
    const noPv = { ...scenario, peak_day: { ...scenario.peak_day, sampled_target_kw: null, points: [point("06:00", 0)] } };
    const { rerender } = render(<ScenarioPeakReplay scenario={noPv} />);
    expect(screen.getByText("No modelled PV generation on this day")).toBeTruthy();
    expect(screen.getByText("0 discharge intervals")).toBeTruthy();
    expect(screen.queryByText(/Sampled target/)).toBeNull();
    rerender(<ScenarioPeakReplay scenario={{ ...noPv, peak_day: { ...noPv.peak_day, points: [] } }} />);
    expect(screen.getByText(/No peak-day intervals available/)).toBeTruthy();
  });

  it("does not replace missing PV values with zeros", () => {
    render(<ScenarioPeakReplay scenario={{ ...scenario, peak_day: { ...scenario.peak_day, points: [{ ...point("06:00", 0), pv_generation_kw: undefined as unknown as number }] } }} />);
    expect(screen.getByText("PV generation data unavailable. Run analysis again.")).toBeTruthy();
  });
});

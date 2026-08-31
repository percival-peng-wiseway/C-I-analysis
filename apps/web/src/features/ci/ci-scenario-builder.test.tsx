// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiScenarioInput } from "./api/ci-scenarios";
import { CiScenarioBuilder } from "./ci-scenario-builder";

afterEach(cleanup);

describe("CiScenarioBuilder", () => {
  it("restores added PV and battery ranges, auto-sizes inverter, and saves existing assets", async () => {
    const onSubmit = vi.fn();
    render(<CiScenarioBuilder error={null} initialSolutions={solutions} isPending={false} onSubmit={onSubmit} />);

    const pv = screen.getByRole("region", { name: "Added PV search range" });
    const battery = screen.getByRole("region", { name: "Added battery search range" });

    expect((within(pv).getByLabelText("Min") as HTMLInputElement).value).toBe("100");
    expect((within(pv).getByLabelText("Max") as HTMLInputElement).value).toBe("150");
    expect((within(battery).getByLabelText("Min") as HTMLInputElement).value).toBe("200");
    expect((within(battery).getByLabelText("Max") as HTMLInputElement).value).toBe("400");
    expect(screen.getByRole("region", { name: "Automatic hybrid inverter sizing" })).toBeTruthy();
    expect(screen.getByText("Hybrid inverter / PCS")).toBeTruthy();
    expect(screen.queryByText("PV inverter")).toBeNull();
    expect(screen.queryByText("Battery PCS")).toBeNull();
    expect(screen.getByText("2 PV × 2 battery = 4 cases")).toBeTruthy();
    expect(screen.getAllByText("Technical options")).toHaveLength(2);

    await userEvent.click(screen.getByLabelText("Existing solar PV already installed"));
    await userEvent.type(screen.getByLabelText("Panel brand"), "Trina");
    await userEvent.type(screen.getByLabelText("Panel model"), "Vertex S+");
    await userEvent.type(screen.getByLabelText("Installed capacity (kWp DC)"), "50");
    await userEvent.type(screen.getByLabelText("Panel quantity"), "100");
    await userEvent.type(screen.getByLabelText("Panel rating (W)"), "500");

    await userEvent.click(screen.getByRole("button", { name: "Generate 4 solutions" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toHaveLength(4);
    expect(onSubmit.mock.calls[0][0][0].pv_inverter_capacity_kw_ac).toBe(80);
    expect(onSubmit.mock.calls[0][0][0].shared_ac_headroom_kw).toBe(80);
    expect(onSubmit.mock.calls[0][0][1]).toMatchObject({ pv_inverter_capacity_kw_ac: 100, shared_ac_headroom_kw: 100, max_discharge_kw: 100 });
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ existing_solar: { brand: "Trina", model: "Vertex S+", installed_capacity_kwp_dc: 50 } });
    expect(onSubmit.mock.calls[0][0][0].grid_emissions_factor_kg_co2e_per_kwh).toBe(0.79);
    expect(onSubmit.mock.calls[0][1].technical_options.grid_emissions_factor_kg_co2e_per_kwh).toBe(0.79);
  });
});

const solutions = [
  scenario("pv-1", "battery-1", 100, 80, 200, 50),
  scenario("pv-1", "battery-2", 100, 80, 400, 100),
  scenario("pv-2", "battery-1", 150, 120, 200, 50),
  scenario("pv-2", "battery-2", 150, 120, 400, 100),
];

function scenario(pvId: string, batteryId: string, pvCapacity: number, inverterCapacity: number, batteryCapacity: number, batteryPower: number): CiScenarioInput {
  return {
    scenario_id: `${pvId}__${batteryId}`,
    label: `${pvCapacity} kWp + ${batteryCapacity} kWh`,
    battery_system_id: batteryId,
    battery_technology_id: "generic_li_ion_ac",
    control_profile_id: "demand_peak_shaving",
    pv_system_id: pvId,
    pv_profile_id: "generic_normalized_solar_shape_v1",
    pv_capacity_kwp_dc: pvCapacity,
    pv_inverter_capacity_kw_ac: inverterCapacity,
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

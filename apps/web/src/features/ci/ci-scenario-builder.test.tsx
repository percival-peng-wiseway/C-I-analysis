// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDeviceProfile } from "./api/ci-device-profile";
import { CiScenarioBuilder } from "./ci-scenario-builder";

afterEach(cleanup);

describe("CiScenarioBuilder", () => {
  it("submits only the profile selections, site factors and ranges for Python generation", async () => {
    const onSubmit = vi.fn();
    render(
      <CiScenarioBuilder
        deviceProfile={deviceProfile}
        error={null}
        isPending={false}
        onSubmit={onSubmit}
        siteAddress="10 Sample Street, Melbourne VIC 3000"
      />,
    );

    expect(screen.getByText("10 Sample Street, Melbourne VIC 3000")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Directions in Google Maps/ }).getAttribute("href")).toContain("10%20Sample%20Street");
    expect(screen.getByRole("region", { name: "Solar PV profile" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Battery profile" })).toBeTruthy();
    expect(screen.queryByText("Existing site assets")).toBeNull();
    expect(screen.getByText("30 requested · Python will snap & validate")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Generate 30 requested cases" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      contract_version: "ci_solution_generation_request_v1",
      pv_range: { minimum_kwp_dc: 100, maximum_kwp_dc: 500, step_kwp_dc: 100 },
      battery_range: { minimum_kwh: 0, maximum_kwh: 500, step_kwh: 100 },
      solar_profile_id: "generic_crystalline_pv_v1",
      battery_profile_id: "generic_lfp_ac_2h_v1",
      site_factors: {
        resource_basis: "gross_specific_yield_before_site_losses",
        resource_source: "analyst_assumption",
        resource_label: "Workspace screening assumption",
        array_azimuth_degrees: 0,
        array_tilt_degrees: 20,
      },
      connection_options: {
        site_ac_headroom_kw: 250,
        allow_grid_charging: false,
        grid_emissions_factor_kg_co2e_per_kwh: null,
        initial_soc_basis: "full_soc_physical_upper_bound",
      },
    });
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("scenarios");
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("existing_solar");
  });

  it("uses another published profile selected from the workspace library", async () => {
    const onSubmit = vi.fn();
    const secondProfile: CiDeviceProfile = structuredClone(deviceProfile);
    secondProfile.solution_profiles.solar_profiles.push({
      ...secondProfile.solution_profiles.solar_profiles[0],
      profile_id: "high_power_pv_v1",
      name: "High-power PV",
      rated_power_w: 700,
    });
    render(<CiScenarioBuilder deviceProfile={secondProfile} error={null} isPending={false} onSubmit={onSubmit} />);

    await userEvent.selectOptions(screen.getByLabelText("Published Solar profile"), "high_power_pv_v1");
    await userEvent.click(screen.getByRole("button", { name: "Generate 30 requested cases" }));

    expect(onSubmit.mock.calls[0][0].solar_profile_id).toBe("high_power_pv_v1");
    expect(screen.getByText("700 W")).toBeTruthy();
  });

  it("keeps DC-coupled battery profiles out of the current AC dispatch generator", () => {
    const dcOnly: CiDeviceProfile = structuredClone(deviceProfile);
    dcOnly.solution_profiles.battery_profiles[0].coupling = "dc";

    render(<CiScenarioBuilder deviceProfile={dcOnly} error={null} isPending={false} onSubmit={vi.fn()} />);

    expect(screen.getByText(/current Python dispatch engine does not model them/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate 30 requested cases" })).toHaveProperty("disabled", true);
  });

  it("disables requests that could exceed the saved canonical candidate limit", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimums = screen.getAllByRole("spinbutton", { name: "Minimum" }) as HTMLInputElement[];
    const maximums = screen.getAllByRole("spinbutton", { name: "Maximum" }) as HTMLInputElement[];
    const steps = screen.getAllByRole("spinbutton", { name: "Step" }) as HTMLInputElement[];

    await user.clear(minimums[0]); await user.type(minimums[0], "1");
    await user.clear(maximums[0]); await user.type(maximums[0], "20");
    await user.clear(steps[0]); await user.type(steps[0], "1");
    await user.clear(minimums[1]); await user.type(minimums[1], "100");
    await user.clear(maximums[1]); await user.type(maximums[1], "1000");
    await user.clear(steps[1]); await user.type(steps[1], "100");

    expect(await screen.findByText("200 requested · up to 400 candidates (maximum 200)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate 200 requested cases" })).toHaveProperty("disabled", true);
  });
});

const deviceProfile: CiDeviceProfile = {
  contract_version: "ci_device_profile_v4",
  profile_id: "workspace_device_profile",
  currency: "AUD",
  tax_basis: "gst_exclusive",
  pv_cost_aud_per_kwp_dc: 530,
  battery_cost_aud_per_kwh: 413,
  inverter_cost_aud_per_kw_ac: 80,
  equipment_catalog: {
    pv_products: [{
      product_id: "astronergy_astro_n7_600_630w",
      manufacturer: "Astronergy",
      model: "ASTRO N7 600–630W",
      rated_power_min_w: 600,
      rated_power_max_w: 630,
      capital_cost_aud_per_kwp_dc: 530,
      replacement_cost_aud_per_kwp_dc: 530,
      annual_om_aud: 0,
    }],
    battery_products: [{
      product_id: "fox_ess_cq7_ci",
      manufacturer: "Fox ESS",
      model: "CQ7 C&I",
      chemistry: "LFP",
      module_capacity_kwh: 7,
      cost_curve: [{ quantity: 30, capital_cost_aud: 77578, replacement_cost_aud: 57456, annual_om_aud: 0 }],
    }],
    inverter_products: [{
      product_id: "fox_ess_h3_plus_125kw",
      manufacturer: "Fox ESS",
      model: "H3 Plus Hybrid Inverter",
      sizing_unit_kw_ac: 125,
      cost_curve: [{ capacity_kw_ac: 125, capital_cost_aud: 10000, replacement_cost_aud: 10000, annual_om_aud: 0 }],
    }],
  },
  default_equipment_selection: {
    pv_product_id: "astronergy_astro_n7_600_630w",
    battery_product_id: "fox_ess_cq7_ci",
    inverter_product_id: "fox_ess_h3_plus_125kw",
  },
  solution_profiles: {
    solar_profiles: [{
      profile_id: "generic_crystalline_pv_v1",
      version: 1,
      status: "published",
      name: "Generic crystalline PV screening profile",
      manufacturer: "Generic",
      model: "Screening assumption",
      module_technology: "monocrystalline",
      rated_power_w: 600,
      module_efficiency_percent: 22,
      temperature_coefficient_percent_per_c: -0.35,
      annual_degradation_percent: 0.5,
      default_dc_ac_ratio: 1.15,
      source_type: "analyst_assumption",
      source_label: "Generic screening assumption",
      source_date: null,
    }],
    battery_profiles: [{
      profile_id: "generic_lfp_ac_2h_v1",
      version: 1,
      status: "published",
      name: "Generic LFP AC 2-hour screening profile",
      manufacturer: "Generic",
      model: "Screening assumption",
      chemistry: "LFP",
      coupling: "ac",
      nominal_capacity_kwh_per_unit: 100,
      continuous_power_kw_per_unit: 50,
      round_trip_efficiency_percent: 90,
      power_conversion_efficiency_percent: 95,
      usable_depth_of_discharge_percent: 90,
      standby_loss_percent_per_month: 1,
      annual_capacity_degradation_percent: 2,
      minimum_units: 1,
      maximum_units: 10000,
      source_type: "analyst_assumption",
      source_label: "Generic screening assumption",
      source_date: null,
    }],
      inverter_profiles: [{ profile_id: "fox_h3_125_plus_v1", version: 1, status: "draft", name: "H3-125-Plus evidence", manufacturer: "Fox ESS", model: "H3-125-Plus", rated_active_power_kw: 125, rated_apparent_power_kva: 137.5, maximum_reactive_power_kvar: 82.5, power_factor_leading_limit: 0.8, power_factor_lagging_limit: 0.8, pq_capability_curve_available: false, reactive_power_at_zero_active_power: true, night_reactive_capability: true, european_efficiency_percent: 98.1, maximum_efficiency_percent: 98.5, source_type: "supplier_data", source_label: "Supplied C&I device workbook", source_date: null }],
  },
  default_solution_profile_selection: {
    solar_profile_id: "generic_crystalline_pv_v1",
    battery_profile_id: "generic_lfp_ac_2h_v1",
  },
  discount_rate: 0.08,
  annual_value_escalation_rate: 0.025,
  annual_value_degradation_rate: 0.005,
  annual_om_fraction_of_capex: 0.015,
  analysis_term_years: 15,
};

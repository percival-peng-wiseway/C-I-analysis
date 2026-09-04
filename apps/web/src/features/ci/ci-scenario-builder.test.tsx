// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDeviceProfile } from "./api/ci-device-profile";
import type { CiDesignContextV2 } from "./api/ci-projects";
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
    expect(screen.getAllByText("Performance reference")).toHaveLength(3);
    expect(screen.queryByText("Module rating")).toBeNull();
    expect(screen.queryByText("Unit size")).toBeNull();
    expect(screen.queryByText("Existing site assets")).toBeNull();
    expect(screen.queryByText(/Python will snap & validate/)).toBeNull();
    expect(screen.queryByText("Python auto-sizing")).toBeNull();
    expect(screen.queryByText("PCS block from selected inverter")).toBeNull();
    expect(screen.queryByLabelText(/Inverter quantity/)).toBeNull();
    expect(screen.queryByText("Configured PCS")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Save configuration & generate solutions" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      contract_version: "ci_solution_generation_request_v1",
      pv_range: { minimum_kwp_dc: 100, maximum_kwp_dc: 500, step_kwp_dc: 100 },
      battery_range: { minimum_kwh: 0, maximum_kwh: 500, step_kwh: 100 },
      solar_profile_id: "generic_crystalline_pv_v1",
      battery_profile_id: "generic_lfp_ac_2h_v1",
      inverter_profile_id: "fox_h3_125_plus_v1",
      site_factors: {
        resource_basis: "gross_specific_yield_before_site_losses",
        resource_source: "analyst_assumption",
        resource_label: "Workspace screening assumption",
        array_azimuth_degrees: 0,
        array_tilt_degrees: 20,
      },
      connection_options: {
        site_ac_headroom_kw: 250,
        allow_grid_charging: true,
        grid_emissions_factor_kg_co2e_per_kwh: null,
        initial_soc_basis: "full_soc_physical_upper_bound",
      },
    });
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("scenarios");
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("existing_solar");
    expect(screen.queryByLabelText("Allow grid charging")).toBeNull();
    expect(screen.getByText("5 candidates:").parentElement?.textContent).toBe("5 candidates: 100, 200, 300, 400, 500 kWp");
    expect(screen.getByText("6 candidates:").parentElement?.textContent).toBe("6 candidates: 0, 100, 200, 300, 400, 500 kWh");
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

    await userEvent.selectOptions(screen.getByLabelText("Solar performance profile"), "high_power_pv_v1");
    await userEvent.click(screen.getByRole("button", { name: "Save configuration & generate solutions" }));

    expect(onSubmit.mock.calls[0][0].solar_profile_id).toBe("high_power_pv_v1");
  });

  it("shows every requested PV and battery candidate from the configured ranges", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimums = screen.getAllByRole("spinbutton", { name: "Minimum" });
    const maximums = screen.getAllByRole("spinbutton", { name: "Maximum" });
    const steps = screen.getAllByRole("spinbutton", { name: "Step" });

    await user.clear(minimums[0]); await user.type(minimums[0], "100");
    await user.clear(maximums[0]); await user.type(maximums[0], "150");
    await user.clear(steps[0]); await user.type(steps[0], "10");
    await user.clear(minimums[1]); await user.type(minimums[1], "350");
    await user.clear(maximums[1]); await user.type(maximums[1], "400");
    await user.clear(steps[1]); await user.type(steps[1], "10");

    expect(screen.getAllByText("6 candidates:")[0].parentElement?.textContent).toBe("6 candidates: 100, 110, 120, 130, 140, 150 kWp");
    expect(screen.getAllByText("6 candidates:")[1].parentElement?.textContent).toBe("6 candidates: 350, 360, 370, 380, 390, 400 kWh");
  });

  it("floors decimal range counts the same way as Python", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimum = screen.getAllByRole("spinbutton", { name: "Minimum" })[0];
    const maximum = screen.getAllByRole("spinbutton", { name: "Maximum" })[0];
    const step = screen.getAllByRole("spinbutton", { name: "Step" })[0];

    await user.clear(minimum); await user.type(minimum, "100");
    await user.clear(maximum); await user.type(maximum, "100.299999999");
    await user.clear(step); await user.type(step, "0.1");

    expect(screen.getByText("3 candidates:").parentElement?.textContent).toBe("3 candidates: 100, 100.1, 100.2 kWp");
  });

  it("preserves distinct sub-six-decimal candidate values in the requested list", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimum = screen.getAllByRole("spinbutton", { name: "Minimum" })[0];
    const maximum = screen.getAllByRole("spinbutton", { name: "Maximum" })[0];
    const step = screen.getAllByRole("spinbutton", { name: "Step" })[0];

    await user.clear(minimum); await user.type(minimum, "100.1234567");
    await user.clear(maximum); await user.type(maximum, "100.1234568");
    await user.clear(step); await user.type(step, "0.0000001");

    expect(screen.getByText("2 candidates:").parentElement?.textContent).toBe("2 candidates: 100.1234567, 100.1234568 kWp");
  });

  it("uses Python half-even rounding for nine-decimal candidate values", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimum = screen.getAllByRole("spinbutton", { name: "Minimum" })[0];
    const maximum = screen.getAllByRole("spinbutton", { name: "Maximum" })[0];

    await user.clear(minimum); await user.type(minimum, "100.0009765625");
    await user.clear(maximum); await user.type(maximum, "100.0009765625");

    expect(screen.getByText("1 candidate:").parentElement?.textContent).toBe("1 candidate: 100.000976562 kWp");
  });

  it("restores and resubmits saved nine-decimal ranges without truncation", async () => {
    const onSubmit = vi.fn();
    const initialContext = {
      contract_version: "ci_design_context_v2",
      search_space: {
        pv_range: { minimum_kwp_dc: 100.000000001, maximum_kwp_dc: 100.000000002, step_kwp_dc: 0.000000001 },
        battery_range: { minimum_kwh: 350.000000001, maximum_kwh: 350.000000002, step_kwh: 0.000000001 },
      },
      site_factors: {
        resource_source: "analyst_assumption",
        resource_label: "Workspace screening assumption",
        annual_specific_yield_kwh_per_kw: 1500,
        array_azimuth_degrees: 0,
        array_tilt_degrees: 20,
        shading_loss_percent: 3,
        soiling_loss_percent: 2,
        temperature_loss_percent: 5,
        wiring_mismatch_loss_percent: 2,
        other_system_loss_percent: 0,
        system_availability_percent: 99,
      },
      profile_selection: {
        solar_profile_id: "generic_crystalline_pv_v1",
        battery_profile_id: "generic_lfp_ac_2h_v1",
        inverter_profile_id: "fox_h3_125_plus_v1",
      },
      technical_options: {
        inverter_block_size_kw: 125,
        site_ac_headroom_kw: 250,
        reactive_support_enabled: true,
        reactive_support_max_kvar: 57,
        grid_emissions_factor_kg_co2e_per_kwh: 0,
      },
    } as unknown as CiDesignContextV2;
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} initialContext={initialContext} isPending={false} onSubmit={onSubmit} />);

    const minimums = screen.getAllByRole("spinbutton", { name: "Minimum" }) as HTMLInputElement[];
    const maximums = screen.getAllByRole("spinbutton", { name: "Maximum" }) as HTMLInputElement[];
    const steps = screen.getAllByRole("spinbutton", { name: "Step" }) as HTMLInputElement[];
    expect([minimums[0].value, maximums[0].value, steps[0].value]).toEqual(["100.000000001", "100.000000002", "0.000000001"]);
    expect([minimums[1].value, maximums[1].value, steps[1].value]).toEqual(["350.000000001", "350.000000002", "0.000000001"]);
    expect((screen.getByLabelText("Reactive support cap (kvar)") as HTMLInputElement).value).toBe("57");

    await userEvent.click(screen.getByRole("button", { name: "Save configuration & generate solutions" }));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      pv_range: { minimum_kwp_dc: 100.000000001, maximum_kwp_dc: 100.000000002, step_kwp_dc: 0.000000001 },
      battery_range: { minimum_kwh: 350.000000001, maximum_kwh: 350.000000002, step_kwh: 0.000000001 },
      connection_options: { reactive_support_enabled: true, reactive_support_max_kvar: 57 },
    });
  });

  it("preserves a manual reactive cap until the inverter profile is deliberately changed", async () => {
    const user = userEvent.setup();
    const profiles: CiDeviceProfile = structuredClone(deviceProfile);
    profiles.solution_profiles.inverter_profiles.push({
      ...profiles.solution_profiles.inverter_profiles[0],
      profile_id: "inverter-100",
      name: "H3-100-Plus evidence",
      model: "H3-100-Plus",
      rated_active_power_kw: 100,
      rated_apparent_power_kva: 110,
      maximum_reactive_power_kvar: 66,
    });
    const view = render(<CiScenarioBuilder deviceProfile={profiles} error={null} isPending={false} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("checkbox", { name: "Model inverter reactive support" }));
    const cap = screen.getByLabelText("Reactive support cap (kvar)") as HTMLInputElement;
    await user.type(cap, "57");
    expect(cap.value).toBe("57");

    view.rerender(<CiScenarioBuilder deviceProfile={structuredClone(profiles)} error={null} isPending={false} onSubmit={vi.fn()} />);
    expect((screen.getByLabelText("Reactive support cap (kvar)") as HTMLInputElement).value).toBe("57");

    await user.selectOptions(screen.getByLabelText("Inverter performance profile"), "inverter-100");
    expect((screen.getByLabelText("Reactive support cap (kvar)") as HTMLInputElement).value).toBe("66");
  });

  it("adopts a newly saved published battery profile without remounting", async () => {
    const beforeSave: CiDeviceProfile = structuredClone(deviceProfile);
    const foxBattery = {
      ...beforeSave.solution_profiles.battery_profiles[0],
      profile_id: "fox_ess_cq7_l14_v1",
      name: "Fox ESS CQ7-L14",
      manufacturer: "Fox ESS",
      model: "CQ7-L14",
      nominal_capacity_kwh_per_unit: 97.44,
      continuous_power_kw_per_unit: 64.51,
      status: "draft" as const,
    };
    beforeSave.solution_profiles.battery_profiles[0].status = "draft";
    beforeSave.solution_profiles.battery_profiles.push(foxBattery);

    const afterSave: CiDeviceProfile = structuredClone(beforeSave);
    afterSave.solution_profiles.battery_profiles[1].status = "published";
    afterSave.default_solution_profile_selection.battery_profile_id = "fox_ess_cq7_l14_v1";

    const view = render(<CiScenarioBuilder deviceProfile={beforeSave} error={null} isPending={false} onSubmit={vi.fn()} />);
    expect(screen.getByText("No published profile is available.")).toBeTruthy();

    view.rerender(<CiScenarioBuilder deviceProfile={afterSave} error={null} isPending={false} onSubmit={vi.fn()} />);

    await waitFor(() => expect((screen.getByLabelText("Battery performance profile") as HTMLSelectElement).value).toBe("fox_ess_cq7_l14_v1"));
    expect(screen.getByRole("region", { name: "Battery profile" }).textContent).toContain("Fox ESS CQ7-L14");
    expect(screen.getByRole("button", { name: "Save configuration & generate solutions" })).toHaveProperty("disabled", false);
  });

  it("keeps DC-coupled battery profiles out of the current AC dispatch generator", () => {
    const dcOnly: CiDeviceProfile = structuredClone(deviceProfile);
    dcOnly.solution_profiles.battery_profiles[0].coupling = "dc";

    render(<CiScenarioBuilder deviceProfile={dcOnly} error={null} isPending={false} onSubmit={vi.fn()} />);

    expect(screen.getByText("Published Solar, AC Battery and Inverter profiles are required.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save configuration & generate solutions" })).toHaveProperty("disabled", true);
  });

  it("allows exactly 200 direct PV and battery combinations", async () => {
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

    expect(screen.queryByText(/Maximum 200 solutions/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save configuration & generate solutions" })).toHaveProperty("disabled", false);
  });

  it("disables ranges above the downstream PV and battery candidate limits", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimums = screen.getAllByRole("spinbutton", { name: "Minimum" }) as HTMLInputElement[];
    const maximums = screen.getAllByRole("spinbutton", { name: "Maximum" }) as HTMLInputElement[];
    const steps = screen.getAllByRole("spinbutton", { name: "Step" }) as HTMLInputElement[];

    await user.clear(minimums[0]); await user.type(minimums[0], "1");
    await user.clear(maximums[0]); await user.type(maximums[0], "21");
    await user.clear(steps[0]); await user.type(steps[0], "1");
    await user.clear(minimums[1]); await user.type(minimums[1], "0");
    await user.clear(maximums[1]); await user.type(maximums[1], "0");
    await user.clear(steps[1]); await user.type(steps[1], "1");

    expect(await screen.findByText("Maximum 20 PV candidates. Current configuration: 21.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save configuration & generate solutions" })).toHaveProperty("disabled", true);

    await user.clear(maximums[0]); await user.type(maximums[0], "1");
    await user.clear(maximums[1]); await user.type(maximums[1], "15");

    expect(await screen.findByText("Maximum 15 battery candidates. Current configuration: 16.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save configuration & generate solutions" })).toHaveProperty("disabled", true);
  });

  it("disables requests that exceed the direct combination limit", async () => {
    const user = userEvent.setup();
    render(<CiScenarioBuilder deviceProfile={deviceProfile} error={null} isPending={false} onSubmit={vi.fn()} />);
    const minimums = screen.getAllByRole("spinbutton", { name: "Minimum" }) as HTMLInputElement[];
    const maximums = screen.getAllByRole("spinbutton", { name: "Maximum" }) as HTMLInputElement[];
    const steps = screen.getAllByRole("spinbutton", { name: "Step" }) as HTMLInputElement[];

    await user.clear(minimums[0]); await user.type(minimums[0], "1");
    await user.clear(maximums[0]); await user.type(maximums[0], "20");
    await user.clear(steps[0]); await user.type(steps[0], "1");
    await user.clear(minimums[1]); await user.type(minimums[1], "100");
    await user.clear(maximums[1]); await user.type(maximums[1], "1100");
    await user.clear(steps[1]); await user.type(steps[1], "100");

    expect(await screen.findByText("Maximum 200 solutions. Current configuration: 220.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save configuration & generate solutions" })).toHaveProperty("disabled", true);
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
      inverter_profiles: [{ profile_id: "fox_h3_125_plus_v1", version: 1, status: "published", name: "H3-125-Plus evidence", manufacturer: "Fox ESS", model: "H3-125-Plus", rated_active_power_kw: 125, rated_apparent_power_kva: 137.5, maximum_reactive_power_kvar: 82.5, power_factor_leading_limit: 0.8, power_factor_lagging_limit: 0.8, pq_capability_curve_available: false, reactive_power_at_zero_active_power: true, night_reactive_capability: true, european_efficiency_percent: 98.1, maximum_efficiency_percent: 98.5, source_type: "supplier_data", source_label: "Supplied C&I device workbook", source_date: null }],
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

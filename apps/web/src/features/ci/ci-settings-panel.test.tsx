// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiDeviceProfile } from "./api/ci-device-profile";
import { CiSettingsPanel } from "./ci-settings-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CiSettingsPanel solution profile library", () => {
  it("adds a stable solar draft, publishes it, and saves it as the default", async () => {
    const user = userEvent.setup();
    const profile = deviceProfile();
    const saved: { current: CiDeviceProfile | null } = { current: null };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        saved.current = JSON.parse(String(init.body)) as CiDeviceProfile;
        return new Response(JSON.stringify(readyState(saved.current)), { status: 200 });
      }
      return new Response(JSON.stringify(readyState(profile)), { status: 200 });
    }));

    renderSettings();
    expect(await screen.findByRole("heading", { name: "Solution profile library" })).toBeTruthy();
    expect(screen.getByText(/Draft evidence is stored for completion/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set ASTRO N7 reference as default solar profile" }).textContent).toBe("Default");

    await user.click(screen.getByRole("button", { name: "Add profile" }));
    const profileId = screen.getByLabelText("Profile ID") as HTMLInputElement;
    expect(profileId.readOnly).toBe(true);
    expect(profileId.value).toMatch(/^solar_[a-z0-9]+$/);
    expect((screen.getByRole("button", { name: "Set as default" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Delete/i })).toBeNull();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Warehouse roof profile");
    await user.selectOptions(screen.getByLabelText("Status"), "published");
    await user.click(screen.getByRole("button", { name: "Set as default" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(saved.current).not.toBeNull());
    expect(saved.current?.default_solution_profile_selection.solar_profile_id).toBe(profileId.value);
    expect(saved.current?.solution_profiles.solar_profiles.at(-1)).toMatchObject({ profile_id: profileId.value, name: "Warehouse roof profile", status: "published", source_type: "analyst_assumption" });
  });

  it("keeps equipment pricing and finance in a separate settings section", async () => {
    const user = userEvent.setup();
    const profile = deviceProfile();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(readyState(profile)), { status: 200 })));

    renderSettings();
    await screen.findByRole("heading", { name: "Solution profile library" });
    await user.click(screen.getByRole("tab", { name: "Equipment & finance" }));
    expect(screen.getByRole("heading", { name: "Equipment & finance" })).toBeTruthy();
    expect((screen.getByLabelText("Per kWp DC capital") as HTMLInputElement).value).toBe("530");
    expect((screen.getByLabelText("210 kWh capital") as HTMLInputElement).value).toBe("77578");
    expect((screen.getByLabelText("Discount rate") as HTMLInputElement).value).toBe("8");
    await user.clear(screen.getByLabelText("Analysis term"));
    await user.type(screen.getByLabelText("Analysis term"), "51");
    expect(screen.getByText(/within the allowed ranges/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save profile" })).toHaveProperty("disabled", true);
  });

  it("shows inverter reactive capability evidence without offering it as a generator default", async () => {
    const user = userEvent.setup();
    const profile = deviceProfile();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(readyState(profile)), { status: 200 })));

    renderSettings();
    await screen.findByRole("heading", { name: "Solution profile library" });
    await user.click(screen.getByRole("tab", { name: "Inverter" }));
    expect((screen.getByLabelText("Reactive support cap") as HTMLInputElement).value).toBe("82.5");
    expect((screen.getByLabelText("Rated apparent power") as HTMLInputElement).value).toBe("137.5");
    expect(screen.queryByRole("button", { name: /default inverter profile/ })).toBeNull();
  });

  it("locks profile edits while a saved snapshot is in flight", async () => {
    const user = userEvent.setup();
    const profile = deviceProfile();
    let releaseSave: () => void = () => undefined;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await saveGate;
        return new Response(JSON.stringify(readyState(JSON.parse(String(init.body)) as CiDeviceProfile)), { status: 200 });
      }
      return new Response(JSON.stringify(readyState(profile)), { status: 200 });
    }));

    renderSettings();
    await screen.findByRole("heading", { name: "Solution profile library" });
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add profile" });
    expect(add.matches(":disabled")).toBe(true);
    await user.click(add);
    expect(screen.getAllByRole("button", { name: /Edit solar profile/ })).toHaveLength(1);

    releaseSave();
    expect(await screen.findByText(/Device profile saved/)).toBeTruthy();
  });
});

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><CiSettingsPanel onClose={vi.fn()} /></QueryClientProvider>);
}

function readyState(profile: CiDeviceProfile) {
  return { contract_version: "ci_device_profile_state_v1", status: "ready", updated_at: "2026-09-01T00:00:00Z", profile_sha256: "a".repeat(64), profile, suggested_profile: profile };
}

function deviceProfile(): CiDeviceProfile {
  return {
    contract_version: "ci_device_profile_v4",
    profile_id: "workspace_device_profile",
    currency: "AUD",
    tax_basis: "gst_exclusive",
    pv_cost_aud_per_kwp_dc: 530,
    battery_cost_aud_per_kwh: 413,
    inverter_cost_aud_per_kw_ac: 80,
    equipment_catalog: {
      pv_products: [{ product_id: "astronergy_astro_n7_600_630w", manufacturer: "Astronergy", model: "ASTRO N7 600–630W", rated_power_min_w: 600, rated_power_max_w: 630, capital_cost_aud_per_kwp_dc: 530, replacement_cost_aud_per_kwp_dc: 530, annual_om_aud: 0 }],
      battery_products: [{ product_id: "fox_ess_cq7_ci", manufacturer: "Fox ESS", model: "CQ7 C&I", chemistry: "LFP", module_capacity_kwh: 7, cost_curve: [{ quantity: 30, capital_cost_aud: 77578, replacement_cost_aud: 57456, annual_om_aud: 0 }, { quantity: 36, capital_cost_aud: 91866, replacement_cost_aud: 69660, annual_om_aud: 0 }, { quantity: 42, capital_cost_aud: 106154, replacement_cost_aud: 81864, annual_om_aud: 0 }] }],
      inverter_products: [{ product_id: "fox_ess_h3_plus_125kw", manufacturer: "Fox ESS", model: "H3 Plus Hybrid Inverter", sizing_unit_kw_ac: 125, cost_curve: [{ capacity_kw_ac: 80, capital_cost_aud: 9000, replacement_cost_aud: 9000, annual_om_aud: 0 }, { capacity_kw_ac: 100, capital_cost_aud: 9500, replacement_cost_aud: 9500, annual_om_aud: 0 }, { capacity_kw_ac: 125, capital_cost_aud: 10000, replacement_cost_aud: 10000, annual_om_aud: 0 }] }],
    },
    default_equipment_selection: { pv_product_id: "astronergy_astro_n7_600_630w", battery_product_id: "fox_ess_cq7_ci", inverter_product_id: "fox_ess_h3_plus_125kw" },
    solution_profiles: {
      solar_profiles: [{ profile_id: "astro_n7_default", version: 1, status: "published", name: "ASTRO N7 reference", manufacturer: "Astronergy", model: "ASTRO N7 630W", module_technology: "monocrystalline", rated_power_w: 630, module_efficiency_percent: 23.3, temperature_coefficient_percent_per_c: -0.29, annual_degradation_percent: 0.4, default_dc_ac_ratio: 1.15, source_type: "manufacturer_datasheet", source_label: "ASTRO N7 datasheet", source_date: "2026-06-01" }],
      battery_profiles: [{ profile_id: "fox_cq7_default", version: 1, status: "published", name: "CQ7 reference", manufacturer: "Fox ESS", model: "CQ7", chemistry: "LFP", coupling: "ac", nominal_capacity_kwh_per_unit: 7, continuous_power_kw_per_unit: 3.5, round_trip_efficiency_percent: 90, power_conversion_efficiency_percent: 97, usable_depth_of_discharge_percent: 90, standby_loss_percent_per_month: 0.5, annual_capacity_degradation_percent: 2, minimum_units: 1, maximum_units: 500, source_type: "manufacturer_datasheet", source_label: "CQ7 datasheet", source_date: "2026-06-01" }],
      inverter_profiles: [{ profile_id: "fox_h3_125_plus_v1", version: 1, status: "draft", name: "H3-125-Plus evidence", manufacturer: "Fox ESS", model: "H3-125-Plus", rated_active_power_kw: 125, rated_apparent_power_kva: 137.5, maximum_reactive_power_kvar: 82.5, power_factor_leading_limit: 0.8, power_factor_lagging_limit: 0.8, pq_capability_curve_available: false, reactive_power_at_zero_active_power: true, night_reactive_capability: true, european_efficiency_percent: 98.1, maximum_efficiency_percent: 98.5, source_type: "supplier_data", source_label: "Supplied C&I device workbook", source_date: null }],
    },
    default_solution_profile_selection: { solar_profile_id: "astro_n7_default", battery_profile_id: "fox_cq7_default" },
    discount_rate: 0.08,
    annual_value_escalation_rate: 0.025,
    annual_value_degradation_rate: 0.005,
    annual_om_fraction_of_capex: 0.015,
    analysis_term_years: 15,
  };
}

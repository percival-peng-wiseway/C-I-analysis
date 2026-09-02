import { describe, expect, it, vi } from "vitest";

import { assertCiDeviceProfileState, fetchCiDeviceProfile, saveCiDeviceProfile, type CiDeviceProfile } from "./ci-device-profile";

const profile: CiDeviceProfile = {
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

const state = (savedProfile: CiDeviceProfile | null = null) => ({
  contract_version: "ci_device_profile_state_v1",
  status: savedProfile ? "ready" : "not_configured",
  updated_at: savedProfile ? "2026-08-19" : null,
  profile_sha256: savedProfile ? "a".repeat(64) : null,
  profile: savedProfile,
  suggested_profile: profile,
});

describe("Device profile v4 API", () => {
  it("loads an explicit not-configured state with published solution-profile defaults", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(state()), { status: 200 }));
    await expect(fetchCiDeviceProfile(fetcher)).resolves.toMatchObject({ status: "not_configured", suggested_profile: profile });
  });

  it("saves the full v4 profile as an AUD ex-GST contract", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual(profile);
      return new Response(JSON.stringify(state(profile)), { status: 200 });
    });
    await expect(saveCiDeviceProfile(profile, fetcher)).resolves.toMatchObject({ status: "ready", profile });
  });

  it("accepts non-default drafts but rejects a non-published default", () => {
    const withDraft = structuredClone(profile);
    withDraft.solution_profiles.solar_profiles.push({ ...withDraft.solution_profiles.solar_profiles[0], profile_id: "solar_draft", name: "Solar draft", status: "draft" });
    expect(assertCiDeviceProfileState({ ...state(withDraft), suggested_profile: withDraft })).toMatchObject({ status: "ready" });

    withDraft.default_solution_profile_selection.solar_profile_id = "solar_draft";
    expect(() => assertCiDeviceProfileState({ ...state(withDraft), suggested_profile: withDraft })).toThrow("unsafe contract");
  });

  it("accepts incomplete draft batteries but rejects publishing them", () => {
    const withIncompleteDraft = structuredClone(profile);
    const battery = { ...withIncompleteDraft.solution_profiles.battery_profiles[0] };
    withIncompleteDraft.solution_profiles.battery_profiles.push(battery);
    battery.profile_id = "cq7_l14_draft";
    battery.status = "draft";
    battery.coupling = null;
    battery.power_conversion_efficiency_percent = null;
    battery.standby_loss_percent_per_month = null;
    battery.annual_capacity_degradation_percent = null;
    expect(assertCiDeviceProfileState({ ...state(withIncompleteDraft), suggested_profile: withIncompleteDraft })).toMatchObject({ status: "ready" });

    battery.status = "published";
    expect(() => assertCiDeviceProfileState({ ...state(withIncompleteDraft), suggested_profile: withIncompleteDraft })).toThrow("unsafe contract");
  });

  it("rejects legacy and duplicate profile contracts", () => {
    expect(() => assertCiDeviceProfileState({ ...state(), suggested_profile: { ...profile, contract_version: "ci_device_profile_v2" } })).toThrow("unsafe contract");
    const duplicate = structuredClone(profile);
    duplicate.solution_profiles.battery_profiles.push({ ...duplicate.solution_profiles.battery_profiles[0], name: "Duplicate" });
    expect(() => assertCiDeviceProfileState({ ...state(), suggested_profile: duplicate })).toThrow("unsafe contract");
  });

  it("rejects malformed equipment cost curves before Settings can render them", () => {
    const malformed = structuredClone(profile);
    (malformed.equipment_catalog.battery_products[0] as { cost_curve?: unknown }).cost_curve = undefined;

    expect(() => assertCiDeviceProfileState({ ...state(), suggested_profile: malformed })).toThrow("unsafe contract");
  });

  it("accepts a legacy-compatible zero nested PV catalog cost", () => {
    const compatible = structuredClone(profile);
    compatible.equipment_catalog.pv_products[0].capital_cost_aud_per_kwp_dc = 0;

    expect(assertCiDeviceProfileState({ ...state(compatible), suggested_profile: compatible })).toMatchObject({ status: "ready" });
  });

  it("surfaces Pydantic validation messages when a save is rejected", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ detail: [{ msg: "Analysis term must be at most 50" }] }), { status: 422 }));

    await expect(saveCiDeviceProfile(profile, fetcher)).rejects.toThrow("Analysis term must be at most 50");
  });
});

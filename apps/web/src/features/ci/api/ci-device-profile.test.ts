import { expect, it, vi } from "vitest";

import { fetchCiDeviceProfile, saveCiDeviceProfile, type CiDeviceProfile } from "./ci-device-profile";

const profile: CiDeviceProfile = {
  contract_version: "ci_device_profile_v2",
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
  discount_rate: 0.08,
  annual_value_escalation_rate: 0.025,
  annual_value_degradation_rate: 0.005,
  annual_om_fraction_of_capex: 0.015,
  analysis_term_years: 15,
};

it("loads an explicit not-configured Device profile state", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ contract_version: "ci_device_profile_state_v1", status: "not_configured", updated_at: null, profile_sha256: null, profile: null, suggested_profile: profile }), { status: 200 }));
  await expect(fetchCiDeviceProfile(fetcher)).resolves.toMatchObject({ status: "not_configured", suggested_profile: profile });
});

it("saves the shared profile as an AUD ex-GST contract", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual(profile);
    return new Response(JSON.stringify({ contract_version: "ci_device_profile_state_v1", status: "ready", updated_at: "2026-08-19", profile_sha256: "a".repeat(64), profile, suggested_profile: profile }), { status: 200 });
  });
  await expect(saveCiDeviceProfile(profile, fetcher)).resolves.toMatchObject({ status: "ready", profile });
});

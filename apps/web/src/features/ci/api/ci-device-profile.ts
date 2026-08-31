export interface CiDeviceProfile {
  contract_version: "ci_device_profile_v2";
  profile_id: "workspace_device_profile";
  currency: "AUD";
  tax_basis: "gst_exclusive";
  pv_cost_aud_per_kwp_dc: number;
  battery_cost_aud_per_kwh: number;
  inverter_cost_aud_per_kw_ac: number;
  equipment_catalog: {
    pv_products: Array<{
      product_id: "astronergy_astro_n7_600_630w";
      manufacturer: "Astronergy";
      model: string;
      rated_power_min_w: number;
      rated_power_max_w: number;
      capital_cost_aud_per_kwp_dc: number;
      replacement_cost_aud_per_kwp_dc: number;
      annual_om_aud: number;
    }>;
    battery_products: Array<{
      product_id: "fox_ess_cq7_ci";
      manufacturer: "Fox ESS";
      model: string;
      chemistry: "LFP";
      module_capacity_kwh: number;
      cost_curve: Array<{ quantity: number; capital_cost_aud: number; replacement_cost_aud: number; annual_om_aud: number }>;
    }>;
    inverter_products: Array<{
      product_id: "fox_ess_h3_plus_125kw";
      manufacturer: "Fox ESS";
      model: string;
      sizing_unit_kw_ac: number;
      cost_curve: Array<{ capacity_kw_ac: number; capital_cost_aud: number; replacement_cost_aud: number; annual_om_aud: number }>;
    }>;
  };
  default_equipment_selection: CiEquipmentSelection;
  discount_rate: number;
  annual_value_escalation_rate: number;
  annual_value_degradation_rate: number;
  annual_om_fraction_of_capex: number;
  analysis_term_years: number;
}

export interface CiEquipmentSelection {
  pv_product_id: "astronergy_astro_n7_600_630w";
  battery_product_id: "fox_ess_cq7_ci";
  inverter_product_id: "fox_ess_h3_plus_125kw";
}

export interface CiDeviceProfileState {
  contract_version: "ci_device_profile_state_v1";
  status: "not_configured" | "ready";
  updated_at: string | null;
  profile_sha256: string | null;
  profile: CiDeviceProfile | null;
  suggested_profile: CiDeviceProfile;
}

export const ciDeviceProfileQueryKey = ["ci-device-profile"] as const;

export async function fetchCiDeviceProfile(
  fetcher: typeof fetch = fetch,
): Promise<CiDeviceProfileState> {
  const response = await fetcher("/api/commercial-industrial/settings/device-profile", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not load the workspace Device profile.");
  return assertCiDeviceProfileState(await response.json());
}

export async function saveCiDeviceProfile(
  profile: CiDeviceProfile,
  fetcher: typeof fetch = fetch,
): Promise<CiDeviceProfileState> {
  const response = await fetcher("/api/commercial-industrial/settings/device-profile", {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Could not save the workspace Device profile.");
  }
  return assertCiDeviceProfileState(await response.json());
}

export function assertCiDeviceProfileState(value: unknown): CiDeviceProfileState {
  const payload = value as CiDeviceProfileState;
  if (
    payload.contract_version !== "ci_device_profile_state_v1" ||
    !["not_configured", "ready"].includes(payload.status) ||
    !isProfile(payload.suggested_profile) ||
    (payload.status === "ready" && (!isProfile(payload.profile) || typeof payload.profile_sha256 !== "string")) ||
    (payload.status === "not_configured" && (payload.profile !== null || payload.profile_sha256 !== null))
  ) throw new Error("Device profile returned an unsafe contract.");
  return payload;
}

function isProfile(value: unknown): value is CiDeviceProfile {
  const profile = value as CiDeviceProfile;
  return Boolean(
    profile &&
    profile.contract_version === "ci_device_profile_v2" &&
    profile.profile_id === "workspace_device_profile" &&
    profile.currency === "AUD" &&
    profile.tax_basis === "gst_exclusive" &&
    [
      profile.pv_cost_aud_per_kwp_dc,
      profile.battery_cost_aud_per_kwh,
      profile.inverter_cost_aud_per_kw_ac,
      profile.discount_rate,
      profile.annual_value_escalation_rate,
      profile.annual_value_degradation_rate,
      profile.annual_om_fraction_of_capex,
      profile.analysis_term_years,
    ].every(Number.isFinite) &&
    profile.pv_cost_aud_per_kwp_dc > 0 &&
    profile.battery_cost_aud_per_kwh > 0 &&
    profile.inverter_cost_aud_per_kw_ac > 0
    && profile.equipment_catalog?.pv_products?.length === 1
    && profile.equipment_catalog?.battery_products?.length === 1
    && profile.equipment_catalog?.inverter_products?.length === 1
    && profile.default_equipment_selection?.pv_product_id === "astronergy_astro_n7_600_630w"
    && profile.default_equipment_selection?.battery_product_id === "fox_ess_cq7_ci"
    && profile.default_equipment_selection?.inverter_product_id === "fox_ess_h3_plus_125kw"
  );
}

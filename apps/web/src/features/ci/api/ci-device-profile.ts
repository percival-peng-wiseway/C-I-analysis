export type CiSolutionProfileStatus = "draft" | "published" | "retired";
export type CiSolutionProfileSourceType = "manufacturer_datasheet" | "supplier_data" | "analyst_assumption";

export interface CiSolarSolutionProfile {
  profile_id: string;
  version: number;
  status: CiSolutionProfileStatus;
  name: string;
  manufacturer: string;
  model: string;
  module_technology: "monocrystalline" | "polycrystalline" | "thin_film" | "other";
  rated_power_w: number;
  module_efficiency_percent: number;
  temperature_coefficient_percent_per_c: number;
  annual_degradation_percent: number;
  default_dc_ac_ratio: number;
  source_type: CiSolutionProfileSourceType;
  source_label: string;
  source_date: string | null;
}

export interface CiBatterySolutionProfile {
  profile_id: string;
  version: number;
  status: CiSolutionProfileStatus;
  name: string;
  manufacturer: string;
  model: string;
  chemistry: string;
  coupling: "ac" | "dc" | null;
  nominal_capacity_kwh_per_unit: number | null;
  continuous_power_kw_per_unit: number | null;
  round_trip_efficiency_percent: number | null;
  power_conversion_efficiency_percent: number | null;
  usable_depth_of_discharge_percent: number | null;
  standby_loss_percent_per_month: number | null;
  annual_capacity_degradation_percent: number | null;
  minimum_units: number | null;
  maximum_units: number | null;
  source_type: CiSolutionProfileSourceType;
  source_label: string;
  source_date: string | null;
}

export interface CiInverterSolutionProfile {
  profile_id: string;
  version: number;
  status: CiSolutionProfileStatus;
  name: string;
  manufacturer: string;
  model: string;
  rated_active_power_kw: number;
  rated_apparent_power_kva: number;
  reactive_support_enabled: boolean;
  maximum_reactive_power_kvar: number;
  power_factor_leading_limit: number;
  power_factor_lagging_limit: number;
  pq_capability_curve_available: boolean;
  reactive_power_at_zero_active_power: boolean;
  night_reactive_capability: boolean;
  european_efficiency_percent: number;
  maximum_efficiency_percent: number;
  source_type: CiSolutionProfileSourceType;
  source_label: string;
  source_date: string | null;
}

export interface CiSolutionProfileSelection {
  solar_profile_id: string;
  battery_profile_id: string;
}

export interface CiDeviceProfile {
  contract_version: "ci_device_profile_v5";
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
  solution_profiles: {
    solar_profiles: CiSolarSolutionProfile[];
    battery_profiles: CiBatterySolutionProfile[];
    inverter_profiles: CiInverterSolutionProfile[];
  };
  default_solution_profile_selection: CiSolutionProfileSelection;
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
    const payload = await response.json().catch(() => null);
    throw new Error(deviceProfileErrorMessage(payload));
  }
  return assertCiDeviceProfileState(await response.json());
}

export function assertCiDeviceProfileState(value: unknown): CiDeviceProfileState {
  const payload = value as CiDeviceProfileState;
  const ready = payload?.status === "ready";
  if (
    !payload ||
    payload.contract_version !== "ci_device_profile_state_v1" ||
    !["not_configured", "ready"].includes(payload.status) ||
    !isProfile(payload.suggested_profile) ||
    (ready && (!isProfile(payload.profile) || !isSha256(payload.profile_sha256))) ||
    (!ready && (payload.profile !== null || payload.profile_sha256 !== null))
  ) throw new Error("Device profile returned an unsafe contract.");
  return payload;
}

function isProfile(value: unknown): value is CiDeviceProfile {
  const profile = value as CiDeviceProfile;
  if (!profile || profile.contract_version !== "ci_device_profile_v5") return false;
  const solarProfiles = profile.solution_profiles?.solar_profiles;
  const batteryProfiles = profile.solution_profiles?.battery_profiles;
  const inverterProfiles = profile.solution_profiles?.inverter_profiles;
  if (
    profile.profile_id !== "workspace_device_profile" ||
    profile.currency !== "AUD" ||
    profile.tax_basis !== "gst_exclusive" ||
    !isExistingPricingAndFinance(profile) ||
    !Array.isArray(solarProfiles) || solarProfiles.length === 0 || solarProfiles.length > 50 ||
    !Array.isArray(batteryProfiles) || batteryProfiles.length === 0 || batteryProfiles.length > 50 ||
    !Array.isArray(inverterProfiles) || inverterProfiles.length === 0 || inverterProfiles.length > 50 ||
    solarProfiles.some((item) => !isSolarSolutionProfile(item)) ||
    batteryProfiles.some((item) => !isBatterySolutionProfile(item)) ||
    inverterProfiles.some((item) => !isInverterSolutionProfile(item)) ||
    !hasUniqueProfileIds([...solarProfiles, ...batteryProfiles, ...inverterProfiles])
  ) return false;

  const defaults = profile.default_solution_profile_selection;
  return Boolean(
    defaults &&
    isIdentifier(defaults.solar_profile_id) &&
    isIdentifier(defaults.battery_profile_id) &&
    solarProfiles.some((item) => item.profile_id === defaults.solar_profile_id && item.status === "published") &&
    batteryProfiles.some((item) => item.profile_id === defaults.battery_profile_id && item.status === "published")
  );
}

function isExistingPricingAndFinance(profile: CiDeviceProfile) {
  const pv = profile.equipment_catalog?.pv_products?.[0];
  const battery = profile.equipment_catalog?.battery_products?.[0];
  const inverter = profile.equipment_catalog?.inverter_products?.[0];
  return Boolean(
    isFiniteInRange(profile.pv_cost_aud_per_kwp_dc, 0, 1_000_000, false) &&
    isFiniteInRange(profile.battery_cost_aud_per_kwh, 0, 1_000_000, false) &&
    isFiniteInRange(profile.inverter_cost_aud_per_kw_ac, 0, 1_000_000, false) &&
    isFiniteInRange(profile.discount_rate, 0, 1, true, false) &&
    isFiniteInRange(profile.annual_value_escalation_rate, 0, 1, true, false) &&
    isFiniteInRange(profile.annual_value_degradation_rate, 0, 1, true, false) &&
    isFiniteInRange(profile.annual_om_fraction_of_capex, 0, 0.201, true, false) &&
    Number.isInteger(profile.analysis_term_years) && profile.analysis_term_years >= 1 && profile.analysis_term_years <= 50 &&
    profile.equipment_catalog?.pv_products?.length === 1 &&
    profile.equipment_catalog?.battery_products?.length === 1 &&
    profile.equipment_catalog?.inverter_products?.length === 1 &&
    isPvProduct(pv) &&
    isBatteryProduct(battery) &&
    isInverterProduct(inverter) &&
    profile.default_equipment_selection?.pv_product_id === pv.product_id &&
    profile.default_equipment_selection?.battery_product_id === battery.product_id &&
    profile.default_equipment_selection?.inverter_product_id === inverter.product_id
  );
}

function isPvProduct(value: unknown): value is CiDeviceProfile["equipment_catalog"]["pv_products"][number] {
  const product = value as CiDeviceProfile["equipment_catalog"]["pv_products"][number];
  return Boolean(
    product &&
    hasExactKeys(product, ["product_id", "manufacturer", "model", "rated_power_min_w", "rated_power_max_w", "capital_cost_aud_per_kwp_dc", "replacement_cost_aud_per_kwp_dc", "annual_om_aud"]) &&
    product.product_id === "astronergy_astro_n7_600_630w" &&
    product.manufacturer === "Astronergy" &&
    isLabel(product.model) &&
    isPositiveFinite(product.rated_power_min_w) &&
    isPositiveFinite(product.rated_power_max_w) &&
    product.rated_power_max_w >= product.rated_power_min_w &&
    isMoney(product.capital_cost_aud_per_kwp_dc) &&
    isMoney(product.replacement_cost_aud_per_kwp_dc) &&
    isMoney(product.annual_om_aud)
  );
}

function isBatteryProduct(value: unknown): value is CiDeviceProfile["equipment_catalog"]["battery_products"][number] {
  const product = value as CiDeviceProfile["equipment_catalog"]["battery_products"][number];
  return Boolean(
    product &&
    hasExactKeys(product, ["product_id", "manufacturer", "model", "chemistry", "module_capacity_kwh", "cost_curve"]) &&
    product.product_id === "fox_ess_cq7_ci" &&
    product.manufacturer === "Fox ESS" &&
    product.chemistry === "LFP" &&
    isLabel(product.model) &&
    isPositiveFinite(product.module_capacity_kwh) &&
    isCostCurve(product.cost_curve, "quantity", [30, 36, 42])
  );
}

function isInverterProduct(value: unknown): value is CiDeviceProfile["equipment_catalog"]["inverter_products"][number] {
  const product = value as CiDeviceProfile["equipment_catalog"]["inverter_products"][number];
  return Boolean(
    product &&
    hasExactKeys(product, ["product_id", "manufacturer", "model", "sizing_unit_kw_ac", "cost_curve"]) &&
    product.product_id === "fox_ess_h3_plus_125kw" &&
    product.manufacturer === "Fox ESS" &&
    isLabel(product.model) &&
    isPositiveFinite(product.sizing_unit_kw_ac) &&
    isCostCurve(product.cost_curve, "capacity_kw_ac", [80, 100, 125])
  );
}

function isCostCurve(value: unknown, axis: "quantity" | "capacity_kw_ac", expectedAxes: number[]) {
  if (!Array.isArray(value) || value.length !== expectedAxes.length) return false;
  return value.every((point, index) => {
    if (!point || typeof point !== "object" || !hasExactKeys(point, [axis, "capital_cost_aud", "replacement_cost_aud", "annual_om_aud"])) return false;
    const entry = point as Record<string, unknown>;
    return entry[axis] === expectedAxes[index] && isMoney(entry.capital_cost_aud, true) && isMoney(entry.replacement_cost_aud) && isMoney(entry.annual_om_aud);
  });
}

function isMoney(value: unknown, positive = false) {
  return isFiniteInRange(value, 0, positive ? 1_000_000 : 1_000_000_000, !positive);
}

function deviceProfileErrorMessage(value: unknown) {
  const detail = (value as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (Array.isArray(detail)) {
    const message = detail.map((item) => (item as { msg?: unknown })?.msg).find((item) => typeof item === "string" && item.trim());
    if (typeof message === "string") return message;
  }
  return "Could not save the workspace Device profile.";
}

function isSolarSolutionProfile(value: unknown): value is CiSolarSolutionProfile {
  const profile = value as CiSolarSolutionProfile;
  return Boolean(
    profile &&
    hasExactKeys(profile, ["profile_id", "version", "status", "name", "manufacturer", "model", "module_technology", "rated_power_w", "module_efficiency_percent", "temperature_coefficient_percent_per_c", "annual_degradation_percent", "default_dc_ac_ratio", "source_type", "source_label", "source_date"]) &&
    isIdentifier(profile.profile_id) &&
    isVersion(profile.version) &&
    isStatus(profile.status) &&
    [profile.name, profile.manufacturer, profile.model].every((item) => isLabel(item)) &&
    ["monocrystalline", "polycrystalline", "thin_film", "other"].includes(profile.module_technology) &&
    isFiniteInRange(profile.rated_power_w, 100, 2_000) &&
    isFiniteInRange(profile.module_efficiency_percent, 1, 40) &&
    isFiniteInRange(profile.temperature_coefficient_percent_per_c, -2, 0) &&
    isFiniteInRange(profile.annual_degradation_percent, 0, 10) &&
    isFiniteInRange(profile.default_dc_ac_ratio, 0.8, 2) &&
    isSourceType(profile.source_type) &&
    isLabel(profile.source_label) &&
    isSourceDate(profile.source_date)
  );
}

function isBatterySolutionProfile(value: unknown): value is CiBatterySolutionProfile {
  const profile = value as CiBatterySolutionProfile;
  const allowMissing = profile?.status === "draft";
  return Boolean(
    profile &&
    hasExactKeys(profile, ["profile_id", "version", "status", "name", "manufacturer", "model", "chemistry", "coupling", "nominal_capacity_kwh_per_unit", "continuous_power_kw_per_unit", "round_trip_efficiency_percent", "power_conversion_efficiency_percent", "usable_depth_of_discharge_percent", "standby_loss_percent_per_month", "annual_capacity_degradation_percent", "minimum_units", "maximum_units", "source_type", "source_label", "source_date"]) &&
    isIdentifier(profile.profile_id) &&
    isVersion(profile.version) &&
    isStatus(profile.status) &&
    [profile.name, profile.manufacturer, profile.model, profile.chemistry].every((item) => isLabel(item)) &&
    isDraftable(profile.coupling, allowMissing, (item) => item === "ac" || item === "dc") &&
    isDraftable(profile.nominal_capacity_kwh_per_unit, allowMissing, isPositiveFinite) &&
    isDraftable(profile.continuous_power_kw_per_unit, allowMissing, isPositiveFinite) &&
    isDraftable(profile.round_trip_efficiency_percent, allowMissing, (item) => isFiniteInRange(item, 1, 100)) &&
    isDraftable(profile.power_conversion_efficiency_percent, allowMissing, (item) => isFiniteInRange(item, 1, 100)) &&
    isDraftable(profile.usable_depth_of_discharge_percent, allowMissing, (item) => isFiniteInRange(item, 1, 100)) &&
    isDraftable(profile.standby_loss_percent_per_month, allowMissing, (item) => isFiniteInRange(item, 0, 100, true, false)) &&
    isDraftable(profile.annual_capacity_degradation_percent, allowMissing, (item) => isFiniteInRange(item, 0, 100, true, false)) &&
    isDraftable(profile.minimum_units, allowMissing, isProfileUnitCount) &&
    isDraftable(profile.maximum_units, allowMissing, isProfileUnitCount) &&
    (profile.minimum_units === null || profile.maximum_units === null || profile.maximum_units >= profile.minimum_units) &&
    isSourceType(profile.source_type) &&
    isLabel(profile.source_label) &&
    isSourceDate(profile.source_date)
  );
}

function isInverterSolutionProfile(value: unknown): value is CiInverterSolutionProfile {
  const profile = value as CiInverterSolutionProfile;
  return Boolean(
    profile &&
    hasExactKeys(profile, ["profile_id", "version", "status", "name", "manufacturer", "model", "rated_active_power_kw", "rated_apparent_power_kva", "reactive_support_enabled", "maximum_reactive_power_kvar", "power_factor_leading_limit", "power_factor_lagging_limit", "pq_capability_curve_available", "reactive_power_at_zero_active_power", "night_reactive_capability", "european_efficiency_percent", "maximum_efficiency_percent", "source_type", "source_label", "source_date"]) &&
    isIdentifier(profile.profile_id) &&
    isVersion(profile.version) &&
    isStatus(profile.status) &&
    [profile.name, profile.manufacturer, profile.model].every((item) => isLabel(item)) &&
    isPositiveFinite(profile.rated_active_power_kw) &&
    isPositiveFinite(profile.rated_apparent_power_kva) &&
    profile.rated_apparent_power_kva >= profile.rated_active_power_kw &&
    typeof profile.reactive_support_enabled === "boolean" &&
    isFiniteInRange(profile.maximum_reactive_power_kvar, 0, 1_000_000) &&
    (!profile.reactive_support_enabled || profile.maximum_reactive_power_kvar > 0) &&
    profile.maximum_reactive_power_kvar <= profile.rated_apparent_power_kva &&
    isFiniteInRange(profile.power_factor_leading_limit, 0, 1) &&
    isFiniteInRange(profile.power_factor_lagging_limit, 0, 1) &&
    typeof profile.pq_capability_curve_available === "boolean" &&
    typeof profile.reactive_power_at_zero_active_power === "boolean" &&
    typeof profile.night_reactive_capability === "boolean" &&
    isFiniteInRange(profile.european_efficiency_percent, 1, 100) &&
    isFiniteInRange(profile.maximum_efficiency_percent, 1, 100) &&
    profile.european_efficiency_percent <= profile.maximum_efficiency_percent &&
    isSourceType(profile.source_type) &&
    isLabel(profile.source_label) &&
    isSourceDate(profile.source_date)
  );
}

function isDraftable(value: unknown, allowMissing: boolean, validate: (candidate: unknown) => boolean) {
  return value === null ? allowMissing : validate(value);
}

function isProfileUnitCount(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10_000;
}

function hasUniqueProfileIds(values: Array<{ profile_id: string }>) {
  return new Set(values.map((item) => item.profile_id)).size === values.length;
}

function isIdentifier(value: unknown) {
  return typeof value === "string" && value.length <= 120 && /^[a-z0-9](?:[a-z0-9_-]{0,118}[a-z0-9])?$/.test(value);
}

function isVersion(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10_000;
}

function isStatus(value: unknown): value is CiSolutionProfileStatus {
  return typeof value === "string" && ["draft", "published", "retired"].includes(value);
}

function isSourceType(value: unknown): value is CiSolutionProfileSourceType {
  return typeof value === "string" && ["manufacturer_datasheet", "supplier_data", "analyst_assumption"].includes(value);
}

function isLabel(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240;
}

function isSourceDate(value: unknown) {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number, inclusiveMinimum = true, inclusiveMaximum = true) {
  return typeof value === "number" && Number.isFinite(value) && (inclusiveMinimum ? value >= minimum : value > minimum) && (inclusiveMaximum ? value <= maximum : value < maximum);
}

function isPositiveFinite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasExactKeys(value: object, keys: string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

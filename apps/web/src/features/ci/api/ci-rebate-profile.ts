export type CiProjectRebateProfileStatus = "not_configured" | "draft" | "approved" | "stale";

export type CiProjectRebateProgramId = "solar_stc" | "battery_stc" | "vic_deemed_veec";

export type CiVictoriaRegion = "metropolitan" | "regional";

export const ciSolarStcZoneRatings = [1.622, 1.536, 1.382, 1.185] as const;

export interface CiProjectRebateProgramCommon {
  enabled: boolean;
  eligibility_confirmed: boolean;
  eligibility_source_label: string;
  certificate_price_aud_ex_gst: number;
  price_source_label: string;
  price_as_of_date: string;
}

export interface CiSolarStcRebateProgram extends CiProjectRebateProgramCommon {
  postcode_zone_rating: number | null;
  zone_source_label: string;
}

export interface CiBatteryStcRebateProgram extends CiProjectRebateProgramCommon {
  certified_usable_capacity_fraction: number | null;
  capacity_source_label: string;
}

export interface CiVicDeemedVeecRebateProgram extends CiProjectRebateProgramCommon {
  victoria_region: CiVictoriaRegion | null;
  inverter_apparent_power_kva_per_kw_ac: number | null;
  inverter_apparent_power_source_label: string;
}

export interface CiProjectRebateProfile {
  contract_version: "ci_project_rebate_profile_v1";
  target_certificate_date: string;
  site_state_code: string;
  site_postcode: string;
  site_location_confirmed: boolean;
  site_location_source_label: string;
  stacking_confirmed: boolean;
  programs: {
    solar_stc: CiSolarStcRebateProgram;
    battery_stc: CiBatteryStcRebateProgram;
    vic_deemed_veec: CiVicDeemedVeecRebateProgram;
  };
}

export interface CiProjectRebateSiteEvidence {
  detected_site_address: string | null;
  state_code: string | null;
  postcode: string | null;
}

export interface CiProjectRebateBlocker {
  code: string;
  message: string;
}

export interface CiProjectRebateOfficialSource {
  source_id: string;
  label: string;
  url: string;
  status: "authoritative" | "proposal_not_enabled";
}

export interface CiProjectRebateRuleset {
  ruleset_id: string;
  ruleset_sha256: string;
  official_sources: CiProjectRebateOfficialSource[];
}

export interface CiProjectRebateProfileState {
  contract_version: "ci_project_rebate_profile_state_v1";
  status: CiProjectRebateProfileStatus;
  updated_at: string | null;
  approved_at: string | null;
  profile_sha256: string | null;
  profile: CiProjectRebateProfile | null;
  suggested_profile: CiProjectRebateProfile;
  site_evidence: CiProjectRebateSiteEvidence;
  blockers: CiProjectRebateBlocker[];
  ruleset: CiProjectRebateRuleset;
}

export interface CiProjectStcSettings {
  solarStcEnabled: boolean;
  solarStcPriceAudExGst: number;
  batteryStcEnabled: boolean;
  batteryStcPriceAudExGst: number;
}

export const ciProjectRebateProfileQueryKey = (projectId: string) =>
  ["ci-project-rebate-profile", projectId] as const;

export async function fetchCiProjectRebateProfile(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiProjectRebateProfileState> {
  const response = await fetcher(rebateProfileUrl(projectId), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Project rebate profile could not be loaded (${response.status}).`);
  }
  return assertCiProjectRebateProfileState(await response.json());
}

export async function saveCiProjectRebateProfile(
  projectId: string,
  input: { profile: CiProjectRebateProfile; approveForCalculation: boolean },
  fetcher: typeof fetch = fetch,
): Promise<CiProjectRebateProfileState> {
  const response = await fetcher(rebateProfileUrl(projectId), {
    method: "PUT",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: input.profile,
      approve_for_calculation: input.approveForCalculation,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(rebateProfileErrorMessage(payload, response.status));
  }
  return assertCiProjectRebateProfileState(await response.json());
}

export async function saveCiProjectStcSettings(
  projectId: string,
  input: CiProjectStcSettings,
  fetcher: typeof fetch = fetch,
): Promise<CiProjectRebateProfileState> {
  const response = await fetcher(`${rebateProfileUrl(projectId)}/stc-settings`, {
    method: "PUT",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      solar_stc_enabled: input.solarStcEnabled,
      solar_stc_price_aud_ex_gst: input.solarStcPriceAudExGst,
      battery_stc_enabled: input.batteryStcEnabled,
      battery_stc_price_aud_ex_gst: input.batteryStcPriceAudExGst,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(rebateProfileErrorMessage(payload, response.status));
  }
  return assertCiProjectRebateProfileState(await response.json());
}

export function assertCiProjectRebateProfileState(value: unknown): CiProjectRebateProfileState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contract_version",
    "status",
    "updated_at",
    "approved_at",
    "profile_sha256",
    "profile",
    "suggested_profile",
    "site_evidence",
    "blockers",
    "ruleset",
  ])) {
    throw unsafeContractError();
  }

  const status = value.status;
  const hasSavedProfile = status === "draft" || status === "approved" || status === "stale";
  if (
    value.contract_version !== "ci_project_rebate_profile_state_v1" ||
    !isOneOf(status, ["not_configured", "draft", "approved", "stale"]) ||
    !isNullableDateTime(value.updated_at) ||
    !isNullableDateTime(value.approved_at) ||
    !isProjectRebateProfile(value.suggested_profile) ||
    !isSiteEvidence(value.site_evidence) ||
    !Array.isArray(value.blockers) ||
    value.blockers.some((blocker) => !isBlocker(blocker)) ||
    !isRuleset(value.ruleset) ||
    (hasSavedProfile && (!isProjectRebateProfile(value.profile) || !isSha256(value.profile_sha256))) ||
    (!hasSavedProfile && (
      value.updated_at !== null ||
      value.approved_at !== null ||
      value.profile !== null ||
      value.profile_sha256 !== null
    )) ||
    (status === "draft" && (value.updated_at === null || value.approved_at !== null)) ||
    (status === "approved" && (value.updated_at === null || value.approved_at === null)) ||
    (status === "stale" && value.updated_at === null)
  ) {
    throw unsafeContractError();
  }
  return value as unknown as CiProjectRebateProfileState;
}

export function assertCiProjectRebateProfile(value: unknown): CiProjectRebateProfile {
  if (!isProjectRebateProfile(value)) {
    throw new Error("Imported JSON is not a supported project rebate profile.");
  }
  return value;
}

function rebateProfileUrl(projectId: string) {
  return `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/rebate-profile`;
}

function isProjectRebateProfile(value: unknown): value is CiProjectRebateProfile {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contract_version",
    "target_certificate_date",
    "site_state_code",
    "site_postcode",
    "site_location_confirmed",
    "site_location_source_label",
    "stacking_confirmed",
    "programs",
  ])) return false;

  if (!isRecord(value.programs) || !hasExactKeys(value.programs, ["solar_stc", "battery_stc", "vic_deemed_veec"])) {
    return false;
  }

  return (
    value.contract_version === "ci_project_rebate_profile_v1" &&
    isSupportedProfileDate(value.target_certificate_date) &&
    (value.site_state_code === "" || isOneOf(value.site_state_code, australianStateCodes)) &&
    (value.site_postcode === "" || isAustralianPostcode(value.site_postcode)) &&
    typeof value.site_location_confirmed === "boolean" &&
    isBoundedString(value.site_location_source_label, 240) &&
    typeof value.stacking_confirmed === "boolean" &&
    isSolarStcProgram(value.programs.solar_stc) &&
    isBatteryStcProgram(value.programs.battery_stc) &&
    isVicDeemedVeecProgram(value.programs.vic_deemed_veec)
  );
}

const commonProgramKeys = [
  "enabled",
  "eligibility_confirmed",
  "eligibility_source_label",
  "certificate_price_aud_ex_gst",
  "price_source_label",
  "price_as_of_date",
] as const;

const australianStateCodes = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"] as const;

function isSolarStcProgram(value: unknown): value is CiSolarStcRebateProgram {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, [...commonProgramKeys, "postcode_zone_rating", "zone_source_label"]) &&
    hasValidCommonProgramFields(value) &&
    (value.postcode_zone_rating === null || isSupportedSolarZoneRating(value.postcode_zone_rating)) &&
    isBoundedString(value.zone_source_label, 240)
  );
}

function isBatteryStcProgram(value: unknown): value is CiBatteryStcRebateProgram {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, [...commonProgramKeys, "certified_usable_capacity_fraction", "capacity_source_label"]) &&
    hasValidCommonProgramFields(value) &&
    (value.certified_usable_capacity_fraction === null ||
      isBoundedFinite(value.certified_usable_capacity_fraction, 1e-12, 1)) &&
    isBoundedString(value.capacity_source_label, 240)
  );
}

function isVicDeemedVeecProgram(value: unknown): value is CiVicDeemedVeecRebateProgram {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, [
      ...commonProgramKeys,
      "victoria_region",
      "inverter_apparent_power_kva_per_kw_ac",
      "inverter_apparent_power_source_label",
    ]) &&
    hasValidCommonProgramFields(value) &&
    (value.victoria_region === null || isOneOf(value.victoria_region, ["metropolitan", "regional"])) &&
    (value.inverter_apparent_power_kva_per_kw_ac === null ||
      isBoundedFinite(value.inverter_apparent_power_kva_per_kw_ac, 1, 10)) &&
    isBoundedString(value.inverter_apparent_power_source_label, 240)
  );
}

function hasValidCommonProgramFields(value: Record<string, unknown>) {
  return (
    typeof value.enabled === "boolean" &&
    typeof value.eligibility_confirmed === "boolean" &&
    isBoundedString(value.eligibility_source_label, 240) &&
    isBoundedFinite(value.certificate_price_aud_ex_gst, 0, 1_000_000) &&
    isBoundedString(value.price_source_label, 240) &&
    isSupportedProfileDate(value.price_as_of_date)
  );
}

function isSiteEvidence(value: unknown): value is CiProjectRebateSiteEvidence {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, ["detected_site_address", "state_code", "postcode"]) &&
    (value.detected_site_address === null || isNonEmptyString(value.detected_site_address)) &&
    (value.state_code === null || isOneOf(value.state_code, australianStateCodes)) &&
    (value.postcode === null || isAustralianPostcode(value.postcode))
  );
}

function isBlocker(value: unknown): value is CiProjectRebateBlocker {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    isNonEmptyBoundedString(value.code, 120) &&
    isNonEmptyBoundedString(value.message, 500)
  );
}

function isRuleset(value: unknown): value is CiProjectRebateRuleset {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, ["ruleset_id", "ruleset_sha256", "official_sources"]) &&
    isNonEmptyBoundedString(value.ruleset_id, 160) &&
    isSha256(value.ruleset_sha256) &&
    Array.isArray(value.official_sources) &&
    value.official_sources.length > 0 &&
    value.official_sources.every((source) => isOfficialSource(source))
  );
}

function isOfficialSource(value: unknown): value is CiProjectRebateOfficialSource {
  return Boolean(
    isRecord(value) &&
    hasExactKeys(value, ["source_id", "label", "url", "status"]) &&
    isNonEmptyBoundedString(value.source_id, 160) &&
    isNonEmptyBoundedString(value.label, 500) &&
    isHttpUrl(value.url) &&
    isOneOf(value.status, ["authoritative", "proposal_not_enabled"])
  );
}

function isSupportedProfileDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isAustralianPostcode(value: unknown) {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

function isSupportedSolarZoneRating(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    ciSolarStcZoneRatings.some((rating) => Math.abs(rating - value) <= 1e-9);
}

function isNullableDateTime(value: unknown) {
  return value === null || (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isHttpUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isBoundedFinite(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum;
}

function isNonEmptyBoundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function unsafeContractError() {
  return new Error("Project rebate profile returned an unsafe contract.");
}

function rebateProfileErrorMessage(value: unknown, status: number) {
  const detail = isRecord(value) ? value.detail : null;
  if (isRecord(detail)) {
    const message = detail.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (Array.isArray(detail)) {
    const message = detail
      .map((item) => isRecord(item) ? item.msg : null)
      .find((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (message) return message;
  }
  return `Project rebate profile could not be saved (${status}).`;
}

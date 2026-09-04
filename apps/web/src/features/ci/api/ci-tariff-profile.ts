export type CiProjectTariffProfileStatus = "not_available" | "draft" | "approved" | "stale";

export interface CiTariffWindow {
  start: string;
  end: string;
}

export interface CiProjectTariffProfile {
  contract_version: "ci_project_tariff_profile_v1";
  display_label: string;
  network_tariff_code: string;
  additional_bill_adjustment_aud?: number;
  rates: {
    retail_peak_c_per_kwh: number;
    retail_off_peak_c_per_kwh: number;
    incentive_demand_aud_per_kva_month: number;
    rolling_demand_aud_per_kva_month: number;
    network_peak_c_per_kwh: number;
    network_off_peak_c_per_kwh: number;
    aemo_ancillary_c_per_kwh: number;
    aemo_participant_c_per_kwh: number;
    aemo_frc_c_per_day: number;
    environmental_c_per_kwh: number;
    environmental_certificate_fraction: number;
    metering_aud_per_day: number;
    value_added_c_per_day: number;
  };
  factors: {
    mlf: number;
    dlf: number;
  };
  windows: {
    retail_energy: CiTariffWindow;
    network_energy: CiTariffWindow;
    rolling_demand: CiTariffWindow;
    incentive_demand: CiTariffWindow;
  };
  minimum_chargeable_rolling_kva: number;
}

export interface CiProjectTariffProfileState {
  contract_version: "ci_project_tariff_profile_state_v1";
  status: CiProjectTariffProfileStatus;
  updated_at: string | null;
  approved_at: string | null;
  profile_sha256: string | null;
  profile: CiProjectTariffProfile | null;
  suggested_profile: CiProjectTariffProfile | null;
  evidence_basis: {
    network_tariff_code: string | null;
    billing_period_start: string | null;
    billing_period_end: string | null;
    billing_days: number | null;
    billed_consumption_kwh: number | null;
    charge_categories_ex_gst_aud: Record<string, number> | null;
    derivation_notice: string;
  } | null;
  blockers: Array<{ code: string; message: string }>;
}

export const ciProjectTariffProfileQueryKey = (projectId: string) =>
  ["ci-project-tariff-profile", projectId] as const;

const TARIFF_PROFILE_SAVE_ATTEMPTS = 3;
const TARIFF_PROFILE_NETWORK_RETRY_DELAY_MS = 500;
const TARIFF_PROFILE_MAX_RETRY_DELAY_MS = 30_000;

export async function fetchCiProjectTariffProfile(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiProjectTariffProfileState> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/tariff-profile`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Project tariff profile could not be loaded (${response.status}).`);
  }
  return assertCiProjectTariffProfileState(await response.json());
}

export async function saveCiProjectTariffProfile(
  projectId: string,
  input: { profile: CiProjectTariffProfile; approveForCalculation: boolean },
  fetcher: typeof fetch = fetch,
): Promise<CiProjectTariffProfileState> {
  const url = `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/tariff-profile`;
  const body = JSON.stringify({
    profile: input.profile,
    approve_for_calculation: input.approveForCalculation,
  });
  for (let attempt = 0; attempt < TARIFF_PROFILE_SAVE_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("The project tariff profile could not be saved because the cloud connection was interrupted. Please try again.");
      }
      const confirmed = await confirmTariffProfileSave(url, input, fetcher);
      if (confirmed !== null) return confirmed;
      if (attempt + 1 >= TARIFF_PROFILE_SAVE_ATTEMPTS) {
        throw new Error("The project tariff profile could not be saved because the cloud connection was interrupted. Please try again.");
      }
      await waitForTariffProfileRetry(tariffProfileRetryDelay(null, attempt));
      continue;
    }
    if (response.ok) return assertCiProjectTariffProfileState(await response.json());

    const failure = await readTariffProfileFailure(response);
    if (isRecoverableTariffSaveFailure(response.status, failure.errorCode)) {
      const confirmed = await confirmTariffProfileSave(url, input, fetcher);
      if (confirmed !== null) return confirmed;
      if (attempt + 1 >= TARIFF_PROFILE_SAVE_ATTEMPTS) {
        throw new Error(tariffProfileErrorMessage(failure, response.status));
      }
      await waitForTariffProfileRetry(
        tariffProfileRetryDelay(response.headers.get("Retry-After"), attempt),
      );
      continue;
    }
    throw new Error(tariffProfileErrorMessage(failure, response.status));
  }
  throw new Error("The project tariff profile could not be saved.");
}

export function assertCiProjectTariffProfileState(value: unknown): CiProjectTariffProfileState {
  const state = value as CiProjectTariffProfileState;
  const hasSavedProfile = state?.status === "draft" || state?.status === "approved" || state?.status === "stale";
  if (
    !state ||
    state.contract_version !== "ci_project_tariff_profile_state_v1" ||
    !["not_available", "draft", "approved", "stale"].includes(state.status) ||
    !isNullableDateTime(state.updated_at) ||
    !isNullableDateTime(state.approved_at) ||
    !(state.suggested_profile === null || isTariffProfile(state.suggested_profile)) ||
    !(state.evidence_basis === null || isEvidenceBasis(state.evidence_basis)) ||
    !Array.isArray(state.blockers) ||
    state.blockers.some((item) => !isBlocker(item)) ||
    (hasSavedProfile && (!isTariffProfile(state.profile) || !isSha256(state.profile_sha256))) ||
    (!hasSavedProfile && (state.profile !== null || state.profile_sha256 !== null))
  ) {
    throw new Error("Project tariff profile returned an unsafe contract.");
  }
  return state;
}

function isEvidenceBasis(value: unknown) {
  const basis = value as CiProjectTariffProfileState["evidence_basis"];
  return Boolean(
    basis &&
    (basis.network_tariff_code === null || typeof basis.network_tariff_code === "string") &&
    (basis.billing_period_start === null || typeof basis.billing_period_start === "string") &&
    (basis.billing_period_end === null || typeof basis.billing_period_end === "string") &&
    (basis.billing_days === null || isNonNegativeFinite(basis.billing_days)) &&
    (basis.billed_consumption_kwh === null || isNonNegativeFinite(basis.billed_consumption_kwh)) &&
    (basis.charge_categories_ex_gst_aud === null || (
      typeof basis.charge_categories_ex_gst_aud === "object" &&
      Object.values(basis.charge_categories_ex_gst_aud).every((amount) => typeof amount === "number" && Number.isFinite(amount))
    )) &&
    isLabel(basis.derivation_notice, 1000)
  );
}

export function assertCiProjectTariffProfile(value: unknown): CiProjectTariffProfile {
  if (!isTariffProfile(value)) {
    throw new Error("Imported JSON is not a supported project tariff profile.");
  }
  return value;
}

function isTariffProfile(value: unknown): value is CiProjectTariffProfile {
  const profile = value as CiProjectTariffProfile;
  const rates = profile?.rates;
  const factors = profile?.factors;
  const windows = profile?.windows;
  const rateKeys = [
    "retail_peak_c_per_kwh",
    "retail_off_peak_c_per_kwh",
    "incentive_demand_aud_per_kva_month",
    "rolling_demand_aud_per_kva_month",
    "network_peak_c_per_kwh",
    "network_off_peak_c_per_kwh",
    "aemo_ancillary_c_per_kwh",
    "aemo_participant_c_per_kwh",
    "aemo_frc_c_per_day",
    "environmental_c_per_kwh",
    "environmental_certificate_fraction",
    "metering_aud_per_day",
    "value_added_c_per_day",
  ] as const;
  return Boolean(
    profile &&
    hasRequiredKeysAndNoOthers(
      profile,
      ["contract_version", "display_label", "network_tariff_code", "rates", "factors", "windows", "minimum_chargeable_rolling_kva"],
      ["additional_bill_adjustment_aud"],
    ) &&
    profile.contract_version === "ci_project_tariff_profile_v1" &&
    isLabel(profile.display_label, 160) &&
    isLabel(profile.network_tariff_code, 64) &&
    (profile.additional_bill_adjustment_aud === undefined || isBoundedFinite(profile.additional_bill_adjustment_aud, -1_000_000, 1_000_000)) &&
    rates &&
    hasExactKeys(rates, rateKeys) &&
    rateKeys.every((key) => isBoundedFinite(rates[key], 0, 1_000_000)) &&
    rates.environmental_certificate_fraction <= 1 &&
    factors &&
    hasExactKeys(factors, ["mlf", "dlf"]) &&
    isBoundedFinite(factors.mlf, 0.01, 5) &&
    isBoundedFinite(factors.dlf, 0.01, 5) &&
    windows &&
    hasExactKeys(windows, ["retail_energy", "network_energy", "rolling_demand", "incentive_demand"]) &&
    isWindow(windows.retail_energy) &&
    isWindow(windows.network_energy) &&
    isWindow(windows.rolling_demand) &&
    isWindow(windows.incentive_demand) &&
    isBoundedFinite(profile.minimum_chargeable_rolling_kva, 0, 1_000_000)
  );
}

function isWindow(value: unknown): value is CiTariffWindow {
  const window = value as CiTariffWindow;
  return Boolean(
    window &&
    hasExactKeys(window, ["start", "end"]) &&
    isTime(window.start) &&
    isTime(window.end) &&
    window.start < window.end,
  );
}

function isTime(value: unknown) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isLabel(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isBoundedFinite(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isNonNegativeFinite(value: unknown) {
  return isBoundedFinite(value, 0, Number.MAX_SAFE_INTEGER);
}

function hasExactKeys(value: object, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasRequiredKeysAndNoOthers(value: object, required: readonly string[], optional: readonly string[]) {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && actual.every((key) => required.includes(key) || optional.includes(key));
}

function isNullableDateTime(value: unknown) {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isBlocker(value: unknown) {
  const blocker = value as { code?: unknown; message?: unknown };
  return Boolean(blocker && isLabel(blocker.code, 120) && isLabel(blocker.message, 500));
}

interface TariffProfileFailure {
  errorCode: string | null;
  message: string | null;
  requestId: string | null;
}

async function readTariffProfileFailure(response: Response): Promise<TariffProfileFailure> {
  const body = await response.text().catch(() => "");
  if (!body) return { errorCode: null, message: null, requestId: null };
  try {
    const payload = JSON.parse(body) as {
      detail?: unknown;
      error_code?: unknown;
      message?: unknown;
      request_id?: unknown;
    };
    const detail = payload.detail;
    const detailCode = detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as { code?: unknown }).code
      : null;
    const detailMessage = detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as { message?: unknown }).message
      : typeof detail === "string"
        ? detail
        : null;
    const validationMessage = Array.isArray(detail)
      ? detail
        .map((item) => (item as { msg?: unknown })?.msg)
        .find((item) => typeof item === "string" && item.trim())
      : null;
    return {
      errorCode: typeof payload.error_code === "string"
        ? payload.error_code
        : typeof detailCode === "string"
          ? detailCode
          : null,
      message: typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : typeof detailMessage === "string" && detailMessage.trim()
          ? detailMessage
          : typeof validationMessage === "string"
            ? validationMessage
            : null,
      requestId: typeof payload.request_id === "string" && payload.request_id.trim()
        ? payload.request_id
        : null,
    };
  } catch {
    return { errorCode: null, message: null, requestId: null };
  }
}

function tariffProfileErrorMessage(failure: TariffProfileFailure, status: number) {
  const message = failure.message ?? `Project tariff profile could not be saved (${status}).`;
  if (!failure.requestId) return message;
  return `${message} Request ID: ${failure.requestId}.`;
}

function isRecoverableContainerFailure(errorCode: string | null) {
  return errorCode === "container_provisioning"
    || errorCode === "container_start_timeout"
    || errorCode === "container_unavailable";
}

function isRecoverableTariffSaveFailure(status: number, errorCode: string | null) {
  return status === 503 && isRecoverableContainerFailure(errorCode);
}

async function confirmTariffProfileSave(
  url: string,
  input: { profile: CiProjectTariffProfile; approveForCalculation: boolean },
  fetcher: typeof fetch,
): Promise<CiProjectTariffProfileState | null> {
  try {
    const response = await fetcher(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const state = assertCiProjectTariffProfileState(await response.json());
    const expectedStatus = input.approveForCalculation ? "approved" : "draft";
    if (state.status !== expectedStatus || state.profile === null) return null;
    return sameJsonValue(state.profile, input.profile) ? state : null;
  } catch {
    return null;
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (
    left === null || right === null
    || typeof left !== "object" || typeof right !== "object"
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && sameJsonValue(leftRecord[key], rightRecord[key])
    ));
}

function tariffProfileRetryDelay(retryAfter: string | null, attempt: number) {
  if (retryAfter === null) {
    return Math.min(
      TARIFF_PROFILE_MAX_RETRY_DELAY_MS,
      TARIFF_PROFILE_NETWORK_RETRY_DELAY_MS * (2 ** attempt),
    );
  }
  const seconds = Number(retryAfter);
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(requestedDelay)) {
    return tariffProfileRetryDelay(null, attempt);
  }
  return Math.min(TARIFF_PROFILE_MAX_RETRY_DELAY_MS, Math.max(0, requestedDelay));
}

async function waitForTariffProfileRetry(delayMs: number) {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

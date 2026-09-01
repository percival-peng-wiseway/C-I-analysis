export interface CiEvidenceIntakeResult {
  contract_version: "ci_evidence_intake_v7" | "ci_evidence_intake_v8" | "ci_evidence_intake_v9" | "ci_evidence_intake_v10";
  intake_status: "ready_for_profile_review" | "action_required";
  bill: {
    fingerprint: string;
    retailer: string;
    invoice_kind: string;
    extraction_method: string;
    review_status: "not_required" | "confirmation_required" | "analyst_confirmed";
    missing_fields: string[];
    invoice_arithmetic_scope: "charge_categories_and_totals" | "invoice_totals_only";
    site_identity_status: "extracted" | "missing";
    site_address?: string | null;
    billing_period_start: string | null;
    billing_period_end: string | null;
    billing_days: number | null;
    network_tariff_code: string | null;
    consumption_kwh: number | null;
    highest_metered_demand_kva: number | null;
    power_factor_at_highest_demand: number | null;
    charge_categories_ex_gst_aud: Record<string, number>;
    subtotal_ex_gst_aud: number | null;
    gst_aud: number | null;
    total_inc_gst_aud: number | null;
  };
  nem12: {
    fingerprint: string;
    input_format: "nem12_standard" | "wide_interval_30_minute";
    coverage_start: string;
    coverage_end: string;
    interval_minutes: number;
    stream_ids: string[];
    aligned_stream_ids: string[];
    missing_stream_ids: string[];
    unaligned_stream_ids: string[];
    capability_status: "active_import_only" | "active_import_export" | "active_reactive_import" | "full_active_reactive_import_export" | "measured_active_demand" | "measured_apparent_demand";
    full_tariff_analysis_ready: boolean;
    days_per_stream: number;
    quality_method_counts: Record<string, number>;
    quality_override_count: number;
  };
  pair_checks: Array<{ code: string; passed: boolean; severity: "pass" | "warning" | "error"; message: string }>;
  annual_demand_heatmap: {
    metric: "measured_apparent_demand" | "measured_active_demand";
    source_streams: string[];
    unit: "kVA" | "kW";
    reactive_data_status: "available" | "unavailable_active_only" | "reported_apparent_demand";
    interval_minutes: 15 | 30;
    time_basis: "fixed_aest_meter_time" | "source_local_time_unverified";
    tariff_window_status: "not_applied_pre_tariff";
    shared_scale_maximum_demand: number;
    years: Array<{
      year: number;
      coverage_start: string;
      coverage_end: string;
      day_count: number;
      complete_calendar_year: boolean;
      interval_count: number;
      expected_interval_count: number;
      missing_interval_count: number;
      maximum_interval_demand: number;
      average_interval_demand: number;
      days: Array<{ date: string; interval_demand: Array<number | null> }>;
    }>;
  };
  detected_tariff?: CiDetectedTariff;
  annual_bill_estimate?: CiAnnualBillEstimate;
  next_steps: string[];
  privacy: {
    files_persisted: true;
    customer_identifiers_returned: boolean;
    customer_facing_permission: false;
  };
}

export interface CiDetectedTariffItem {
  key: string;
  label: string;
  source_amount_ex_gst_aud: number;
  basis_label: string;
  rate_label: string;
}

export interface CiDetectedTariffGroup {
  key: "fixed" | "other_usage" | "energy_import";
  label: string;
  items: CiDetectedTariffItem[];
}

export interface CiDetectedTariff {
  status: "category_totals_detected" | "review_required";
  tariff_code: string | null;
  tax_basis: "ex_gst";
  warning: string;
  groups: CiDetectedTariffGroup[];
}

export interface CiAnnualBillEstimateV9Unavailable {
  status: "unavailable";
  method: "approved_tariff_replay_required" | "unavailable";
  confidence: "unavailable";
  tariff_code: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  annual_import_kwh: number | null;
  total_ex_gst_aud: number | null;
  customer_facing_permission: false;
  warning: string;
  assumptions: string[];
  groups: [];
}

export interface CiBillPeriodReconciliation {
  status: "pass" | "failed" | "unavailable";
  coverage_complete: boolean;
  billing_period_start: string | null;
  billing_period_end: string | null;
  billing_days: number | null;
  interval_import_kwh: number | null;
  billed_consumption_kwh: number | null;
  difference_kwh: number | null;
  difference_percent: number | null;
  tolerance_percent: 2;
  warning: string;
}

export interface CiAnnualBillEstimateV10Unavailable {
  status: "unavailable";
  method: "unavailable";
  confidence: "unavailable";
  tariff_code: string | null;
  coverage_start: null;
  coverage_end: null;
  annual_import_kwh: null;
  bill_period_reconciliation: CiBillPeriodReconciliation;
  total_ex_gst_aud: null;
  customer_facing_permission: false;
  warning: string;
  assumptions: string[];
  groups: [];
}

export interface CiAnnualBillEstimateItem {
  key: string;
  label: string;
  source_amount_ex_gst_aud: number;
  scaling_basis: "365_days_over_billing_days" | "annual_import_kwh_over_billed_consumption_kwh" | "excluded_unverified_recurrence";
  scaling_factor: number;
  annual_amount_ex_gst_aud: number;
}

export interface CiAnnualBillEstimateGroup {
  key: "fixed" | "other_usage" | "energy_import";
  label: string;
  total_ex_gst_aud: number;
  items: CiAnnualBillEstimateItem[];
}

export interface CiAnnualBillEstimateEstimated {
  status: "estimated";
  method: "bill_derived_interval_scaled_v1";
  confidence: "evidence_limited";
  tariff_code: string | null;
  coverage_start: string;
  coverage_end: string;
  annual_import_kwh: number;
  bill_period_reconciliation: CiBillPeriodReconciliation & {
    status: "pass";
    coverage_complete: true;
    billing_period_start: string;
    billing_period_end: string;
    billing_days: number;
    interval_import_kwh: number;
    billed_consumption_kwh: number;
    difference_kwh: number;
    difference_percent: number;
  };
  total_ex_gst_aud: number;
  customer_facing_permission: false;
  warning: string;
  assumptions: string[];
  groups: CiAnnualBillEstimateGroup[];
}

export type CiAnnualBillEstimate = CiAnnualBillEstimateV9Unavailable | CiAnnualBillEstimateV10Unavailable | CiAnnualBillEstimateEstimated;

export interface CiProjectEvidenceState {
  contract_version: "ci_project_evidence_state_v1";
  status: "not_saved" | "saved";
  evidence: null | {
    saved_at: string;
    files: {
      bill: CiSavedEvidenceFile;
      interval: CiSavedEvidenceFile;
    };
    inspection: CiEvidenceIntakeResult;
  };
}

export interface CiSavedEvidenceFile {
  filename: string;
  content_type: string;
  size_bytes: number;
}

export const ciProjectEvidenceQueryKey = (projectId: string) => ["ci-project-evidence", projectId] as const;

export interface CiBillReviewInput {
  confirmed: true;
  retailer: string;
  invoice_kind: string;
  nmi?: string;
  billing_period_start: string;
  billing_period_end: string;
  network_tariff_code: string;
  consumption_kwh: number;
  highest_metered_demand_kva: number;
  power_factor_at_highest_demand: number;
  subtotal_ex_gst_aud: number;
  gst_aud: number;
  total_inc_gst_aud: number;
}

export async function inspectCiEvidencePair(
  projectId: string,
  bill: File,
  nem12: File,
  fetcher: typeof fetch = fetch,
  billReview?: CiBillReviewInput,
): Promise<CiEvidenceIntakeResult> {
  const body = new FormData();
  body.append("bill", bill);
  body.append("nem12", nem12);
  if (billReview) body.append("bill_review_payload", JSON.stringify(billReview));
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/evidence-intake/inspect`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Evidence intake failed with status ${response.status}.`);
  }
  const payload = (await response.json()) as CiEvidenceIntakeResult;
  if (!isSafePersistedResult(payload)) {
    throw new Error("Evidence intake returned an unsafe or incomplete result contract.");
  }
  return payload;
}

export async function fetchCiProjectEvidence(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiProjectEvidenceState> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/evidence-intake`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Saved project evidence could not be loaded (${response.status}).`);
  const payload = (await response.json()) as CiProjectEvidenceState;
  const validEvidence = payload.status === "not_saved"
    ? payload.evidence === null
    : payload.status === "saved" && isSafeSavedEvidence(payload.evidence);
  if (payload.contract_version !== "ci_project_evidence_state_v1" || !validEvidence) {
    throw new Error("Saved project evidence returned an unsafe or incomplete contract.");
  }
  return payload;
}

export async function reviewSavedCiEvidence(
  projectId: string,
  billReview: CiBillReviewInput,
  fetcher: typeof fetch = fetch,
): Promise<CiEvidenceIntakeResult> {
  const response = await fetcher(`/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/evidence-intake/review`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(billReview),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Saved evidence review failed with status ${response.status}.`);
  }
  const payload = (await response.json()) as CiEvidenceIntakeResult;
  if (!isSafePersistedResult(payload)) {
    throw new Error("Saved evidence review returned an unsafe or incomplete result contract.");
  }
  return payload;
}

function isSafeSavedEvidence(value: CiProjectEvidenceState["evidence"]): boolean {
  return Boolean(
    value &&
    !Number.isNaN(Date.parse(value.saved_at)) &&
    isSafeSavedFile(value.files?.bill) &&
    isSafeSavedFile(value.files?.interval) &&
    isSafePersistedResult(value.inspection),
  );
}

function isSafeSavedFile(value: CiSavedEvidenceFile | undefined): boolean {
  return Boolean(
    value &&
    typeof value.filename === "string" && value.filename.length > 0 && value.filename.length <= 255 &&
    typeof value.content_type === "string" && value.content_type.length > 0 && value.content_type.length <= 128 &&
    Number.isInteger(value.size_bytes) && value.size_bytes > 0,
  );
}

function isSafePersistedResult(payload: CiEvidenceIntakeResult): boolean {
  const returnedAddress = typeof payload.bill?.site_address === "string" && payload.bill.site_address.trim().length > 0;
  return !(
    !["ci_evidence_intake_v7", "ci_evidence_intake_v8", "ci_evidence_intake_v9", "ci_evidence_intake_v10"].includes(payload.contract_version) ||
    !["ready_for_profile_review", "action_required"].includes(payload.intake_status) ||
    payload.privacy?.files_persisted !== true ||
    typeof payload.privacy?.customer_identifiers_returned !== "boolean" ||
    (payload.contract_version === "ci_evidence_intake_v7" && payload.privacy.customer_identifiers_returned !== false) ||
    (["ci_evidence_intake_v8", "ci_evidence_intake_v9", "ci_evidence_intake_v10"].includes(payload.contract_version) && payload.privacy.customer_identifiers_returned !== returnedAddress) ||
    payload.privacy?.customer_facing_permission !== false ||
    !Array.isArray(payload.pair_checks) ||
    !Array.isArray(payload.nem12?.stream_ids) ||
    !Array.isArray(payload.nem12?.aligned_stream_ids) ||
    !Array.isArray(payload.nem12?.missing_stream_ids) ||
    !Array.isArray(payload.nem12?.unaligned_stream_ids) ||
    !["nem12_standard", "wide_interval_30_minute"].includes(payload.nem12.input_format) ||
    (payload.nem12.input_format === "nem12_standard" && (!payload.nem12.stream_ids.includes("E1") || !payload.nem12.aligned_stream_ids.includes("E1"))) ||
    (payload.nem12.input_format === "wide_interval_30_minute" && !payload.nem12.aligned_stream_ids.some((item) => item === "kW" || item === "kVA")) ||
    !["active_import_only", "active_import_export", "active_reactive_import", "full_active_reactive_import_export", "measured_active_demand", "measured_apparent_demand"].includes(payload.nem12.capability_status) ||
    typeof payload.nem12.full_tariff_analysis_ready !== "boolean" ||
    payload.nem12.full_tariff_analysis_ready !== (payload.nem12.input_format === "nem12_standard" && ["B1", "E1", "K1", "Q1"].every((stream) => payload.nem12.aligned_stream_ids.includes(stream))) ||
    payload.pair_checks.some((check) => !["pass", "warning", "error"].includes(check.severity) || check.passed !== (check.severity !== "error")) ||
    !isSafeBill(payload.bill) ||
    (payload.contract_version === "ci_evidence_intake_v9" && (
      !isSafeDetectedTariff(payload.detected_tariff) ||
      !isSafeV9AnnualBillEstimate(payload.annual_bill_estimate) ||
      !isSafeV9CrossFields(payload)
    )) ||
    (payload.contract_version === "ci_evidence_intake_v10" && (
      !isSafeDetectedTariff(payload.detected_tariff) ||
      !isSafeV10AnnualBillEstimate(payload.annual_bill_estimate) ||
      !isSafeV10CrossFields(payload)
    )) ||
    !isSafeAnnualDemandHeatmap(payload.annual_demand_heatmap)
  );
}

function isSafeDetectedTariff(value: CiDetectedTariff | undefined) {
  return Boolean(
    value &&
    ["category_totals_detected", "review_required"].includes(value.status) &&
    (value.tariff_code === null || isSafeLabel(value.tariff_code, 80)) &&
    value.tax_basis === "ex_gst" &&
    isSafeLabel(value.warning, 2_000) &&
    isSafeDetectedTariffGroups(value.groups) &&
    (value.status === "category_totals_detected" ? value.groups.length === 3 : value.groups.length === 0),
  );
}

function isSafeV9AnnualBillEstimate(value: CiAnnualBillEstimate | undefined) {
  const optionalNonNegativeFinite = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item) && item >= 0);
  return Boolean(
    value &&
    value.status === "unavailable" &&
    ["approved_tariff_replay_required", "unavailable"].includes(value.method) &&
    value.confidence === "unavailable" &&
    (value.tariff_code === null || isSafeLabel(value.tariff_code, 80)) &&
    (value.coverage_start === null || /^\d{4}-\d{2}-\d{2}$/.test(value.coverage_start)) &&
    (value.coverage_end === null || /^\d{4}-\d{2}-\d{2}$/.test(value.coverage_end)) &&
    optionalNonNegativeFinite(value.annual_import_kwh) &&
    optionalNonNegativeFinite(value.total_ex_gst_aud) &&
    value.customer_facing_permission === false &&
    isSafeLabel(value.warning, 2_000) &&
    Array.isArray(value.assumptions) && value.assumptions.every((item) => isSafeLabel(item, 2_000)) &&
    Array.isArray(value.groups) &&
    value.total_ex_gst_aud === null &&
    value.groups.length === 0 &&
    ((value.method === "unavailable" &&
      value.coverage_start === null &&
      value.coverage_end === null &&
      value.annual_import_kwh === null) ||
     (value.method === "approved_tariff_replay_required" &&
      value.coverage_start !== null &&
      value.coverage_end !== null &&
      value.annual_import_kwh !== null)),
  );
}

function isSafeV10AnnualBillEstimate(value: CiAnnualBillEstimate | undefined) {
  if (!value || value.customer_facing_permission !== false || !isSafeLabel(value.warning, 2_000)) return false;
  if (!Array.isArray(value.assumptions) || !value.assumptions.every((item) => isSafeLabel(item, 2_000))) return false;
  if (value.tariff_code !== null && !isSafeLabel(value.tariff_code, 80)) return false;
  if (value.status === "unavailable") {
    if (!("bill_period_reconciliation" in value)) return false;
    return value.method === "unavailable" &&
      value.confidence === "unavailable" &&
      value.coverage_start === null &&
      value.coverage_end === null &&
      value.annual_import_kwh === null &&
      value.total_ex_gst_aud === null &&
      isSafeBillPeriodReconciliation(value.bill_period_reconciliation) &&
      Array.isArray(value.groups) && value.groups.length === 0;
  }
  return value.status === "estimated" &&
    value.method === "bill_derived_interval_scaled_v1" &&
    value.confidence === "evidence_limited" &&
    isIsoDate(value.coverage_start) &&
    isIsoDate(value.coverage_end) &&
    isPositiveFinite(value.annual_import_kwh) &&
    isNonNegativeFinite(value.total_ex_gst_aud) &&
    isSafeEstimatedReconciliation(value.bill_period_reconciliation) &&
    isSafeAnnualBillGroups(value.groups, value) &&
    moneyMatches(value.total_ex_gst_aud, value.groups.reduce((total, group) => total + group.total_ex_gst_aud, 0));
}

function isSafeBillPeriodReconciliation(value: CiBillPeriodReconciliation | undefined) {
  if (!value || !["pass", "failed", "unavailable"].includes(value.status)) return false;
  if (typeof value.coverage_complete !== "boolean" || value.tolerance_percent !== 2 || !isSafeLabel(value.warning, 2_000)) return false;
  if (value.billing_period_start !== null && !isIsoDate(value.billing_period_start)) return false;
  if (value.billing_period_end !== null && !isIsoDate(value.billing_period_end)) return false;
  if (value.billing_days !== null && (!Number.isInteger(value.billing_days) || value.billing_days < 0)) return false;
  if (value.billed_consumption_kwh !== null && !isNonNegativeFinite(value.billed_consumption_kwh)) return false;
  if (value.status === "unavailable") {
    return value.coverage_complete === false &&
      value.interval_import_kwh === null &&
      value.difference_kwh === null &&
      value.difference_percent === null;
  }
  if (
    value.coverage_complete !== true ||
    !isIsoDate(value.billing_period_start) ||
    !isIsoDate(value.billing_period_end) ||
    typeof value.billing_days !== "number" || !Number.isInteger(value.billing_days) || value.billing_days <= 0 ||
    !isNonNegativeFinite(value.interval_import_kwh) ||
    !isPositiveFinite(value.billed_consumption_kwh) ||
    typeof value.difference_kwh !== "number" || !Number.isFinite(value.difference_kwh) ||
    !isNonNegativeFinite(value.difference_percent)
  ) return false;
  const calculatedDifference = value.interval_import_kwh - value.billed_consumption_kwh;
  const calculatedPercent = Math.abs(calculatedDifference) / value.billed_consumption_kwh * 100;
  if (!numberMatches(value.difference_kwh, calculatedDifference, 0.0011) || !numberMatches(value.difference_percent, calculatedPercent, 0.000_001_1)) return false;
  return value.status === "pass"
    ? value.billing_days >= 20 && value.billing_days <= 45 && value.difference_percent <= value.tolerance_percent
    : value.difference_percent > value.tolerance_percent;
}

function isSafeEstimatedReconciliation(value: CiBillPeriodReconciliation | undefined) {
  return isSafeBillPeriodReconciliation(value) && value?.status === "pass" && value.coverage_complete === true;
}

const V10_ANNUAL_GROUP_SPECS = {
  fixed: {
    label: "Fixed",
    items: { metering_charges: { label: "Metering charges", scalingBasis: "365_days_over_billing_days" } },
  },
  other_usage: {
    label: "Other usage",
    items: {
      network_charges: { label: "Network charges", scalingBasis: "365_days_over_billing_days" },
      regulated_charges: { label: "Regulated charges", scalingBasis: "annual_import_kwh_over_billed_consumption_kwh" },
      environmental_charges: { label: "Environmental charges", scalingBasis: "annual_import_kwh_over_billed_consumption_kwh" },
      additional_charges: { label: "Additional charges, credits & adjustments", scalingBasis: "excluded_unverified_recurrence" },
    },
  },
  energy_import: {
    label: "Energy (Import)",
    items: { energy_charges: { label: "Energy charges", scalingBasis: "annual_import_kwh_over_billed_consumption_kwh" } },
  },
} as const;

function isSafeAnnualBillGroups(value: CiAnnualBillEstimateGroup[] | undefined, estimate: CiAnnualBillEstimateEstimated) {
  const allowedKeys = new Set(Object.keys(V10_ANNUAL_GROUP_SPECS));
  return Boolean(
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((group) => group && typeof group === "object") &&
    new Set(value.map((group) => group.key)).size === value.length &&
    value.every((group) => {
      if (!allowedKeys.has(group.key)) return false;
      const spec = V10_ANNUAL_GROUP_SPECS[group.key];
      const expectedItemKeys = Object.keys(spec.items);
      return group.label === spec.label &&
        Number.isFinite(group.total_ex_gst_aud) &&
        Array.isArray(group.items) &&
        group.items.length === expectedItemKeys.length &&
        group.items.every((item) => item && typeof item === "object") &&
        new Set(group.items.map((item) => item.key)).size === group.items.length &&
        group.items.every((item) => expectedItemKeys.includes(item.key) && isSafeAnnualBillItem(item, group.key, estimate)) &&
        moneyMatches(group.total_ex_gst_aud, group.items.reduce((total, item) => total + item.annual_amount_ex_gst_aud, 0));
    }),
  );
}

function isSafeAnnualBillItem(item: CiAnnualBillEstimateItem, groupKey: CiAnnualBillEstimateGroup["key"], estimate: CiAnnualBillEstimateEstimated) {
  const spec = v10AnnualItemSpec(groupKey, item.key);
  if (!spec || item.label !== spec.label || item.scaling_basis !== spec.scalingBasis) return false;
  if (!(
    Number.isFinite(item.source_amount_ex_gst_aud) &&
    isNonNegativeFinite(item.scaling_factor) &&
    Number.isFinite(item.annual_amount_ex_gst_aud)
  )) return false;
  if (item.scaling_basis === "excluded_unverified_recurrence") {
    return item.scaling_factor === 0 && item.annual_amount_ex_gst_aud === 0;
  }
  const expectedFactor = item.scaling_basis === "365_days_over_billing_days"
    ? 365 / estimate.bill_period_reconciliation.billing_days
    : estimate.annual_import_kwh / estimate.bill_period_reconciliation.billed_consumption_kwh;
  return isPositiveFinite(item.scaling_factor) &&
    (item.scaling_basis !== "annual_import_kwh_over_billed_consumption_kwh" || expectedFactor <= 25) &&
    numberMatches(item.scaling_factor, expectedFactor, 0.000_000_001_1) &&
    moneyMatches(item.annual_amount_ex_gst_aud, item.source_amount_ex_gst_aud * item.scaling_factor);
}

function v10AnnualItemSpec(groupKey: CiAnnualBillEstimateGroup["key"], itemKey: string) {
  return (V10_ANNUAL_GROUP_SPECS[groupKey].items as Record<string, {
    readonly label: string;
    readonly scalingBasis: CiAnnualBillEstimateItem["scaling_basis"];
  }>)[itemKey];
}

function isSafeV10SourceAlignment(payload: CiEvidenceIntakeResult, annual: CiAnnualBillEstimateEstimated) {
  const detected = payload.detected_tariff;
  if (!detected || detected.groups.length !== 3) return false;
  return detected.groups.every((detectedGroup) => {
    const groupSpec = V10_ANNUAL_GROUP_SPECS[detectedGroup.key];
    const expectedKeys = Object.keys(groupSpec.items);
    const annualGroup = annual.groups.find((group) => group.key === detectedGroup.key);
    if (
      detectedGroup.label !== groupSpec.label ||
      detectedGroup.items.length !== expectedKeys.length ||
      new Set(detectedGroup.items.map((item) => item.key)).size !== expectedKeys.length ||
      !annualGroup
    ) return false;
    return detectedGroup.items.every((detectedItem) => {
      const itemSpec = v10AnnualItemSpec(detectedGroup.key, detectedItem.key);
      const annualItem = annualGroup.items.find((item) => item.key === detectedItem.key);
      const billAmount = payload.bill.charge_categories_ex_gst_aud[detectedItem.key];
      return itemSpec !== undefined &&
        detectedItem.label === itemSpec.label &&
        annualItem !== undefined &&
        typeof billAmount === "number" && Number.isFinite(billAmount) &&
        moneyMatches(detectedItem.source_amount_ex_gst_aud, billAmount) &&
        moneyMatches(annualItem.source_amount_ex_gst_aud, billAmount);
    });
  });
}

function isSafeV9CrossFields(payload: CiEvidenceIntakeResult) {
  const detected = payload.detected_tariff;
  const annual = payload.annual_bill_estimate;
  if (!detected || !annual) return false;
  if (detected.tariff_code !== payload.bill.network_tariff_code || annual.tariff_code !== payload.bill.network_tariff_code) return false;
  if (annual.method !== "approved_tariff_replay_required") return true;
  const requiredChecks = new Set(["site_identity_match", "bill_period_covered", "invoice_arithmetic", "bill_review_confirmed"]);
  const passedChecks = new Set(payload.pair_checks.filter((check) => check.passed).map((check) => check.code));
  if (![...requiredChecks].every((code) => passedChecks.has(code))) return false;
  if (!annual.coverage_start || !annual.coverage_end) return false;
  const coverageDays = (Date.parse(`${annual.coverage_end}T00:00:00Z`) - Date.parse(`${annual.coverage_start}T00:00:00Z`)) / 86_400_000 + 1;
  return coverageDays === 365 && annual.coverage_start >= payload.nem12.coverage_start && annual.coverage_end <= payload.nem12.coverage_end;
}

function isSafeV10CrossFields(payload: CiEvidenceIntakeResult) {
  const detected = payload.detected_tariff;
  const annual = payload.annual_bill_estimate;
  if (!detected || !annual) return false;
  if (detected.tariff_code !== payload.bill.network_tariff_code || annual.tariff_code !== payload.bill.network_tariff_code) return false;
  if (annual.status === "unavailable") return true;
  if (detected.status !== "category_totals_detected" || !annual.tariff_code) return false;
  const requiredChecks = new Set(["site_identity_match", "bill_period_covered", "invoice_arithmetic", "bill_review_confirmed"]);
  const passedChecks = new Set(payload.pair_checks.filter((check) => check.passed).map((check) => check.code));
  if (![...requiredChecks].every((code) => passedChecks.has(code))) return false;
  const coverageDays = (Date.parse(`${annual.coverage_end}T00:00:00Z`) - Date.parse(`${annual.coverage_start}T00:00:00Z`)) / 86_400_000 + 1;
  if (
    coverageDays !== 365 ||
    payload.nem12.input_format !== "nem12_standard" ||
    !payload.nem12.aligned_stream_ids.includes("E1") ||
    annual.coverage_start < payload.nem12.coverage_start ||
    annual.coverage_end > payload.nem12.coverage_end ||
    !isSafeV10SourceAlignment(payload, annual)
  ) return false;
  const reconciliation = annual.bill_period_reconciliation;
  const reconciliationDays = (Date.parse(`${reconciliation.billing_period_end}T00:00:00Z`) - Date.parse(`${reconciliation.billing_period_start}T00:00:00Z`)) / 86_400_000 + 1;
  return reconciliation.billing_period_start === payload.bill.billing_period_start &&
    reconciliation.billing_period_end === payload.bill.billing_period_end &&
    reconciliation.billing_days === payload.bill.billing_days &&
    reconciliationDays === reconciliation.billing_days &&
    numberMatches(reconciliation.billed_consumption_kwh, payload.bill.consumption_kwh ?? Number.NaN, 0.0011) &&
    reconciliation.billing_period_start >= annual.coverage_start &&
    reconciliation.billing_period_end <= annual.coverage_end;
}

function isSafeDetectedTariffGroups(value: CiDetectedTariffGroup[] | undefined) {
  const allowedKeys = new Set(["fixed", "other_usage", "energy_import"]);
  return Boolean(
    Array.isArray(value) &&
    value.every((group) => group && typeof group === "object") &&
    new Set(value.map((group) => group.key)).size === value.length &&
    value.every((group) =>
      allowedKeys.has(group.key) &&
      isSafeLabel(group.label, 160) &&
      Array.isArray(group.items) &&
      group.items.every((item) => item && typeof item === "object") &&
      new Set(group.items.map((item) => item.key)).size === group.items.length &&
      group.items.every((item) =>
        isSafeLabel(item.key, 160) &&
        isSafeLabel(item.label, 240) &&
        isSafeLabel(item.basis_label, 1_000) &&
        isSafeLabel(item.rate_label, 1_000) &&
        Number.isFinite(item.source_amount_ex_gst_aud),
      ),
    ),
  );
}

function isSafeLabel(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isIsoDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function moneyMatches(expected: number, actual: number, tolerance = 0.011) {
  return numberMatches(expected, actual, tolerance);
}

function numberMatches(expected: number, actual: number, tolerance: number) {
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance;
}

function isSafeBill(value: CiEvidenceIntakeResult["bill"] | undefined) {
  const optionalFinite = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item) && item >= 0);
  return Boolean(
    value &&
    typeof value.retailer === "string" &&
    typeof value.invoice_kind === "string" &&
    ["not_required", "confirmation_required", "analyst_confirmed"].includes(value.review_status) &&
    ["charge_categories_and_totals", "invoice_totals_only"].includes(value.invoice_arithmetic_scope) &&
    ["extracted", "missing"].includes(value.site_identity_status) &&
    (value.site_address === undefined || value.site_address === null || (typeof value.site_address === "string" && value.site_address.trim().length > 0 && value.site_address.length <= 240)) &&
    Array.isArray(value.missing_fields) &&
    optionalFinite(value.billing_days) &&
    optionalFinite(value.consumption_kwh) &&
    optionalFinite(value.highest_metered_demand_kva) &&
    optionalFinite(value.power_factor_at_highest_demand) &&
    (value.power_factor_at_highest_demand === null || value.power_factor_at_highest_demand <= 1) &&
    optionalFinite(value.subtotal_ex_gst_aud) &&
    optionalFinite(value.gst_aud) &&
    optionalFinite(value.total_inc_gst_aud)
  );
}

function isSafeAnnualDemandHeatmap(
  value: CiEvidenceIntakeResult["annual_demand_heatmap"] | undefined,
) {
  return Boolean(
    value &&
    ["measured_apparent_demand", "measured_active_demand"].includes(value.metric) &&
    ((value.metric === "measured_apparent_demand" && value.source_streams?.join(",") === "E1,Q1" && value.unit === "kVA" && value.reactive_data_status === "available") ||
      (value.metric === "measured_active_demand" && value.source_streams?.join(",") === "E1" && value.unit === "kW" && value.reactive_data_status === "unavailable_active_only") ||
      (value.metric === "measured_apparent_demand" && value.source_streams?.join(",") === "kVA" && value.unit === "kVA" && value.reactive_data_status === "reported_apparent_demand") ||
      (value.metric === "measured_active_demand" && value.source_streams?.join(",") === "kW" && value.unit === "kW" && value.reactive_data_status === "unavailable_active_only")) &&
    [15, 30].includes(value.interval_minutes) &&
    ["fixed_aest_meter_time", "source_local_time_unverified"].includes(value.time_basis) &&
    value.tariff_window_status === "not_applied_pre_tariff" &&
    Number.isFinite(value.shared_scale_maximum_demand) &&
    value.shared_scale_maximum_demand >= 0 &&
    Array.isArray(value.years) &&
    value.years.length > 0 &&
    value.years.every((year) =>
      Number.isInteger(year.year) &&
      Number.isInteger(year.day_count) &&
      year.day_count === year.days?.length &&
      Number.isInteger(year.interval_count) && year.interval_count > 0 &&
      year.interval_count === year.days?.reduce((total, day) => total + day.interval_demand.filter((amount) => amount !== null).length, 0) &&
      Number.isInteger(year.expected_interval_count) && year.expected_interval_count === year.day_count * (1440 / value.interval_minutes) &&
      Number.isInteger(year.missing_interval_count) && year.missing_interval_count === year.expected_interval_count - year.interval_count &&
      Number.isFinite(year.maximum_interval_demand) &&
      year.maximum_interval_demand >= 0 &&
      year.maximum_interval_demand <= value.shared_scale_maximum_demand &&
      Number.isFinite(year.average_interval_demand) &&
      year.average_interval_demand >= 0 &&
      Array.isArray(year.days) &&
      year.days.every((day) =>
        /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
        Array.isArray(day.interval_demand) &&
        day.interval_demand.length === 1440 / value.interval_minutes &&
        day.interval_demand.every((amount) => amount === null || (Number.isFinite(amount) && amount >= 0)),
      ),
    ),
  );
}

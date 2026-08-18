export interface CiEvidenceIntakeResult {
  contract_version: "ci_evidence_intake_v7";
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
  next_steps: string[];
  privacy: {
    files_persisted: true;
    customer_identifiers_returned: false;
    customer_facing_permission: false;
  };
}

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
  return !(
    payload.contract_version !== "ci_evidence_intake_v7" ||
    !["ready_for_profile_review", "action_required"].includes(payload.intake_status) ||
    payload.privacy?.files_persisted !== true ||
    payload.privacy?.customer_identifiers_returned !== false ||
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
    !isSafeAnnualDemandHeatmap(payload.annual_demand_heatmap)
  );
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

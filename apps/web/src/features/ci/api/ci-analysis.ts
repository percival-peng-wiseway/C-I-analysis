export interface CiAnalysisResult {
  contract_version: "ci_interval_tariff_analysis_v1";
  analysis_status: "ready";
  analysis_mode: "evidence_limited_internal_review";
  customer_facing_permission: false;
  profile: {
    profile_id: string;
    display_label: string;
    network_tariff_code: string;
    billing_period_start: string;
    billing_period_end: string;
    source_version: string;
  };
  data_quality: {
    status: "pass" | "review";
    coverage_start: string;
    coverage_end: string;
    interval_minutes: number;
    interval_count_per_required_stream: number;
    required_streams_present: boolean;
    quality_method_counts: Record<string, number>;
    quality_override_count: number;
    warning_codes: string[];
  };
  tariff_mapping: {
    meter_time_basis: string;
    local_timezone: string;
    demand_interval_minutes: number;
    rolling_demand_months: number;
    minimum_chargeable_rolling_kva: number;
    network_peak_window: string;
    incentive_window: string;
    gst_basis: string;
  };
  demand_evidence: {
    rolling_demand_kva: number;
    chargeable_rolling_demand_kva: number;
    rolling_demand_timestamp: string;
    incentive_demand_kva: number;
    incentive_demand_timestamp: string;
    billing_period_max_kva: number;
    billing_period_max_kw: number;
    billing_period_max_kvar: number;
    billing_period_max_power_factor: number;
    billing_period_max_timestamp: string;
  };
  bill_reconciliation: {
    status: "pass";
    calculated_subtotal_ex_gst_aud: number;
    calculated_gst_aud: number;
    calculated_total_inc_gst_aud: number;
    charge_categories: Record<string, number>;
    checks: Array<{
      code: string;
      passed: boolean;
      calculated: number;
      expected: number;
    }>;
  };
  assumptions: string[];
}

export async function analyzeCiNem12(
  file: File,
  fetcher: typeof fetch = fetch,
): Promise<CiAnalysisResult> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetcher(
    "/api/commercial-industrial/powercor-llvt2-analysis",
    { method: "POST", headers: { Accept: "application/json" }, body },
  );
  if (!response.ok) {
    if (response.status === 413) {
      throw new Error(
        "The C&I NEM12 file is larger than the 25 MB local upload limit.",
      );
    }
    const payload = (await response.json().catch(() => null)) as
      | { detail?: { message?: string } }
      | null;
    throw new Error(
      payload?.detail?.message ??
        `C&I analysis request failed with status ${response.status}.`,
    );
  }
  const payload = (await response.json()) as CiAnalysisResult;
  if (
    payload.contract_version !== "ci_interval_tariff_analysis_v1" ||
    payload.analysis_status !== "ready" ||
    payload.analysis_mode !== "evidence_limited_internal_review" ||
    payload.customer_facing_permission !== false ||
    payload.bill_reconciliation?.status !== "pass" ||
    payload.bill_reconciliation.checks.some((check) => !check.passed)
  ) {
    throw new Error("C&I analysis returned an unsafe or incomplete result contract.");
  }
  return payload;
}

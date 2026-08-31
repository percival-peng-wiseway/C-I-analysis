import type { CiScenarioInput } from "./ci-scenarios";

export interface CiInternalReportArtifact {
  contract_version: "ci_internal_review_report_artifacts_v1";
  artifact_id: string;
  status: "ready";
  display_status: "Ready";
  created_new: boolean;
  financial_solution_id: string;
  source_fingerprint: string;
  source_nem12_sha256: string;
  source_physical_scenario_sha256: string;
  optimizer_run_snapshot_sha256: string;
  comparison_sha256: string;
  html_sha256: string;
  html_byte_size: number;
  pdf_sha256: string;
  pdf_byte_size: number;
  renderer_id: string;
  renderer_version: string;
  page_count: 3;
  created_at: string;
  can_download_html: true;
  can_download_pdf: true;
  customer_facing_permission: false;
  recommendation_permitted: false;
  eligibility_permitted: false;
  manual_delivery_permission: false;
  repository_managed_delivery_permission: false;
}

export async function fetchLatestCiInternalReport(
  fetcher: typeof fetch = fetch,
): Promise<CiInternalReportArtifact | null> {
  const response = await fetcher("/api/commercial-industrial/internal-review-report");
  if (!response.ok) throw new Error("Could not load the internal report state.");
  const payload = await response.json() as { artifact?: CiInternalReportArtifact | null };
  if (payload.artifact === null || payload.artifact === undefined) return null;
  return validate(payload.artifact);
}

export async function prepareCiInternalReport(
  input: {
    file: File;
    financialSolutionId: string;
    scenarios: CiScenarioInput[];
    pvOnlyScenarioId: string;
    pvBatteryScenarioId: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<CiInternalReportArtifact> {
  const body = new FormData();
  body.append("file", input.file);
  body.append("payload", JSON.stringify({
    financial_solution_id: input.financialSolutionId,
    scenarios: input.scenarios,
    pv_only_scenario_id: input.pvOnlyScenarioId,
    pv_battery_scenario_id: input.pvBatteryScenarioId,
  }));
  const response = await fetcher("/api/commercial-industrial/internal-review-report", {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "The internal report could not be prepared.");
  }
  return validate(await response.json() as CiInternalReportArtifact);
}

export function ciInternalReportDownloadPath(
  artifactId: string,
  kind: "html" | "pdf",
): string {
  return `/api/commercial-industrial/internal-review-report/${encodeURIComponent(artifactId)}.${kind}`;
}

function validate(artifact: CiInternalReportArtifact): CiInternalReportArtifact {
  if (
    artifact.contract_version !== "ci_internal_review_report_artifacts_v1" ||
    artifact.status !== "ready" ||
    artifact.page_count !== 3 ||
    artifact.customer_facing_permission !== false ||
    artifact.recommendation_permitted !== false ||
    artifact.eligibility_permitted !== false ||
    artifact.manual_delivery_permission !== false ||
    artifact.repository_managed_delivery_permission !== false ||
    !artifact.can_download_html ||
    !artifact.can_download_pdf
  ) {
    throw new Error("The internal report returned an unsafe or incomplete contract.");
  }
  return artifact;
}

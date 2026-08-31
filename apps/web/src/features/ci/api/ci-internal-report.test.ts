import { describe, expect, it } from "vitest";

import {
  ciInternalReportDownloadPath,
  fetchLatestCiInternalReport,
  prepareCiInternalReport,
  type CiInternalReportArtifact,
} from "./ci-internal-report";
import type { CiScenarioInput } from "./ci-scenarios";

const artifact: CiInternalReportArtifact = {
  contract_version: "ci_internal_review_report_artifacts_v1",
  artifact_id: "report-1",
  status: "ready",
  display_status: "Ready",
  created_new: true,
  financial_solution_id: "solution-1",
  source_fingerprint: "a".repeat(64),
  source_nem12_sha256: "b".repeat(64),
  source_physical_scenario_sha256: "c".repeat(64),
  optimizer_run_snapshot_sha256: "d".repeat(64),
  comparison_sha256: "e".repeat(64),
  html_sha256: "f".repeat(64),
  html_byte_size: 100,
  pdf_sha256: "1".repeat(64),
  pdf_byte_size: 200,
  renderer_id: "weasyprint_restricted_process",
  renderer_version: "69.0",
  page_count: 3,
  created_at: "2026-08-16T00:00:00Z",
  can_download_html: true,
  can_download_pdf: true,
  customer_facing_permission: false,
  recommendation_permitted: false,
  eligibility_permitted: false,
  manual_delivery_permission: false,
  repository_managed_delivery_permission: false,
};

describe("C&I internal report API", () => {
  it("prepares one explicit evidence-bound report and returns stable download paths", async () => {
    const scenarios = [{ scenario_id: "pv-only" }, { scenario_id: "pv-battery" }] as CiScenarioInput[];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/internal-review-report");
      const form = init?.body as FormData;
      expect(JSON.parse(String(form.get("payload")))).toEqual({
        financial_solution_id: "solution-1",
        scenarios,
        pv_only_scenario_id: "pv-only",
        pv_battery_scenario_id: "pv-battery",
      });
      return new Response(JSON.stringify(artifact), { status: 201 });
    };
    await expect(prepareCiInternalReport({
      file: new File(["synthetic"], "synthetic.csv"),
      financialSolutionId: "solution-1",
      scenarios,
      pvOnlyScenarioId: "pv-only",
      pvBatteryScenarioId: "pv-battery",
    }, fetcher as typeof fetch)).resolves.toEqual(artifact);
    expect(ciInternalReportDownloadPath("report-1", "pdf")).toBe(
      "/api/commercial-industrial/internal-review-report/report-1.pdf",
    );
  });

  it("loads no artifact and rejects an unsafe permission response", async () => {
    await expect(fetchLatestCiInternalReport(async () => new Response(JSON.stringify({ artifact: null })) as never)).resolves.toBeNull();
    await expect(fetchLatestCiInternalReport(async () => new Response(JSON.stringify({ artifact: { ...artifact, customer_facing_permission: true } })) as never)).rejects.toThrow("unsafe or incomplete");
  });
});

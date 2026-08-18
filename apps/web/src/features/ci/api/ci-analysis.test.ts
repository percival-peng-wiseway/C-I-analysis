import { describe, expect, it, vi } from "vitest";

import { analyzeCiNem12 } from "./ci-analysis";

describe("analyzeCiNem12", () => {
  it("posts the selected file and accepts a reconciled internal-review result", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contract_version: "ci_interval_tariff_analysis_v1",
      analysis_status: "ready",
      analysis_mode: "evidence_limited_internal_review",
      customer_facing_permission: false,
      bill_reconciliation: { status: "pass", checks: [{ code: "total", passed: true, calculated: 1, expected: 1 }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const file = new File(["synthetic"], "interval.csv", { type: "text/csv" });

    await expect(analyzeCiNem12(file, fetcher)).resolves.toMatchObject({
      analysis_status: "ready",
      customer_facing_permission: false,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/commercial-industrial/powercor-llvt2-analysis",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a result with failed reconciliation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contract_version: "ci_interval_tariff_analysis_v1",
      analysis_status: "ready",
      analysis_mode: "evidence_limited_internal_review",
      customer_facing_permission: false,
      bill_reconciliation: { status: "pass", checks: [{ code: "total", passed: false }] },
    }), { status: 200 }));
    await expect(
      analyzeCiNem12(new File(["x"], "x.csv"), fetcher),
    ).rejects.toThrow("unsafe or incomplete");
  });

  it("explains a proxy-rejected oversized upload", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 413 }));

    await expect(
      analyzeCiNem12(new File(["x"], "large.csv"), fetcher),
    ).rejects.toThrow("larger than the 25 MB local upload limit");
  });
});

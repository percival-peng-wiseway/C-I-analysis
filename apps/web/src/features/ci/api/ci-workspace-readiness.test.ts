import { describe, expect, it } from "vitest";

import { fetchCiWorkspaceReadiness } from "./ci-workspace-readiness";

describe("fetchCiWorkspaceReadiness", () => {
  it("accepts the exact backend contract version", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      contract_version: "ci_workspace_readiness_v3",
      product_id: "commercial_and_industrial",
      availability: "unavailable",
      active_profile_id: null,
      active_profile_label: null,
      blockers: [{ code: "ci_evidence_gate_issue_5", message: "Unavailable" }],
      workspace_areas: [
        "data_qc", "tariff_mapping", "peak_shaving", "kw_kva_pf_evidence",
        "scenario_ranking", "report_preview",
      ].map((workspace_id) => ({
        workspace_id,
        display_label: workspace_id,
        description: "Unavailable area",
        availability: "unavailable",
      })),
    }), { status: 200 });

    await expect(fetchCiWorkspaceReadiness(fetcher as typeof fetch)).resolves.toMatchObject({
      availability: "unavailable",
    });
  });

  it("fails closed on an incomplete workspace inventory", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      contract_version: "ci_workspace_readiness_v3",
      product_id: "commercial_and_industrial",
      availability: "unavailable",
      active_profile_id: null,
      active_profile_label: null,
      blockers: [{ code: "ci_evidence_gate_issue_5", message: "Unavailable" }],
      workspace_areas: [],
    }), { status: 200 });
    await expect(fetchCiWorkspaceReadiness(fetcher as typeof fetch)).rejects.toThrow(
      "unsafe availability contract",
    );
  });

  it("fails closed if any workspace is marked available", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      contract_version: "ci_workspace_readiness_v3",
      product_id: "commercial_and_industrial",
      availability: "unavailable",
      active_profile_id: null,
      active_profile_label: null,
      blockers: [{ code: "ci_evidence_gate_issue_5", message: "Unavailable" }],
      workspace_areas: [{
        workspace_id: "data_qc",
        display_label: "C&I Data QC",
        description: "Evidence",
        availability: "available",
      }],
    }), { status: 200 });
    await expect(fetchCiWorkspaceReadiness(fetcher as typeof fetch)).rejects.toThrow(
      "unsafe availability contract",
    );
  });

  it("fails closed on an unexpected contract version", async () => {
    const fetcher = async () => new Response(JSON.stringify({ contract_version: "unexpected" }), {
      status: 200,
    });

    await expect(fetchCiWorkspaceReadiness(fetcher as typeof fetch)).rejects.toThrow(
      "unexpected contract version",
    );
  });
});

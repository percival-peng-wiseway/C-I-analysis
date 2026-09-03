import { describe, expect, it, vi } from "vitest";

import { fetchCiDesignPricePreview } from "./ci-design-price-preview";

describe("fetchCiDesignPricePreview", () => {
  it("accepts the Python-priced all-solution contract", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 }));
    const result = await fetchCiDesignPricePreview("project-1", fetcher as typeof fetch);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/commercial-industrial/projects/project-1/design-price-preview",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(result.solutions[0].net_capex_aud_ex_gst).toBe(90_000);
  });

  it("rejects a Net CAPEX value that does not reconcile", async () => {
    const invalid = payload();
    invalid.solutions[0].net_capex_aud_ex_gst = 99_000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(invalid), { status: 200 }));

    await expect(fetchCiDesignPricePreview("project-1", fetcher as typeof fetch)).rejects.toThrow("unsafe contract");
  });
});

function payload() {
  return {
    contract_version: "ci_design_price_preview_v1",
    project_id: "project-1",
    status: "ready",
    pricing_basis: "workspace_device_profile_less_approved_rebates",
    design_candidates_sha256: "c".repeat(64),
    device_profile_sha256: "a".repeat(64),
    rebate_profile_sha256: null,
    equipment_selection: {
      pv_product_id: "astronergy_astro_n7_600_630w",
      battery_product_id: "fox_ess_cq7_ci",
      inverter_product_id: "fox_ess_h3_plus_125kw",
    },
    candidate_count: 1,
    solutions: [{
      scenario_id: "scenario-1",
      label: "Option 1",
      pv_capacity_kwp_dc: 100,
      battery_capacity_kwh: 100,
      inverter_capacity_kw_ac: 50,
      gross_capex_aud_ex_gst: 100_000,
      upfront_rebate_aud_ex_gst: 10_000,
      net_capex_aud_ex_gst: 90_000,
      capex_breakdown_aud_ex_gst: { pv_aud: 50_000, battery_aud: 40_000, inverter_aud: 10_000 },
      rebate_calculation: { scenario_id: "scenario-1", customer_facing_permission: false },
    }],
    quotation_override_basis: "Entered quotation replaces modelled Net CAPEX.",
    currency_values_permitted: true,
    customer_facing_permission: false,
    recommendation_permitted: false,
  };
}

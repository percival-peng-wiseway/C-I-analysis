import { describe, expect, it } from "vitest";

import { getCiComponentCostLibrary, publishCiPricingDraft, saveCiPricingDraft, type CiPricingCatalogVersion } from "./ci-pricing-catalog";

const version: CiPricingCatalogVersion = {
  catalog_version_id: "catalog-1", version_number: 1, status: "draft", catalog_hash: "a".repeat(64),
  catalog: {
    contract_version: "ci_pricing_catalog_v1", catalog_id: "ci_solution_pricing",
    currency: "AUD", tax_basis: "gst_exclusive",
    products: [{ item_id: "battery", label: "Battery", category: "battery", pricing_basis: "size_cost_table", unit_price_aud: 0, size_metric: "battery_kwh", replacement_interval_years: 8, cost_rows: [{ size: 400, capital_cost_aud: 76000, replacement_cost_aud: 38000, annual_om_cost_aud: 1000 }, { size: 500, capital_cost_aud: 90000, replacement_cost_aud: 45000, annual_om_cost_aud: 1200 }], effective_status: "active" }],
    installation_items: [{ item_id: "install", label: "Install", pricing_basis: "fixed", unit_price_aud: 25000, effective_status: "active" }],
  },
};

describe("C&I pricing catalog API", () => {
  it("loads the reusable backend-owned component cost library", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      expect(input).toBe("/api/commercial-industrial/component-cost-library");
      return new Response(JSON.stringify({
        contract_version: "ci_component_cost_library_v1",
        library_id: "provided_ci_component_costs",
        currency: "AUD",
        entries: [{ component_id: "provided-inverter-inv" }],
      }), { status: 200 });
    };
    await expect(getCiComponentCostLibrary(fetcher as typeof fetch)).resolves.toMatchObject({
      entries: [{ component_id: "provided-inverter-inv" }],
    });
  });

  it("saves structured product and installation prices", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/pricing-catalog/drafts/catalog-1");
      const body = JSON.parse(String(init?.body));
      expect(body.catalog.products[0].pricing_basis).toBe("size_cost_table");
      expect(body.catalog.products[0].cost_rows[1]).toMatchObject({ size: 500, capital_cost_aud: 90000, annual_om_cost_aud: 1200 });
      expect(body.catalog.installation_items[0].unit_price_aud).toBe(25000);
      return new Response(JSON.stringify(version), { status: 200 });
    };
    await expect(saveCiPricingDraft(version, fetcher as typeof fetch)).resolves.toMatchObject({ version_number: 1 });
  });

  it("publishes the exact saved catalog hash", async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ expected_catalog_hash: "a".repeat(64) });
      return new Response(JSON.stringify({ ...version, status: "published" }), { status: 200 });
    };
    await expect(publishCiPricingDraft(version, fetcher as typeof fetch)).resolves.toMatchObject({ status: "published" });
  });
});

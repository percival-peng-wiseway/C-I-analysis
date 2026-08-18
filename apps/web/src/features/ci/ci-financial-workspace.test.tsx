import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CiComponentCostLibrary, CiPricingCatalogVersion } from "./api/ci-pricing-catalog";
import { CiPricingCatalogManager } from "./ci-financial-workspace";

describe("C&I pricing catalog workspace", () => {
  it("presents exact sizing with capital, replacement, and annual O&M", () => {
    const version: CiPricingCatalogVersion = {
      catalog_version_id: "catalog-1",
      version_number: 1,
      status: "draft",
      catalog_hash: "a".repeat(64),
      catalog: {
        contract_version: "ci_pricing_catalog_v1",
        catalog_id: "ci_solution_pricing",
        currency: "AUD",
        tax_basis: "gst_exclusive",
        products: [{
          item_id: "battery",
          label: "Battery",
          category: "battery",
          pricing_basis: "size_cost_table",
          unit_price_aud: 0,
          size_metric: "battery_kwh",
          replacement_interval_years: 8,
          cost_rows: [{ size: 400, capital_cost_aud: 76000, replacement_cost_aud: 38000, annual_om_cost_aud: 1000 }, { size: 500, capital_cost_aud: 90000, replacement_cost_aud: 45000, annual_om_cost_aud: 1200 }],
          effective_status: "active",
        }],
        installation_items: [],
      },
    };
    const library: CiComponentCostLibrary = {
      contract_version: "ci_component_cost_library_v1",
      library_id: "provided_ci_component_costs",
      currency: "AUD",
      entries: [{
        component_id: "fox-ess-cq7-ci-provided",
        label: "Fox ESS CQ7 C&I",
        abbreviation: "LFP",
        category: "battery",
        source_size_metric: "battery_kwh",
        source_size_unit: "kWh",
        source_tax_basis: "not_stated",
        source_reference: "synthetic",
        module_nominal_capacity_kwh: 6.96,
        stated_lifetime_years: null,
        reuse_status: "replacement_interval_required",
        cost_rows: [{ size: 83.52, capital_cost_aud: 34712, replacement_cost_aud: 20844, annual_om_cost_aud: 0 }],
        pricing_catalog_template: {
          item_id: "provided-fox-ess-cq7-ci-battery",
          label: "Fox ESS CQ7 C&I battery",
          category: "battery",
          pricing_basis: "size_cost_table",
          unit_price_aud: 0,
          size_metric: "battery_kwh",
          replacement_interval_years: null,
          cost_rows: [{ size: 83.52, capital_cost_aud: 34712, replacement_cost_aud: 20844, annual_om_cost_aud: 0 }],
          effective_status: "active",
        },
      }],
    };

    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CiPricingCatalogManager library={library} versions={[version]} />
      </QueryClientProvider>,
    );

    expect(html).toContain("Size cost table");
    expect(html).toContain("Battery kWh");
    expect(html).toContain("Capital (AUD)");
    expect(html).toContain("Replacement (AUD)");
    expect(html).toContain("O&amp;M (AUD/year)");
    expect(html).toContain("Costs are linear between points");
    expect(html).toContain("Reusable component cost library");
    expect(html).toContain("Fox ESS CQ7 C&amp;I");
    expect(html).toContain("CQ7 module: 6.96 kWh nominal");
    expect(html).toContain("Add to price draft");
    expect(html).toContain("did not state GST");
  });
});

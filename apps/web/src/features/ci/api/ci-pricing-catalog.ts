export type CiPriceBasis = "fixed" | "per_kwh_capacity" | "per_kw_discharge" | "per_kw_pv_dc" | "size_cost_table";
export type CiSizeMetric = "pv_kwp_dc" | "pv_inverter_kw_ac" | "battery_kwh" | "battery_kw_discharge";

export interface CiCostRow {
  size: number;
  capital_cost_aud: number;
  replacement_cost_aud: number;
  annual_om_cost_aud: number;
}

export interface CiPriceItem {
  item_id: string;
  label: string;
  pricing_basis: CiPriceBasis;
  unit_price_aud: number;
  size_metric?: CiSizeMetric;
  replacement_interval_years?: number | null;
  cost_rows?: CiCostRow[];
  effective_status: "active" | "inactive";
  category?: "solar_pv" | "battery" | "pcs_inverter" | "switchgear" | "ems" | "other";
  source_component_id?: string;
  source_tax_basis?: "not_stated";
  source_quantity_points?: number[];
  module_nominal_capacity_kwh?: number;
}

export interface CiComponentCostLibraryEntry {
  component_id: string;
  label: string;
  abbreviation: string;
  category: CiPriceItem["category"];
  source_size_metric: CiSizeMetric;
  source_size_unit: string;
  source_tax_basis: "not_stated";
  source_reference: string;
  capacity_source_reference?: string;
  capacity_source_url?: string;
  module_nominal_capacity_kwh?: number;
  stated_lifetime_years: number | null;
  reuse_status: "direct" | "replacement_interval_required";
  cost_rows: CiCostRow[];
  pricing_catalog_template: CiPriceItem | null;
}

export interface CiComponentCostLibrary {
  contract_version: "ci_component_cost_library_v1";
  library_id: "provided_ci_component_costs";
  currency: "AUD";
  entries: CiComponentCostLibraryEntry[];
}

export interface CiPricingCatalogVersion {
  catalog_version_id: string;
  version_number: number;
  status: "draft" | "published" | "retired";
  catalog_hash: string;
  catalog: {
    contract_version: "ci_pricing_catalog_v1";
    catalog_id: "ci_solution_pricing";
    currency: "AUD";
    tax_basis: "gst_inclusive" | "gst_exclusive";
    products: CiPriceItem[];
    installation_items: CiPriceItem[];
  };
}

export async function listCiPricingCatalog(fetcher: typeof fetch = fetch): Promise<CiPricingCatalogVersion[]> {
  const response = await fetcher("/api/commercial-industrial/pricing-catalog");
  if (!response.ok) throw new Error("Could not load the C&I price catalog.");
  const payload = await response.json() as { versions?: CiPricingCatalogVersion[] };
  if (!Array.isArray(payload.versions)) throw new Error("C&I price catalog is invalid.");
  return payload.versions;
}

export async function getCiComponentCostLibrary(fetcher: typeof fetch = fetch): Promise<CiComponentCostLibrary> {
  const response = await fetcher("/api/commercial-industrial/component-cost-library");
  if (!response.ok) throw new Error("Could not load the C&I component cost library.");
  const payload = await response.json() as CiComponentCostLibrary;
  if (
    payload.contract_version !== "ci_component_cost_library_v1" ||
    payload.library_id !== "provided_ci_component_costs" ||
    !Array.isArray(payload.entries)
  ) throw new Error("C&I component cost library is invalid.");
  return payload;
}

export async function createCiPricingDraft(fetcher: typeof fetch = fetch): Promise<CiPricingCatalogVersion> {
  const response = await fetcher("/api/commercial-industrial/pricing-catalog/drafts", { method: "POST" });
  if (!response.ok) throw new Error("Could not create the C&I price draft.");
  return response.json() as Promise<CiPricingCatalogVersion>;
}

export async function saveCiPricingDraft(version: CiPricingCatalogVersion, fetcher: typeof fetch = fetch): Promise<CiPricingCatalogVersion> {
  const response = await fetcher(`/api/commercial-industrial/pricing-catalog/drafts/${version.catalog_version_id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ catalog: version.catalog }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Could not save the C&I price draft.");
  }
  return response.json() as Promise<CiPricingCatalogVersion>;
}

export async function publishCiPricingDraft(version: CiPricingCatalogVersion, fetcher: typeof fetch = fetch): Promise<CiPricingCatalogVersion> {
  const response = await fetcher(`/api/commercial-industrial/pricing-catalog/drafts/${version.catalog_version_id}/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_catalog_hash: version.catalog_hash }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Could not publish the C&I price catalog.");
  }
  return response.json() as Promise<CiPricingCatalogVersion>;
}

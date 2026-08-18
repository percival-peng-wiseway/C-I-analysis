import type { CiPhysicalScenarioResult } from "./ci-scenarios";

export interface CiFinancialSolution {
  contract_version: "ci_financial_solution_v1" | "ci_financial_solution_v2" | "ci_financial_solution_v3" | "ci_financial_solution_v4";
  solution_id: string;
  label: string;
  scenario_id: string;
  source_physical_scenario_sha256: string;
  optimizer_run_snapshot_sha256: string | null;
  optimizer_run_snapshot: PhysicalScenario["optimizer_run_snapshot"] | null;
  optimizer_audit_projection: PhysicalScenario["optimizer_audit_projection"] | null;
  assumptions: {
    upfront_cost_aud: number;
    first_year_net_value_aud: number;
    annual_om_cost_aud: number;
    replacement_events_aud: Array<{ year: number; amount_aud: number }>;
    discount_rate: number;
    annual_value_degradation_rate: number;
    analysis_term_years: number;
    currency: "AUD";
    value_source: "expert_authored" | "evidence_bound_tariff_scenario";
    tariff_value?: PhysicalScenario["annual_tariff_value"];
    pricing_resolution: {
      catalog_version_id: string;
      catalog_version_number: number;
      catalog_hash: string;
      tax_basis: "gst_inclusive" | "gst_exclusive";
      resolved_upfront_cost_aud: number;
      resolved_annual_om_cost_aud: number;
      lines: Array<{ item_id: string; item_kind: "product" | "installation"; label: string; amount_aud: number; replacement_cost_aud: number; annual_om_cost_aud: number; replacement_interval_years: number | null; resolution_method: "unit_rate" | "zero_size" | "exact" | "interpolated" | "extrapolated" }>;
    };
  };
  metrics: {
    net_present_value_aud: number;
    payback_period_years: number | null;
    internal_rate_of_return: number | null;
    lifetime_net_value_undiscounted_aud: number;
    annual_cashflows_aud: number[];
  };
  starred: boolean;
  created_at: string;
  updated_at: string;
  customer_facing_permission: false;
}

export type PhysicalScenario = CiPhysicalScenarioResult["scenarios"][number];

export async function listCiFinancialSolutions(fetcher: typeof fetch = fetch): Promise<CiFinancialSolution[]> {
  const response = await fetcher("/api/commercial-industrial/financial-solutions");
  if (!response.ok) throw new Error("Could not load saved financial solutions.");
  const payload = await response.json() as { solutions?: CiFinancialSolution[] };
  if (!Array.isArray(payload.solutions)) throw new Error("Financial solution list is invalid.");
  return payload.solutions;
}

export async function saveCiFinancialSolution(
  input: {
    file: File;
    label: string;
    scenario: PhysicalScenario;
    discountRate: number;
    degradationRate: number;
    termYears: number;
    pricingCatalogVersionId: string;
    productIds: string[];
    installationItemIds: string[];
  },
  fetcher: typeof fetch = fetch,
): Promise<CiFinancialSolution> {
  const payload = {
    label: input.label,
    scenario_id: input.scenario.scenario_id,
    source_physical_scenario: input.scenario,
    assumptions: {
      discount_rate: input.discountRate,
      annual_value_degradation_rate: input.degradationRate,
      analysis_term_years: input.termYears,
    },
    pricing_catalog_version_id: input.pricingCatalogVersionId,
    product_ids: input.productIds,
    installation_item_ids: input.installationItemIds,
  };
  const body = new FormData();
  body.append("file", input.file);
  body.append("payload", JSON.stringify(payload));
  const response = await fetcher("/api/commercial-industrial/financial-solutions", {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  if (!response.ok) throw new Error("Could not save the financial solution.");
  return response.json() as Promise<CiFinancialSolution>;
}

export async function setCiFinancialSolutionStarred(
  solutionId: string,
  starred: boolean,
  fetcher: typeof fetch = fetch,
): Promise<CiFinancialSolution> {
  const response = await fetcher(`/api/commercial-industrial/financial-solutions/${solutionId}/star`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ starred }),
  });
  if (!response.ok) throw new Error("Could not update the saved solution.");
  return response.json() as Promise<CiFinancialSolution>;
}

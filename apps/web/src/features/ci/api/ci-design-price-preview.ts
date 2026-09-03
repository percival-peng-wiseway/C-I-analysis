import type { CiScenarioRebateCalculation } from "@/features/ci/api/ci-annual-financial-comparison";
import type { CiEquipmentSelection } from "@/features/ci/api/ci-device-profile";

export interface CiDesignPricePreviewSolution {
  scenario_id: string;
  label: string;
  pv_capacity_kwp_dc: number;
  battery_capacity_kwh: number;
  inverter_capacity_kw_ac: number;
  gross_capex_aud_ex_gst: number;
  upfront_rebate_aud_ex_gst: number;
  net_capex_aud_ex_gst: number;
  capex_breakdown_aud_ex_gst: {
    pv_aud: number;
    battery_aud: number;
    inverter_aud: number;
  };
  rebate_calculation: CiScenarioRebateCalculation;
}

export interface CiDesignPricePreview {
  contract_version: "ci_design_price_preview_v1";
  project_id: string;
  status: "ready";
  pricing_basis: "workspace_device_profile_less_approved_rebates";
  design_candidates_sha256: string;
  device_profile_sha256: string;
  rebate_profile_sha256: string | null;
  equipment_selection: CiEquipmentSelection;
  candidate_count: number;
  solutions: CiDesignPricePreviewSolution[];
  quotation_override_basis: string;
  currency_values_permitted: true;
  customer_facing_permission: false;
  recommendation_permitted: false;
}

export const ciDesignPricePreviewQueryKey = (projectId: string) =>
  ["ci-design-price-preview", projectId] as const;

export async function fetchCiDesignPricePreview(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiDesignPricePreview> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/design-price-preview`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? "Could not calculate Net CAPEX for the generated solutions.");
  }
  return assertCiDesignPricePreview(await response.json(), projectId);
}

export function assertCiDesignPricePreview(value: unknown, projectId: string): CiDesignPricePreview {
  const payload = value as CiDesignPricePreview;
  const ids = Array.isArray(payload?.solutions) ? payload.solutions.map((item) => item?.scenario_id) : [];
  if (
    payload?.contract_version !== "ci_design_price_preview_v1" ||
    payload.project_id !== projectId ||
    payload.status !== "ready" ||
    payload.pricing_basis !== "workspace_device_profile_less_approved_rebates" ||
    !isSha256(payload.design_candidates_sha256) ||
    !isSha256(payload.device_profile_sha256) ||
    !(payload.rebate_profile_sha256 === null || isSha256(payload.rebate_profile_sha256)) ||
    !Number.isInteger(payload.candidate_count) ||
    payload.candidate_count < 1 ||
    payload.candidate_count > 200 ||
    payload.candidate_count !== payload.solutions?.length ||
    new Set(ids).size !== ids.length ||
    typeof payload.quotation_override_basis !== "string" ||
    payload.currency_values_permitted !== true ||
    payload.customer_facing_permission !== false ||
    payload.recommendation_permitted !== false ||
    !payload.solutions.every(validSolution)
  ) throw new Error("Net CAPEX preview returned an unsafe contract.");
  return payload;
}

function validSolution(solution: CiDesignPricePreviewSolution) {
  const breakdown = solution.capex_breakdown_aud_ex_gst;
  const values = [
    solution.pv_capacity_kwp_dc,
    solution.battery_capacity_kwh,
    solution.inverter_capacity_kw_ac,
    solution.gross_capex_aud_ex_gst,
    solution.upfront_rebate_aud_ex_gst,
    solution.net_capex_aud_ex_gst,
    breakdown?.pv_aud,
    breakdown?.battery_aud,
    breakdown?.inverter_aud,
  ];
  const breakdownTotal = breakdown ? breakdown.pv_aud + breakdown.battery_aud + breakdown.inverter_aud : Number.NaN;
  return (
    typeof solution.scenario_id === "string" && solution.scenario_id.length > 0 &&
    typeof solution.label === "string" && solution.label.length > 0 &&
    values.every((item) => Number.isFinite(item) && item >= 0) &&
    solution.gross_capex_aud_ex_gst > 0 &&
    solution.net_capex_aud_ex_gst > 0 &&
    nearlyEqual(breakdownTotal, solution.gross_capex_aud_ex_gst) &&
    nearlyEqual(solution.gross_capex_aud_ex_gst - solution.upfront_rebate_aud_ex_gst, solution.net_capex_aud_ex_gst) &&
    solution.rebate_calculation?.scenario_id === solution.scenario_id &&
    solution.rebate_calculation?.customer_facing_permission === false
  );
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.011;
}

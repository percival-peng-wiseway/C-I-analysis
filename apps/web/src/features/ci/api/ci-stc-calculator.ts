export interface StcCalculatorInput {
  solar_installation_year: number;
  solar_zone: 3 | 4;
  pv_capacity_kwp: number;
  solar_certificate_price: number;
  battery_installation_period: string;
  battery_usable_capacity_kwh: number;
  battery_certificate_price: number;
}
export interface StcEstimate {
  contract_version: "ci_stc_manual_estimate_v1";
  inputs: StcCalculatorInput;
  solar_deeming_years: number;
  solar_zone_factor: number;
  battery_factor: number;
  solar_calculated_quantity: number;
  battery_calculated_quantity: number;
  solar_rebate_aud: number;
  battery_rebate_aud: number;
  total_rebate_aud: number;
  applied_to_solutions: false;
  applied_to_finance: false;
  customer_facing_permission: false;
}
export interface StcCalculatorState {
  contract_version: "ci_stc_calculator_state_v1";
  project_id: string;
  estimate: StcEstimate | null;
}
export const stcCalculatorKey = (id: string) => ["ci-stc-calculator", id] as const;
export async function fetchStcCalculator(id: string, input?: StcCalculatorInput): Promise<StcCalculatorState> {
  const response = await fetch(`/api/commercial-industrial/projects/${encodeURIComponent(id)}/stc-calculator`, {
    method: input ? "PUT" : "GET", cache: "no-store",
    headers: { Accept: "application/json", ...(input ? { "Content-Type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) throw new Error("STC calculation could not be loaded or saved. Check the inputs and try again.");
  const data = await response.json() as StcCalculatorState;
  const e = data?.estimate;
  if (data.contract_version !== "ci_stc_calculator_state_v1" || data.project_id !== id ||
      (e !== null && (!e || e.contract_version !== "ci_stc_manual_estimate_v1" || !e.inputs ||
        e.applied_to_solutions !== false || e.applied_to_finance !== false || e.customer_facing_permission !== false ||
        ![e.solar_deeming_years, e.solar_zone_factor, e.battery_factor, e.solar_calculated_quantity,
          e.battery_calculated_quantity, e.solar_rebate_aud, e.battery_rebate_aud, e.total_rebate_aud].every(v => Number.isFinite(v) && v >= 0) ||
        Math.abs(e.total_rebate_aud - e.solar_rebate_aud - e.battery_rebate_aud) > 0.011))) {
    throw new Error("STC calculator returned an unexpected result.");
  }
  return data;
}

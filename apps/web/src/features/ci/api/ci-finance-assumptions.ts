import type {
  CiSavedAnnualFinancialState,
  compareCiAnnualFinancialScenarios,
} from "./ci-annual-financial-comparison";
import type { CiDeviceProfileState } from "./ci-device-profile";

export type CiAnnualFinanceAssumptions = NonNullable<
  Parameters<typeof compareCiAnnualFinancialScenarios>[0]["assumptions"]
>;

/** Forward saved inputs only; Python remains authoritative for financial math. */
export function resolveCiAnnualFinanceAssumptions(
  savedFinance: Pick<CiSavedAnnualFinancialState, "status" | "result"> | undefined,
  deviceProfile: Pick<CiDeviceProfileState, "status" | "profile"> | undefined,
): CiAnnualFinanceAssumptions {
  const saved = savedFinance?.status === "ready" ? savedFinance.result : null;
  if (savedFinance?.status === "ready" && !saved) {
    throw new Error("The saved finance assumptions are unavailable. Review Finance before analysing again.");
  }
  if (saved && (!Array.isArray(saved.assumptions.replacement_events_aud)
    || saved.assumptions.replacement_events_aud.length !== 0)) {
    // The annual-comparison endpoint currently supports no replacement schedule.
    // Never silently discard a future or unsupported authored replacement event.
    throw new Error("This analysis cannot preserve the saved replacement schedule. Review Finance before analysing again.");
  }
  const source = saved?.assumptions
    ?? (deviceProfile?.status === "ready" ? deviceProfile.profile : null);
  if (!source) {
    throw new Error("Save finance defaults in Settings before running financial analysis.");
  }
  const assumptions: CiAnnualFinanceAssumptions = {
    discountRate: source.discount_rate,
    annualValueEscalationRate: source.annual_value_escalation_rate,
    annualValueDegradationRate: source.annual_value_degradation_rate,
    annualOmFractionOfCapex: source.annual_om_fraction_of_capex,
    analysisTermYears: source.analysis_term_years,
  };
  if (![assumptions.discountRate, assumptions.annualValueEscalationRate,
    assumptions.annualValueDegradationRate].every((value) => Number.isFinite(value) && value >= 0 && value < 1)
    || !Number.isFinite(assumptions.annualOmFractionOfCapex)
    || assumptions.annualOmFractionOfCapex < 0 || assumptions.annualOmFractionOfCapex >= 0.201
    || !Number.isInteger(assumptions.analysisTermYears)
    || assumptions.analysisTermYears < 1 || assumptions.analysisTermYears > 50) {
    throw new Error("The saved finance assumptions are invalid. Review Finance or Settings before analysing again.");
  }
  return assumptions;
}

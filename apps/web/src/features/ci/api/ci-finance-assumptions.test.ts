import { describe, expect, it } from "vitest";

import type { CiSavedAnnualFinancialState } from "./ci-annual-financial-comparison";
import type { CiDeviceProfileState } from "./ci-device-profile";
import { resolveCiAnnualFinanceAssumptions } from "./ci-finance-assumptions";

const savedInputs = {
  discount_rate: 0.06,
  annual_value_escalation_rate: 0.03,
  annual_value_degradation_rate: 0.016,
  annual_om_fraction_of_capex: 0.02,
  analysis_term_years: 20,
  replacement_events_aud: [],
};
const workspaceInputs = {
  discount_rate: 0.09,
  annual_value_escalation_rate: 0.04,
  annual_value_degradation_rate: 0.01,
  annual_om_fraction_of_capex: 0.025,
  analysis_term_years: 12,
};
const currentFinance = {
  status: "ready",
  result: { assumptions: savedInputs },
} as CiSavedAnnualFinancialState;
const workspaceProfile = {
  status: "ready",
  profile: workspaceInputs,
} as CiDeviceProfileState;

describe("one-click finance assumption provenance", () => {
  it("preserves current saved finance inputs ahead of workspace defaults", () => {
    expect(resolveCiAnnualFinanceAssumptions(currentFinance, workspaceProfile)).toEqual({
      discountRate: 0.06,
      annualValueEscalationRate: 0.03,
      annualValueDegradationRate: 0.016,
      annualOmFractionOfCapex: 0.02,
      analysisTermYears: 20,
    });
  });

  it.each(["not_saved", "stale"] as const)("uses workspace defaults when finance is %s", (status) => {
    expect(resolveCiAnnualFinanceAssumptions({ ...currentFinance, status }, workspaceProfile)).toEqual({
      discountRate: 0.09,
      annualValueEscalationRate: 0.04,
      annualValueDegradationRate: 0.01,
      annualOmFractionOfCapex: 0.025,
      analysisTermYears: 12,
    });
  });

  it("preserves explicit zeros and never substitutes fallback percentages", () => {
    const source = structuredClone(currentFinance);
    Object.assign(source.result!.assumptions, {
      discount_rate: 0,
      annual_value_escalation_rate: 0,
      annual_value_degradation_rate: 0,
      annual_om_fraction_of_capex: 0,
      analysis_term_years: 1,
    });
    expect(resolveCiAnnualFinanceAssumptions(source, undefined)).toEqual({
      discountRate: 0, annualValueEscalationRate: 0, annualValueDegradationRate: 0,
      annualOmFractionOfCapex: 0, analysisTermYears: 1,
    });
  });

  it("fails closed without current saved inputs or configured workspace defaults", () => {
    expect(() => resolveCiAnnualFinanceAssumptions(undefined, {
      status: "not_configured", profile: null,
    })).toThrow("Save finance defaults");
    expect(() => resolveCiAnnualFinanceAssumptions({ status: "ready", result: null }, workspaceProfile))
      .toThrow("saved finance assumptions are unavailable");
  });

  it.each([
    { discount_rate: Number.NaN }, { annual_value_escalation_rate: -0.01 },
    { annual_value_degradation_rate: 1 }, { annual_om_fraction_of_capex: 0.201 },
    { analysis_term_years: 1.5 }, { analysis_term_years: 51 },
  ])("rejects invalid saved finance inputs rather than silently changing basis: %o", (override) => {
    const source = structuredClone(currentFinance);
    Object.assign(source.result!.assumptions, override);
    expect(() => resolveCiAnnualFinanceAssumptions(source, workspaceProfile)).toThrow("assumptions are invalid");
  });

  it("does not silently discard a replacement schedule unsupported by annual comparison", () => {
    const source = structuredClone(currentFinance);
    Object.assign(source.result!.assumptions, { replacement_events_aud: [{ year: 10, cost_aud: 10000 }] });
    expect(() => resolveCiAnnualFinanceAssumptions(source, workspaceProfile)).toThrow("cannot preserve the saved replacement schedule");
  });
});

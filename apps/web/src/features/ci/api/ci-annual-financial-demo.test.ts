import { describe, expect, it } from "vitest";

import { annualFinancialDemoFixture } from "./ci-annual-financial-demo.fixture";
import {
  assertCiAnnualFinancialDemo,
  fetchCiAnnualFinancialDemo,
} from "./ci-annual-financial-demo";

describe("C&I annual finance demo API", () => {
  it("accepts the guarded feasibility and three-offer demo contract", async () => {
    const payload = annualFinancialDemoFixture();
    const result = await fetchCiAnnualFinancialDemo("project-1", async (input) => {
      expect(String(input)).toBe("/api/commercial-industrial/projects/project-1/annual-financial-demo");
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    expect(result.solutions.map((item) => item.upfront_cost_aud)).toEqual([249800, 268800, 298600]);
    expect(result.solar_only_case.financial_metrics_permitted).toBe(false);
    expect(result.tariff_inputs.demand_savings_applied).toBe(false);
  });

  it("rejects customer-facing or incomplete demo payloads", () => {
    const payload = annualFinancialDemoFixture();
    expect(() => assertCiAnnualFinancialDemo({ ...payload, customer_facing_permission: true }, "project-1")).toThrow(/unsafe contract/i);
    expect(() => assertCiAnnualFinancialDemo({ ...payload, solutions: payload.solutions.slice(0, 2) }, "project-1")).toThrow(/unsafe contract/i);
    expect(() => assertCiAnnualFinancialDemo({ ...payload, tariff_inputs: { ...payload.tariff_inputs, demand_savings_applied: true } }, "project-1")).toThrow(/unsafe contract/i);
    expect(() => assertCiAnnualFinancialDemo({ ...payload, solar_only_case: { ...payload.solar_only_case, financial_metrics_permitted: true } }, "project-1")).toThrow(/unsafe contract/i);
  });
});

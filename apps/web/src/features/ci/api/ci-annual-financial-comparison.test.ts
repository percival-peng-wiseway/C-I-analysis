import { expect, it, vi } from "vitest";

import {
  compareCiAnnualFinancialScenarios,
  type CiAnnualFinancialComparisonResult,
  type CiAnnualFinancialRebateBreakdown,
  type CiScenarioRebateCalculation,
} from "./ci-annual-financial-comparison";

it("posts explicit Top 10 prices and accepts the fail-closed v4 comparison contract", async () => {
  const payload = comparisonPayload();
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ pricing_mode: "manual_quotes", prices: [{ scenario_id: "scenario-1", upfront_cost_aud_ex_gst: 60000 }], discount_rate: 0.08, annual_value_escalation_rate: 0.025, annual_value_degradation_rate: 0.005, annual_om_fraction_of_capex: 0.015, analysis_term_years: 15 });
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  await expect(compareCiAnnualFinancialScenarios({
    projectId: "project-1",
    prices: [{ scenarioId: "scenario-1", upfrontCostAudExGst: 60000 }],
    assumptions: { discountRate: 0.08, annualValueEscalationRate: 0.025, annualValueDegradationRate: 0.005, annualOmFractionOfCapex: 0.015, analysisTermYears: 15 },
  }, fetcher)).resolves.toMatchObject({
    project_id: "project-1",
    assumptions: { rebate_application_basis: "not_deducted_from_analyst_entered_manual_quote" },
    solutions: [{
      gross_upfront_cost_aud_ex_gst: 60000,
      upfront_rebate_aud_ex_gst: 0,
      upfront_cost_aud_ex_gst: 60000,
      rebate_application_status: "not_applied_to_manual_quote",
      rebate_breakdown: [{ program_id: "solar_stc" }, { program_id: "battery_stc" }, { program_id: "vic_deemed_veec" }],
    }],
  });
});

it("rejects an otherwise valid v4 response that grants recommendation permission", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    ...comparisonPayload(),
    recommendation_permitted: true,
  }), { status: 200 }));

  await expect(compareCiAnnualFinancialScenarios({
    projectId: "project-1",
    prices: [{ scenarioId: "scenario-1", upfrontCostAudExGst: 60000 }],
    assumptions: { discountRate: 0.08, annualValueEscalationRate: 0.025, annualValueDegradationRate: 0.005, annualOmFractionOfCapex: 0.015, analysisTermYears: 15 },
  }, fetcher)).rejects.toThrow("unsafe contract");
});

it("rejects rebate audit data that conflicts with the finance assumptions", async () => {
  const wrongBasis = comparisonPayload();
  wrongBasis.assumptions.rebate_application_basis = "deducted_from_workspace_device_profile_gross_cost";
  const wrongRuleset = comparisonPayload();
  wrongRuleset.solutions[0].rebate_calculation.ruleset_sha256 = "d".repeat(64);

  for (const payload of [wrongBasis, wrongRuleset]) {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(compareCiAnnualFinancialScenarios({
      projectId: "project-1",
      prices: [{ scenarioId: "scenario-1", upfrontCostAudExGst: 60000 }],
      assumptions: { discountRate: 0.08, annualValueEscalationRate: 0.025, annualValueDegradationRate: 0.005, annualOmFractionOfCapex: 0.015, analysisTermYears: 15 },
    }, fetcher)).rejects.toThrow("unsafe contract");
  }
});

function comparisonPayload(): CiAnnualFinancialComparisonResult {
  const rebateCalculation = scenarioRebateCalculation("scenario-1");
  return {
    contract_version: "ci_annual_financial_comparison_v4",
    status: "ready",
    analysis_mode: "evidence_limited_internal_financial_comparison",
    project_id: "project-1",
    source_tariff_replay_sha256: "a".repeat(64),
    profile: { profile_id: "profile", display_label: "Evidence", source_version: "v1" },
    assumptions: {
      currency: "AUD",
      tax_basis: "gst_exclusive",
      price_source: "analyst_entered_total_solution_price",
      device_profile_sha256: null,
      device_prices: null,
      equipment_selection: null,
      rebate_profile_sha256: "b".repeat(64),
      rebate_ruleset_id: "au_ci_rebates_2026_v1",
      rebate_ruleset_sha256: "c".repeat(64),
      rebate_application_basis: "not_deducted_from_analyst_entered_manual_quote",
      discount_rate: 0.08,
      annual_value_escalation_rate: 0.025,
      annual_value_degradation_rate: 0.005,
      annual_om_fraction_of_capex: 0.015,
      analysis_term_years: 15,
      replacement_events_aud: [],
    },
    shortlist_source: { algorithm_id: "ci_analyst_selected_tariff_scenarios_v1", available_scenario_count: 20, shortlist_count: 1 },
    financial_review_order: { algorithm_id: "ci_highest_npv_review_order_v1", basis: "Highest NPV; internal only.", leader_scenario_id: "scenario-1", recommendation_permitted: false },
    solutions: [{
      scenario_id: "scenario-1",
      label: "Solution 1",
      physical_review_rank: 1,
      financial_review_rank: 1,
      pv_capacity_kwp_dc: 100,
      battery_capacity_kwh: 200,
      inverter_capacity_kw_ac: 80,
      gross_upfront_cost_aud_ex_gst: 60000,
      upfront_rebate_aud_ex_gst: 0,
      upfront_cost_aud_ex_gst: 60000,
      rebate_application_status: "not_applied_to_manual_quote",
      rebate_breakdown: rebateBreakdown(rebateCalculation),
      rebate_calculation: rebateCalculation,
      capex_breakdown_aud_ex_gst: null,
      annual_om_cost_aud_ex_gst: 900,
      first_year_value_aud_ex_gst: 10000,
      annual_cost_aud_ex_gst: 90000,
      metrics: { net_present_value_aud: -42167.35, payback_period_years: null, internal_rate_of_return: null, lifetime_net_value_undiscounted_aud: -40000, annual_cashflows_aud: Array(15).fill(10000) },
      customer_facing_permission: false,
      recommendation_permitted: false,
    }],
    currency_values_permitted: true,
    customer_facing_permission: false,
    recommendation_permitted: false,
    disclaimer: "Internal only.",
  };
}

function scenarioRebateCalculation(scenarioId: string): CiScenarioRebateCalculation {
  return {
    contract_version: "ci_scenario_rebate_calculation_v1",
    scenario_id: scenarioId,
    ruleset_id: "au_ci_rebates_2026_v1",
    ruleset_sha256: "c".repeat(64),
    target_certificate_date: "2026-09-02",
    programs: {
      solar_stc: {
        program_id: "solar_stc", label: "Solar STCs", status: "applied",
        reason_codes: [], reason_messages: [], certificate_quantity: 100,
        unit_price_aud_ex_gst: 39, rebate_aud_ex_gst: 3900,
        formula: { rule_id: "cer_solar_stc_2026_2030_v1", operands: { system_capacity_kwp_dc: 100, postcode_zone_rating: 1.382, deeming_years: 5 }, rounding: "floor_after_multiplication" },
        sources: { eligibility_source_label: "CER eligibility review", price_source_label: "Net certificate price", price_as_of_date: "2026-09-02", zone_source_label: "CER postcode zone table" },
      },
      battery_stc: {
        program_id: "battery_stc", label: "Battery STCs", status: "ineligible",
        reason_codes: ["battery_stc_nominal_capacity_out_of_range"], reason_messages: ["Battery STCs require total nominal capacity from 5 kWh through 100 kWh."], certificate_quantity: 0,
        unit_price_aud_ex_gst: 39, rebate_aud_ex_gst: 0,
        formula: { rule_id: "cer_battery_stc_2025_2030_v1", operands: { nominal_capacity_kwh: 200, certified_usable_capacity_fraction: 0.9 }, rounding: "floor_after_all_tiers_summed" },
        sources: { eligibility_source_label: "CER eligibility review", price_source_label: "Net certificate price", price_as_of_date: "2026-09-02", capacity_source_label: "Approved product datasheet" },
      },
      vic_deemed_veec: {
        program_id: "vic_deemed_veec", label: "Victorian deemed VEECs", status: "applied",
        reason_codes: [], reason_messages: [], certificate_quantity: 20,
        unit_price_aud_ex_gst: 70, rebate_aud_ex_gst: 1400,
        formula: { rule_id: "vic_veu_part47_v25_2026_v1", operands: { system_capacity_kwp_dc: 100, victoria_region: "metropolitan", regional_factor: 0.98, inverter_apparent_power_kva_per_kw_ac: 1.25 }, rounding: "floor_after_multiplication" },
        sources: { eligibility_source_label: "VEU Part 47 review", price_source_label: "Net certificate price", price_as_of_date: "2026-09-02", inverter_apparent_power_source_label: "Approved inverter datasheet" },
      },
    },
    total_rebate_aud_ex_gst: 5300,
    eligibility_guaranteed: false,
    customer_facing_permission: false,
  };
}

function rebateBreakdown(calculation: CiScenarioRebateCalculation): CiAnnualFinancialRebateBreakdown[] {
  return Object.values(calculation.programs).map((program) => ({
    program_id: program.program_id,
    label: program.label,
    status: program.status,
    certificate_quantity: program.certificate_quantity,
    unit_price_aud_ex_gst: program.unit_price_aud_ex_gst,
    rebate_aud_ex_gst: program.rebate_aud_ex_gst,
  }));
}

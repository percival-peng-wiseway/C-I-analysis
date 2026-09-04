// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CiAnalysisResult } from "./api/ci-analysis";
import type { CiFinancialSolution } from "./api/ci-financial-solutions";
import type { CiPhysicalScenarioResult, CiThreeCaseComparisonResult } from "./api/ci-scenarios";
import { CiConsultantReviewContent, CiConsultantReviewWorkspace } from "./ci-consultant-review-workspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const analysis: CiAnalysisResult = {
  contract_version: "ci_interval_tariff_analysis_v1",
  analysis_status: "ready",
  analysis_mode: "evidence_limited_internal_review",
  customer_facing_permission: false,
  profile: {
    profile_id: "synthetic",
    display_label: "Synthetic evidence profile",
    network_tariff_code: "LLVT2",
    billing_period_start: "2026-03-01",
    billing_period_end: "2026-03-31",
    source_version: "synthetic-v1",
  },
  data_quality: {
    status: "pass",
    coverage_start: "2025-04-01",
    coverage_end: "2026-03-31",
    interval_minutes: 5,
    interval_count_per_required_stream: 105120,
    required_streams_present: true,
    quality_method_counts: { A: 1 },
    quality_override_count: 0,
    warning_codes: [],
  },
  tariff_mapping: {
    meter_time_basis: "fixed_aest_interval_records",
    local_timezone: "Australia/Melbourne",
    demand_interval_minutes: 15,
    rolling_demand_months: 12,
    minimum_chargeable_rolling_kva: 0,
    network_peak_window: "07:00-22:00",
    incentive_window: "16:00-19:00",
    gst_basis: "exclusive",
  },
  demand_evidence: {
    rolling_demand_kva: 293,
    chargeable_rolling_demand_kva: 293,
    rolling_demand_timestamp: "2026-02-02T17:00:00+11:00",
    incentive_demand_kva: 270,
    incentive_demand_timestamp: "2026-02-02T17:00:00+11:00",
    billing_period_max_kva: 281,
    billing_period_max_kw: 260,
    billing_period_max_kvar: 106,
    billing_period_max_power_factor: 0.926,
    billing_period_max_timestamp: "2026-03-02T17:00:00+11:00",
  },
  bill_reconciliation: {
    status: "pass",
    calculated_subtotal_ex_gst_aud: 200000,
    calculated_gst_aud: 20000,
    calculated_total_inc_gst_aud: 220000,
    charge_categories: {},
    checks: [{ code: "synthetic", passed: true, calculated: 1, expected: 1 }],
  },
  assumptions: ["Synthetic fixture for presentation testing only."],
};

const scenarioResult: CiPhysicalScenarioResult = {
  contract_version: "ci_physical_scenario_review_v6",
  calculation_revision: "ci_physical_scenario_planner_primary_seed_v2",
  analysis_status: "ready",
  analysis_mode: "evidence_limited_internal_review",
  customer_facing_permission: false,
  recommendation_permitted: false,
  currency_values_permitted: true,
  ranking_basis: "Physical review order only.",
  baseline: {
    raw_rolling_demand_kva: 293,
    chargeable_rolling_demand_kva: 293,
    incentive_demand_kva: 270,
    billing_period_max_kva: 281,
    billing_period_max_kw: 260,
  },
  scenarios: [{
    scenario_id: "scenario-300",
    label: "141 kWp PV + 300 kWh BESS",
    physical_review_rank: 1,
    authored_inputs: {
      battery_system_id: "battery-300",
      battery_technology_id: "generic_li_ion_ac",
      control_profile_id: "demand_peak_shaving",
      pv_system_id: "pv-141",
      pv_profile_id: "generic_normalized_solar_shape_v1",
      pv_capacity_kwp_dc: 141.123456789,
      pv_inverter_capacity_kw_ac: 120.111222333,
      shared_ac_headroom_kw: 250,
      reactive_support_enabled: false,
      reactive_support_max_kvar: 0,
      shared_inverter_apparent_power_limit_kva: null,
      reactive_capability_curve: "circular_pq",
      reactive_capability_provenance: "analyst_assumption",
      reactive_overcompensation_permitted: false,
      pv_annual_specific_yield_kwh_per_kw: 1200,
      pv_derating_factor: 0.9,
      nominal_capacity_kwh: 300.987654321,
      max_charge_kw: 150,
      max_discharge_kw: 150.246813579,
      charge_efficiency: 0.95,
      discharge_efficiency: 0.95,
      min_soc_fraction: 0.1,
      max_soc_fraction: 1,
      initial_soc_fraction: 1,
      allow_grid_charging: true,
    },
    post_dispatch: {
      authority_source: "ci_peak_shaving_rolling_replay_v2",
      pv_generation_kwh: 170000,
      pv_curtailed_kwh: 0,
      raw_rolling_demand_kva: 188,
      chargeable_rolling_demand_kva: 188,
      maximum_reactive_support_kvar: 0,
      maximum_post_grid_reactive_kvar: 80,
      maximum_shared_inverter_apparent_power_kva: 141,
      incentive_demand_kva: 180,
      billing_period_max_kva: 190,
      billing_period_max_kw: 175,
      billing_period_peak_kw_reduction: 85,
      billing_period_peak_effect: "reduction",
      billing_period_peak_change_kw: 85,
      billing_period_projection_status: "evaluated",
    },
    dispatch_review_projection: {
      contract_version: "ci_dispatch_review_projection_v2",
      status: "ready",
      selection_basis: "maximum_post_dispatch_rolling_kva_earliest_timestamp",
      peak_local_date: "2026-02-02",
      peak_interval: { interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", baseline_import_kw: 260, post_dispatch_import_kw: 175, baseline_kva: 293, post_dispatch_kva: 188 },
      coverage: { interval_minutes: 15, interval_count: 2, start_local_timestamp: "2026-02-02T16:45:00+11:00", end_local_timestamp: "2026-02-02T17:00:00+11:00" },
      units: { active_power: "kW", apparent_power: "kVA", reactive_power: "kvar", stored_energy: "kWh" },
      soc_status: "available",
      authority_source: "ci_peak_shaving_rolling_replay_v2",
      optimizer_snapshot_sha256: "a".repeat(64),
      interval_dispatch_sha256: "b".repeat(64),
      customer_facing_permission: false,
      recommendation_permitted: false,
      projection_sha256: "c".repeat(64),
      points: [
        { interval_timestamp: "2026-02-02T16:45:00+11:00", local_timestamp: "2026-02-02T16:45:00+11:00", local_time_label: "16:45 AEDT", baseline_import_kw: 220, post_dispatch_import_kw: 180, baseline_kva: 250, post_dispatch_kva: 190, site_reactive_import_kvar: 80, inverter_reactive_support_kvar: 0, post_grid_reactive_kvar: 80, grid_charge_kw: 0, pv_charge_kw: 10, battery_discharge_kw: 0, soc_end_kwh: 290 },
        { interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", local_time_label: "17:00 AEDT", baseline_import_kw: 260, post_dispatch_import_kw: 175, baseline_kva: 293, post_dispatch_kva: 188, site_reactive_import_kvar: 80, inverter_reactive_support_kvar: 0, post_grid_reactive_kvar: 80, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 85, soc_end_kwh: 268 },
      ],
    },
    annual_tariff_value: {
      calculation_method: "representative_year_repeat_v1",
      period_start: "2025-04-01",
      period_end: "2026-03-31",
      rate_basis: "synthetic",
      baseline_cost_ex_gst_aud: 200000,
      scenario_cost_ex_gst_aud: 160000,
      first_year_value_ex_gst_aud: 40000,
      baseline_cost_inc_gst_aud: 220000,
      scenario_cost_inc_gst_aud: 176000,
      first_year_value_inc_gst_aud: 44000,
      category_savings_ex_gst_aud: { energy: 40000 },
      customer_facing_permission: false,
    },
    planned_demand_limits_kva: [{ component_id: "annual_rolling_kva", billing_period_id: null, rate_aud_per_kva: 12, planner_limit_kva: 175 }],
    selected_monthly_thresholds_kw: Array(12).fill(175),
    optimizer_run_snapshot: {
      contract_version: "ci_optimizer_run_snapshot_v2",
      calculation_revision: "ci_optimizer_run_snapshot_planner_primary_seed_v2",
      snapshot_sha256: "a".repeat(64),
      algorithm_id: "ci_peak_shaving_rolling_replay_v2",
      customer_facing_permission: false,
      recommendation_permitted: false,
      input_projection: {},
      physical_assumptions: {},
      result_projection: {},
    },
    optimizer_audit_projection: {
      contract_version: "ci_optimizer_audit_projection_v2",
      snapshot_sha256: "a".repeat(64),
      customer_facing_permission: false,
      recommendation_permitted: false,
    },
  }],
  report_preview: {
    status: "ready",
    output_kind: "in_app_evidence_preview",
    download_available: false,
    sections: ["Evidence-bound baseline"],
    disclaimer: "Internal physical review only.",
  },
  assumptions: ["Physical scenario values are analyst-authored inputs."],
};

const financialSolution: CiFinancialSolution = {
  contract_version: "ci_financial_solution_v4",
  solution_id: "financial-300",
  label: "141 kWp PV + 300 kWh BESS",
  scenario_id: "scenario-300",
  source_physical_scenario_sha256: "b".repeat(64),
  optimizer_run_snapshot_sha256: "a".repeat(64),
  optimizer_run_snapshot: scenarioResult.scenarios[0].optimizer_run_snapshot,
  optimizer_audit_projection: scenarioResult.scenarios[0].optimizer_audit_projection,
  assumptions: {
    upfront_cost_aud: 268800,
    first_year_net_value_aud: 42000,
    annual_om_cost_aud: 2000,
    replacement_events_aud: [],
    discount_rate: 0.08,
    annual_value_degradation_rate: 0,
    analysis_term_years: 15,
    currency: "AUD",
    value_source: "evidence_bound_tariff_scenario",
    pricing_resolution: {
      catalog_version_id: "catalog-1",
      catalog_version_number: 1,
      catalog_hash: "c".repeat(64),
      tax_basis: "gst_inclusive",
      resolved_upfront_cost_aud: 268800,
      resolved_annual_om_cost_aud: 2000,
      lines: [],
    },
  },
  metrics: {
    net_present_value_aud: 150000,
    payback_period_years: 6.4,
    internal_rate_of_return: 0.14,
    lifetime_net_value_undiscounted_aud: 360000,
    annual_cashflows_aud: [-268800, 40000, 40000, 40000],
  },
  starred: true,
  created_at: "2026-08-15T00:00:00+10:00",
  updated_at: "2026-08-15T00:00:00+10:00",
  customer_facing_permission: false,
};

const secondScenario = {
  ...scenarioResult.scenarios[0],
  scenario_id: "scenario-400",
  label: "180 kWp PV + 400 kWh BESS",
  physical_review_rank: 2,
  authored_inputs: {
    ...scenarioResult.scenarios[0].authored_inputs,
    pv_capacity_kwp_dc: 180,
    nominal_capacity_kwh: 400,
    max_charge_kw: 200,
    max_discharge_kw: 200,
  },
  post_dispatch: {
    ...scenarioResult.scenarios[0].post_dispatch,
    raw_rolling_demand_kva: 170,
    billing_period_max_kva: 172,
  },
  optimizer_run_snapshot: {
    ...scenarioResult.scenarios[0].optimizer_run_snapshot!,
    snapshot_sha256: "d".repeat(64),
  },
  optimizer_audit_projection: {
    ...scenarioResult.scenarios[0].optimizer_audit_projection!,
    snapshot_sha256: "d".repeat(64),
  },
};

const scenarioResultWithTwo: CiPhysicalScenarioResult = {
  ...scenarioResult,
  scenarios: [scenarioResult.scenarios[0], secondScenario],
};

const pvOnlyScenario: CiPhysicalScenarioResult["scenarios"][number] = {
  ...scenarioResult.scenarios[0],
  scenario_id: "scenario-pv-only",
  label: "141 kWp PV only",
  authored_inputs: {
    ...scenarioResult.scenarios[0].authored_inputs,
    battery_system_id: "battery-zero",
    nominal_capacity_kwh: 0,
    max_charge_kw: 0,
    max_discharge_kw: 0,
  },
  post_dispatch: {
    ...scenarioResult.scenarios[0].post_dispatch,
    authority_source: "ci_pv_only_shared_pq_v1",
  },
  dispatch_review_projection: {
    ...scenarioResult.scenarios[0].dispatch_review_projection,
    authority_source: "ci_pv_only_shared_pq_v1",
    soc_status: "not_applicable_no_battery",
    optimizer_snapshot_sha256: null,
    interval_dispatch_sha256: null,
    points: scenarioResult.scenarios[0].dispatch_review_projection.points.map((point) => ({
      ...point,
      grid_charge_kw: 0,
      pv_charge_kw: 0,
      battery_discharge_kw: 0,
      soc_end_kwh: null,
    })),
  },
  optimizer_run_snapshot: null,
  optimizer_audit_projection: null,
};

const comparison: CiThreeCaseComparisonResult = {
  contract_version: "ci_three_case_peak_day_comparison_v2",
  status: "ready",
  analysis_mode: "evidence_limited_internal_review",
  selection_basis: "pv_battery_maximum_post_dispatch_rolling_kva_earliest_timestamp",
  pairing_basis: "explicit_consultant_selected_exact_pv_match",
  common_local_date: "2026-02-02",
  selected_peak_interval_timestamp: "2026-02-02T17:00:00+11:00",
  coverage: { interval_minutes: 15, interval_count: 1, start_local_timestamp: "2026-02-02T17:00:00+11:00", end_local_timestamp: "2026-02-02T17:00:00+11:00", timestamps_aligned: true },
  units: { active_power: "kW", apparent_power: "kVA", reactive_power: "kvar", stored_energy: "kWh" },
  cases: [
    { case_id: "no_system", label: "No system", scenario_id: null, authority_source: "ci_evidence_bound_baseline_v1", soc_status: "not_applicable_no_battery", projection_sha256: null, optimizer_snapshot_sha256: null, interval_dispatch_sha256: null },
    { case_id: "pv_only", label: "141 kWp PV only", scenario_id: "scenario-pv-only", authority_source: "ci_pv_only_shared_pq_v1", soc_status: "not_applicable_no_battery", projection_sha256: "a".repeat(64), optimizer_snapshot_sha256: null, interval_dispatch_sha256: null },
    { case_id: "pv_battery", label: "141 kWp PV + 300 kWh BESS", scenario_id: "scenario-300", authority_source: "ci_peak_shaving_rolling_replay_v2", soc_status: "available", projection_sha256: "b".repeat(64), optimizer_snapshot_sha256: "c".repeat(64), interval_dispatch_sha256: "d".repeat(64) },
  ],
  baseline: scenarioResult.baseline,
  provenance: { source_contract_version: "ci_physical_scenario_review_v6", profile_id: "synthetic", profile_source_version: "synthetic-v1", source_nem12_sha256: "e".repeat(64), pv_only_scenario_sha256: "f".repeat(64), pv_battery_scenario_sha256: "0".repeat(64) },
  customer_facing_permission: false,
  recommendation_permitted: false,
  eligibility_permitted: false,
  report_available: false,
  download_available: false,
  delivery_permitted: false,
  points: [{
    interval_timestamp: "2026-02-02T17:00:00+11:00", local_timestamp: "2026-02-02T17:00:00+11:00", local_time_label: "17:00 AEDT",
    no_system: { import_kw: 260, import_kva: 293, site_reactive_import_kvar: 80, reactive_support_kvar: 0, post_grid_reactive_kvar: 80, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 0, soc_end_kwh: null },
    pv_only: { import_kw: 210, import_kva: 240, site_reactive_import_kvar: 80, reactive_support_kvar: 0, post_grid_reactive_kvar: 80, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 0, soc_end_kwh: null },
    pv_battery: { import_kw: 175, import_kva: 188, site_reactive_import_kvar: 80, reactive_support_kvar: 0, post_grid_reactive_kvar: 80, grid_charge_kw: 0, pv_charge_kw: 0, battery_discharge_kw: 85, soc_end_kwh: 268 },
  }],
  comparison_sha256: "1".repeat(64),
};

const secondFinancialSolution: CiFinancialSolution = {
  ...financialSolution,
  solution_id: "financial-400",
  scenario_id: "scenario-400",
  label: "180 kWp PV + 400 kWh BESS",
  optimizer_run_snapshot_sha256: "d".repeat(64),
  optimizer_run_snapshot: secondScenario.optimizer_run_snapshot,
  optimizer_audit_projection: secondScenario.optimizer_audit_projection,
  metrics: {
    ...financialSolution.metrics,
    net_present_value_aud: 210000,
  },
  starred: false,
};

describe("C&I consultant review workspace", () => {
  it("organizes existing backend facts into a guided internal review without recommendation or output authority", () => {
    const html = renderToStaticMarkup(
      <CiConsultantReviewContent
        analysis={analysis}
        financialSolutions={[financialSolution]}
        scenarioResult={scenarioResult}
      />,
    );

    expect(html).toContain("Consultant review");
    expect(html).toContain("Decision overview");
    expect(html).toContain("Baseline &amp; evidence");
    expect(html).toContain("Solution explorer");
    expect(html).toContain("Physical / peak evidence");
    expect(html).toContain("Financial assessment");
    expect(html).toContain("Assumptions &amp; provenance");
    expect(html).toContain("Output status");
    expect(html).toContain("141 kWp PV + 300 kWh BESS");
    expect(html).toContain("141.123456789 kWp PV · 300.987654321 kWh BESS · 150.246813579 kW discharge");
    expect(html).toContain("$268,800");
    expect(html).toContain("14.0%");
    expect(html).toContain("No automatic recommendation");
    expect(html).toContain("Customer-facing permission");
    expect(html).toContain("Prepare report");
    expect((html.match(/Unavailable/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("Returned peak-day traces");
    expect(html).toContain("Reactive import and inverter support");
    expect(html).toContain("Post-grid reactive");
    expect(html).toContain("Exact returned intervals");
    expect(html).not.toContain(">Recommended<");
  });

  it("keeps an empty financial state anchored to a returned physical scenario", () => {
    const html = renderToStaticMarkup(
      <CiConsultantReviewContent
        analysis={analysis}
        financialSolutions={[]}
        scenarioResult={scenarioResult}
      />,
    );

    expect(html).toContain("Viewed physical scenario");
    expect(html).toContain("no matching saved financial assessment");
    expect(html).toContain("Save a financial solution in Analyse");
  });

  it("requires explicit case selection and presents the returned comparison under collapsed disclosures", async () => {
    const user = userEvent.setup();
    const onRunComparison = vi.fn();
    render(
      <CiConsultantReviewContent
        analysis={analysis}
        comparison={comparison}
        financialSolutions={[]}
        onRunComparison={onRunComparison}
        scenarioResult={{ ...scenarioResult, scenarios: [pvOnlyScenario, scenarioResult.scenarios[0]] }}
      />,
    );

    expect(screen.getByText("Compare no system, PV only and PV + battery on one common peak day")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "PV-only scenario" }), "scenario-pv-only");
    await user.selectOptions(screen.getByRole("combobox", { name: "PV + battery scenario" }), "scenario-300");
    await user.click(screen.getByRole("button", { name: "Compare selected cases" }));
    expect(onRunComparison).toHaveBeenCalledWith({ pvOnlyScenarioId: "scenario-pv-only", pvBatteryScenarioId: "scenario-300" });
    expect(screen.getByText("Common returned day: 2026-02-02")).toBeTruthy();
    expect(screen.getByText("Exact values for the three aligned cases")).toBeTruthy();
    expect(screen.getByText("Reactive import on common returned day")).toBeTruthy();
    expect(screen.getByText("Comparison provenance and permissions")).toBeTruthy();
    expect(screen.queryByText(/Recommended/)).toBeNull();
  });

  it("shows one contextual report action and downloads only the exact current pair", async () => {
    const user = userEvent.setup();
    const onPrepareReport = vi.fn();
    const { rerender } = render(
      <CiConsultantReviewContent
        analysis={analysis}
        comparison={comparison}
        financialSolutions={[financialSolution]}
        onPrepareReport={onPrepareReport}
        scenarioResult={scenarioResult}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Prepare report" }));
    expect(onPrepareReport).toHaveBeenCalledWith(financialSolution, comparison);

    rerender(
      <CiConsultantReviewContent
        analysis={analysis}
        comparison={comparison}
        financialSolutions={[financialSolution]}
        reportArtifact={{
          contract_version: "ci_internal_review_report_artifacts_v1",
          artifact_id: "report-1",
          status: "ready",
          display_status: "Ready",
          created_new: true,
          financial_solution_id: financialSolution.solution_id,
          source_fingerprint: "a".repeat(64),
          source_nem12_sha256: "b".repeat(64),
          source_physical_scenario_sha256: "c".repeat(64),
          optimizer_run_snapshot_sha256: "d".repeat(64),
          comparison_sha256: comparison.comparison_sha256,
          html_sha256: "e".repeat(64), html_byte_size: 100,
          pdf_sha256: "f".repeat(64), pdf_byte_size: 200,
          renderer_id: "weasyprint_restricted_process", renderer_version: "69.0",
          page_count: 3, created_at: "2026-08-16T00:00:00Z",
          can_download_html: true, can_download_pdf: true,
          customer_facing_permission: false, recommendation_permitted: false,
          eligibility_permitted: false, manual_delivery_permission: false,
          repository_managed_delivery_permission: false,
        }}
        scenarioResult={scenarioResult}
      />,
    );
    expect(screen.getByRole("link", { name: "Download report" }).getAttribute("href")).toContain("report-1.pdf");
    expect(screen.queryByRole("button", { name: "Prepare report" })).toBeNull();
    expect(screen.getByText(/customer\/recommendation\/delivery unavailable/)).toBeTruthy();
  });

  it("synchronizes financial focus to its physical scenario and keeps physical-only focus unpaired", async () => {
    const user = userEvent.setup();
    const onStar = vi.fn();
    render(
      <CiConsultantReviewContent
        analysis={analysis}
        financialSolutions={[financialSolution, secondFinancialSolution]}
        onStar={onStar}
        scenarioResult={scenarioResultWithTwo}
      />,
    );

    const tables = screen.getAllByRole("table");
    const physicalRow = within(tables[1]).getByText("180 kWp PV + 400 kWh BESS", { selector: "td" }).closest("tr");
    expect(physicalRow).not.toBeNull();
    await user.click(within(physicalRow!).getByRole("button", { name: "View" }));
    const overview = screen.getByRole("region", { name: "Decision overview" });
    expect(within(overview).getByText("Viewed physical scenario")).toBeTruthy();
    expect(within(overview).getByText(/no matching saved financial assessment/)).toBeTruthy();

    const financialRow = within(tables[0]).getByText("180 kWp PV + 400 kWh BESS", { selector: "td" }).closest("tr");
    expect(financialRow).not.toBeNull();
    await user.click(within(financialRow!).getByRole("button", { name: "View" }));
    expect(within(overview).getByText("Viewed solution")).toBeTruthy();
    expect(within(overview).getByText("180 kWp PV + 400 kWh BESS")).toBeTruthy();
    expect(within(overview).getByText(/180 kWp PV · 400 kWh BESS/)).toBeTruthy();

    await user.click(within(financialRow!).getByRole("button", { name: "Add 180 kWp PV + 400 kWh BESS to shortlist" }));
    expect(onStar).toHaveBeenCalledWith(secondFinancialSolution);
  });

  it("shows explicit financial loading, recovery, and shortlist mutation states", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <CiConsultantReviewContent
        analysis={analysis}
        financialLoading
        financialSolutions={[]}
        scenarioResult={scenarioResult}
      />,
    );
    expect(screen.getAllByText("Loading saved financial solutions…").length).toBeGreaterThan(0);

    rerender(
      <CiConsultantReviewContent
        analysis={analysis}
        financialError="Synthetic saved-solution failure."
        financialSolutions={[]}
        onRetryFinancial={onRetry}
        scenarioResult={scenarioResult}
      />,
    );
    expect(screen.getByText("Saved financial solutions could not be loaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reload saved solutions" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <CiConsultantReviewContent
        analysis={analysis}
        financialSolutions={[financialSolution]}
        scenarioResult={scenarioResult}
        starError="Synthetic shortlist failure."
        starPendingId={financialSolution.solution_id}
      />,
    );
    expect(screen.getByText("Synthetic shortlist failure.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Remove 141 kWp PV + 300 kWh BESS from shortlist" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("excludes persisted financial solutions without a corresponding current physical result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ solutions: [secondFinancialSolution] }), { status: 200 }),
    ));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CiConsultantReviewWorkspace analysis={analysis} scenarioResult={scenarioResult} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Viewed physical scenario")).toBeTruthy();
    expect(screen.queryByText("180 kWp PV + 400 kWh BESS")).toBeNull();
    expect(screen.getByText(/no matching saved financial assessment/)).toBeTruthy();
  });
});

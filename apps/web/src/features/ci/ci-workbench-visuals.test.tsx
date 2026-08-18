import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CiAnalysisResult } from "@/features/ci/api/ci-analysis";
import type { CiPhysicalScenarioResult } from "@/features/ci/api/ci-scenarios";
import { CiBaselineVisuals, CiScenarioVisuals, CiWorkflowNavigator } from "@/features/ci/ci-workbench-visuals";

describe("C&I workbench visuals", () => {
  it("charts only returned demand and bill values", () => {
    render(<CiBaselineVisuals result={{
      demand_evidence: {
        rolling_demand_kva: 310,
        incentive_demand_kva: 270,
        billing_period_max_kva: 295,
        billing_period_max_power_factor: 0.91,
      },
      bill_reconciliation: {
        charge_categories: { energy_charge: 12000, demand_charge: 8000, export_credit: -900 },
        calculated_total_inc_gst_aud: 21010,
      },
    } as unknown as CiAnalysisResult} />);

    expect(screen.getByRole("img", { name: "Bill composition chart" })).toBeTruthy();
    expect(screen.getByText("310.00 kVA")).toBeTruthy();
    expect(screen.getByText("Export Credit")).toBeTruthy();
  });

  it("renders a solution landscape and baseline comparison", () => {
    const scenario = {
      scenario_id: "pv-battery",
      label: "200 kWp + 400 kWh",
      physical_review_rank: 1,
      authored_inputs: { pv_capacity_kwp_dc: 200, nominal_capacity_kwh: 400 },
      post_dispatch: { raw_rolling_demand_kva: 230 },
      annual_tariff_value: { first_year_value_ex_gst_aud: 42000 },
    };
    render(<CiScenarioVisuals result={{
      baseline: { raw_rolling_demand_kva: 310 },
      scenarios: [scenario],
    } as unknown as CiPhysicalScenarioResult} />);

    expect(screen.getByRole("img", { name: "Solution landscape chart" })).toBeTruthy();
    expect(screen.getByText("Evidence baseline")).toBeTruthy();
    expect(screen.getByText("#1 200 kWp + 400 kWh")).toBeTruthy();
  });

  it("keeps future steps visibly locked until their prerequisites exist", () => {
    render(<CiWorkflowNavigator analysisReady={false} evidenceReady posture="analyse" scenariosReady={false} />);
    expect(screen.getByText("Data & tariff").closest("a")?.getAttribute("data-status")).toBe("current");
    expect(screen.getByText("Financials").closest("a")?.getAttribute("aria-disabled")).toBe("true");
  });
});
// @vitest-environment jsdom

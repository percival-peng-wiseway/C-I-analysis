// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { CiAnnualBillEstimateEstimated } from "./api/ci-evidence-intake";
import { CiAnnualBillCompositionChart } from "./ci-annual-bill-visuals";

afterEach(cleanup);

const groups: CiAnnualBillEstimateEstimated["groups"] = [
  { key: "fixed", label: "Fixed", total_ex_gst_aud: 100, items: [] },
  { key: "other_usage", label: "Other usage", total_ex_gst_aud: 600, items: [] },
  { key: "energy_import", label: "Energy (Import)", total_ex_gst_aud: 300, items: [] },
];

it("shows exact annualised group totals and proportions without hover", () => {
  render(<CiAnnualBillCompositionChart groups={groups} total={1_000} />);

  expect(screen.getByRole("img", { name: /Annualised charge mix: Fixed \$100\.00, Other usage \$600\.00, Energy \(Import\) \$300\.00/ })).toBeTruthy();
  expect(screen.getByText("10% of total")).toBeTruthy();
  expect(screen.getByText("60% of total")).toBeTruthy();
  expect(screen.getByText("30% of total")).toBeTruthy();
});

it("falls back to labelled totals when a signed group makes proportions misleading", () => {
  render(<CiAnnualBillCompositionChart groups={[
    { ...groups[0], total_ex_gst_aud: -100 },
    groups[1],
    groups[2],
  ]} total={800} />);

  expect(screen.queryByRole("img", { name: /Annualised charge mix/ })).toBeNull();
  expect(screen.getByText(/proportional view is not shown/i)).toBeTruthy();
  expect(screen.getByText("-$100.00")).toBeTruthy();
  expect(screen.queryByText(/of total/)).toBeNull();
});

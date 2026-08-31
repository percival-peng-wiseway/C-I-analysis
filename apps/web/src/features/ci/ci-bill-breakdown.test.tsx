// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { CiEvidenceIntakeResult } from "./api/ci-evidence-intake";
import { CiBillBreakdown } from "./ci-bill-breakdown";

afterEach(cleanup);

const categoryBill: CiEvidenceIntakeResult["bill"] = {
  fingerprint: "bill123",
  retailer: "Origin Energy",
  invoice_kind: "Business Electricity Tax Invoice",
  extraction_method: "verified_origin_template",
  review_status: "not_required",
  missing_fields: [],
  invoice_arithmetic_scope: "charge_categories_and_totals",
  site_identity_status: "extracted",
  billing_period_start: "2026-03-01",
  billing_period_end: "2026-03-31",
  billing_days: 31,
  network_tariff_code: "LLVT2",
  consumption_kwh: 1000,
  highest_metered_demand_kva: 120,
  power_factor_at_highest_demand: 0.82,
  charge_categories_ex_gst_aud: {
    energy_charges: 300,
    network_charges: 500,
    regulated_charges: 50,
    environmental_charges: 30,
    metering_charges: 20,
    additional_charges: 0,
  },
  subtotal_ex_gst_aud: 900,
  gst_aud: 90,
  total_inc_gst_aud: 990,
};

it("charts verified bill categories and invoice averages", () => {
  render(<CiBillBreakdown bill={categoryBill} />);

  expect(screen.getByRole("heading", { name: "Detected bill breakdown" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "Detected invoice charge categories" })).toBeTruthy();
  expect(screen.getByRole("rowheader", { name: "Network charges" })).toBeTruthy();
  expect(screen.getByText("55.6%")).toBeTruthy();
  expect(screen.getByText("Total inc GST")).toBeTruthy();
  expect(screen.queryByRole("img", { name: /Invoice composition including GST/ })).toBeNull();
  expect(screen.getByText("90 c/kWh")).toBeTruthy();
  expect(screen.getByText("99 c/kWh")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Power factor at maximum demand 0.820" })).toBeTruthy();
});

it("shows confirmed totals without inventing charge categories", () => {
  render(<CiBillBreakdown bill={{
    ...categoryBill,
    extraction_method: "generic_pdf_text_with_analyst_confirmation",
    review_status: "analyst_confirmed",
    invoice_arithmetic_scope: "invoice_totals_only",
    charge_categories_ex_gst_aud: {},
  }} />);

  expect(screen.getByText("Category detail unavailable")).toBeTruthy();
  expect(screen.queryByRole("table", { name: "Detected invoice charge categories" })).toBeNull();
  expect(screen.getByText("Subtotal ex GST")).toBeTruthy();
  expect(screen.getByText("GST")).toBeTruthy();
  expect(screen.getByText("Total inc GST")).toBeTruthy();
});

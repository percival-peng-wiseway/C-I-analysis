// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

import type { CiAnnualBillEstimate, CiDetectedTariff } from "./api/ci-evidence-intake";
import { CiTariffAnnualEstimate } from "./ci-tariff-annual-estimate";

afterEach(cleanup);

const detectedTariff: CiDetectedTariff = {
  status: "category_totals_detected",
  tariff_code: "LLVT2",
  tax_basis: "ex_gst",
  warning: "Category totals come from the invoice. Derived labels are not approved tariff rates.",
  groups: [
    { key: "fixed", label: "Fixed", items: [{ key: "metering", label: "Metering charges", source_amount_ex_gst_aud: 31, basis_label: "31-day invoice period", rate_label: "Derived daily equivalent: $1/day" }] },
    { key: "other_usage", label: "Other usage", items: [{ key: "network", label: "Network charges", source_amount_ex_gst_aud: 420, basis_label: "Invoice category total", rate_label: "Demand and volume rate split unavailable" }] },
    { key: "energy_import", label: "Energy (Import)", items: [{ key: "energy", label: "Energy charges", source_amount_ex_gst_aud: 250, basis_label: "1,000 kWh invoice consumption", rate_label: "Derived blended rate: 25 c/kWh" }] },
  ],
};

const estimate: CiAnnualBillEstimate = {
  status: "unavailable",
  method: "approved_tariff_replay_required",
  confidence: "unavailable",
  tariff_code: "LLVT2",
  coverage_start: "2025-04-01",
  coverage_end: "2026-03-31",
  annual_import_kwh: 125_000,
  total_ex_gst_aud: null,
  customer_facing_permission: false,
  warning: "A formal replay is required because network demand and volume rates were not detected.",
  assumptions: ["The bill-period interval import must reconcile to billed consumption.", "Approved current demand rules are required."],
  groups: [],
};

const billDerivedEstimate: CiAnnualBillEstimate = {
  status: "estimated",
  method: "bill_derived_interval_scaled_v1",
  confidence: "evidence_limited",
  tariff_code: "LLVT2",
  coverage_start: "2025-04-01",
  coverage_end: "2026-03-31",
  annual_import_kwh: 20_000,
  bill_period_reconciliation: {
    status: "pass",
    coverage_complete: true,
    billing_period_start: "2026-01-01",
    billing_period_end: "2026-01-31",
    billing_days: 31,
    interval_import_kwh: 995,
    billed_consumption_kwh: 1_000,
    difference_kwh: -5,
    difference_percent: 0.5,
    tolerance_percent: 2,
    warning: "The NEM12 E1 import reconciles to billed consumption within 2%.",
  },
  total_ex_gst_aud: 11_410.16,
  customer_facing_permission: false,
  warning: "Internal estimate only; this is not a contractual tariff replay or customer quote.",
  assumptions: ["The most recent complete 365 NEM12 E1 days represent annual site import."],
  groups: [
    {
      key: "fixed", label: "Fixed", total_ex_gst_aud: 365,
      items: [{ key: "metering_charges", label: "Metering charges", source_amount_ex_gst_aud: 31, scaling_basis: "365_days_over_billing_days", scaling_factor: 11.774193548, annual_amount_ex_gst_aud: 365 }],
    },
    {
      key: "other_usage", label: "Other usage", total_ex_gst_aud: 6_045.16,
      items: [
        { key: "network_charges", label: "Network charges", source_amount_ex_gst_aud: 420, scaling_basis: "365_days_over_billing_days", scaling_factor: 11.774193548, annual_amount_ex_gst_aud: 4_945.16 },
        { key: "regulated_charges", label: "Regulated charges", source_amount_ex_gst_aud: 40, scaling_basis: "annual_import_kwh_over_billed_consumption_kwh", scaling_factor: 20, annual_amount_ex_gst_aud: 800 },
        { key: "environmental_charges", label: "Environmental charges", source_amount_ex_gst_aud: 15, scaling_basis: "annual_import_kwh_over_billed_consumption_kwh", scaling_factor: 20, annual_amount_ex_gst_aud: 300 },
        { key: "additional_charges", label: "Additional charges, credits & adjustments", source_amount_ex_gst_aud: -20, scaling_basis: "excluded_unverified_recurrence", scaling_factor: 0, annual_amount_ex_gst_aud: 0 },
      ],
    },
    {
      key: "energy_import", label: "Energy (Import)", total_ex_gst_aud: 5_000,
      items: [{ key: "energy_charges", label: "Energy charges", source_amount_ex_gst_aud: 250, scaling_basis: "annual_import_kwh_over_billed_consumption_kwh", scaling_factor: 20, annual_amount_ex_gst_aud: 5_000 }],
    },
  ],
};

it("shows the three detected tariff categories without presenting derived labels as approved rates", async () => {
  const user = userEvent.setup();
  render(<CiTariffAnnualEstimate detectedTariff={detectedTariff} estimate={estimate} tariffCode="LLVT2" />);

  expect(screen.getByRole("tab", { name: "Fixed" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("table", { name: "Fixed detected invoice charges" })).toBeTruthy();
  expect(screen.getByText("Derived daily equivalent: $1/day")).toBeTruthy();
  expect(screen.getByText(/not approved tariff rates/i)).toBeTruthy();

  await user.click(screen.getByRole("tab", { name: "Other usage" }));
  expect(screen.getByRole("table", { name: "Other usage detected invoice charges" })).toBeTruthy();
  expect(screen.getByText("Demand and volume rate split unavailable")).toBeTruthy();

  const otherTab = screen.getByRole("tab", { name: "Other usage" });
  otherTab.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Energy (Import)" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("table", { name: "Energy (Import) detected invoice charges" })).toBeTruthy();
});

it("shows annual usage readiness but withholds customer dollar claims", () => {
  render(<CiTariffAnnualEstimate detectedTariff={detectedTariff} estimate={estimate} tariffCode="LLVT2" />);

  expect(screen.getByRole("heading", { name: "Estimated annual bill" })).toBeTruthy();
  expect(screen.getByText("125,000 kWh")).toBeTruthy();
  expect(screen.getByText("2025-04-01 to 2026-03-31")).toBeTruthy();
  expect(screen.getByText("Withheld pending approved tariff replay")).toBeTruthy();
  expect(screen.getByText("Evidence required")).toBeTruthy();
  expect(screen.getByText("The bill-period interval import must reconcile to billed consumption.")).toBeTruthy();
  expect(screen.getByText(/formal replay is required/i)).toBeTruthy();
  expect(screen.queryByText("$56,200.29")).toBeNull();
});

it("shows a reconciled bill-derived annual estimate with category detail and exclusions", () => {
  render(<CiTariffAnnualEstimate detectedTariff={detectedTariff} estimate={billDerivedEstimate} tariffCode="LLVT2" />);

  expect(screen.getByText("Expected bill (baseline)")).toBeTruthy();
  expect(screen.getByText("$11,410.16")).toBeTruthy();
  expect(screen.getByText("Evidence-limited estimate")).toBeTruthy();
  expect(screen.getByRole("table", { name: "Fixed estimated annual charges" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "Other usage estimated annual charges" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "Energy (Import) estimated annual charges" })).toBeTruthy();
  expect(screen.getByText("-5 kWh (0.5%)")).toBeTruthy();
  expect(screen.getByText("≤ 2%")).toBeTruthy();
  expect(screen.getByText("-$20.00")).toBeTruthy();
  expect(screen.getByText("Excluded — recurrence not verified")).toBeTruthy();
  expect(screen.getByText("Not annualised")).toBeTruthy();
  expect(screen.getByText(/not a contractual quote/i)).toBeTruthy();
  expect(screen.queryByText("Estimate assumptions and limits")).toBeNull();
  expect(screen.queryByText(billDerivedEstimate.warning)).toBeNull();
  expect(screen.queryByText("The most recent complete 365 NEM12 E1 days represent annual site import.")).toBeNull();
});

it("fails closed when detected category detail and annual estimation are unavailable", () => {
  render(<CiTariffAnnualEstimate
    detectedTariff={{ status: "review_required", tariff_code: null, tax_basis: "ex_gst", warning: "Verified charge categories are unavailable.", groups: [] }}
    estimate={{
      status: "unavailable", method: "unavailable", confidence: "unavailable", tariff_code: null,
      coverage_start: null, coverage_end: null, annual_import_kwh: null, total_ex_gst_aud: null,
      customer_facing_permission: false, warning: "A complete 365-day import series is required.", assumptions: [], groups: [],
    }}
    tariffCode={null}
  />);

  expect(screen.getByText("Verified charge categories are unavailable.")).toBeTruthy();
  expect(screen.getByText("A complete 365-day import series is required.")).toBeTruthy();
  expect(screen.queryByText(/Expected bill \(baseline\)/)).toBeNull();
  expect(screen.queryByText(/^\$/)).toBeNull();
});

import { describe, expect, it } from "vitest";

import { fetchCiProjectEvidence, inspectCiEvidencePair, reviewSavedCiEvidence } from "./ci-evidence-intake";

const safeResult = {
  contract_version: "ci_evidence_intake_v7",
  intake_status: "ready_for_profile_review",
  bill: {
    fingerprint: "abc123", retailer: "Origin Energy", invoice_kind: "Business Electricity Tax Invoice",
    extraction_method: "verified_origin_template", review_status: "not_required", missing_fields: [],
    invoice_arithmetic_scope: "charge_categories_and_totals", site_identity_status: "extracted",
    billing_period_start: "2026-01-01", billing_period_end: "2026-01-01", billing_days: 1,
    network_tariff_code: "LLVT2", consumption_kwh: 10, highest_metered_demand_kva: 5,
    power_factor_at_highest_demand: 0.9, charge_categories_ex_gst_aud: {}, subtotal_ex_gst_aud: 10,
    gst_aud: 1, total_inc_gst_aud: 11,
  },
  nem12: {
    input_format: "nem12_standard",
    stream_ids: ["B1", "E1", "K1", "Q1"], aligned_stream_ids: ["B1", "E1", "K1", "Q1"],
    missing_stream_ids: [], unaligned_stream_ids: [], capability_status: "full_active_reactive_import_export",
    full_tariff_analysis_ready: true,
  },
  pair_checks: [],
  annual_demand_heatmap: {
    metric: "measured_apparent_demand",
    source_streams: ["E1", "Q1"],
    unit: "kVA",
    reactive_data_status: "available",
    interval_minutes: 15,
    time_basis: "fixed_aest_meter_time",
    tariff_window_status: "not_applied_pre_tariff",
    shared_scale_maximum_demand: 20,
    years: [{
      year: 2026,
      coverage_start: "2026-01-01",
      coverage_end: "2026-01-01",
      day_count: 1,
      complete_calendar_year: false,
      interval_count: 96,
      expected_interval_count: 96,
      missing_interval_count: 0,
      maximum_interval_demand: 20,
      average_interval_demand: 10,
      days: [{ date: "2026-01-01", interval_demand: Array(96).fill(10) }],
    }],
  },
  next_steps: [],
  privacy: { files_persisted: true, customer_identifiers_returned: false, customer_facing_permission: false },
};

describe("inspectCiEvidencePair", () => {
  it("sends both source files and accepts the privacy-safe contract", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/evidence-intake/inspect");
      expect((init?.body as FormData).get("bill")).toBeInstanceOf(File);
      expect((init?.body as FormData).get("nem12")).toBeInstanceOf(File);
      return new Response(JSON.stringify(safeResult), { status: 200 });
    };
    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf", { type: "application/pdf" }),
      new File(["nem12"], "meter.csv", { type: "text/csv" }),
      fetcher as typeof fetch,
    )).resolves.toMatchObject({ intake_status: "ready_for_profile_review" });
  });

  it("rejects a project contract that does not confirm local persistence", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      ...safeResult,
      privacy: { ...safeResult.privacy, files_persisted: false },
    }), { status: 200 });
    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["nem12"], "meter.csv"),
      fetcher as typeof fetch,
    )).rejects.toThrow("unsafe or incomplete");
  });

  it("restores the saved filenames and inspection result for one project", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/evidence-intake");
      return new Response(JSON.stringify({
        contract_version: "ci_project_evidence_state_v1",
        status: "saved",
        evidence: {
          saved_at: "2026-08-17T01:02:03+00:00",
          files: {
            bill: { filename: "bill.pdf", content_type: "application/pdf", size_bytes: 123 },
            interval: { filename: "meter.csv", content_type: "text/csv", size_bytes: 456 },
          },
          inspection: safeResult,
        },
      }), { status: 200 });
    };
    await expect(fetchCiProjectEvidence("project-1", fetcher as typeof fetch)).resolves.toMatchObject({
      status: "saved",
      evidence: { files: { bill: { filename: "bill.pdf" }, interval: { filename: "meter.csv" } } },
    });
  });

  it("re-checks confirmed bill fields using the already-saved files", async () => {
    const review = {
      confirmed: true as const, retailer: "AGL", invoice_kind: "Tax invoice", billing_period_start: "2026-01-01",
      billing_period_end: "2026-01-31", network_tariff_code: "LLVT2", consumption_kwh: 10,
      highest_metered_demand_kva: 5, power_factor_at_highest_demand: 0.9,
      subtotal_ex_gst_aud: 10, gst_aud: 1, total_inc_gst_aud: 11,
    };
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/commercial-industrial/projects/project-1/evidence-intake/review");
      expect(JSON.parse(String(init?.body))).toEqual(review);
      return new Response(JSON.stringify(safeResult), { status: 200 });
    };
    await expect(reviewSavedCiEvidence("project-1", review, fetcher as typeof fetch)).resolves.toMatchObject({
      intake_status: "ready_for_profile_review",
    });
  });

  it("rejects malformed 15-minute demand heatmap data", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      ...safeResult,
      annual_demand_heatmap: {
        ...safeResult.annual_demand_heatmap,
        years: [{ ...safeResult.annual_demand_heatmap.years[0], days: [{ date: "2026-01-01", interval_demand: [5] }] }],
      },
    }), { status: 200 });
    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["nem12"], "meter.csv"),
      fetcher as typeof fetch,
    )).rejects.toThrow("unsafe or incomplete");
  });

  it("accepts a safe E1-only active-demand setup result", async () => {
    const activeOnly = {
      ...safeResult,
      nem12: {
        ...safeResult.nem12,
        stream_ids: ["E1"], aligned_stream_ids: ["E1"], missing_stream_ids: ["B1", "K1", "Q1"],
        capability_status: "active_import_only", full_tariff_analysis_ready: false,
      },
      annual_demand_heatmap: {
        ...safeResult.annual_demand_heatmap,
        metric: "measured_active_demand", source_streams: ["E1"], unit: "kW",
        reactive_data_status: "unavailable_active_only",
      },
    };
    const fetcher = async () => new Response(JSON.stringify(activeOnly), { status: 200 });
    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["nem12"], "meter.csv"),
      fetcher as typeof fetch,
    )).resolves.toMatchObject({ nem12: { full_tariff_analysis_ready: false } });
  });

  it("accepts v9 detected invoice groups while withholding annual dollars", async () => {
    const v9Result = {
      ...safeResult,
      contract_version: "ci_evidence_intake_v9",
      nem12: { ...safeResult.nem12, coverage_start: "2025-01-01", coverage_end: "2026-01-01" },
      pair_checks: [
        { code: "site_identity_match", passed: true, severity: "pass", message: "Matched." },
        { code: "bill_period_covered", passed: true, severity: "pass", message: "Covered." },
        { code: "invoice_arithmetic", passed: true, severity: "pass", message: "Reconciled." },
        { code: "bill_review_confirmed", passed: true, severity: "pass", message: "Confirmed." },
      ],
      detected_tariff: {
        status: "category_totals_detected",
        tariff_code: "LLVT2",
        tax_basis: "ex_gst",
        warning: "Category totals are observed; rate labels are derived.",
        groups: [
          { key: "fixed", label: "Fixed", items: [{ key: "metering", label: "Metering charges", source_amount_ex_gst_aud: 1, basis_label: "One-day invoice", rate_label: "Derived daily equivalent" }] },
          { key: "other_usage", label: "Other usage", items: [{ key: "network", label: "Network charges", source_amount_ex_gst_aud: 4, basis_label: "Invoice category total", rate_label: "Rate split unavailable" }] },
          { key: "energy_import", label: "Energy (Import)", items: [{ key: "energy", label: "Energy charges", source_amount_ex_gst_aud: 5, basis_label: "10 kWh invoice usage", rate_label: "Derived blended rate" }] },
        ],
      },
      annual_bill_estimate: {
        status: "unavailable",
        method: "approved_tariff_replay_required",
        confidence: "unavailable",
        tariff_code: "LLVT2",
        coverage_start: "2025-01-01",
        coverage_end: "2025-12-31",
        annual_import_kwh: 3650,
        total_ex_gst_aud: null,
        customer_facing_permission: false,
        warning: "Approved tariff replay is required before publishing a dollar result.",
        assumptions: ["Demand rules must be evidenced."],
        groups: [],
      },
    };
    const fetcher = async () => new Response(JSON.stringify(v9Result), { status: 200 });

    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["nem12"], "meter.csv"),
      fetcher as typeof fetch,
    )).resolves.toMatchObject({
      contract_version: "ci_evidence_intake_v9",
      annual_bill_estimate: {
        status: "unavailable",
        method: "approved_tariff_replay_required",
        total_ex_gst_aud: null,
      },
    });
  });

  it("rejects a v9 annual estimate that claims customer-facing permission", async () => {
    const unsafeV9 = {
      ...safeResult,
      contract_version: "ci_evidence_intake_v9",
      detected_tariff: { status: "review_required", tariff_code: "LLVT2", tax_basis: "ex_gst", warning: "Review required.", groups: [] },
      annual_bill_estimate: {
        status: "unavailable", method: "unavailable", confidence: "unavailable", tariff_code: "LLVT2",
        coverage_start: null, coverage_end: null, annual_import_kwh: null, total_ex_gst_aud: null,
        customer_facing_permission: true, warning: "Unavailable.", assumptions: [], groups: [],
      },
    };
    const fetcher = async () => new Response(JSON.stringify(unsafeV9), { status: 200 });

    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["nem12"], "meter.csv"),
      fetcher as typeof fetch,
    )).rejects.toThrow("unsafe or incomplete");
  });

  it("rejects a v9 annual dollar extrapolation without an approved replay", async () => {
    const unsafeV9 = {
      ...safeResult,
      contract_version: "ci_evidence_intake_v9",
      detected_tariff: { status: "review_required", tariff_code: "LLVT2", tax_basis: "ex_gst", warning: "Review required.", groups: [] },
      annual_bill_estimate: {
        status: "indicative", method: "latest_complete_365_day_usage_with_invoice_category_scaling_v1", confidence: "low", tariff_code: "LLVT2",
        coverage_start: "2025-01-01", coverage_end: "2025-12-31", annual_import_kwh: 3650, total_ex_gst_aud: 3650,
        customer_facing_permission: false, warning: "Invoice extrapolation.", assumptions: [], groups: [],
      },
    };
    const fetcher = async () => new Response(JSON.stringify(unsafeV9), { status: 200 });

    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["nem12"], "meter.csv"),
      fetcher as typeof fetch,
    )).rejects.toThrow("unsafe or incomplete");
  });

  it("accepts a safe 30-minute wide interval result without treating it as formal NEM12", async () => {
    const wideResult = {
      ...safeResult,
      nem12: {
        ...safeResult.nem12,
        input_format: "wide_interval_30_minute", interval_minutes: 30,
        stream_ids: ["kW", "kVA", "PowerFactor"], aligned_stream_ids: ["kVA"],
        missing_stream_ids: ["E1", "B1", "Q1", "K1"], capability_status: "measured_apparent_demand",
        full_tariff_analysis_ready: false,
      },
      annual_demand_heatmap: {
        ...safeResult.annual_demand_heatmap,
        source_streams: ["kVA"], reactive_data_status: "reported_apparent_demand",
        interval_minutes: 30, time_basis: "source_local_time_unverified",
        years: [{
          ...safeResult.annual_demand_heatmap.years[0], interval_count: 48,
          expected_interval_count: 48, missing_interval_count: 0,
          days: [{ date: "2026-01-01", interval_demand: Array(48).fill(10) }],
        }],
      },
    };
    const fetcher = async () => new Response(JSON.stringify(wideResult), { status: 200 });
    await expect(inspectCiEvidencePair(
      "project-1",
      new File(["bill"], "bill.pdf"),
      new File(["wide"], "meter.csv"),
      fetcher as typeof fetch,
    )).resolves.toMatchObject({
      nem12: { input_format: "wide_interval_30_minute", full_tariff_analysis_ready: false },
      annual_demand_heatmap: { interval_minutes: 30, unit: "kVA" },
    });
  });
});

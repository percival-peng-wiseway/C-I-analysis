// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { CiEvidenceIntake } from "./ci-evidence-intake";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("inspects the usual bill and NEM12 pair and continues to physical feasibility", async () => {
  const user = userEvent.setup();
  const onUseNem12 = vi.fn();
  const inspectionResult = {
    contract_version: "ci_evidence_intake_v8",
    intake_status: "ready_for_profile_review",
    bill: {
      fingerprint: "abc123",
      retailer: "Origin Energy",
      invoice_kind: "Business Electricity Tax Invoice",
      extraction_method: "verified_origin_template",
      review_status: "not_required",
      missing_fields: [],
      invoice_arithmetic_scope: "charge_categories_and_totals",
      site_identity_status: "extracted",
      site_address: "Unit 4, 18 Example Road North Sydney NSW 2060",
      billing_period_start: "2026-03-01",
      billing_period_end: "2026-03-31",
      billing_days: 31,
      network_tariff_code: "LLVT2",
      consumption_kwh: 100,
      highest_metered_demand_kva: 20,
      power_factor_at_highest_demand: 0.9,
      charge_categories_ex_gst_aud: {},
      subtotal_ex_gst_aud: 90,
      gst_aud: 9,
      total_inc_gst_aud: 99,
    },
    nem12: {
      fingerprint: "def456",
      input_format: "nem12_standard",
      coverage_start: "2025-04-01",
      coverage_end: "2026-03-31",
      interval_minutes: 5,
      stream_ids: ["B1", "E1", "K1", "Q1"],
      aligned_stream_ids: ["B1", "E1", "K1", "Q1"],
      missing_stream_ids: [],
      unaligned_stream_ids: [],
      capability_status: "full_active_reactive_import_export",
      full_tariff_analysis_ready: true,
      days_per_stream: 365,
      quality_method_counts: { A: 1400 },
      quality_override_count: 0,
    },
    pair_checks: [{ code: "site_identity_match", passed: true, severity: "pass", message: "The bill and NEM12 identify the same site." }],
    annual_demand_heatmap: {
      metric: "measured_apparent_demand",
      source_streams: ["E1", "Q1"],
      unit: "kVA",
      reactive_data_status: "available",
      interval_minutes: 15,
      time_basis: "fixed_aest_meter_time",
      tariff_window_status: "not_applied_pre_tariff",
      shared_scale_maximum_demand: 20,
      years: [
        { year: 2025, coverage_start: "2025-01-01", coverage_end: "2025-12-31", day_count: 365, complete_calendar_year: true, interval_count: 365 * 96, expected_interval_count: 365 * 96, missing_interval_count: 0, maximum_interval_demand: 20, average_interval_demand: 10, days: Array.from({ length: 365 }, (_, index) => ({ date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), interval_demand: Array(96).fill(10) })) },
        { year: 2026, coverage_start: "2026-01-01", coverage_end: "2026-03-31", day_count: 90, complete_calendar_year: false, interval_count: 90 * 96, expected_interval_count: 90 * 96, missing_interval_count: 0, maximum_interval_demand: 15, average_interval_demand: 8, days: Array.from({ length: 90 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), interval_demand: Array(96).fill(8) })) },
      ],
    },
    next_steps: [],
    privacy: { files_persisted: true, customer_identifiers_returned: true, customer_facing_permission: false },
  };
  let saved = false;
  let sitePhotos: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input), "http://local.test").pathname;
    if (pathname.endsWith("/site-material") && !init?.method) {
      return new Response(JSON.stringify({ contract_version: "ci_project_site_material_v1", photos: sitePhotos }), { status: 200 });
    }
    if (pathname.endsWith("/site-material") && init?.method === "POST") {
      const photo = {
        photo_id: "123e4567-e89b-12d3-a456-426614174000",
        filename: "north-roof.jpg",
        content_type: "image/jpeg",
        size_bytes: 4,
        created_at: "2026-08-19T01:02:03+00:00",
        content_url: "/api/commercial-industrial/projects/project-1/site-material/123e4567-e89b-12d3-a456-426614174000/content",
      };
      sitePhotos = [photo];
      return new Response(JSON.stringify({ contract_version: "ci_project_site_material_v1", photo }), { status: 201 });
    }
    if (pathname.endsWith("/evidence-intake") && !init?.method) {
      return new Response(JSON.stringify(saved ? {
        contract_version: "ci_project_evidence_state_v1",
        status: "saved",
        evidence: { saved_at: "2026-08-17T01:02:03+00:00", files: { bill: { filename: "bill.pdf", content_type: "application/pdf", size_bytes: 3 }, interval: { filename: "meter.csv", content_type: "text/csv", size_bytes: 5 } }, inspection: inspectionResult },
      } : { contract_version: "ci_project_evidence_state_v1", status: "not_saved", evidence: null }), { status: 200 });
    }
    saved = true;
    return new Response(JSON.stringify(inspectionResult), { status: 200 });
  }));
  const firstView = render(
    <QueryClientProvider client={new QueryClient()}>
      <CiEvidenceIntake onReady={onUseNem12} projectId="project-1" />
    </QueryClientProvider>,
  );
  const nem12 = new File(["nem12"], "meter.csv", { type: "text/csv" });
  await user.upload(await screen.findByLabelText("Electricity bill PDF"), new File(["pdf"], "bill.pdf", { type: "application/pdf" }));
  await user.upload(screen.getByLabelText("Matching interval CSV / NEM12"), nem12);
  await user.upload(screen.getByLabelText("Roof and site photos"), new File(["roof"], "north-roof.jpg", { type: "image/jpeg" }));
  expect(await screen.findByRole("img", { name: "Roof photo north-roof.jpg" })).toBeTruthy();
  expect(screen.getByText("north-roof.jpg · 0.0 KB")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Inspect & save" }));

  expect(await screen.findByRole("heading", { name: "Bill detected" })).toBeTruthy();
  const directions = screen.getByRole("link", { name: "Directions" });
  expect(directions.getAttribute("href")).toBe("https://www.google.com/maps/dir/?api=1&destination=Unit%204%2C%2018%20Example%20Road%20North%20Sydney%20NSW%202060");
  expect(directions.getAttribute("target")).toBe("_blank");
  expect(screen.getByText("B1 · E1 · K1 · Q1")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Detected bill breakdown" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show breakdown" }));
  expect(screen.getByRole("heading", { name: "Detected bill breakdown" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide breakdown" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("heading", { name: "NEM12 load profile" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Average day NEM12 load profile for 365 days in kVA" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Maximum demand by interval" })).toBeTruthy();
  expect(screen.getByText("Maximum by interval")).toBeTruthy();
  await user.selectOptions(screen.getByRole("combobox", { name: "Load profile days" }), "weekends");
  expect(screen.getByRole("img", { name: /Average day NEM12 load profile for \d+ days in kVA/ })).toBeTruthy();
  await user.selectOptions(screen.getByRole("combobox", { name: "Load profile season" }), "winter");
  await user.click(screen.getByRole("button", { name: "Annual" }));
  expect(screen.getByRole("img", { name: "2025 annual NEM12 load profile in kVA" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Load profile season" })).toBeNull();
  expect(screen.getByRole("heading", { name: "15-minute demand heatmap" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "2025 15-minute measured-demand heatmap, E1 and Q1 apparent demand in kVA" })).toBeTruthy();
  const colourScale = screen.getByRole("img", { name: "Shared green-yellow-red demand colour scale from 0 to 20 kVA for every year" });
  expect(colourScale.textContent).toBe("05101520 kVA");
  const gradient = colourScale.querySelector<HTMLElement>("[style]");
  expect(gradient?.style.background).toContain("#064e3b");
  expect(gradient?.style.background).toContain("#facc15");
  expect(gradient?.style.background).toContain("#991b1b");
  await user.selectOptions(screen.getByRole("combobox", { name: "Demand heatmap calendar year" }), "2026");
  expect(screen.getByRole("img", { name: "2026 15-minute measured-demand heatmap, E1 and Q1 apparent demand in kVA" })).toBeTruthy();
  expect(onUseNem12).toHaveBeenCalledWith();

  firstView.unmount();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CiEvidenceIntake onReady={vi.fn()} projectId="project-1" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("bill.pdf")).toBeTruthy();
  expect(screen.getByText("meter.csv")).toBeTruthy();
  expect(screen.getByLabelText("Electricity bill PDF")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "15-minute demand heatmap" })).toBeTruthy();
  expect(await screen.findByRole("img", { name: "Roof photo north-roof.jpg" })).toBeTruthy();
  expect(screen.getByText("north-roof.jpg · 0.0 KB")).toBeTruthy();
});

it("confirms a retailer-neutral bill without adding a company adapter", async () => {
  const user = userEvent.setup();
  const baseResult = {
    contract_version: "ci_evidence_intake_v7",
    intake_status: "action_required",
    bill: {
      fingerprint: "generic123", retailer: "AGL", invoice_kind: "Electricity Tax Invoice",
      extraction_method: "generic_pdf_text", review_status: "confirmation_required", missing_fields: [],
      invoice_arithmetic_scope: "invoice_totals_only", site_identity_status: "extracted",
      billing_period_start: "2026-01-05", billing_period_end: "2026-01-05", billing_days: 1,
      network_tariff_code: null, consumption_kwh: 288, highest_metered_demand_kva: 15,
      power_factor_at_highest_demand: 0.8, charge_categories_ex_gst_aud: {}, subtotal_ex_gst_aud: 42,
      gst_aud: 4.2, total_inc_gst_aud: 46.2,
    },
    nem12: { fingerprint: "nem123", input_format: "nem12_standard", coverage_start: "2026-01-05", coverage_end: "2026-01-05", interval_minutes: 5, stream_ids: ["B1", "E1", "K1", "Q1"], aligned_stream_ids: ["B1", "E1", "K1", "Q1"], missing_stream_ids: [], unaligned_stream_ids: [], capability_status: "full_active_reactive_import_export", full_tariff_analysis_ready: true, days_per_stream: 1, quality_method_counts: { A: 4 }, quality_override_count: 0 },
    pair_checks: [{ code: "bill_review_confirmed", passed: false, severity: "error", message: "Review and confirm the retailer-neutral bill fields before continuing." }],
    annual_demand_heatmap: { metric: "measured_apparent_demand", source_streams: ["E1", "Q1"], unit: "kVA", reactive_data_status: "available", interval_minutes: 15, time_basis: "fixed_aest_meter_time", tariff_window_status: "not_applied_pre_tariff", shared_scale_maximum_demand: 15, years: [{ year: 2026, coverage_start: "2026-01-05", coverage_end: "2026-01-05", day_count: 1, complete_calendar_year: false, interval_count: 96, expected_interval_count: 96, missing_interval_count: 0, maximum_interval_demand: 15, average_interval_demand: 10, days: [{ date: "2026-01-05", interval_demand: Array(96).fill(10) }] }] },
    next_steps: [],
    privacy: { files_persisted: true, customer_identifiers_returned: false, customer_facing_permission: false },
  };
  const confirmedResult = { ...baseResult, intake_status: "ready_for_profile_review", bill: { ...baseResult.bill, extraction_method: "generic_pdf_text_with_analyst_confirmation", review_status: "analyst_confirmed" }, pair_checks: [{ code: "bill_review_confirmed", passed: true, severity: "pass", message: "The retailer-neutral bill fields were confirmed for this request." }] };
  let saved = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input), "http://local.test").pathname;
    if (pathname.endsWith("/site-material") && !init?.method) return new Response(JSON.stringify({ contract_version: "ci_project_site_material_v1", photos: [] }), { status: 200 });
    if (!init?.method) return new Response(JSON.stringify(saved ? {
      contract_version: "ci_project_evidence_state_v1", status: "saved",
      evidence: { saved_at: "2026-08-17T01:02:03+00:00", files: { bill: { filename: "agl.pdf", content_type: "application/pdf", size_bytes: 3 }, interval: { filename: "meter.csv", content_type: "text/csv", size_bytes: 5 } }, inspection: baseResult },
    } : { contract_version: "ci_project_evidence_state_v1", status: "not_saved", evidence: null }), { status: 200 });
    if (pathname.endsWith("/inspect")) { saved = true; return new Response(JSON.stringify(baseResult), { status: 200 }); }
    return new Response(JSON.stringify(confirmedResult), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={new QueryClient()}><CiEvidenceIntake onReady={vi.fn()} projectId="project-1" /></QueryClientProvider>);
  await user.upload(await screen.findByLabelText("Electricity bill PDF"), new File(["pdf"], "agl.pdf", { type: "application/pdf" }));
  await user.upload(screen.getByLabelText("Matching interval CSV / NEM12"), new File(["nem12"], "meter.csv", { type: "text/csv" }));
  await user.click(screen.getByRole("button", { name: "Inspect & save" }));

  expect(await screen.findByRole("heading", { name: "Confirm bill fields" })).toBeTruthy();
  await user.type(screen.getByLabelText("Manual tariff code"), "LLVT2");
  expect((screen.getByLabelText("Network tariff code") as HTMLInputElement).value).toBe("LLVT2");
  await user.click(screen.getByRole("button", { name: "Confirm fields and re-check" }));

  expect(await screen.findByText("Analyst confirmed")).toBeTruthy();
  const reviewCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/evidence-intake/review"));
  const submitted = JSON.parse(String(reviewCall?.[1]?.body));
  expect(submitted).toMatchObject({ confirmed: true, retailer: "AGL", network_tariff_code: "LLVT2", total_inc_gst_aud: 46.2 });
  expect(String(reviewCall?.[1]?.body)).not.toContain("SYNTH");
});

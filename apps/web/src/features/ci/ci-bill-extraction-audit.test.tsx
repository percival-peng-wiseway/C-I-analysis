// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BillExtractionAudit } from "./ci-bill-extraction-audit";

afterEach(cleanup);

it("shows uncertain OCR fields, source pages and failed Python reconciliation", () => {
  render(<BillExtractionAudit audit={{ version: 1,
    pages: [{ page: 1, method: "paddle_ocr", table_count: 0 }],
    sources: [{ field: "total_inc_gst_aud", page: 1, method: "paddle_ocr", bbox: [1, 2, 100, 20], confidence: .72, text: "Invoice total $46.20" }],
    issues: [{ code: "low_ocr_confidence", message: "Check invoice total against the PDF.", resolved_by_review: false }],
    checks: [{ code: "invoice_totals", passed: false, message: "Subtotal + GST must equal current invoice charges." }], line_items: [],
  }} />);
  expect(screen.getByText("Check invoice total against the PDF.")).toBeTruthy();
  expect(screen.getByText("Needs review:")).toBeTruthy();
  expect(screen.getByText("Page 1 · Paddle OCR")).toBeTruthy();
  expect(screen.getByText("Recognition score: 72%")).toBeTruthy();
  expect(screen.getByText("Invoice total $46.20")).toBeTruthy();
});

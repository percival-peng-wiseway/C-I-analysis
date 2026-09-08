import type { CiBillExtractionAudit } from "./api/ci-evidence-intake";

const sourceLabel = (method: string) => method === "paddle_ocr" ? "Paddle OCR" : method === "native_table" ? "PDF table" : "PDF text";
const fieldLabel = (field: string) => field.replaceAll("_", " ").replace(/\baud\b/g, "AUD").replace(/\bgst\b/g, "GST").replace(/\bkwh\b/g, "kWh").replace(/\bkva\b/g, "kVA");

export function BillExtractionAudit({ audit }: { audit: CiBillExtractionAudit }) {
  const pending = audit.issues.filter((issue) => !issue.resolved_by_review);
  const failed = audit.checks.filter((check) => !check.passed);
  const ocrPages = audit.pages.filter((page) => page.method === "paddle_ocr").length;
  return (
    <section aria-label="Bill extraction and reconciliation" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Extraction and reconciliation</h3>
        <span className="text-xs text-slate-500">{audit.pages.length} pages · {ocrPages} read with Paddle OCR</span>
      </div>
      {pending.length > 0 ? <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{pending.map((issue, index) => <li key={index}>{issue.page ? `Page ${issue.page}: ` : ""}{issue.message}</li>)}</ul> : null}
      <ul className="grid gap-2 text-xs md:grid-cols-2">{audit.checks.map((check) => <li key={check.code} className={check.passed ? "text-emerald-800" : "text-amber-900"}><strong>{check.passed ? "Passed" : "Needs review"}:</strong> {check.message}</li>)}</ul>
      {failed.length > 0 ? <p className="text-xs text-slate-500">Review flagged checks before using this bill as calculation evidence. Missing categories and unverified tariff terms remain subject to profile approval.</p> : null}
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium">Field sources ({audit.sources.length})</summary>
        <div className="mt-3 max-h-80 overflow-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b"><th className="p-2">Field</th><th className="p-2">Source</th><th className="p-2">Extracted text</th></tr></thead><tbody>{audit.sources.map((source, index) => <tr key={index} className="border-b border-slate-100 align-top"><td className="p-2 capitalize">{fieldLabel(source.field)}</td><td className="whitespace-nowrap p-2">Page {source.page} · {sourceLabel(source.method)}{source.method === "paddle_ocr" ? <span className="block text-slate-500">Recognition score: {(source.confidence * 100).toFixed(0)}%</span> : null}</td><td className="min-w-40 break-words p-2">{source.text}</td></tr>)}</tbody></table></div>
      </details>
      {audit.line_items_reviewed ? <p className="text-xs text-slate-500">Flagged charge rows were checked by the analyst. Original arithmetic differences remain visible; their rates were not imported automatically.</p> : null}
      {audit.issues.some((issue) => issue.resolved_by_review) ? <p className="text-xs text-slate-500">Extraction uncertainties were acknowledged during analyst confirmation. Source evidence is retained for review.</p> : null}
    </section>
  );
}

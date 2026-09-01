import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiEvidenceIntakeResult } from "@/features/ci/api/ci-evidence-intake";

type Bill = CiEvidenceIntakeResult["bill"];

const CATEGORY_META: Record<string, { colour: string; label: string }> = {
  energy_charges: { colour: "#0891b2", label: "Energy charges" },
  network_charges: { colour: "#2563eb", label: "Network charges" },
  regulated_charges: { colour: "#7c3aed", label: "Regulated charges" },
  environmental_charges: { colour: "#16a34a", label: "Environmental charges" },
  metering_charges: { colour: "#d97706", label: "Metering charges" },
  additional_charges: { colour: "#64748b", label: "Additional charges / credits" },
};
const FALLBACK_COLOURS = ["#0f766e", "#4f46e5", "#be123c", "#9333ea"];

export function CiBillBreakdown({ bill }: { bill: Bill }) {
  const categories = Object.entries(bill.charge_categories_ex_gst_aud)
    .filter(([, amount]) => Number.isFinite(amount) && amount !== 0)
    .map(([key, amount], index) => ({
      amount,
      colour: CATEGORY_META[key]?.colour ?? FALLBACK_COLOURS[index % FALLBACK_COLOURS.length],
      key,
      label: CATEGORY_META[key]?.label ?? humanizeKey(key),
    }));
  const categoryTotal = categories.reduce((total, item) => total + item.amount, 0);
  const positiveChargeTotal = categories.reduce((total, item) => total + Math.max(0, item.amount), 0);
  const categoryDetailAvailable = categories.length > 0 && bill.invoice_arithmetic_scope === "charge_categories_and_totals";
  const subtotal = bill.subtotal_ex_gst_aud;
  const gst = bill.gst_aud;
  const total = bill.total_inc_gst_aud;
  const consumption = bill.consumption_kwh;
  const blendedExGst = consumption && consumption > 0 && subtotal !== null ? subtotal / consumption * 100 : null;
  const blendedIncGst = consumption && consumption > 0 && total !== null ? total / consumption * 100 : null;

  return (
    <Card>
      <CardHeader className="border-b border-slate-200 bg-slate-50/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><CardTitle as="h3">Detected bill breakdown</CardTitle><p className="mt-1 text-xs text-muted-foreground">Uploaded invoice period · amounts shown exactly as detected</p></div>
          {total !== null ? <div className="text-right"><span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Invoice total inc GST</span><strong className="mt-1 block text-xl tabular-nums text-slate-950">{formatAud(total)}</strong></div> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid items-stretch gap-4 xl:grid-cols-[1.35fr_0.65fr]">
          <section aria-labelledby="charge-breakdown-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-4">
              <div>
                <h4 className="font-semibold" id="charge-breakdown-title">Charge breakdown</h4>
                <p className="mt-1 text-xs text-muted-foreground">Verified invoice categories · ex GST</p>
              </div>
              {subtotal !== null ? <div className="text-right"><span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Subtotal</span><strong className="mt-1 block text-base tabular-nums">{formatAud(subtotal)}</strong></div> : null}
            </div>
            {categoryDetailAvailable ? (
              <>
                <ChargeCompositionChart categories={categories} positiveTotal={positiveChargeTotal} />
                <ChargeCategoryTable categories={categories} positiveTotal={positiveChargeTotal} total={categoryTotal} />
              </>
            ) : (
              <div className="m-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <strong>Category detail unavailable</strong>
                <p className="mt-1 leading-6">This bill supplied confirmed invoice totals but no verified category mapping. Energy, network and other charges are not guessed.</p>
              </div>
            )}
            <InvoiceTotals gst={gst} subtotal={subtotal} total={total} />
          </section>

          <section aria-labelledby="usage-snapshot-title" className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50/50">
            <div className="border-b border-slate-200 bg-white px-5 py-4">
              <h4 className="font-semibold" id="usage-snapshot-title">Usage &amp; price snapshot</h4>
            </div>
            <div className="grid flex-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-1">
              <PriceMetric label="Invoice-period all-in cost ex GST" value={formatCents(blendedExGst)} />
              <PriceMetric label="Invoice-period all-in cost inc GST" value={formatCents(blendedIncGst)} />
              <PowerFactorMetric value={bill.power_factor_at_highest_demand} />
            </div>
          </section>
        </div>

      </CardContent>
    </Card>
  );
}

function ChargeCompositionChart({ categories, positiveTotal }: { categories: Array<{ amount: number; colour: string; key: string; label: string }>; positiveTotal: number }) {
  const charges = categories.filter((item) => item.amount > 0);
  const credits = categories.filter((item) => item.amount < 0);
  const chartLabel = charges.map((item) => `${item.label} ${formatAud(item.amount)}`).join(", ");
  return (
    <figure className="border-b border-slate-200 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Invoice charge mix</h5>
        <span className="text-xs tabular-nums text-slate-500">Gross charges {formatAud(positiveTotal)}</span>
      </div>
      {positiveTotal > 0 ? (
        <div aria-label={`Invoice charge mix excluding credits: ${chartLabel}.`} className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200" role="img">
          {charges.map((item) => <span aria-hidden="true" key={item.key} style={{ backgroundColor: item.colour, width: `${item.amount / positiveTotal * 100}%` }} />)}
        </div>
      ) : null}
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600">
        {charges.map((item) => (
          <span className="inline-flex items-center gap-1.5" key={item.key}>
            <span aria-hidden="true" className="size-2 rounded-sm" style={{ backgroundColor: item.colour }} />
            {item.label} {formatPercent(item.amount / positiveTotal * 100)}
          </span>
        ))}
        {credits.length ? <span className="font-medium text-slate-700">Credits shown separately in the table below</span> : null}
      </figcaption>
    </figure>
  );
}

function ChargeCategoryTable({ categories, positiveTotal, total }: { categories: Array<{ amount: number; colour: string; key: string; label: string }>; positiveTotal: number; total: number }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label="Detected invoice charge categories" className="w-full min-w-[520px] border-collapse text-sm">
        <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          <tr><th className="px-5 py-3">Charge category</th><th className="px-5 py-3 text-right">Share of charges</th><th className="px-5 py-3 text-right">Amount ex GST</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {categories.map((item) => {
            const share = item.amount > 0 && positiveTotal > 0 ? item.amount / positiveTotal * 100 : null;
            return (
              <tr className="hover:bg-slate-50/70" key={item.key}>
                <th className="px-5 py-3 text-left font-medium text-slate-800" scope="row"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm" style={{ backgroundColor: item.colour }} />{item.label}</span></th>
                <td className="px-5 py-3 text-right tabular-nums text-slate-500">{share === null ? "Credit / adjustment" : formatPercent(share)}</td>
                <td className={`px-5 py-3 text-right font-semibold tabular-nums ${item.amount < 0 ? "text-emerald-700" : "text-slate-950"}`}>{formatAud(item.amount)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t border-slate-300 bg-slate-100/80">
          <tr><th className="px-5 py-3 text-left font-semibold text-slate-950" colSpan={2}>Detected category net total</th><td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-950">{formatAud(total)}</td></tr>
        </tfoot>
      </table>
      <p className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">Shares use gross positive charges. Credits and adjustments reduce the net total and are not treated as a positive share. Unit rates, quantities and loss factors are not inferred here.</p>
    </div>
  );
}

function InvoiceTotals({ gst, subtotal, total }: { gst: number | null; subtotal: number | null; total: number | null }) {
  return (
    <dl className="grid grid-cols-3 border-t border-slate-200 bg-slate-50/70">
      <InvoiceTotal label="Subtotal ex GST" value={formatAud(subtotal)} />
      <InvoiceTotal label="GST" value={formatAud(gst)} />
      <InvoiceTotal emphasized label="Total inc GST" value={formatAud(total)} />
    </dl>
  );
}

function InvoiceTotal({ emphasized = false, label, value }: { emphasized?: boolean; label: string; value: string }) {
  return <div className="border-r border-slate-200 px-4 py-3 last:border-r-0"><dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt><dd className={`mt-1 tabular-nums ${emphasized ? "font-semibold text-cyan-800" : "font-medium text-slate-800"}`}>{value}</dd></div>;
}

function PowerFactorMetric({ value }: { value: number | null }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 sm:col-span-2 xl:col-span-1">
      <div className="flex items-end justify-between gap-3"><span className="text-xs font-medium text-slate-600">Power factor</span><strong className="text-xl tabular-nums text-slate-950">{value === null ? "—" : value.toFixed(3)}</strong></div>
      <p className="mt-1 text-[10px] leading-4 text-slate-500">Observed at maximum recorded demand; no contractual target is applied.</p>
    </div>
  );
}

function PriceMetric({ label, value }: { label: string; value: string }) {
  return <p className="rounded-lg border border-slate-200 bg-white p-4"><span className="block text-xs text-slate-500">{label}</span><strong className="mt-2 block text-xl tabular-nums text-slate-950">{value}</strong></p>;
}

function humanizeKey(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAud(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

function formatCents(value: number | null) {
  return value === null ? "—" : `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value)} c/kWh`;
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value)}%`;
}

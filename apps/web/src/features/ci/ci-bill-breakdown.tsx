import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
    .map(([key, amount], index) => ({
      amount,
      colour: CATEGORY_META[key]?.colour ?? FALLBACK_COLOURS[index % FALLBACK_COLOURS.length],
      key,
      label: CATEGORY_META[key]?.label ?? humanizeKey(key),
    }));
  const categoryTotal = categories.reduce((total, item) => total + item.amount, 0);
  const categoryDetailAvailable = categories.length > 0 && bill.invoice_arithmetic_scope === "charge_categories_and_totals";
  const subtotal = bill.subtotal_ex_gst_aud;
  const gst = bill.gst_aud;
  const total = bill.total_inc_gst_aud;
  const consumption = bill.consumption_kwh;
  const billingDays = bill.billing_days;
  const averageDailyKwh = consumption !== null && billingDays && billingDays > 0 ? consumption / billingDays : null;
  const blendedExGst = consumption && consumption > 0 && subtotal !== null ? subtotal / consumption * 100 : null;
  const blendedIncGst = consumption && consumption > 0 && total !== null ? total / consumption * 100 : null;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle as="h3">Bill &amp; usage breakdown</CardTitle>
          <CardDescription className="mt-1">
            A quick view of invoice composition and billed consumption. Blended costs are invoice averages, not tariff rates.
          </CardDescription>
        </div>
        <Badge variant={categoryDetailAvailable ? "secondary" : "warning"}>
          {categoryDetailAvailable ? "Category detail extracted" : bill.review_status === "analyst_confirmed" ? "Confirmed totals only" : "Check against PDF"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <BreakdownFact label="Billed consumption" value={formatUnit(consumption, "kWh")} />
          <BreakdownFact label="Average daily use" value={formatUnit(averageDailyKwh, "kWh/day")} />
          <BreakdownFact label="Highest metered demand" value={formatUnit(bill.highest_metered_demand_kva, "kVA")} />
          <BreakdownFact label="Invoice total" value={formatAud(total)} />
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
          <section aria-labelledby="charge-breakdown-title" className="rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="font-semibold" id="charge-breakdown-title">Charge breakdown</h4>
                <p className="mt-1 text-xs text-muted-foreground">Amounts exclude GST unless shown separately.</p>
              </div>
              {subtotal !== null ? <strong className="text-sm tabular-nums">{formatAud(subtotal)} ex GST</strong> : null}
            </div>
            {categoryDetailAvailable ? (
              <div className="mt-4 grid gap-5 md:grid-cols-[160px_1fr] md:items-center">
                <ChargeDonut categories={categories} total={categoryTotal} />
                <div className="space-y-3">
                  {categories.map((item) => (
                    <ChargeBar item={item} key={item.key} maximum={Math.max(...categories.map((entry) => entry.amount))} total={categoryTotal} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <strong>Category detail unavailable</strong>
                <p className="mt-1 leading-6">This bill supplied confirmed invoice totals but no verified category mapping. Energy, network and other charges are not guessed.</p>
              </div>
            )}
            <InvoiceComposition categories={categoryDetailAvailable ? categories : []} gst={gst} subtotal={subtotal} total={total} />
          </section>

          <section aria-labelledby="usage-snapshot-title" className="rounded-xl border border-slate-200 p-4">
            <h4 className="font-semibold" id="usage-snapshot-title">Usage &amp; price snapshot</h4>
            <p className="mt-1 text-xs text-muted-foreground">Derived only from the confirmed invoice period.</p>
            <div className="mt-4 space-y-4">
              <PriceMetric label="Blended invoice cost ex GST" value={formatCents(blendedExGst)} />
              <PriceMetric label="Blended invoice cost inc GST" value={formatCents(blendedIncGst)} />
              <PowerFactorGauge value={bill.power_factor_at_highest_demand} />
            </div>
          </section>
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          These charts summarize the uploaded invoice only. They do not infer time-of-use rates, demand windows, avoided charges or savings.
        </p>
      </CardContent>
    </Card>
  );
}

function ChargeDonut({ categories, total }: { categories: Array<{ amount: number; colour: string; label: string }>; total: number }) {
  let cursor = 0;
  const stops = categories.map((item) => {
    const start = cursor;
    cursor += total > 0 ? item.amount / total * 100 : 0;
    return `${item.colour} ${start}% ${cursor}%`;
  });
  return (
    <div
      aria-label={`Invoice charge breakdown: ${categories.map((item) => `${item.label} ${formatAud(item.amount)}`).join(", ")}`}
      className="relative mx-auto grid size-36 place-items-center rounded-full"
      role="img"
      style={{ background: `conic-gradient(${stops.join(", ")})` }}
    >
      <div className="grid size-20 place-items-center rounded-full bg-white text-center shadow-sm">
        <span><strong className="block text-sm tabular-nums">{formatAud(total)}</strong><small className="text-[10px] text-muted-foreground">ex GST</small></span>
      </div>
    </div>
  );
}

function ChargeBar({ item, maximum, total }: { item: { amount: number; colour: string; label: string }; maximum: number; total: number }) {
  const share = total > 0 ? item.amount / total * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-2"><span className="size-2.5 rounded-sm" style={{ backgroundColor: item.colour }} />{item.label}</span>
        <span className="shrink-0 tabular-nums"><strong>{formatAud(item.amount)}</strong> · {formatPercent(share)}</span>
      </div>
      <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full" style={{ backgroundColor: item.colour, width: `${maximum > 0 ? item.amount / maximum * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function InvoiceComposition({ categories, gst, subtotal, total }: { categories: Array<{ amount: number; colour: string; label: string }>; gst: number | null; subtotal: number | null; total: number | null }) {
  const segments = categories.length
    ? [...categories, ...(gst && gst > 0 ? [{ amount: gst, colour: "#e11d48", label: "GST" }] : [])]
    : [
        ...(subtotal && subtotal > 0 ? [{ amount: subtotal, colour: "#2563eb", label: "Subtotal ex GST" }] : []),
        ...(gst && gst > 0 ? [{ amount: gst, colour: "#e11d48", label: "GST" }] : []),
      ];
  const denominator = total && total > 0 ? total : segments.reduce((sum, item) => sum + item.amount, 0);
  return segments.length ? (
    <div className="mt-5 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium">Invoice composition</span><span className="tabular-nums">{formatAud(total)} inc GST</span></div>
      <div aria-label={`Invoice composition including GST: ${segments.map((item) => `${item.label} ${formatAud(item.amount)}`).join(", ")}`} className="mt-2 flex h-4 overflow-hidden rounded-full bg-slate-100" role="img">
        {segments.map((item) => <span aria-hidden="true" key={item.label} style={{ backgroundColor: item.colour, width: `${denominator > 0 ? item.amount / denominator * 100 : 0}%` }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {segments.map((item) => <span className="flex items-center gap-1.5" key={item.label}><span className="size-2 rounded-sm" style={{ backgroundColor: item.colour }} />{item.label}</span>)}
      </div>
    </div>
  ) : null;
}

function PowerFactorGauge({ value }: { value: number | null }) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value * 100));
  return (
    <div>
      <div className="flex items-end justify-between gap-3"><span className="text-xs text-muted-foreground">Power factor at maximum demand</span><strong className="text-lg tabular-nums">{value === null ? "—" : value.toFixed(3)}</strong></div>
      <div aria-label={value === null ? "Power factor unavailable" : `Power factor at maximum demand ${value.toFixed(3)}`} className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100" role="img">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-400 via-lime-400 to-emerald-600" style={{ width: `${percent}%` }} />
      </div>
      <div aria-hidden="true" className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>0.0</span><span>1.0</span></div>
    </div>
  );
}

function BreakdownFact({ label, value }: { label: string; value: string }) {
  return <p className="rounded-xl bg-cyan-50/60 p-3"><span className="block text-xs text-muted-foreground">{label}</span><strong className="mt-1 block text-base font-semibold tabular-nums">{value}</strong></p>;
}

function PriceMetric({ label, value }: { label: string; value: string }) {
  return <p className="flex items-end justify-between gap-4 border-b border-slate-100 pb-3"><span className="text-xs text-muted-foreground">{label}</span><strong className="text-base tabular-nums">{value}</strong></p>;
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

function formatUnit(value: number | null, unit: string) {
  return value === null ? "—" : `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}

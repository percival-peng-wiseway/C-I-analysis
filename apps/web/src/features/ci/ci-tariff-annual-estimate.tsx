import { ChevronDown, CircleAlert, Info, ReceiptText } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CiAnnualBillEstimate,
  CiAnnualBillEstimateGroup,
  CiAnnualBillEstimateItem,
  CiDetectedTariff,
  CiDetectedTariffGroup,
} from "@/features/ci/api/ci-evidence-intake";

const GROUPS = [
  { key: "fixed", label: "Fixed" },
  { key: "other_usage", label: "Other usage" },
  { key: "energy_import", label: "Energy (Import)" },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];

export function CiTariffAnnualEstimate({
  detectedTariff,
  estimate,
  tariffCode,
}: {
  detectedTariff?: CiDetectedTariff;
  estimate?: CiAnnualBillEstimate;
  tariffCode: string | null;
}) {
  const annualEstimateAvailable = estimate?.status === "estimated";
  return (
    <Card>
      <CardHeader className="border-b border-slate-200 bg-slate-50/40">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle as="h2" className="text-lg">Tariff &amp; {annualEstimateAvailable ? "estimated annual bill" : "annual bill readiness"}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Verified invoice-category evidence and {annualEstimateAvailable ? "an internal bill-derived annual estimate" : "the requirements for an auditable annual bill"}</p>
          </div>
          {tariffCode ? <Badge variant="outline">Network tariff {tariffCode}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        <DetectedTariffTabs detectedTariff={detectedTariff} />
        <EstimatedAnnualBill estimate={estimate} />
      </CardContent>
    </Card>
  );
}

function DetectedTariffTabs({ detectedTariff }: { detectedTariff?: CiDetectedTariff }) {
  const [selected, setSelected] = useState<GroupKey>("fixed");
  const id = useId();
  const group = detectedTariff?.groups.find((item) => item.key === selected);
  const available = detectedTariff?.status === "category_totals_detected";

  const changeTabFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % GROUPS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + GROUPS.length) % GROUPS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = GROUPS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = GROUPS[nextIndex];
    setSelected(next.key);
    document.getElementById(`${id}-tab-${next.key}`)?.focus();
  };

  return (
    <section aria-labelledby={`${id}-tariff-title`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-950" id={`${id}-tariff-title`}>Detected invoice charge groups</h3>
          <p className="mt-1 text-xs text-slate-500">Observed bill-period category amounts grouped for review. These are not a detected contractual tariff schedule.</p>
        </div>
        <Badge variant={available ? "secondary" : "warning"}>{available ? "Invoice categories detected" : "Review required"}</Badge>
      </div>

      <div className="mt-4 overflow-x-auto" role="tablist" aria-label="Detected invoice charge group">
        <div className="flex min-w-max gap-2 border-b border-slate-200 px-1">
          {GROUPS.map((item, index) => {
            const active = selected === item.key;
            return (
              <button
                aria-controls={`${id}-panel-${item.key}`}
                aria-selected={active}
                className={`rounded-t-lg border border-b-0 px-4 py-2.5 text-sm font-semibold transition ${active ? "border-slate-300 bg-slate-100 text-slate-950" : "border-transparent bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}
                id={`${id}-tab-${item.key}`}
                key={item.key}
                onClick={() => setSelected(item.key)}
                onKeyDown={(event) => changeTabFromKeyboard(event, index)}
                role="tab"
                tabIndex={active ? 0 : -1}
                type="button"
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        aria-labelledby={`${id}-tab-${selected}`}
        className="overflow-hidden rounded-b-xl rounded-tr-xl border border-t-0 border-slate-200 bg-white"
        id={`${id}-panel-${selected}`}
        role="tabpanel"
      >
        {available && group ? <DetectedGroupTable group={group} /> : (
          <UnavailableMessage>
            {detectedTariff?.warning || "Upload and inspect an electricity bill with verified charge categories to display tariff evidence."}
          </UnavailableMessage>
        )}
      </div>

      {available && detectedTariff.warning ? <WarningMessage>{detectedTariff.warning}</WarningMessage> : null}
    </section>
  );
}

function DetectedGroupTable({ group }: { group: CiDetectedTariffGroup }) {
  const total = group.items.reduce((sum, item) => sum + item.source_amount_ex_gst_aud, 0);
  if (!group.items.length) {
    return <UnavailableMessage>No verified {group.label.toLowerCase()} items were detected on the uploaded bill.</UnavailableMessage>;
  }
  return (
    <div className="overflow-x-auto">
      <table aria-label={`${group.label} detected invoice charges`} className="w-full min-w-[680px] border-collapse text-sm">
        <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          <tr>
            <th className="px-5 py-3">Item</th>
            <th className="px-5 py-3">Evidence basis</th>
            <th className="px-5 py-3">Rate label</th>
            <th className="px-5 py-3 text-right">Bill-period amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {group.items.map((item) => (
            <tr key={item.key}>
              <th className="px-5 py-3 text-left font-medium text-slate-800" scope="row">{item.label}</th>
              <td className="px-5 py-3 text-slate-600">{item.basis_label}</td>
              <td className="px-5 py-3 text-slate-600">{item.rate_label}</td>
              <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-950">{formatAud(item.source_amount_ex_gst_aud)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-slate-300 bg-slate-100/80">
          <tr>
            <th className="px-5 py-3 text-left font-semibold text-slate-950" colSpan={3}>Observed {group.label.toLowerCase()} total</th>
            <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-950">{formatAud(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function EstimatedAnnualBill({ estimate }: { estimate?: CiAnnualBillEstimate }) {
  if (estimate?.status === "estimated") return <AvailableAnnualBill estimate={estimate} />;
  const annualEvidenceAvailable = Boolean(
    estimate?.method === "approved_tariff_replay_required" &&
    estimate.coverage_start &&
    estimate.coverage_end &&
    estimate.annual_import_kwh !== null,
  );
  return (
    <section aria-labelledby="estimated-annual-bill-title" className="border-t border-slate-200 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-slate-950" id="estimated-annual-bill-title">Estimated annual bill</h3>
            <span title="Annual dollar values require an approved effective-dated tariff and interval replay."><Info aria-label="About the annual estimate" className="size-4 text-slate-400" /></span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Fail-closed until current tariff and demand evidence can be replayed</p>
        </div>
        <Badge variant="outline">Evidence required</Badge>
      </div>

      <div className="mt-4 space-y-3">
        {annualEvidenceAvailable && estimate ? (
          <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-3">
            <EstimateFact label="Reference interval" value={`${estimate.coverage_start} to ${estimate.coverage_end}`} />
            <EstimateFact label="Interval-recorded annual import" value={`${formatNumber(estimate.annual_import_kwh as number)} kWh`} />
            <EstimateFact label="Annual dollar result" value="Withheld pending approved tariff replay" />
          </dl>
        ) : null}
        <UnavailableMessage>{estimate?.warning || "A complete representative year and approved, effective-dated tariff evidence are required before an annual bill can be calculated."}</UnavailableMessage>
        {estimate?.assumptions.length ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <strong className="text-sm text-slate-800">Evidence still required</strong>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-slate-600">{estimate.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AvailableAnnualBill({ estimate }: { estimate: Extract<CiAnnualBillEstimate, { status: "estimated" }> }) {
  const reconciliation = estimate.bill_period_reconciliation;
  return (
    <section aria-labelledby="estimated-annual-bill-title" className="border-t border-slate-200 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-slate-950" id="estimated-annual-bill-title">Estimated annual bill</h3>
            <span title="This internal estimate annualises verified invoice category totals. It is not a contractual tariff replay or customer quote."><Info aria-label="About the annual estimate" className="size-4 text-slate-400" /></span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Bill-derived estimate for an average year, excluding GST</p>
        </div>
        <Badge variant="warning">Evidence-limited estimate</Badge>
      </div>

      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-slate-800 px-5 py-4 text-white">
          <div>
            <strong className="text-lg">Expected bill (baseline)</strong>
            <p className="mt-1 text-xs text-slate-300">Indicative estimate · ex GST · not a contractual quote</p>
          </div>
          <div className="text-left sm:text-right">
            <span className="block text-xs text-slate-300">Total bill (excl. GST)</span>
            <strong className="mt-0.5 block text-2xl tabular-nums">{formatAud(estimate.total_ex_gst_aud)}</strong>
          </div>
        </div>

        <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <EstimateFact label="Reference interval" value={`${estimate.coverage_start} to ${estimate.coverage_end}`} />
          <EstimateFact label="Measured annual import" value={`${formatNumber(estimate.annual_import_kwh)} kWh`} />
          <EstimateFact label="Estimate method" value="Bill-derived interval scaling" />
        </dl>

        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm text-emerald-950">Bill-period import reconciliation</strong>
            <Badge variant="success">Passed</Badge>
          </div>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
            <EstimateFact label="Bill period" value={`${reconciliation.billing_period_start} to ${reconciliation.billing_period_end}`} />
            <EstimateFact label="Billed consumption" value={`${formatNumber(reconciliation.billed_consumption_kwh)} kWh`} />
            <EstimateFact label="NEM12 E1 import" value={`${formatNumber(reconciliation.interval_import_kwh)} kWh`} />
            <EstimateFact label="Difference" value={`${formatSignedNumber(reconciliation.difference_kwh)} kWh (${formatPercent(reconciliation.difference_percent)})`} />
            <EstimateFact label="Tolerance" value={`≤ ${formatPercent(reconciliation.tolerance_percent)}`} />
          </dl>
          <p className="mt-3 text-xs leading-5 text-emerald-900">{reconciliation.warning}</p>
        </div>

        <div className="space-y-3">
          {GROUPS.map(({ key }) => {
            const group = estimate.groups.find((item) => item.key === key);
            return group ? <AnnualEstimateGroup key={group.key} group={group} /> : null;
          })}
        </div>
      </div>
    </section>
  );
}

function AnnualEstimateGroup({ group }: { group: CiAnnualBillEstimateGroup }) {
  return (
    <details className="group overflow-hidden rounded-lg border border-slate-200 bg-white" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-900 marker:content-none">
        <span className="flex items-center gap-2"><ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />{group.label}</span>
        <span className="tabular-nums">{formatAud(group.total_ex_gst_aud)}</span>
      </summary>
      <div className="overflow-x-auto">
        <table aria-label={`${group.label} estimated annual charges`} className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="bg-white text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">Source bill amount</th>
              <th className="px-4 py-3">Annualisation basis</th>
              <th className="px-4 py-3 text-right">Scaling factor</th>
              <th className="px-4 py-3 text-right">Estimated ex GST</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 border-t border-slate-100">
            {group.items.map((item) => <AnnualEstimateItemRow item={item} key={item.key} />)}
          </tbody>
          <tfoot className="border-t border-slate-300 bg-slate-100/80">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-slate-950" colSpan={4}>{group.label} total</th>
              <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-950">{formatAud(group.total_ex_gst_aud)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  );
}

function AnnualEstimateItemRow({ item }: { item: CiAnnualBillEstimateItem }) {
  const excluded = item.scaling_basis === "excluded_unverified_recurrence";
  return (
    <tr>
      <th className="px-4 py-3 text-left font-medium text-slate-800" scope="row">{item.label}</th>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatAud(item.source_amount_ex_gst_aud)}</td>
      <td className="px-4 py-3 text-slate-600">{annualisationBasisLabel(item.scaling_basis)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{excluded ? "Not annualised" : `× ${formatScaleFactor(item.scaling_factor)}`}</td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-950">{excluded ? <span className="text-amber-800">Excluded</span> : formatAud(item.annual_amount_ex_gst_aud)}</td>
    </tr>
  );
}

function EstimateFact({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 font-medium text-slate-800">{value}</dd></div>;
}

function WarningMessage({ children }: { children: string }) {
  return <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950"><CircleAlert className="mt-0.5 size-4 shrink-0" />{children}</p>;
}

function UnavailableMessage({ children }: { children: ReactNode }) {
  return <div className="flex gap-3 px-5 py-6 text-sm text-slate-600"><ReceiptText className="mt-0.5 size-4 shrink-0 text-slate-400" /><p className="leading-6"><strong className="block text-slate-800">Verified detail unavailable</strong>{children}</p></div>;
}

function formatAud(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value);
}

function formatSignedNumber(value: number) {
  const amount = formatNumber(value);
  return value > 0 ? `+${amount}` : amount;
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 3 }).format(value)}%`;
}

function formatScaleFactor(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 4 }).format(value);
}

function annualisationBasisLabel(value: CiAnnualBillEstimateItem["scaling_basis"]) {
  if (value === "365_days_over_billing_days") return "365 days ÷ source billing days";
  if (value === "annual_import_kwh_over_billed_consumption_kwh") return "Measured annual import ÷ billed consumption";
  return "Excluded — recurrence not verified";
}

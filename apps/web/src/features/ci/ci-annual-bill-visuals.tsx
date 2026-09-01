import { Badge } from "@/components/ui/badge";
import type {
  CiAnnualBillEstimateEstimated,
  CiAnnualBillEstimateGroup,
} from "@/features/ci/api/ci-evidence-intake";

const GROUP_META: Record<CiAnnualBillEstimateGroup["key"], { colour: string; label: string }> = {
  fixed: { colour: "#0e7490", label: "Fixed" },
  other_usage: { colour: "#7c3aed", label: "Other usage" },
  energy_import: { colour: "#d97706", label: "Energy (Import)" },
};

export function CiAnnualBillCompositionChart({
  groups,
  total,
}: {
  groups: CiAnnualBillEstimateGroup[];
  total: number;
}) {
  const items = groups.map((group) => ({
    ...group,
    colour: GROUP_META[group.key].colour,
    label: GROUP_META[group.key].label,
  }));
  const groupTotal = items.reduce((sum, item) => sum + item.total_ex_gst_aud, 0);
  const canShowProportions = total > 0 && items.length > 0 && items.every((item) => item.total_ex_gst_aud >= 0) && moneyMatches(groupTotal, total);
  const chartLabel = items.map((item) => `${item.label} ${formatAud(item.total_ex_gst_aud)}`).join(", ");

  return (
    <figure className="rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <h4 className="text-sm font-semibold text-slate-950">Annualised charge mix</h4>
        <p className="mt-1 text-xs leading-5 text-slate-500">Share of the bill-derived annualised total, excluding GST.</p>
      </div>

      {canShowProportions ? (
        <div
          aria-label={`Annualised charge mix: ${chartLabel}. Total ${formatAud(total)} excluding GST.`}
          className="mt-4 flex h-4 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200"
          role="img"
        >
          {items.map((item) => (
            <span
              aria-hidden="true"
              key={item.key}
              style={{ backgroundColor: item.colour, width: `${item.total_ex_gst_aud / total * 100}%` }}
            />
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
          A proportional view is not shown because the annualised groups include a signed amount or do not reconcile to the total.
        </p>
      )}

      <figcaption className="mt-4 grid gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <div className="rounded-lg bg-slate-50 p-3" key={item.key}>
            <span className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: item.colour }} />
              {item.label}
            </span>
            <strong className="mt-1.5 block tabular-nums text-slate-950">{formatAud(item.total_ex_gst_aud)}</strong>
            {canShowProportions ? <span className="mt-0.5 block text-xs tabular-nums text-slate-500">{formatPercent(item.total_ex_gst_aud / total * 100)} of total</span> : null}
          </div>
        ))}
      </figcaption>
    </figure>
  );
}

export function CiBillPeriodReconciliationChart({
  reconciliation,
}: {
  reconciliation: CiAnnualBillEstimateEstimated["bill_period_reconciliation"];
}) {
  const signedDifferencePercent = reconciliation.billed_consumption_kwh === 0
    ? 0
    : reconciliation.difference_kwh / reconciliation.billed_consumption_kwh * 100;
  const tolerance = reconciliation.tolerance_percent;
  const chartRange = Math.max(tolerance * 2, Math.abs(signedDifferencePercent) * 1.25, 4);
  const toleranceStart = 50 - tolerance / (chartRange * 2) * 100;
  const toleranceWidth = tolerance / chartRange * 100;
  const marker = clamp(50 + signedDifferencePercent / (chartRange * 2) * 100, 0, 100);
  const period = `${reconciliation.billing_period_start} to ${reconciliation.billing_period_end}`;

  return (
    <figure className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-emerald-950">Bill-period import reconciliation</h4>
          <p className="mt-1 text-xs text-emerald-900/75">{period}</p>
        </div>
        <Badge variant="success">Internal evidence check passed</Badge>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        <ReconciliationFact label="Billed consumption" value={`${formatNumber(reconciliation.billed_consumption_kwh)} kWh`} />
        <ReconciliationFact label="NEM12 E1 import" value={`${formatNumber(reconciliation.interval_import_kwh)} kWh`} />
      </dl>

      <div
        aria-label={`Bill-period reconciliation for ${period}. Billed consumption ${formatNumber(reconciliation.billed_consumption_kwh)} kWh. NEM12 E1 import ${formatNumber(reconciliation.interval_import_kwh)} kWh. Difference ${formatSignedNumber(reconciliation.difference_kwh)} kWh, ${formatPercent(reconciliation.difference_percent)}. Internal reconciliation threshold plus or minus ${formatPercent(tolerance)}.`}
        className="mt-4"
        role="img"
      >
        <div className="relative h-5 rounded-full bg-slate-200 ring-1 ring-inset ring-slate-300">
          <span
            aria-hidden="true"
            className="absolute inset-y-0 rounded-full bg-emerald-300/80"
            style={{ left: `${toleranceStart}%`, width: `${toleranceWidth}%` }}
          />
          <span aria-hidden="true" className="absolute inset-y-[-4px] left-1/2 w-px bg-slate-500" />
          <span
            aria-hidden="true"
            className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900 shadow-sm"
            style={{ left: `${marker}%` }}
          />
        </div>
        <div aria-hidden="true" className="mt-1.5 flex justify-between text-[10px] font-medium text-slate-500">
          <span>−{formatPercent(chartRange)}</span>
          <span>Exact match</span>
          <span>+{formatPercent(chartRange)}</span>
        </div>
      </div>

      <figcaption className="mt-3 text-xs leading-5 text-emerald-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>Difference {formatSignedNumber(reconciliation.difference_kwh)} kWh ({formatPercent(reconciliation.difference_percent)})</span>
          <span className="font-medium">Within ±{formatPercent(tolerance)} internal threshold</span>
        </div>
        <p className="mt-2 text-emerald-900/80">{reconciliation.warning}</p>
      </figcaption>
    </figure>
  );
}

function ReconciliationFact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-emerald-100 bg-white/80 p-3"><dt className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800/70">{label}</dt><dd className="mt-1 font-semibold tabular-nums text-slate-950">{value}</dd></div>;
}

function moneyMatches(left: number, right: number) {
  return Math.abs(left - right) <= 0.02;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value);
}

function formatSignedNumber(value: number) {
  const amount = formatNumber(value);
  return value > 0 ? `+${amount}` : amount;
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value)}%`;
}

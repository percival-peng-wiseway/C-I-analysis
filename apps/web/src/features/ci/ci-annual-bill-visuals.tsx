import type { CiAnnualBillEstimateGroup } from "@/features/ci/api/ci-evidence-intake";

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

function moneyMatches(left: number, right: number) {
  return Math.abs(left - right) <= 0.02;
}

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value)}%`;
}

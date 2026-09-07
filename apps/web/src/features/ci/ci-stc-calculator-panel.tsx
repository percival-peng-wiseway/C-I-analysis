import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchStcCalculator, stcCalculatorKey, type StcCalculatorInput } from "./api/ci-stc-calculator";

const periods = [
  ["2025", "2025 Jan–Dec"], ["2026-01_04", "2026 Jan–Apr"], ["2026-05_12", "2026 May–Dec"],
  ["2027-01_06", "2027 Jan–Jun"], ["2027-07_12", "2027 Jul–Dec"],
  ["2028-01_06", "2028 Jan–Jun"], ["2028-07_12", "2028 Jul–Dec"],
  ["2029-01_06", "2029 Jan–Jun"], ["2029-07_12", "2029 Jul–Dec"],
  ["2030-01_06", "2030 Jan–Jun"], ["2030-07_12", "2030 Jul–Dec"],
];
type Draft = Record<keyof StcCalculatorInput, string>;
const emptyDraft: Draft = { solar_installation_year: "2026", solar_zone: "4", pv_capacity_kwp: "",
  solar_certificate_price: "39", battery_installation_period: "2026-05_12",
  battery_stc_count: "174", battery_certificate_price: "39" };
const draftFrom = (input: StcCalculatorInput): Draft => Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])) as Draft;
const money = (v: number) => v.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const control = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 disabled:opacity-60";

export function CiStcCalculatorPanel({ projectId }: { projectId: string }) {
  return <StcWorksheet key={projectId} projectId={projectId} />;
}
function StcWorksheet({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const state = useQuery({ queryKey: stcCalculatorKey(projectId), queryFn: () => fetchStcCalculator(projectId), retry: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (state.data && draft === null) setDraft(state.data.draft_inputs ? draftFrom(state.data.draft_inputs) : { ...emptyDraft }); }, [state.data, draft]);
  const save = useMutation({ mutationFn: (input: StcCalculatorInput) => fetchStcCalculator(projectId, input),
    onSuccess: data => { client.setQueryData(stcCalculatorKey(projectId), data); } });
  const saved = state.data?.estimate;
  const dirty = !!draft && (!saved || Object.keys(draft).some(k => draft[k as keyof Draft] !== String(saved.inputs[k as keyof StcCalculatorInput])));
  const valid = !!draft && Object.entries(draft).every(([key, value]) => key === "battery_installation_period" || (value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0))
    && Number(draft.solar_certificate_price) <= 1000 && Number(draft.battery_certificate_price) <= 1000
    && Number(draft.pv_capacity_kwp) <= 1_000_000 && Number(draft.battery_stc_count) <= 1_000_000;
  const update = (key: keyof Draft, value: string) => { save.reset(); setDraft(d => d ? { ...d, [key]: value } : d); };
  const calculate = () => {
    if (!draft || !valid) return;
    const input = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, key === "battery_installation_period" ? value : Number(value)])) as unknown as StcCalculatorInput;
    save.mutate(input);
  };
  const field = (key: keyof Draft, label: string) => <label className="grid gap-1.5 text-xs font-medium text-slate-600"><span>{label}</span><input form={`stc-worksheet-${projectId}`} className={control} type="number" min="0" step="any" max={key.includes("price") ? 1000 : 1_000_000} disabled={save.isPending} value={draft?.[key] ?? ""} onChange={e => update(key, e.target.value)} onKeyDown={e => { if(e.key === "Enter") { e.preventDefault(); e.stopPropagation(); calculate(); } }} /></label>;
  return <details className="overflow-hidden rounded-xl border border-slate-200 bg-white" open>
    <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-950">STC calculator <span className="ml-3 text-xs font-normal text-slate-500">Standalone estimate · excluded from solutions &amp; finance</span></summary>
    <div className="space-y-4 border-t border-slate-200 p-5">
      {state.isError ? <p role="alert">STC worksheet could not be loaded. <button type="button" className="underline" onClick={() => { void state.refetch(); }}>Retry</button></p> : !draft ? <p>Loading STC worksheet…</p> : <>
        <div className="grid gap-4 lg:grid-cols-2">
          <section aria-label="Solar STC calculator" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/40 p-4">
            <h5 className="font-semibold">Solar STCs</h5>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-slate-600">Solar installation year<select form={`stc-worksheet-${projectId}`} className={control} value={draft.solar_installation_year} disabled={save.isPending} onChange={e => update("solar_installation_year", e.target.value)}>{[2025,2026,2027,2028,2029,2030].map(y => <option key={y} value={y}>{y}</option>)}</select></label>
              <label className="grid gap-1.5 text-xs font-medium text-slate-600">Solar zone<select form={`stc-worksheet-${projectId}`} className={control} value={draft.solar_zone} disabled={save.isPending} onChange={e => update("solar_zone", e.target.value)}><option value="3">Zone 3 · 1.382</option><option value="4">Zone 4 · 1.185</option></select></label>
              {field("pv_capacity_kwp", "PV capacity (kWp)")}{field("solar_certificate_price", "Solar STC price (AUD / certificate)")}
            </div>
            <p className="text-xs text-slate-500">(2030 − installation year + 1) × zone factor × PV kWp × price</p>
            {saved && !dirty ? <><p className="text-xs">{saved.solar_deeming_years} × {saved.solar_zone_factor} × {saved.inputs.pv_capacity_kwp} × {saved.inputs.solar_certificate_price}</p><p className="text-lg font-semibold">Solar rebate: {money(saved.solar_rebate_aud)}</p></> : null}
          </section>
          <section aria-label="Battery STC calculator" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/40 p-4">
            <h5 className="font-semibold">Battery STCs</h5>
            <label className="grid gap-1.5 text-xs font-medium text-slate-600">Battery installation period<select form={`stc-worksheet-${projectId}`} className={control} value={draft.battery_installation_period} disabled={save.isPending} onChange={e => update("battery_installation_period", e.target.value)}>{periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="grid gap-3 sm:grid-cols-2">{field("battery_stc_count", "Battery STC count (certificates)")}{field("battery_certificate_price", "Battery STC price (AUD / certificate)")}</div>
            <p className="text-xs text-slate-500">STC count × installation-period factor × price (custom worksheet formula)</p>
            {state.data?.legacy_capacity_reset ? <p role="status" className="text-xs text-amber-800">The previous battery capacity was not converted to STC count. The count defaults to 174; review it and calculate again to save the new estimate.</p> : null}
            {saved && !dirty ? <><p className="text-xs">{saved.inputs.battery_stc_count} × {saved.battery_factor} × {saved.inputs.battery_certificate_price}</p><p className="text-lg font-semibold">Battery rebate: {money(saved.battery_rebate_aud)}</p></> : null}
          </section>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 p-4">
          <p className="font-semibold" aria-live="polite">{saved && !dirty ? `Saved total rebate estimate: ${money(saved.total_rebate_aud)}` : "Enter PV capacity and STC count (use 0 if not required), then calculate and save."}</p>
          <Button type="button" disabled={!valid || save.isPending || !dirty} onClick={calculate}>{save.isPending ? "Calculating…" : "Calculate & save STC estimate"}</Button>
        </div>
        {save.error instanceof Error ? <p role="alert" className="text-sm text-red-700">{save.error.message}</p> : null}
      </>}
      <p className="text-xs leading-5 text-slate-500">Manual formula estimate only, not an entitlement or customer quote. No eligibility caps, battery tiering or certificate rounding are applied; money is rounded to cents. Saving does not change Evidence, solution costs, NPV or payback.</p>
    </div>
  </details>;
}

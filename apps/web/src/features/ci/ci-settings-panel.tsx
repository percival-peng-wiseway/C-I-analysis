import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BatteryCharging, BadgeDollarSign, Check, Settings2, SunMedium, X, Zap } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  ciDeviceProfileQueryKey,
  fetchCiDeviceProfile,
  saveCiDeviceProfile,
  type CiDeviceProfile,
} from "@/features/ci/api/ci-device-profile";

export function CiSettingsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({ queryKey: ciDeviceProfileQueryKey, queryFn: () => fetchCiDeviceProfile() });
  const [draft, setDraft] = useState<CiDeviceProfile | null>(null);
  const save = useMutation({
    mutationFn: (profile: CiDeviceProfile) => saveCiDeviceProfile(profile),
    onSuccess: (state) => {
      queryClient.setQueryData(ciDeviceProfileQueryKey, state);
      void queryClient.invalidateQueries({ queryKey: ["ci-project-annual-financial-comparison"] });
    },
  });

  useEffect(() => {
    if (profileQuery.data && draft === null) {
      setDraft(structuredClone(profileQuery.data.profile ?? profileQuery.data.suggested_profile));
    }
  }, [draft, profileQuery.data]);

  const updatePvPrice = (field: "capital_cost_aud_per_kwp_dc" | "replacement_cost_aud_per_kwp_dc" | "annual_om_aud", value: number) => setDraft((current) => {
    if (!current) return current;
    const next = structuredClone(current);
    next.equipment_catalog.pv_products[0][field] = value;
    if (field === "capital_cost_aud_per_kwp_dc") next.pv_cost_aud_per_kwp_dc = value;
    return next;
  });
  const updateBatteryPrice = (index: number, field: "capital_cost_aud" | "replacement_cost_aud" | "annual_om_aud", value: number) => setDraft((current) => {
    if (!current) return current;
    const next = structuredClone(current);
    next.equipment_catalog.battery_products[0].cost_curve[index][field] = value;
    return next;
  });
  const updateInverterPrice = (index: number, field: "capital_cost_aud" | "replacement_cost_aud" | "annual_om_aud", value: number) => setDraft((current) => {
    if (!current) return current;
    const next = structuredClone(current);
    next.equipment_catalog.inverter_products[0].cost_curve[index][field] = value;
    return next;
  });

  return (
    <div aria-label="Settings" aria-modal="true" className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-[2px]" role="dialog">
      <button aria-label="Close settings" className="min-w-0 flex-1 cursor-default" onClick={onClose} type="button" />
      <section className="flex h-full w-full max-w-[560px] flex-col overflow-hidden bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Settings2 className="size-5" /></span><div><p className="text-xs font-semibold uppercase tracking-[.15em] text-cyan-700">Settings</p><h2 className="text-lg font-semibold text-slate-950">Device profile</h2></div></div>
          <Button aria-label="Close settings panel" className="size-9 p-0" onClick={onClose} type="button" variant="ghost"><X className="size-4" /></Button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6">
          {profileQuery.isPending || !draft ? <p className="text-sm text-slate-500">Loading device prices…</p> : null}
          {profileQuery.isError ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">Device profile could not be loaded.</p> : null}
          {draft ? (
            <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}>
              <div>
                <h3 className="text-sm font-semibold text-slate-950">Supported equipment</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500">AUD ex GST. The catalog currently supports these three products only.</p>
                <div className="mt-4 space-y-4">
                  <EquipmentCard icon={SunMedium} manufacturer="Astronergy" model="ASTRO N7 600–630W" summary="600–630 W module · linear PV capacity pricing">
                    <PriceGridHeader first="Rate basis" />
                    <PriceGridRow first="Per kWp DC" onCapital={(value) => updatePvPrice("capital_cost_aud_per_kwp_dc", value)} onOm={(value) => updatePvPrice("annual_om_aud", value)} onReplacement={(value) => updatePvPrice("replacement_cost_aud_per_kwp_dc", value)} values={[draft.equipment_catalog.pv_products[0].capital_cost_aud_per_kwp_dc, draft.equipment_catalog.pv_products[0].replacement_cost_aud_per_kwp_dc, draft.equipment_catalog.pv_products[0].annual_om_aud]} />
                  </EquipmentCard>

                  <EquipmentCard icon={BatteryCharging} manufacturer="Fox ESS" model="CQ7 C&I" summary="LFP · 7.0 kWh pricing module · interpolated cost curve">
                    <PriceGridHeader first="Modules" />
                    {draft.equipment_catalog.battery_products[0].cost_curve.map((point, index) => <PriceGridRow first={String(point.quantity)} key={point.quantity} onCapital={(value) => updateBatteryPrice(index, "capital_cost_aud", value)} onOm={(value) => updateBatteryPrice(index, "annual_om_aud", value)} onReplacement={(value) => updateBatteryPrice(index, "replacement_cost_aud", value)} values={[point.capital_cost_aud, point.replacement_cost_aud, point.annual_om_aud]} />)}
                  </EquipmentCard>

                  <EquipmentCard icon={Zap} manufacturer="Fox ESS" model="H3 Plus Hybrid Inverter / PCS" summary="Shared 125 kW AC unit · quantity automatically sized">
                    <PriceGridHeader first="Capacity" />
                    {draft.equipment_catalog.inverter_products[0].cost_curve.map((point, index) => <PriceGridRow first={`${point.capacity_kw_ac} kW`} key={point.capacity_kw_ac} onCapital={(value) => updateInverterPrice(index, "capital_cost_aud", value)} onOm={(value) => updateInverterPrice(index, "annual_om_aud", value)} onReplacement={(value) => updateInverterPrice(index, "replacement_cost_aud", value)} values={[point.capital_cost_aud, point.replacement_cost_aud, point.annual_om_aud]} />)}
                  </EquipmentCard>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-5">
                <div className="flex items-center gap-2"><BadgeDollarSign className="size-4 text-cyan-700" /><h3 className="text-sm font-semibold text-slate-950">Finance defaults</h3></div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <RateField label="Discount rate" onChange={(value) => setDraft((current) => current ? { ...current, discount_rate: value / 100 } : current)} suffix="%" value={draft.discount_rate * 100} />
                  <RateField label="Analysis term" onChange={(value) => setDraft((current) => current ? { ...current, analysis_term_years: Math.round(value) } : current)} suffix="years" value={draft.analysis_term_years} />
                  <RateField label="Value escalation" onChange={(value) => setDraft((current) => current ? { ...current, annual_value_escalation_rate: value / 100 } : current)} suffix="% / yr" value={draft.annual_value_escalation_rate * 100} />
                  <RateField label="PV degradation" onChange={(value) => setDraft((current) => current ? { ...current, annual_value_degradation_rate: value / 100 } : current)} suffix="% / yr" value={draft.annual_value_degradation_rate * 100} />
                  <RateField label="Annual O&M" onChange={(value) => setDraft((current) => current ? { ...current, annual_om_fraction_of_capex: value / 100 } : current)} suffix="% CAPEX" value={draft.annual_om_fraction_of_capex * 100} />
                </div>
              </div>

              <div className="rounded-xl bg-slate-950 p-4 text-white">
                <p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-300">Automatic CAPEX</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">PV uses the saved $/kWp rate. CQ7 capacity is rounded up to whole 7 kWh pricing modules and evaluated on its cost curve. The shared hybrid inverter / PCS is rounded up to the required number of 125 kW units and priced once.</p>
              </div>

              {save.error instanceof Error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{save.error.message}</p> : null}
              {save.isSuccess ? <p className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800"><Check className="size-4" />Device profile saved. Existing finance results are marked for recalculation.</p> : null}
              <div className="flex justify-end gap-2 border-t border-slate-200 pt-5"><Button onClick={onClose} type="button" variant="outline">Cancel</Button><Button disabled={save.isPending || !isValid(draft)} type="submit">{save.isPending ? "Saving…" : "Save profile"}</Button></div>
            </form>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function EquipmentCard({ children, icon: Icon, manufacturer, model, summary }: { children: ReactNode; icon: typeof SunMedium; manufacturer: string; model: string; summary: string }) {
  return <section className="overflow-hidden rounded-xl border border-slate-200"><div className="flex items-start gap-3 bg-slate-50 px-4 py-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Icon className="size-4" /></span><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[.13em] text-cyan-700">{manufacturer}</p><h4 className="truncate text-sm font-semibold text-slate-950">{model}</h4><p className="mt-0.5 text-[11px] text-slate-500">{summary}</p></div></div><div className="overflow-x-auto p-3"><div className="min-w-[470px]">{children}</div></div></section>;
}

function PriceGridHeader({ first }: { first: string }) {
  return <div className="grid grid-cols-[90px_repeat(3,minmax(110px,1fr))] gap-2 px-2 pb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400"><span>{first}</span><span className="text-right">Capital</span><span className="text-right">Replacement</span><span className="text-right">O&amp;M / yr</span></div>;
}

function PriceGridRow({ first, onCapital, onOm, onReplacement, values }: { first: string; onCapital: (value: number) => void; onOm: (value: number) => void; onReplacement: (value: number) => void; values: [number, number, number] }) {
  return <div className="grid grid-cols-[90px_repeat(3,minmax(110px,1fr))] items-center gap-2 border-t border-slate-100 px-2 py-2"><strong className="text-xs text-slate-700">{first}</strong><CatalogPriceInput label={`${first} capital`} onChange={onCapital} value={values[0]} /><CatalogPriceInput label={`${first} replacement`} onChange={onReplacement} value={values[1]} /><CatalogPriceInput label={`${first} O&M`} onChange={onOm} value={values[2]} /></div>;
}

function CatalogPriceInput({ label, onChange, value }: { label: string; onChange: (value: number) => void; value: number }) {
  return <div className="relative"><span className="absolute left-2.5 top-2 text-xs text-slate-400">$</span><input aria-label={label} className="h-8 w-full rounded-md border border-slate-200 bg-white pl-6 pr-2 text-right text-xs font-semibold tabular-nums" min="0" onChange={(event) => onChange(Number(event.target.value))} step="0.01" type="number" value={value} /></div>;
}

function RateField({ label, onChange, suffix, value }: { label: string; onChange: (value: number) => void; suffix: string; value: number }) {
  return <label className="rounded-lg bg-slate-50 p-3"><span className="text-xs text-slate-500">{label}</span><span className="mt-1 flex items-center gap-1"><input aria-label={label} className="min-w-0 flex-1 bg-transparent text-sm font-semibold tabular-nums outline-none" min="0" onChange={(event) => onChange(Number(event.target.value))} step="0.1" type="number" value={Number(value.toFixed(3))} /><span className="text-[10px] text-slate-400">{suffix}</span></span></label>;
}

function isValid(profile: CiDeviceProfile) {
  const pv = profile.equipment_catalog.pv_products[0];
  const battery = profile.equipment_catalog.battery_products[0];
  const inverter = profile.equipment_catalog.inverter_products[0];
  return pv.capital_cost_aud_per_kwp_dc > 0 && battery.cost_curve.every((point) => point.capital_cost_aud > 0) && inverter.cost_curve.every((point) => point.capital_cost_aud > 0) && profile.analysis_term_years >= 1;
}

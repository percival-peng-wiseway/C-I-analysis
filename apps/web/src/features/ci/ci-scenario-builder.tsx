import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeftRight, BatteryCharging, Building2, Grid3X3, SunMedium, UtilityPole } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiScenarioInput } from "@/features/ci/api/ci-scenarios";

type BatterySystem = { id: string; label: string; capacity: string; power: string };
type PvSystem = { id: string; label: string; capacity: string; inverter: string };

const newBattery = (index: number): BatterySystem => ({ id: `battery-${String(index).padStart(3, "0")}`, label: `Battery system ${index}`, capacity: "", power: "" });
const newPv = (index: number): PvSystem => ({ id: `pv-${String(index).padStart(3, "0")}`, label: `PV system ${index}`, capacity: "", inverter: "" });

export function CiScenarioBuilder({ error, initialSolutions, isPending, onSubmit }: { error: string | null; initialSolutions?: CiScenarioInput[]; isPending: boolean; onSubmit: (solutions: CiScenarioInput[]) => void }) {
  const initialDesign = restoreDesign(initialSolutions);
  const [editor, setEditor] = useState<"pv" | "battery" | null>(null);
  const [batteries, setBatteries] = useState<BatterySystem[]>(initialDesign?.batteries ?? [newBattery(1), newBattery(2)]);
  const [pvSystems, setPvSystems] = useState<PvSystem[]>(initialDesign?.pvSystems ?? [newPv(1)]);
  const [batteryAssumptions, setBatteryAssumptions] = useState(initialDesign?.batteryAssumptions ?? { chargeEfficiency: "94.86832981", dischargeEfficiency: "94.86832981", minSoc: "10", maxSoc: "100", initialSoc: "100", allowGridCharging: false });
  const [pvAssumptions, setPvAssumptions] = useState(initialDesign?.pvAssumptions ?? { annualYield: "1500", derating: "88", sharedAcHeadroom: "250", reactiveSupportEnabled: false, reactiveSupportMaxKvar: "", apparentPowerLimitKva: "" });
  const solutions = useMemo(() => buildSolutions(batteries, pvSystems, batteryAssumptions, pvAssumptions), [batteries, pvSystems, batteryAssumptions, pvAssumptions]);
  const solutionCount = batteries.length * pvSystems.length;

  return <Card>
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle as="h2">PV and battery search space</CardTitle><CardDescription>Configure lower and upper bounds, steps and technical details. Python then validates every generated combination.</CardDescription></div><Badge variant={solutionCount > 200 ? "warning" : "outline"}>{solutionCount} / 200 candidates</Badge></div></CardHeader>
    <CardContent>
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (solutions) onSubmit(solutions); }}>
        <SystemDesignCanvas batteries={batteries} pvSystems={pvSystems} solutionCount={solutionCount} />
        <div className="grid gap-4 md:grid-cols-2">
          <ModuleCard title="Solar PV" count={pvSystems.length} summary={pvSystems.every((item) => validSizePair(item.capacity, item.inverter)) ? `${rangeLabel(pvSystems.map((item) => Number(item.capacity)))} kWp DC` : "Needs system inputs"} onEdit={() => setEditor("pv")} />
          <ModuleCard title="Battery" count={batteries.length} summary={batteries.every((item) => validSizePair(item.capacity, item.power)) ? `${rangeLabel(batteries.map((item) => Number(item.capacity)))} kWh` : "Needs system inputs"} onEdit={() => setEditor("battery")} />
        </div>
        <p className="rounded-lg border border-cyan-100 bg-cyan-50 p-3 text-sm text-cyan-950">Changes inside each module are applied to this draft immediately. Use the button below to validate and save the complete design to this project.</p>
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button disabled={!solutions || isPending} type="submit">{isPending ? `Saving ${solutionCount} candidates` : `Save & validate ${solutionCount} candidates`}</Button>
          {!solutions ? <p className="text-sm text-muted-foreground">Complete both modules and keep the Cartesian product at 200 candidates or fewer.</p> : <p className="text-sm text-muted-foreground">PV systems × battery systems; validation does not run NEM12 dispatch or tariff calculations.</p>}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </form>
      {editor === "battery" ? <BatteryDrawer assumptions={batteryAssumptions} onAssumptions={setBatteryAssumptions} onClose={() => setEditor(null)} onSystems={setBatteries} systems={batteries} /> : null}
      {editor === "pv" ? <PvDrawer assumptions={pvAssumptions} onAssumptions={setPvAssumptions} onClose={() => setEditor(null)} onSystems={setPvSystems} systems={pvSystems} /> : null}
    </CardContent>
  </Card>;
}

function SystemDesignCanvas({ batteries, pvSystems, solutionCount }: { batteries: BatterySystem[]; pvSystems: PvSystem[]; solutionCount: number }) {
  const pvCapacities = pvSystems.map((item) => Number(item.capacity)).filter(Number.isFinite);
  const batteryCapacities = batteries.map((item) => Number(item.capacity)).filter(Number.isFinite);
  const pvRange = pvCapacities.length ? `${rangeLabel(pvCapacities)} kWp` : "Awaiting inputs";
  const batteryRange = batteryCapacities.length ? `${rangeLabel(batteryCapacities)} kWh` : "Awaiting inputs";
  const previewCount = Math.min(solutionCount, 60);
  return (
    <section className="ci-design-canvas" aria-label="System design schematic">
      <div className="ci-design-flow">
        <DesignNode icon={UtilityPole} label="Grid" value="Evidence tariff" tone="slate" />
        <FlowLink />
        <DesignNode icon={Building2} label="Site load" value="NEM12 intervals" tone="violet" />
        <FlowLink />
        <div className="grid gap-3 sm:grid-cols-2">
          <DesignNode icon={SunMedium} label={`${pvSystems.length} PV systems`} value={pvRange} tone="amber" />
          <DesignNode icon={BatteryCharging} label={`${batteries.length} battery systems`} value={batteryRange} tone="cyan" />
        </div>
      </div>
      <div className="ci-search-space">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Search space</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{solutionCount}</p>
            <p className="text-xs text-slate-500">PV × battery combinations</p>
          </div>
          <span className="grid size-9 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Grid3X3 className="size-4" /></span>
        </div>
        <div className="mt-4 grid grid-cols-10 gap-1" aria-label={`${solutionCount} scenario combinations`} role="img">
          {Array.from({ length: Math.max(1, previewCount) }, (_, index) => <span className={`aspect-square rounded-[3px] ${index < solutionCount ? "bg-cyan-400" : "bg-slate-100"}`} key={index} />)}
        </div>
        {solutionCount > previewCount ? <p className="mt-2 text-[10px] text-slate-400">Previewing {previewCount} of {solutionCount} combinations</p> : null}
      </div>
    </section>
  );
}

function DesignNode({ icon: Icon, label, tone, value }: { icon: typeof UtilityPole; label: string; tone: "slate" | "violet" | "amber" | "cyan"; value: string }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    violet: "bg-violet-100 text-violet-700",
    amber: "bg-amber-100 text-amber-700",
    cyan: "bg-cyan-100 text-cyan-800",
  };
  return (
    <div className="flex min-w-[150px] items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${tones[tone]}`}><Icon className="size-4" /></span>
      <span className="min-w-0"><strong className="block truncate text-sm">{label}</strong><span className="block truncate text-xs text-slate-500">{value}</span></span>
    </div>
  );
}

function FlowLink() {
  return <span className="grid size-7 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-400"><ArrowLeftRight className="size-3.5" /></span>;
}

function ModuleCard({ count, onEdit, summary, title }: { count: number; onEdit: () => void; summary: string; title: string }) {
  return <section className="rounded-lg border border-border bg-muted/20 p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{title}</h3><Badge className="mt-2" variant="secondary">{count}</Badge></div><Button onClick={onEdit} type="button" variant="outline">Edit {title}</Button></div><p className="mt-5 text-sm text-muted-foreground">{summary}</p></section>;
}

function BatteryDrawer({ assumptions, onAssumptions, onClose, onSystems, systems }: { assumptions: { chargeEfficiency: string; dischargeEfficiency: string; minSoc: string; maxSoc: string; initialSoc: string; allowGridCharging: boolean }; onAssumptions: (value: typeof assumptions) => void; onClose: () => void; onSystems: (value: BatterySystem[]) => void; systems: BatterySystem[] }) {
  const [range, setRange] = useState({ start: "", end: "", step: "", duration: "" });
  const generate = () => {
    const values = numberRange(range.start, range.end, range.step, 15);
    const duration = Number(range.duration);
    if (!values || !positive(duration)) return;
    onSystems(values.map((capacity, index) => ({ id: `battery-${String(index + 1).padStart(3, "0")}`, label: capacity === 0 ? "No battery" : `${compact(capacity)} kWh / ${compact(capacity / duration)} kW`, capacity: String(capacity), power: String(Number((capacity / duration).toFixed(6))) })));
  };
  return <Drawer heading="Battery" count={`${systems.length} / 15 systems`} onClose={onClose}>
    <Section title="Battery technology" description="Hardware model applied to every battery system."><SelectField label="Battery technology" value="generic_li_ion_ac"><option value="generic_li_ion_ac">Generic Li-ion (AC)</option></SelectField></Section>
    <Section title="Control profile" description="Python-owned dispatch strategy applied to every solution."><SelectField label="Control profile" value="demand_peak_shaving"><option value="demand_peak_shaving">Demand peak shaving</option></SelectField></Section>
    <RangeGrid><Field label="Start capacity (kWh)" numeric value={range.start} onChange={(value) => setRange({ ...range, start: value })} /><Field label="End capacity (kWh)" numeric value={range.end} onChange={(value) => setRange({ ...range, end: value })} /><Field label="Capacity step (kWh)" numeric value={range.step} onChange={(value) => setRange({ ...range, step: value })} /><Field label="Duration (hours)" numeric value={range.duration} onChange={(value) => setRange({ ...range, duration: value })} /><Button disabled={!numberRange(range.start, range.end, range.step, 15) || !positive(range.duration)} onClick={generate} type="button" variant="outline">Generate systems</Button></RangeGrid>
    <Section title="Shared physical assumptions" description="Efficiencies are editable analyst assumptions. SOC values are visible fixed V1 optimizer constraints."><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Field label="Charge efficiency (%)" numeric value={assumptions.chargeEfficiency} onChange={(value) => onAssumptions({ ...assumptions, chargeEfficiency: value })} /><Field label="Discharge efficiency (%)" numeric value={assumptions.dischargeEfficiency} onChange={(value) => onAssumptions({ ...assumptions, dischargeEfficiency: value })} /><Field disabled label="Minimum SOC (%) — V1 fixed" numeric value={assumptions.minSoc} onChange={() => undefined} /><Field disabled label="Maximum SOC (%) — V1 fixed" numeric value={assumptions.maxSoc} onChange={() => undefined} /><Field disabled label="Initial and terminal SOC (%) — V1 fixed" numeric value={assumptions.initialSoc} onChange={() => undefined} /></div><label className="mt-4 flex items-center gap-2 text-sm"><input checked={assumptions.allowGridCharging} onChange={(event) => onAssumptions({ ...assumptions, allowGridCharging: event.target.checked })} type="checkbox" />Allow grid charging</label></Section>
    <SystemTable headers={["Battery system", "Capacity (kWh)", "Power (kW AC)", "Duration", ""]}>{systems.map((system, index) => <tr className="border-t border-border" key={system.id}><Cell><Field hideLabel label={`Battery system ${index + 1} name`} value={system.label} onChange={(value) => onSystems(patchRow(systems, index, { label: value }))} /></Cell><Cell><Field hideLabel label={`Battery system ${index + 1} capacity (kWh)`} numeric value={system.capacity} onChange={(value) => onSystems(patchRow(systems, index, { capacity: value }))} /></Cell><Cell><Field hideLabel label={`Battery system ${index + 1} power (kW)`} numeric value={system.power} onChange={(value) => onSystems(patchRow(systems, index, { power: value }))} /></Cell><Cell>{isZeroSizePair(system.capacity, system.power) ? "Not installed" : positive(system.capacity) && positive(system.power) ? `${compact(Number(system.capacity) / Number(system.power))} h` : "—"}</Cell><Cell><Button aria-label={`Remove battery system ${index + 1}`} disabled={systems.length <= 1} onClick={() => onSystems(systems.filter((_, current) => current !== index))} type="button" variant="ghost">Remove</Button></Cell></tr>)}</SystemTable>
    <Button disabled={systems.length >= 15} onClick={() => onSystems([...systems, newBattery(nextId(systems.map((item) => item.id)))])} type="button" variant="outline">Add extra battery system</Button>
  </Drawer>;
}

function PvDrawer({ assumptions, onAssumptions, onClose, onSystems, systems }: { assumptions: { annualYield: string; derating: string; sharedAcHeadroom: string; reactiveSupportEnabled: boolean; reactiveSupportMaxKvar: string; apparentPowerLimitKva: string }; onAssumptions: (value: typeof assumptions) => void; onClose: () => void; onSystems: (value: PvSystem[]) => void; systems: PvSystem[] }) {
  const [range, setRange] = useState({ start: "", end: "", step: "", dcAcRatio: "" });
  const generate = () => {
    const values = numberRange(range.start, range.end, range.step, 20);
    const ratio = Number(range.dcAcRatio);
    if (!values || !positive(ratio)) return;
    onSystems(values.map((capacity, index) => ({ id: `pv-${String(index + 1).padStart(3, "0")}`, label: capacity === 0 ? "No solar PV" : `${compact(capacity)} kWp / ${compact(capacity / ratio)} kW AC`, capacity: String(capacity), inverter: String(Number((capacity / ratio).toFixed(6))) })));
  };
  return <Drawer heading="Solar PV" count={`${systems.length} / 20 systems`} onClose={onClose}>
    <Section title="Solar profile" description="The selected deterministic shape is scaled to the expert-authored annual specific yield."><SelectField label="Solar profile" value="generic_normalized_solar_shape_v1"><option value="generic_normalized_solar_shape_v1">Generic normalized solar shape</option></SelectField></Section>
    <RangeGrid><Field label="Start PV capacity (kWp DC)" numeric value={range.start} onChange={(value) => setRange({ ...range, start: value })} /><Field label="End PV capacity (kWp DC)" numeric value={range.end} onChange={(value) => setRange({ ...range, end: value })} /><Field label="PV capacity step (kWp)" numeric value={range.step} onChange={(value) => setRange({ ...range, step: value })} /><Field label="DC/AC ratio" numeric value={range.dcAcRatio} onChange={(value) => setRange({ ...range, dcAcRatio: value })} /><Button disabled={!numberRange(range.start, range.end, range.step, 20) || !positive(range.dcAcRatio)} onClick={generate} type="button" variant="outline">Generate PV systems</Button></RangeGrid>
    <Section title="Shared PV and hybrid-inverter assumptions" description="Editable analyst assumptions applied to every solution; they are not inferred site or product facts."><div className="grid gap-3 sm:grid-cols-3"><Field label="Annual specific yield (kWh/kWp)" numeric value={assumptions.annualYield} onChange={(value) => onAssumptions({ ...assumptions, annualYield: value })} /><Field label="PV derating (%)" numeric value={assumptions.derating} onChange={(value) => onAssumptions({ ...assumptions, derating: value })} /><Field label="Shared bidirectional AC headroom (kW)" numeric value={assumptions.sharedAcHeadroom} onChange={(value) => onAssumptions({ ...assumptions, sharedAcHeadroom: value })} /></div><label className="mt-4 flex items-center gap-2 text-sm"><input checked={assumptions.reactiveSupportEnabled} onChange={(event) => onAssumptions({ ...assumptions, reactiveSupportEnabled: event.target.checked })} type="checkbox" />Model reactive support</label>{assumptions.reactiveSupportEnabled ? <div className="mt-4 rounded-md border border-border bg-muted/20 p-4"><p className="text-xs text-muted-foreground">Internal analyst assumptions only. Enter an explicit kvar cap and shared inverter kVA limit; these are not Fox equipment facts or guarantees. Overcompensation and reactive export remain unavailable.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Maximum reactive support (kvar)" numeric value={assumptions.reactiveSupportMaxKvar} onChange={(value) => onAssumptions({ ...assumptions, reactiveSupportMaxKvar: value })} /><Field label="Shared inverter apparent-power limit (kVA)" numeric value={assumptions.apparentPowerLimitKva} onChange={(value) => onAssumptions({ ...assumptions, apparentPowerLimitKva: value })} /></div></div> : null}</Section>
    <SystemTable headers={["PV system", "Capacity (kWp DC)", "Inverter (kW AC)", "DC/AC ratio", ""]}>{systems.map((system, index) => <tr className="border-t border-border" key={system.id}><Cell><Field hideLabel label={`PV system ${index + 1} name`} value={system.label} onChange={(value) => onSystems(patchRow(systems, index, { label: value }))} /></Cell><Cell><Field hideLabel label={`PV system ${index + 1} capacity (kWp DC)`} numeric value={system.capacity} onChange={(value) => onSystems(patchRow(systems, index, { capacity: value }))} /></Cell><Cell><Field hideLabel label={`PV system ${index + 1} inverter (kW AC)`} numeric value={system.inverter} onChange={(value) => onSystems(patchRow(systems, index, { inverter: value }))} /></Cell><Cell>{isZeroSizePair(system.capacity, system.inverter) ? "Not installed" : positive(system.capacity) && positive(system.inverter) ? compact(Number(system.capacity) / Number(system.inverter)) : "—"}</Cell><Cell><Button aria-label={`Remove PV system ${index + 1}`} disabled={systems.length <= 1} onClick={() => onSystems(systems.filter((_, current) => current !== index))} type="button" variant="ghost">Remove</Button></Cell></tr>)}</SystemTable>
    <Button disabled={systems.length >= 20} onClick={() => onSystems([...systems, newPv(nextId(systems.map((item) => item.id)))])} type="button" variant="outline">Add extra PV system</Button>
  </Drawer>;
}

function buildSolutions(batteries: BatterySystem[], pvSystems: PvSystem[], battery: { chargeEfficiency: string; dischargeEfficiency: string; minSoc: string; maxSoc: string; initialSoc: string; allowGridCharging: boolean }, pv: { annualYield: string; derating: string; sharedAcHeadroom: string; reactiveSupportEnabled: boolean; reactiveSupportMaxKvar: string; apparentPowerLimitKva: string }): CiScenarioInput[] | null {
  if (!batteries.length || batteries.length > 15 || !pvSystems.length || pvSystems.length > 20 || batteries.length * pvSystems.length > 200) return null;
  const chargeEfficiency = Number(battery.chargeEfficiency) / 100; const dischargeEfficiency = Number(battery.dischargeEfficiency) / 100; const minSoc = Number(battery.minSoc) / 100; const maxSoc = Number(battery.maxSoc) / 100; const initialSoc = Number(battery.initialSoc) / 100; const annualYield = Number(pv.annualYield); const derating = Number(pv.derating) / 100; const sharedAcHeadroom = Number(pv.sharedAcHeadroom);
  if (![chargeEfficiency, dischargeEfficiency, annualYield, derating, sharedAcHeadroom].every((value) => positive(value)) || chargeEfficiency > 1 || dischargeEfficiency > 1 || derating > 1 || minSoc !== 0.1 || maxSoc !== 1 || initialSoc !== 1) return null;
  if (pv.reactiveSupportEnabled && (!positive(pv.reactiveSupportMaxKvar) || !positive(pv.apparentPowerLimitKva))) return null;
  if (batteries.some((item) => !item.label.trim() || !validSizePair(item.capacity, item.power)) || pvSystems.some((item) => !item.label.trim() || !validSizePair(item.capacity, item.inverter))) return null;
  return pvSystems.flatMap((pvSystem) => batteries.map((batterySystem) => ({ scenario_id: `${pvSystem.id}__${batterySystem.id}`, label: `${pvSystem.label} + ${batterySystem.label}`, battery_system_id: batterySystem.id, battery_technology_id: "generic_li_ion_ac", control_profile_id: "demand_peak_shaving", pv_system_id: pvSystem.id, pv_profile_id: "generic_normalized_solar_shape_v1", pv_capacity_kwp_dc: Number(pvSystem.capacity), pv_inverter_capacity_kw_ac: Number(pvSystem.inverter), shared_ac_headroom_kw: sharedAcHeadroom, reactive_support_enabled: pv.reactiveSupportEnabled, reactive_support_max_kvar: pv.reactiveSupportEnabled ? Number(pv.reactiveSupportMaxKvar) : 0, shared_inverter_apparent_power_limit_kva: pv.reactiveSupportEnabled ? Number(pv.apparentPowerLimitKva) : null, reactive_capability_curve: "circular_pq", reactive_capability_provenance: "analyst_assumption", reactive_overcompensation_permitted: false, pv_annual_specific_yield_kwh_per_kw: annualYield, pv_derating_factor: derating, nominal_capacity_kwh: Number(batterySystem.capacity), max_charge_kw: Number(batterySystem.power), max_discharge_kw: Number(batterySystem.power), charge_efficiency: chargeEfficiency, discharge_efficiency: dischargeEfficiency, min_soc_fraction: minSoc, max_soc_fraction: maxSoc, initial_soc_fraction: initialSoc, allow_grid_charging: battery.allowGridCharging })));
}

function restoreDesign(solutions?: CiScenarioInput[]) {
  if (!solutions?.length) return null;
  const first = solutions[0];
  const batteries = Array.from(new Map(solutions.map((item) => [item.battery_system_id, item])).values()).map((item) => ({
    id: item.battery_system_id,
    label: item.nominal_capacity_kwh === 0 ? "No battery" : `${compact(item.nominal_capacity_kwh)} kWh / ${compact(item.max_discharge_kw)} kW`,
    capacity: String(item.nominal_capacity_kwh),
    power: String(item.max_discharge_kw),
  }));
  const pvSystems = Array.from(new Map(solutions.map((item) => [item.pv_system_id, item])).values()).map((item) => ({
    id: item.pv_system_id,
    label: item.pv_capacity_kwp_dc === 0 ? "No solar PV" : `${compact(item.pv_capacity_kwp_dc)} kWp / ${compact(item.pv_inverter_capacity_kw_ac)} kW AC`,
    capacity: String(item.pv_capacity_kwp_dc),
    inverter: String(item.pv_inverter_capacity_kw_ac),
  }));
  return {
    batteries,
    pvSystems,
    batteryAssumptions: {
      chargeEfficiency: percentage(first.charge_efficiency),
      dischargeEfficiency: percentage(first.discharge_efficiency),
      minSoc: percentage(first.min_soc_fraction),
      maxSoc: percentage(first.max_soc_fraction),
      initialSoc: percentage(first.initial_soc_fraction),
      allowGridCharging: first.allow_grid_charging,
    },
    pvAssumptions: {
      annualYield: String(first.pv_annual_specific_yield_kwh_per_kw),
      derating: percentage(first.pv_derating_factor),
      sharedAcHeadroom: String(first.shared_ac_headroom_kw),
      reactiveSupportEnabled: first.reactive_support_enabled,
      reactiveSupportMaxKvar: first.reactive_support_enabled ? String(first.reactive_support_max_kvar) : "",
      apparentPowerLimitKva: first.shared_inverter_apparent_power_limit_kva === null ? "" : String(first.shared_inverter_apparent_power_limit_kva),
    },
  };
}

function Drawer({ children, count, heading, onClose }: { children: ReactNode; count: string; heading: string; onClose: () => void }) { return <div aria-label={`${heading} system editor`} aria-modal="true" className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog"><div className="h-full w-full max-w-5xl overflow-y-auto bg-background shadow-2xl"><div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background p-5"><div><h3 className="text-xl font-semibold">{heading}</h3><p className="text-xs text-muted-foreground">{count}</p></div><Button aria-label={`Apply and close ${heading} editor`} onClick={onClose} type="button">Apply &amp; close</Button></div><div className="space-y-4 p-5">{children}</div></div></div>; }
function Section({ children, description, title }: { children: ReactNode; description: string; title: string }) { return <section className="rounded-lg border border-border p-4"><h4 className="font-semibold">{title}</h4><p className="mt-1 text-xs text-muted-foreground">{description}</p><div className="mt-4">{children}</div></section>; }
function RangeGrid({ children }: { children: ReactNode }) { return <section className="grid items-end gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-5">{children}</section>; }
function SystemTable({ children, headers }: { children: ReactNode; headers: string[] }) { return <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-800 text-white"><tr>{headers.map((header) => <th className="px-3 py-3" key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Cell({ children }: { children: ReactNode }) { return <td className="px-3 py-2">{children}</td>; }
function Field({ disabled = false, hideLabel = false, label, numeric = false, onChange, value }: { disabled?: boolean; hideLabel?: boolean; label: string; numeric?: boolean; onChange: (value: string) => void; value: string }) { return <label className="grid gap-1 text-sm"><span className={hideLabel ? "sr-only" : "font-medium"}>{label}</span><input aria-label={label} className="rounded-md border border-border bg-background px-3 py-2 disabled:cursor-not-allowed disabled:bg-muted" disabled={disabled} min={numeric ? 0 : undefined} onChange={(event) => onChange(event.target.value)} step={numeric ? "any" : undefined} type={numeric ? "number" : "text"} value={value} /></label>; }
function SelectField({ children, label, value }: { children: ReactNode; label: string; value: string }) { return <label className="grid max-w-md gap-1 text-sm"><span className="font-medium">{label}</span><select className="rounded-md border border-border bg-background px-3 py-2" onChange={() => undefined} value={value}>{children}</select></label>; }
function patchRow<T>(items: T[], index: number, patch: Partial<T>) { return items.map((item, current) => current === index ? { ...item, ...patch } : item); }
function positive(value: string | number) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0; }
function nonNegative(value: string | number) { if (typeof value === "string" && !value.trim()) return false; const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0; }
function validSizePair(size: string | number, power: string | number) { return nonNegative(size) && nonNegative(power) && (Number(size) === 0) === (Number(power) === 0); }
function isZeroSizePair(size: string | number, power: string | number) { return validSizePair(size, power) && Number(size) === 0; }
function numberRange(startText: string, endText: string, stepText: string, limit: number): number[] | null { const start = Number(startText); const end = Number(endText); const step = Number(stepText); if (!nonNegative(start) || !nonNegative(end) || !positive(step) || end < start) return null; const count = Math.floor((end - start) / step + 1e-9) + 1; if (count < 1 || count > limit) return null; return Array.from({ length: count }, (_, index) => Number((start + step * index).toFixed(6))); }
function nextId(ids: string[]) { return Math.max(0, ...ids.map((id) => Number(id.match(/-(\d+)$/)?.[1] ?? 0))) + 1; }
function compact(value: number) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 3 }).format(value); }
function percentage(value: number) { return String(Number((value * 100).toFixed(10))); }
function rangeLabel(values: number[]) { return values.length === 1 ? compact(values[0]) : `${compact(Math.min(...values))}–${compact(Math.max(...values))}`; }

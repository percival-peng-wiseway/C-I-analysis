import { useMemo, useState, type ReactNode } from "react";
import { BatteryCharging, Cpu, Play, Settings2, SunMedium } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CiDesignContext, CiExistingBatteryAsset, CiExistingSolarAsset, CiTechnicalOptions } from "@/features/ci/api/ci-projects";
import type { CiScenarioInput } from "@/features/ci/api/ci-scenarios";

type NumericRange = { start: string; end: string; step: string };
type ExistingSolarForm = Omit<CiExistingSolarAsset, "panel_count" | "panel_rating_w" | "installed_capacity_kwp_dc" | "inverter_capacity_kw_ac" | "installation_year"> & {
  panel_count: string; panel_rating_w: string; installed_capacity_kwp_dc: string; inverter_capacity_kw_ac: string; installation_year: string;
};
type ExistingBatteryForm = Omit<CiExistingBatteryAsset, "nominal_capacity_kwh" | "usable_capacity_kwh" | "power_kw" | "installation_year"> & {
  nominal_capacity_kwh: string; usable_capacity_kwh: string; power_kw: string; installation_year: string;
};
type TechnicalOptionsForm = {
  annual_specific_yield_kwh_per_kw: string; shading_loss_percent: string; soiling_loss_percent: string; temperature_loss_percent: string;
  wiring_mismatch_loss_percent: string; other_system_loss_percent: string; system_availability_percent: string; target_dc_ac_ratio: string;
  inverter_block_size_kw: string; site_ac_headroom_kw: string; battery_duration_hours: string; charge_efficiency_percent: string;
  discharge_efficiency_percent: string; minimum_soc_percent: string; maximum_soc_percent: string; allow_grid_charging: boolean;
  reactive_support_enabled: boolean; reactive_support_max_kvar: string; grid_emissions_factor_kg_co2e_per_kwh: string;
};

const emptyRange = (): NumericRange => ({ start: "", end: "", step: "" });
const emptySolar = (): ExistingSolarForm => ({ installed: false, brand: "", model: "", panel_count: "", panel_rating_w: "", installed_capacity_kwp_dc: "", inverter_brand: "", inverter_model: "", inverter_capacity_kw_ac: "", installation_year: "", operating_status: "unknown", included_in_interval_baseline: false });
const emptyBattery = (): ExistingBatteryForm => ({ installed: false, brand: "", model: "", nominal_capacity_kwh: "", usable_capacity_kwh: "", power_kw: "", installation_year: "", operating_status: "unknown", included_in_interval_baseline: false });
const defaultTechnicalOptions = (): TechnicalOptionsForm => ({
  annual_specific_yield_kwh_per_kw: "1500", shading_loss_percent: "3", soiling_loss_percent: "2", temperature_loss_percent: "5",
  wiring_mismatch_loss_percent: "2", other_system_loss_percent: "0", system_availability_percent: "99", target_dc_ac_ratio: "1.15",
  inverter_block_size_kw: "5", site_ac_headroom_kw: "250", battery_duration_hours: "2", charge_efficiency_percent: "94.86832981",
  discharge_efficiency_percent: "94.86832981", minimum_soc_percent: "10", maximum_soc_percent: "100", allow_grid_charging: false,
  reactive_support_enabled: false, reactive_support_max_kvar: "",
  grid_emissions_factor_kg_co2e_per_kwh: "0.79",
});

export function CiScenarioBuilder({ error, initialContext, initialSolutions, isPending, onSubmit }: {
  error: string | null; initialContext?: CiDesignContext; initialSolutions?: CiScenarioInput[]; isPending: boolean;
  onSubmit: (solutions: CiScenarioInput[], designContext: CiDesignContext) => void;
}) {
  const restored = restoreSearchSpace(initialSolutions, initialContext);
  const [existingSolar, setExistingSolar] = useState(restored.existingSolar);
  const [existingBattery, setExistingBattery] = useState(restored.existingBattery);
  const [pvRange, setPvRange] = useState(restored.pvRange);
  const [batteryRange, setBatteryRange] = useState(restored.batteryRange);
  const [technical, setTechnical] = useState(restored.technical);
  const pvValues = rangeValues(pvRange, 20);
  const batteryValues = rangeValues(batteryRange, 15);
  const solutionCount = (pvValues?.length ?? 0) * (batteryValues?.length ?? 0);
  const designContext = useMemo(() => buildDesignContext(existingSolar, existingBattery, technical), [existingSolar, existingBattery, technical]);
  const solutions = useMemo(() => buildSolutions(pvValues, batteryValues, designContext), [pvValues?.join(","), batteryValues?.join(","), designContext]);
  const status = searchSpaceStatus(pvValues, batteryValues, solutionCount, designContext);
  const hybridInverterRange = designContext && pvValues?.length && batteryValues?.length
    ? pvValues.flatMap((pvCapacity) => batteryValues.map((batteryCapacity) => autoHybridInverterCapacity(pvCapacity, batteryCapacity, designContext.technical_options)))
    : [];
  const effectiveYield = designContext ? designContext.technical_options.annual_specific_yield_kwh_per_kw * Number(designContext.technical_options.effective_derating_percent ?? 0) / 100 : null;

  return (
    <section aria-labelledby="search-space-title" className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-slate-950" id="search-space-title">Build the system search space</h2>
        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium tabular-nums text-slate-700">{status}</span>
      </div>

      <form className="mt-6 space-y-7" onSubmit={(event) => { event.preventDefault(); if (solutions && designContext) onSubmit(solutions, designContext); }}>
        <WorkflowSection description="Equipment already onsite." step="01" title="Existing site assets">
          <div className="grid gap-4 xl:grid-cols-2"><ExistingSolarCard onChange={setExistingSolar} value={existingSolar} /><ExistingBatteryCard onChange={setExistingBattery} value={existingBattery} /></div>
        </WorkflowSection>

        <WorkflowSection description="PV and battery ranges; inverter sizing is automatic." step="02" title="New capacity ranges">
          <div className="grid gap-4 lg:grid-cols-3">
            <RangeCard icon={SunMedium} onChange={setPvRange} range={pvRange} title="Added PV" unit="kWp DC" />
            <RangeCard icon={BatteryCharging} onChange={setBatteryRange} range={batteryRange} title="Added battery" unit="kWh" />
            <section aria-label="Automatic hybrid inverter sizing" className="rounded-xl border border-cyan-100 bg-cyan-50/50 p-4">
              <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-lg bg-white text-cyan-800 shadow-sm"><Cpu className="size-4" /></span><div><h3 className="font-semibold text-slate-950">Hybrid inverter / PCS</h3><p className="text-xs text-slate-500">Shared AC capacity · auto-sized</p></div></div>
              <div className="mt-5 rounded-lg bg-white p-3"><p className="text-xs font-medium text-slate-500">System rating</p><strong className="mt-1 block text-base tabular-nums text-slate-950">{hybridInverterRange.length ? `${compact(Math.min(...hybridInverterRange))}–${compact(Math.max(...hybridInverterRange))} kW AC` : "Set PV and battery"}</strong><p className="mt-1 text-[11px] leading-4 text-slate-500">One shared unit for solar conversion and battery charge/discharge.</p></div>
            </section>
          </div>
        </WorkflowSection>

        <WorkflowSection step="03" title="Technical options">
          <details className="group rounded-xl border border-slate-200 bg-slate-50/60" open>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800"><span className="flex items-center gap-2"><Settings2 className="size-4 text-cyan-700" />Technical options</span><span className="text-xs font-normal text-slate-500">Effective yield {effectiveYield === null ? "—" : `${compact(effectiveYield)} kWh/kWp`}</span></summary>
            <div className="grid gap-5 border-t border-slate-200 p-4 xl:grid-cols-2">
              <OptionGroup title="Solar production">
                <CompactField label="Annual specific yield (kWh/kWp)" onChange={(value) => setTechnical({ ...technical, annual_specific_yield_kwh_per_kw: value })} value={technical.annual_specific_yield_kwh_per_kw} />
                <CompactField label="Shading loss (%)" onChange={(value) => setTechnical({ ...technical, shading_loss_percent: value })} value={technical.shading_loss_percent} />
                <CompactField label="Soiling loss (%)" onChange={(value) => setTechnical({ ...technical, soiling_loss_percent: value })} value={technical.soiling_loss_percent} />
                <CompactField label="Temperature loss (%)" onChange={(value) => setTechnical({ ...technical, temperature_loss_percent: value })} value={technical.temperature_loss_percent} />
                <CompactField label="Wiring & mismatch loss (%)" onChange={(value) => setTechnical({ ...technical, wiring_mismatch_loss_percent: value })} value={technical.wiring_mismatch_loss_percent} />
                <CompactField label="Other system loss (%)" onChange={(value) => setTechnical({ ...technical, other_system_loss_percent: value })} value={technical.other_system_loss_percent} />
                <CompactField label="System availability (%)" onChange={(value) => setTechnical({ ...technical, system_availability_percent: value })} value={technical.system_availability_percent} />
              </OptionGroup>
              <OptionGroup title="Hybrid inverter & site limit">
                <CompactField label="Target DC/AC ratio" onChange={(value) => setTechnical({ ...technical, target_dc_ac_ratio: value })} value={technical.target_dc_ac_ratio} />
                <CompactField label="Hybrid inverter block size (kW)" onChange={(value) => setTechnical({ ...technical, inverter_block_size_kw: value })} value={technical.inverter_block_size_kw} />
                <CompactField label="Site AC headroom (kW)" onChange={(value) => setTechnical({ ...technical, site_ac_headroom_kw: value })} value={technical.site_ac_headroom_kw} />
                <label className="col-span-full flex items-center gap-2 text-xs font-medium text-slate-700"><input checked={technical.reactive_support_enabled} onChange={(event) => setTechnical({ ...technical, reactive_support_enabled: event.target.checked })} type="checkbox" />Model inverter reactive support</label>
                {technical.reactive_support_enabled ? <CompactField label="Reactive support cap (kvar)" onChange={(value) => setTechnical({ ...technical, reactive_support_max_kvar: value })} value={technical.reactive_support_max_kvar} /> : null}
              </OptionGroup>
              <OptionGroup title="Battery output">
                <CompactField label="Battery duration (h)" onChange={(value) => setTechnical({ ...technical, battery_duration_hours: value })} value={technical.battery_duration_hours} />
                <CompactField label="Charge efficiency (%)" onChange={(value) => setTechnical({ ...technical, charge_efficiency_percent: value })} value={technical.charge_efficiency_percent} />
                <CompactField label="Discharge efficiency (%)" onChange={(value) => setTechnical({ ...technical, discharge_efficiency_percent: value })} value={technical.discharge_efficiency_percent} />
                <CompactField label="Minimum SOC (%)" onChange={(value) => setTechnical({ ...technical, minimum_soc_percent: value })} value={technical.minimum_soc_percent} />
                <CompactField label="Maximum SOC (%)" onChange={(value) => setTechnical({ ...technical, maximum_soc_percent: value })} value={technical.maximum_soc_percent} />
                <label className="col-span-full flex items-center gap-2 text-xs font-medium text-slate-700"><input checked={technical.allow_grid_charging} onChange={(event) => setTechnical({ ...technical, allow_grid_charging: event.target.checked })} type="checkbox" />Allow grid charging</label>
              </OptionGroup>
              <OptionGroup title="Environmental accounting">
                <CompactField label="Grid emissions factor (kg CO2-e/kWh)" onChange={(value) => setTechnical({ ...technical, grid_emissions_factor_kg_co2e_per_kwh: value })} value={technical.grid_emissions_factor_kg_co2e_per_kwh} />
                <p className="col-span-full text-xs leading-5 text-slate-500">Used only for an operational Scope 2 estimate. Update it to the approved factor for the project and reporting period.</p>
              </OptionGroup>
            </div>
          </details>
        </WorkflowSection>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-center gap-3"><Button className="min-w-44" disabled={!solutions || !designContext || isPending} type="submit">{isPending ? `Generating ${solutionCount} solutions…` : `Generate ${solutionCount || ""} solutions`}<Play className="size-4" /></Button>{error ? <p className="text-sm text-destructive">{error}</p> : null}</div>
        </div>
      </form>
    </section>
  );
}

function WorkflowSection({ children, description, step, title }: { children: ReactNode; description?: string; step: string; title: string }) { return <section><div className="mb-3 flex gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-950 text-xs font-semibold text-white">{step}</span><div><h3 className="font-semibold text-slate-950">{title}</h3>{description ? <p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p> : null}</div></div>{children}</section>; }

function ExistingSolarCard({ onChange, value }: { onChange: (value: ExistingSolarForm) => void; value: ExistingSolarForm }) {
  return <AssetCard icon={SunMedium} installed={value.installed} onInstalledChange={(installed) => onChange(installed ? { ...value, installed, operating_status: "operational" } : emptySolar())} title="Existing solar PV">
    {value.installed ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <TextField label="Panel brand" onChange={(brand) => onChange({ ...value, brand })} value={value.brand} /><TextField label="Panel model" onChange={(model) => onChange({ ...value, model })} value={value.model} />
      <CompactField label="Installed capacity (kWp DC)" onChange={(installed_capacity_kwp_dc) => onChange({ ...value, installed_capacity_kwp_dc })} value={value.installed_capacity_kwp_dc} /><CompactField label="Panel quantity" onChange={(panel_count) => onChange({ ...value, panel_count })} value={value.panel_count} /><CompactField label="Panel rating (W)" onChange={(panel_rating_w) => onChange({ ...value, panel_rating_w })} value={value.panel_rating_w} />
      <CompactField label="Existing inverter (kW AC)" onChange={(inverter_capacity_kw_ac) => onChange({ ...value, inverter_capacity_kw_ac })} value={value.inverter_capacity_kw_ac} /><TextField label="Inverter brand" onChange={(inverter_brand) => onChange({ ...value, inverter_brand })} value={value.inverter_brand} /><TextField label="Inverter model" onChange={(inverter_model) => onChange({ ...value, inverter_model })} value={value.inverter_model} />
      <CompactField label="Installation year" onChange={(installation_year) => onChange({ ...value, installation_year })} value={value.installation_year} /><StatusField onChange={(operating_status) => onChange({ ...value, operating_status })} value={value.operating_status} /><BaselineField checked={value.included_in_interval_baseline} onChange={(included_in_interval_baseline) => onChange({ ...value, included_in_interval_baseline })} />
    </div> : <EmptyAssetText />}
  </AssetCard>;
}

function ExistingBatteryCard({ onChange, value }: { onChange: (value: ExistingBatteryForm) => void; value: ExistingBatteryForm }) {
  return <AssetCard icon={BatteryCharging} installed={value.installed} onInstalledChange={(installed) => onChange(installed ? { ...value, installed, operating_status: "operational" } : emptyBattery())} title="Existing battery">
    {value.installed ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <TextField label="Battery brand" onChange={(brand) => onChange({ ...value, brand })} value={value.brand} /><TextField label="Battery model" onChange={(model) => onChange({ ...value, model })} value={value.model} />
      <CompactField label="Nominal capacity (kWh)" onChange={(nominal_capacity_kwh) => onChange({ ...value, nominal_capacity_kwh })} value={value.nominal_capacity_kwh} /><CompactField label="Usable capacity (kWh)" onChange={(usable_capacity_kwh) => onChange({ ...value, usable_capacity_kwh })} value={value.usable_capacity_kwh} /><CompactField label="Charge/discharge power (kW)" onChange={(power_kw) => onChange({ ...value, power_kw })} value={value.power_kw} />
      <CompactField label="Battery installation year" onChange={(installation_year) => onChange({ ...value, installation_year })} value={value.installation_year} /><StatusField onChange={(operating_status) => onChange({ ...value, operating_status })} value={value.operating_status} /><BaselineField checked={value.included_in_interval_baseline} onChange={(included_in_interval_baseline) => onChange({ ...value, included_in_interval_baseline })} />
    </div> : <EmptyAssetText />}
  </AssetCard>;
}

function AssetCard({ children, icon: Icon, installed, onInstalledChange, title }: { children: ReactNode; icon: typeof SunMedium; installed: boolean; onInstalledChange: (installed: boolean) => void; title: string }) { return <section aria-label={title} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-lg bg-white text-cyan-800 shadow-sm"><Icon className="size-4" /></span><h4 className="font-semibold text-slate-950">{title}</h4></div><label className="flex items-center gap-2 text-xs font-medium text-slate-700"><input aria-label={`${title} already installed`} checked={installed} onChange={(event) => onInstalledChange(event.target.checked)} type="checkbox" />Already installed</label></div><div className="mt-4">{children}</div></section>; }
function EmptyAssetText() { return <p className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-5 text-center text-xs text-slate-500">No existing equipment recorded.</p>; }
function RangeCard({ icon: Icon, onChange, range, title, unit }: { icon: typeof SunMedium; onChange: (range: NumericRange) => void; range: NumericRange; title: string; unit: string }) { return <section aria-label={`${title} search range`} className="rounded-xl bg-slate-50 p-4"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-lg bg-white text-cyan-800 shadow-sm"><Icon className="size-4" /></span><div><h3 className="font-semibold text-slate-950">{title}</h3><p className="text-xs text-slate-500">{unit}</p></div></div><div className="mt-4 grid grid-cols-3 gap-2"><CompactField label="Min" onChange={(start) => onChange({ ...range, start })} value={range.start} /><CompactField label="Max" onChange={(end) => onChange({ ...range, end })} value={range.end} /><CompactField label="Step" onChange={(step) => onChange({ ...range, step })} value={range.step} /></div></section>; }
function OptionGroup({ children, title }: { children: ReactNode; title: string }) { return <section className="rounded-lg bg-white p-4"><h4 className="mb-3 text-sm font-semibold text-slate-900">{title}</h4><div className="grid gap-3 sm:grid-cols-2">{children}</div></section>; }
function CompactField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) { return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><input aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm tabular-nums text-slate-950" min="0" onChange={(event) => onChange(event.target.value)} step="any" type="number" value={value} /></label>; }
function TextField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) { return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><input aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950" maxLength={120} onChange={(event) => onChange(event.target.value)} type="text" value={value} /></label>; }
function StatusField({ onChange, value }: { onChange: (value: CiExistingSolarAsset["operating_status"]) => void; value: CiExistingSolarAsset["operating_status"] }) { return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>Operating status</span><select aria-label="Operating status" className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" onChange={(event) => onChange(event.target.value as CiExistingSolarAsset["operating_status"])} value={value}><option value="operational">Operational</option><option value="limited">Limited</option><option value="offline">Offline</option><option value="unknown">Unknown</option></select></label>; }
function BaselineField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) { return <label className="flex items-center gap-2 self-end rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700"><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />Included in NEM12 baseline</label>; }

function buildSolutions(pvValues: number[] | null, batteryValues: number[] | null, context: CiDesignContext | null): CiScenarioInput[] | null {
  if (!pvValues || !batteryValues || !context || pvValues.length * batteryValues.length > 200) return null;
  const options = context.technical_options; const derating = Number(options.effective_derating_percent) / 100;
  if (!positive(derating)) return null;
  return pvValues.flatMap((pvCapacity, pvIndex) => batteryValues.map((batteryCapacity, batteryIndex) => {
    const inverterCapacity = autoHybridInverterCapacity(pvCapacity, batteryCapacity, options); const batteryPower = Math.min(inverterCapacity, batteryCapacity === 0 ? 0 : batteryCapacity / options.battery_duration_hours);
    const pvId = `pv-${String(pvIndex + 1).padStart(3, "0")}`; const batteryId = `battery-${String(batteryIndex + 1).padStart(3, "0")}`;
    const apparentLimit = options.reactive_support_enabled ? Math.sqrt(inverterCapacity ** 2 + options.reactive_support_max_kvar ** 2) : null;
    return { scenario_id: `${pvId}__${batteryId}`, label: `${compact(pvCapacity)} kWp PV + ${compact(batteryCapacity)} kWh battery / ${compact(inverterCapacity)} kW hybrid inverter`, battery_system_id: batteryId, battery_technology_id: "generic_li_ion_ac", control_profile_id: "demand_peak_shaving", pv_system_id: pvId, pv_profile_id: "generic_normalized_solar_shape_v1", pv_capacity_kwp_dc: pvCapacity, pv_inverter_capacity_kw_ac: inverterCapacity, shared_ac_headroom_kw: inverterCapacity, reactive_support_enabled: options.reactive_support_enabled, reactive_support_max_kvar: options.reactive_support_enabled ? options.reactive_support_max_kvar : 0, shared_inverter_apparent_power_limit_kva: apparentLimit, reactive_capability_curve: "circular_pq", reactive_capability_provenance: "analyst_assumption", reactive_overcompensation_permitted: false, pv_annual_specific_yield_kwh_per_kw: options.annual_specific_yield_kwh_per_kw, pv_derating_factor: derating, nominal_capacity_kwh: batteryCapacity, max_charge_kw: batteryPower, max_discharge_kw: batteryPower, charge_efficiency: options.charge_efficiency_percent / 100, discharge_efficiency: options.discharge_efficiency_percent / 100, min_soc_fraction: options.minimum_soc_percent / 100, max_soc_fraction: options.maximum_soc_percent / 100, initial_soc_fraction: options.maximum_soc_percent / 100, allow_grid_charging: options.allow_grid_charging, grid_emissions_factor_kg_co2e_per_kwh: options.grid_emissions_factor_kg_co2e_per_kwh ?? 0.79 };
  }));
}

function buildDesignContext(solar: ExistingSolarForm, battery: ExistingBatteryForm, technical: TechnicalOptionsForm): CiDesignContext | null {
  const annualYield = numberText(technical.annual_specific_yield_kwh_per_kw); const shading = numberText(technical.shading_loss_percent); const soiling = numberText(technical.soiling_loss_percent); const temperature = numberText(technical.temperature_loss_percent); const wiring = numberText(technical.wiring_mismatch_loss_percent); const other = numberText(technical.other_system_loss_percent); const availability = numberText(technical.system_availability_percent); const ratio = numberText(technical.target_dc_ac_ratio); const block = numberText(technical.inverter_block_size_kw); const headroom = numberText(technical.site_ac_headroom_kw); const duration = numberText(technical.battery_duration_hours); const charge = numberText(technical.charge_efficiency_percent); const discharge = numberText(technical.discharge_efficiency_percent); const minSoc = numberText(technical.minimum_soc_percent); const maxSoc = numberText(technical.maximum_soc_percent); const reactiveCap = technical.reactive_support_enabled ? numberText(technical.reactive_support_max_kvar) : 0; const emissionsFactor = numberText(technical.grid_emissions_factor_kg_co2e_per_kwh);
  const values = [annualYield, shading, soiling, temperature, wiring, other, availability, ratio, block, headroom, duration, charge, discharge, minSoc, maxSoc, reactiveCap, emissionsFactor];
  const effectiveDerating = availability / 100 * [shading, soiling, temperature, wiring, other].reduce((factor, loss) => factor * (1 - loss / 100), 1);
  if (!values.every(Number.isFinite) || !positive(annualYield) || [shading, soiling, temperature, wiring, other].some((value) => value < 0 || value >= 100) || !positive(availability) || availability > 100 || ratio < 0.8 || ratio > 2 || !positive(block) || !positive(headroom) || !positive(duration) || !positive(charge) || charge > 100 || !positive(discharge) || discharge > 100 || minSoc < 0 || maxSoc > 100 || minSoc >= maxSoc || effectiveDerating <= 0 || emissionsFactor < 0 || emissionsFactor > 5 || (technical.reactive_support_enabled && !positive(reactiveCap))) return null;
  const existingSolar = solarAsset(solar); const existingBattery = batteryAsset(battery); if (!existingSolar || !existingBattery) return null;
  return { contract_version: "ci_design_context_v1", existing_solar: existingSolar, existing_battery: existingBattery, technical_options: { annual_specific_yield_kwh_per_kw: annualYield, shading_loss_percent: shading, soiling_loss_percent: soiling, temperature_loss_percent: temperature, wiring_mismatch_loss_percent: wiring, other_system_loss_percent: other, system_availability_percent: availability, effective_derating_percent: Number((effectiveDerating * 100).toFixed(8)), target_dc_ac_ratio: ratio, inverter_block_size_kw: block, site_ac_headroom_kw: headroom, battery_duration_hours: duration, charge_efficiency_percent: charge, discharge_efficiency_percent: discharge, minimum_soc_percent: minSoc, maximum_soc_percent: maxSoc, allow_grid_charging: technical.allow_grid_charging, reactive_support_enabled: technical.reactive_support_enabled, reactive_support_max_kvar: reactiveCap, grid_emissions_factor_kg_co2e_per_kwh: emissionsFactor } };
}

function solarAsset(value: ExistingSolarForm): CiExistingSolarAsset | null {
  if (!value.installed) return { ...emptySolar(), panel_count: 0, panel_rating_w: 0, installed_capacity_kwp_dc: 0, inverter_capacity_kw_ac: 0, installation_year: null };
  const panelCount = integerText(value.panel_count); const panelRating = numberText(value.panel_rating_w); const capacity = numberText(value.installed_capacity_kwp_dc); const inverter = optionalNumberText(value.inverter_capacity_kw_ac); const year = optionalYear(value.installation_year);
  if (!value.brand.trim() || !value.model.trim() || !panelCount || !positive(panelRating) || !positive(capacity) || inverter === null || year === false) return null;
  return { ...value, brand: value.brand.trim(), model: value.model.trim(), inverter_brand: value.inverter_brand.trim(), inverter_model: value.inverter_model.trim(), panel_count: panelCount, panel_rating_w: panelRating, installed_capacity_kwp_dc: capacity, inverter_capacity_kw_ac: inverter, installation_year: year };
}
function batteryAsset(value: ExistingBatteryForm): CiExistingBatteryAsset | null {
  if (!value.installed) return { ...emptyBattery(), nominal_capacity_kwh: 0, usable_capacity_kwh: 0, power_kw: 0, installation_year: null };
  const nominal = numberText(value.nominal_capacity_kwh); const usable = numberText(value.usable_capacity_kwh); const power = numberText(value.power_kw); const year = optionalYear(value.installation_year);
  if (!value.brand.trim() || !value.model.trim() || !positive(nominal) || !positive(usable) || usable > nominal || !positive(power) || year === false) return null;
  return { ...value, brand: value.brand.trim(), model: value.model.trim(), nominal_capacity_kwh: nominal, usable_capacity_kwh: usable, power_kw: power, installation_year: year };
}

function restoreSearchSpace(solutions?: CiScenarioInput[], context?: CiDesignContext) {
  const first = solutions?.[0]; const pvConfigurations = solutions ? [...new Map(solutions.map((item) => [item.pv_system_id, item])).values()].sort((a, b) => a.pv_capacity_kwp_dc - b.pv_capacity_kwp_dc) : []; const batteries = solutions ? [...new Map(solutions.map((item) => [item.battery_system_id, item])).values()].sort((a, b) => a.nominal_capacity_kwh - b.nominal_capacity_kwh) : []; const duration = batteries.find((item) => item.nominal_capacity_kwh > 0 && item.max_discharge_kw > 0); const options = context?.technical_options; const legacyLoss = first ? Math.max(0, (1 - first.pv_derating_factor) * 100) : 0;
  return { pvRange: pvConfigurations.length ? rangeFromValues(pvConfigurations.map((item) => item.pv_capacity_kwp_dc)) : emptyRange(), batteryRange: batteries.length ? rangeFromValues(batteries.map((item) => item.nominal_capacity_kwh)) : emptyRange(), existingSolar: context ? solarForm(context.existing_solar) : emptySolar(), existingBattery: context ? batteryForm(context.existing_battery) : emptyBattery(), technical: options ? technicalForm(options) : { ...defaultTechnicalOptions(), ...(first ? { annual_specific_yield_kwh_per_kw: String(first.pv_annual_specific_yield_kwh_per_kw), shading_loss_percent: "0", soiling_loss_percent: "0", temperature_loss_percent: "0", wiring_mismatch_loss_percent: "0", other_system_loss_percent: compact(legacyLoss), system_availability_percent: "100", target_dc_ac_ratio: compact(Math.min(2, Math.max(0.8, first.pv_inverter_capacity_kw_ac > 0 ? first.pv_capacity_kwp_dc / first.pv_inverter_capacity_kw_ac : 1.15))), site_ac_headroom_kw: String(first.shared_ac_headroom_kw), battery_duration_hours: duration ? compact(duration.nominal_capacity_kwh / duration.max_discharge_kw) : "2", charge_efficiency_percent: percentage(first.charge_efficiency), discharge_efficiency_percent: percentage(first.discharge_efficiency), minimum_soc_percent: percentage(first.min_soc_fraction), maximum_soc_percent: percentage(first.max_soc_fraction), allow_grid_charging: first.allow_grid_charging, reactive_support_enabled: first.reactive_support_enabled, reactive_support_max_kvar: first.reactive_support_enabled ? String(first.reactive_support_max_kvar) : "" } : {}) } };
}

function autoHybridInverterCapacity(pvCapacity: number, batteryCapacity: number, options: CiTechnicalOptions) {
  const pvPower = pvCapacity / options.target_dc_ac_ratio;
  const batteryPower = batteryCapacity / options.battery_duration_hours;
  const requiredPower = Math.max(pvPower, batteryPower);
  if (requiredPower === 0) return 0;
  return Math.min(options.site_ac_headroom_kw, Math.ceil(requiredPower / options.inverter_block_size_kw) * options.inverter_block_size_kw);
}
function solarForm(value: CiExistingSolarAsset): ExistingSolarForm { return { ...value, panel_count: String(value.panel_count || ""), panel_rating_w: String(value.panel_rating_w || ""), installed_capacity_kwp_dc: String(value.installed_capacity_kwp_dc || ""), inverter_capacity_kw_ac: String(value.inverter_capacity_kw_ac || ""), installation_year: value.installation_year === null ? "" : String(value.installation_year) }; }
function batteryForm(value: CiExistingBatteryAsset): ExistingBatteryForm { return { ...value, nominal_capacity_kwh: String(value.nominal_capacity_kwh || ""), usable_capacity_kwh: String(value.usable_capacity_kwh || ""), power_kw: String(value.power_kw || ""), installation_year: value.installation_year === null ? "" : String(value.installation_year) }; }
function technicalForm(value: CiTechnicalOptions): TechnicalOptionsForm { return { annual_specific_yield_kwh_per_kw: String(value.annual_specific_yield_kwh_per_kw), shading_loss_percent: String(value.shading_loss_percent), soiling_loss_percent: String(value.soiling_loss_percent), temperature_loss_percent: String(value.temperature_loss_percent), wiring_mismatch_loss_percent: String(value.wiring_mismatch_loss_percent), other_system_loss_percent: String(value.other_system_loss_percent), system_availability_percent: String(value.system_availability_percent), target_dc_ac_ratio: String(value.target_dc_ac_ratio), inverter_block_size_kw: String(value.inverter_block_size_kw), site_ac_headroom_kw: String(value.site_ac_headroom_kw), battery_duration_hours: String(value.battery_duration_hours), charge_efficiency_percent: String(value.charge_efficiency_percent), discharge_efficiency_percent: String(value.discharge_efficiency_percent), minimum_soc_percent: String(value.minimum_soc_percent), maximum_soc_percent: String(value.maximum_soc_percent), allow_grid_charging: value.allow_grid_charging, reactive_support_enabled: value.reactive_support_enabled, reactive_support_max_kvar: value.reactive_support_enabled ? String(value.reactive_support_max_kvar) : "", grid_emissions_factor_kg_co2e_per_kwh: String(value.grid_emissions_factor_kg_co2e_per_kwh ?? 0.79) }; }
function rangeFromValues(values: number[]): NumericRange { const sorted = [...new Set(values)].sort((a, b) => a - b); const start = sorted[0] ?? 0; const end = sorted.at(-1) ?? start; const step = sorted.length > 1 ? (end - start) / (sorted.length - 1) : 1; return { start: compact(start), end: compact(end), step: compact(step) }; }
function rangeValues(range: NumericRange, limit: number) { return numberRange(range.start, range.end, range.step, limit); }
function numberRange(startText: string, endText: string, stepText: string, limit: number): number[] | null { const start = Number(startText); const end = Number(endText); const step = Number(stepText); if (!nonNegative(startText) || !nonNegative(endText) || !positive(step) || end < start) return null; const count = Math.floor((end - start) / step + 1e-7) + 1; if (count < 1 || count > limit) return null; return Array.from({ length: count }, (_, index) => Number((start + step * index).toFixed(6))); }
function searchSpaceStatus(pv: number[] | null, battery: number[] | null, count: number, context: CiDesignContext | null) { if (!pv || !battery) return "Set PV and battery ranges"; if (!context) return "Complete asset details and options"; if (count > 200) return `${count} cases · maximum 200`; return `${pv.length} PV × ${battery.length} battery = ${count} cases`; }
function numberText(value: string) { if (!value.trim()) return Number.NaN; return Number(value); }
function optionalNumberText(value: string) { if (!value.trim()) return 0; const parsed = Number(value); return nonNegative(parsed) ? parsed : null; }
function integerText(value: string) { const parsed = numberText(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
function optionalYear(value: string): number | null | false { if (!value.trim()) return null; const year = Number(value); return Number.isInteger(year) && year >= 1980 && year <= 2100 ? year : false; }
function positive(value: string | number) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0; }
function nonNegative(value: string | number) { if (typeof value === "string" && !value.trim()) return false; const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0; }
function compact(value: number) { return String(Number(value.toFixed(6))); }
function percentage(value: number) { return String(Number((value * 100).toFixed(10))); }

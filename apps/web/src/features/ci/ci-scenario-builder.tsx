import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BatteryCharging,
  Cpu,
  ExternalLink,
  MapPin,
  Play,
  Settings2,
  SunMedium,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  CiBatterySolutionProfile,
  CiDeviceProfile,
  CiInverterSolutionProfile,
  CiSolarSolutionProfile,
} from "@/features/ci/api/ci-device-profile";
import type {
  CiDesignContext,
  CiDesignContextV2,
  CiSolutionGenerationRequest,
} from "@/features/ci/api/ci-projects";
import type { CiScenarioInput } from "@/features/ci/api/ci-scenarios";

type NumericRange = { minimum: string; maximum: string; step: string };
type CompleteBatterySolutionProfile = CiBatterySolutionProfile & {
  coupling: "ac";
  nominal_capacity_kwh_per_unit: number;
  continuous_power_kw_per_unit: number;
  round_trip_efficiency_percent: number;
  power_conversion_efficiency_percent: number;
  usable_depth_of_discharge_percent: number;
  standby_loss_percent_per_month: number;
  annual_capacity_degradation_percent: number;
  minimum_units: number;
  maximum_units: number;
};
type SiteFactorsForm = {
  resource_source: CiSolutionGenerationRequest["site_factors"]["resource_source"];
  resource_label: string;
  annual_specific_yield_kwh_per_kw: string;
  array_azimuth_degrees: string;
  array_tilt_degrees: string;
  shading_loss_percent: string;
  soiling_loss_percent: string;
  temperature_loss_percent: string;
  wiring_mismatch_loss_percent: string;
  other_system_loss_percent: string;
  system_availability_percent: string;
};
type ConnectionOptionsForm = {
  inverter_block_size_kw: string;
  site_ac_headroom_kw: string;
  allow_grid_charging: boolean;
  reactive_support_enabled: boolean;
  reactive_support_max_kvar: string;
  grid_emissions_factor_kg_co2e_per_kwh: string;
};
type RestoredBuilderState = {
  pvRange: NumericRange;
  batteryRange: NumericRange;
  site: SiteFactorsForm;
  connection: ConnectionOptionsForm;
  solarProfileId: string;
  batteryProfileId: string;
  inverterProfileId: string;
};

const defaultPvRange = (): NumericRange => ({ minimum: "100", maximum: "500", step: "100" });
const defaultBatteryRange = (): NumericRange => ({ minimum: "0", maximum: "500", step: "100" });
const defaultSiteFactors = (): SiteFactorsForm => ({
  resource_source: "analyst_assumption",
  resource_label: "Workspace screening assumption",
  annual_specific_yield_kwh_per_kw: "1500",
  array_azimuth_degrees: "0",
  array_tilt_degrees: "20",
  shading_loss_percent: "3",
  soiling_loss_percent: "2",
  temperature_loss_percent: "5",
  wiring_mismatch_loss_percent: "2",
  other_system_loss_percent: "0",
  system_availability_percent: "99",
});
const defaultConnectionOptions = (): ConnectionOptionsForm => ({
  inverter_block_size_kw: "5",
  site_ac_headroom_kw: "250",
  allow_grid_charging: false,
  reactive_support_enabled: false,
  reactive_support_max_kvar: "",
  grid_emissions_factor_kg_co2e_per_kwh: "",
});

export function CiScenarioBuilder({
  deviceProfile,
  error,
  initialContext,
  initialSolutions,
  isPending,
  onSubmit,
  siteAddress,
}: {
  deviceProfile: CiDeviceProfile;
  error: string | null;
  initialContext?: CiDesignContext;
  initialSolutions?: CiScenarioInput[];
  isPending: boolean;
  onSubmit: (request: CiSolutionGenerationRequest) => void;
  siteAddress?: string | null;
}) {
  const publishedSolar = useMemo(
    () => deviceProfile.solution_profiles.solar_profiles.filter((profile) => profile.status === "published"),
    [deviceProfile],
  );
  const publishedBattery = useMemo(
    () => deviceProfile.solution_profiles.battery_profiles.filter(isCompletePublishedAcBatteryProfile),
    [deviceProfile],
  );
  const publishedInverter = useMemo(
    () => deviceProfile.solution_profiles.inverter_profiles.filter((profile) => profile.status === "published"),
    [deviceProfile],
  );
  const restored = restoreBuilderState(
    initialContext,
    initialSolutions,
    deviceProfile,
    publishedSolar,
    publishedBattery,
  );
  const [pvRange, setPvRange] = useState(restored.pvRange);
  const [batteryRange, setBatteryRange] = useState(restored.batteryRange);
  const [site, setSite] = useState(restored.site);
  const initialInverterProfile = publishedInverter.find((profile) => profile.profile_id === restored.inverterProfileId) ?? publishedInverter[0] ?? null;
  const [connection, setConnection] = useState(() => restored.inverterProfileId || !initialInverterProfile ? restored.connection : {
    ...restored.connection,
    inverter_block_size_kw: formatNumber(initialInverterProfile.rated_active_power_kw),
  });
  const [solarProfileId, setSolarProfileId] = useState(restored.solarProfileId);
  const [batteryProfileId, setBatteryProfileId] = useState(restored.batteryProfileId);
  const [inverterProfileId, setInverterProfileId] = useState(
    restored.inverterProfileId || publishedInverter[0]?.profile_id || "",
  );

  const solarProfile = publishedSolar.find((profile) => profile.profile_id === solarProfileId) ?? null;
  const batteryProfile = publishedBattery.find((profile) => profile.profile_id === batteryProfileId) ?? null;
  const inverterProfile = publishedInverter.find((profile) => profile.profile_id === inverterProfileId) ?? null;

  useEffect(() => {
    setSolarProfileId((current) => publishedId(
      current || deviceProfile.default_solution_profile_selection.solar_profile_id,
      publishedSolar,
    ));
    setBatteryProfileId((current) => publishedId(
      current || deviceProfile.default_solution_profile_selection.battery_profile_id,
      publishedBattery,
    ));
    setInverterProfileId((current) => publishedId(current, publishedInverter));
  }, [
    deviceProfile.default_solution_profile_selection.battery_profile_id,
    deviceProfile.default_solution_profile_selection.solar_profile_id,
    publishedBattery,
    publishedInverter,
    publishedSolar,
  ]);

  useEffect(() => {
    if (!inverterProfile) return;
    setConnection((current) => {
      const blockSize = formatNumber(inverterProfile.rated_active_power_kw);
      const reactiveCap = current.reactive_support_enabled
        ? formatNumber(inverterProfile.maximum_reactive_power_kvar)
        : "";
      if (
        current.inverter_block_size_kw === blockSize &&
        current.reactive_support_max_kvar === reactiveCap
      ) return current;
      return {
        ...current,
        inverter_block_size_kw: blockSize,
        reactive_support_max_kvar: reactiveCap,
      };
    });
  }, [inverterProfile]);

  const request = useMemo(
    () => buildGenerationRequest({ batteryProfile, batteryRange, connection, inverterProfile, pvRange, site, solarProfile }),
    [batteryProfile, batteryRange, connection, inverterProfile, pvRange, site, solarProfile],
  );
  const requestedCount = rangeCount(pvRange, true) * rangeCount(batteryRange, false);
  const candidateUpperBound = canonicalCandidateUpperBound(pvRange, batteryRange);
  const effectiveYield = effectiveSpecificYield(site);
  const status = generatorStatus(request, requestedCount, candidateUpperBound, publishedSolar.length, publishedBattery.length, publishedInverter.length);

  const selectInverterProfile = (profileId: string) => {
    const selected = publishedInverter.find((profile) => profile.profile_id === profileId);
    setInverterProfileId(profileId);
    if (!selected) return;
    setConnection((current) => ({
      ...current,
      inverter_block_size_kw: formatNumber(selected.rated_active_power_kw),
      reactive_support_max_kvar: current.reactive_support_enabled
        ? formatNumber(selected.maximum_reactive_power_kvar)
        : "",
    }));
  };

  return (
    <section aria-labelledby="search-space-title" className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-950" id="search-space-title">Build the solution search space</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
            Existing onsite PV and batteries are excluded in this version. Python snaps requested sizes to the selected equipment profiles and generates the auditable candidates.
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium tabular-nums text-slate-700">{status}</span>
      </div>

      <form
        className="mt-7 space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (request && candidateUpperBound <= 200) onSubmit(request);
        }}
      >
        <WorkflowSection
          description="Location establishes the solar-resource context. The address is evidence only; the authored yield and losses below drive this screening run."
          step="01"
          title="Location & solar resource"
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(260px,.8fr)_minmax(0,2.2fr)]">
            <LocationCard address={siteAddress} />
            <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-slate-950">Site performance factors</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Specific yield is gross, before the listed site losses. This prevents imported net-yield data from being derated twice.</p>
                </div>
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">Source required</span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <SelectField
                  label="Resource source"
                  onChange={(resource_source) => setSite({ ...site, resource_source: resource_source as SiteFactorsForm["resource_source"] })}
                  options={[
                    ["analyst_assumption", "Analyst assumption"],
                    ["site_assessment", "Site assessment"],
                    ["imported_resource_study", "Imported resource study"],
                  ]}
                  value={site.resource_source}
                />
                <TextField className="sm:col-span-1 lg:col-span-2" label="Resource source / reference" onChange={(resource_label) => setSite({ ...site, resource_label })} value={site.resource_label} />
                <NumberField label="Gross annual specific yield (kWh/kWp)" onChange={(annual_specific_yield_kwh_per_kw) => setSite({ ...site, annual_specific_yield_kwh_per_kw })} value={site.annual_specific_yield_kwh_per_kw} />
                <NumberField label="Array azimuth (°; 0 = north)" onChange={(array_azimuth_degrees) => setSite({ ...site, array_azimuth_degrees })} value={site.array_azimuth_degrees} />
                <NumberField label="Array tilt (°)" onChange={(array_tilt_degrees) => setSite({ ...site, array_tilt_degrees })} value={site.array_tilt_degrees} />
              </div>
              <details className="mt-4 rounded-lg border border-slate-200 bg-white">
                <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-semibold text-slate-700">Site losses & availability</summary>
                <div className="grid gap-3 border-t border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  <NumberField label="Shading loss (%)" onChange={(shading_loss_percent) => setSite({ ...site, shading_loss_percent })} value={site.shading_loss_percent} />
                  <NumberField label="Soiling loss (%)" onChange={(soiling_loss_percent) => setSite({ ...site, soiling_loss_percent })} value={site.soiling_loss_percent} />
                  <NumberField label="Temperature loss (%)" onChange={(temperature_loss_percent) => setSite({ ...site, temperature_loss_percent })} value={site.temperature_loss_percent} />
                  <NumberField label="Wiring & mismatch loss (%)" onChange={(wiring_mismatch_loss_percent) => setSite({ ...site, wiring_mismatch_loss_percent })} value={site.wiring_mismatch_loss_percent} />
                  <NumberField label="Other system loss (%)" onChange={(other_system_loss_percent) => setSite({ ...site, other_system_loss_percent })} value={site.other_system_loss_percent} />
                  <NumberField label="System availability (%)" onChange={(system_availability_percent) => setSite({ ...site, system_availability_percent })} value={site.system_availability_percent} />
                </div>
              </details>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-cyan-50 px-3 py-2 text-xs text-cyan-950">
                <span>Calculation-active site yield after authored losses</span>
                <strong className="tabular-nums">{effectiveYield === null ? "Complete site factors" : `${formatNumber(effectiveYield)} kWh/kWp`}</strong>
              </div>
            </section>
          </div>
        </WorkflowSection>

        <WorkflowSection
          description="Choose the published Solar, Battery and Inverter profiles, set the search ranges and connection assumptions, then save the configuration to generate calculation-ready solutions."
          step="02"
          title="Solar, battery & inverter profiles"
        >
          <div className="grid gap-4 xl:grid-cols-3">
            <SolarProfileCard onProfileChange={setSolarProfileId} onRangeChange={setPvRange} profile={solarProfile} profiles={publishedSolar} range={pvRange} />
            <BatteryProfileCard onProfileChange={setBatteryProfileId} onRangeChange={setBatteryRange} profile={batteryProfile} profiles={publishedBattery} range={batteryRange} />
            <InverterProfileCard onProfileChange={selectInverterProfile} profile={inverterProfile} profiles={publishedInverter} />
          </div>
          {publishedSolar.length === 0 || publishedBattery.length === 0 || publishedInverter.length === 0 ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Publish at least one Solar profile, one AC-coupled Battery profile and one Inverter profile in Settings before generating solutions. DC-coupled battery profiles can remain in the library, but the current Python dispatch engine does not model them.</p>
          ) : (
            <p className="mt-3 text-xs leading-5 text-slate-500">Add, edit, publish or retire reusable profiles in Settings. The saved project keeps the exact selected profile snapshot so later library edits cannot silently change this design.</p>
          )}
          <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-white text-cyan-800 shadow-sm"><Cpu className="size-4" /></span>
              <div>
                <h4 className="font-semibold text-slate-950">Python auto-sizing</h4>
                <p className="text-xs leading-5 text-slate-500">Each PCS is rounded to the block size. Combinations above site headroom are rejected and reported, never silently clipped.</p>
              </div>
            </div>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <OptionGroup title="Connection capacity">
                <ReadOnlyFact label="PCS block from selected inverter" value={inverterProfile ? `${formatNumber(inverterProfile.rated_active_power_kw)} kW AC` : "Select an inverter profile"} />
                <NumberField label="Site AC headroom (kW)" onChange={(site_ac_headroom_kw) => setConnection({ ...connection, site_ac_headroom_kw })} value={connection.site_ac_headroom_kw} />
                <p className="col-span-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Replace the screening headroom with switchboard, export-limit or network evidence before relying on feasibility results.</p>
                <CheckField checked={connection.reactive_support_enabled} label="Model inverter reactive support" onChange={(reactive_support_enabled) => setConnection({ ...connection, reactive_support_enabled })} />
                {connection.reactive_support_enabled ? <NumberField label="Reactive support cap (kvar)" onChange={(reactive_support_max_kvar) => setConnection({ ...connection, reactive_support_max_kvar })} value={connection.reactive_support_max_kvar} /> : null}
              </OptionGroup>
              <OptionGroup title="Battery & environmental assumptions">
                <CheckField checked={connection.allow_grid_charging} label="Allow grid charging" onChange={(allow_grid_charging) => setConnection({ ...connection, allow_grid_charging })} />
                <NumberField allowBlank label="Grid emissions factor (kg CO2-e/kWh)" onChange={(grid_emissions_factor_kg_co2e_per_kwh) => setConnection({ ...connection, grid_emissions_factor_kg_co2e_per_kwh })} value={connection.grid_emissions_factor_kg_co2e_per_kwh} />
                <p className="col-span-full text-xs leading-5 text-slate-500">Blank disables the operational emissions estimate. Use an approved region and reporting-year factor when required.</p>
                <p className="col-span-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-600"><strong className="text-slate-800">Initial SOC:</strong> full-SOC physical upper-bound. It is a stress case, not expected savings or a recommendation.</p>
              </OptionGroup>
            </div>
          </section>
        </WorkflowSection>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><Settings2 className="size-4" />Profile performance and pricing remain separate assumptions.</div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {error ? <p className="max-w-xl text-sm text-destructive">{error}</p> : null}
            {candidateUpperBound > 200 ? <p className="max-w-xl text-sm text-amber-800">Reduce the PV or battery range. Battery cases can add matched PV-only comparators, so this request could create up to {candidateUpperBound} canonical candidates; the saved limit is 200.</p> : null}
            <Button className="min-w-64" disabled={!request || candidateUpperBound > 200 || isPending} type="submit">
              {isPending ? "Saving & generating in Python…" : `Save configuration & generate ${requestedCount || ""} cases`}
              <Play className="size-4" />
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function LocationCard({ address }: { address?: string | null }) {
  const mapsHref = address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null;
  return (
    <section aria-label="Detected project location" className="rounded-xl border border-cyan-100 bg-cyan-50/50 p-4">
      <span className="grid size-10 place-items-center rounded-xl bg-white text-cyan-800 shadow-sm"><MapPin className="size-5" /></span>
      <p className="mt-4 text-xs font-semibold uppercase tracking-[.12em] text-cyan-800">Detected bill address</p>
      <strong className="mt-2 block text-sm leading-6 text-slate-950">{address ?? "No site address detected"}</strong>
      <p className="mt-2 text-xs leading-5 text-slate-600">{address ? "Read from the saved bill evidence. Confirm it before importing any location dataset." : "Return to Evidence or use an analyst-labelled resource assumption."}</p>
      {mapsHref ? <a className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-800 hover:text-cyan-950" href={mapsHref} rel="noreferrer" target="_blank">Directions in Google Maps <ExternalLink className="size-3.5" /></a> : null}
    </section>
  );
}

function SolarProfileCard({ onProfileChange, onRangeChange, profile, profiles, range }: {
  onProfileChange: (profileId: string) => void;
  onRangeChange: (range: NumericRange) => void;
  profile: CiSolarSolutionProfile | null;
  profiles: CiSolarSolutionProfile[];
  range: NumericRange;
}) {
  return (
    <ProfileCard icon={SunMedium} title="Solar PV">
      <SelectField label="Published Solar profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      {profile ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3">
          <ProfileFact label="Hardware" value={`${profile.manufacturer} ${profile.model}`} />
          <ProfileFact label="Module rating" value={`${formatNumber(profile.rated_power_w)} W`} />
          <ProfileFact label="Module efficiency" value={`${formatNumber(profile.module_efficiency_percent)}%`} />
          <ProfileFact label="Technology" value={humanize(profile.module_technology)} />
          <ProfileFact label="Default DC/AC" value={formatNumber(profile.default_dc_ac_ratio)} />
          <ProfileFact label="Source" value={profile.source_label} />
        </dl>
      ) : <MissingProfile />}
      <RangeFields label="Target PV range" onChange={onRangeChange} range={range} unit="kWp DC" />
      <p className="text-[11px] leading-4 text-slate-500">Actual capacity is rounded up to whole {profile ? `${formatNumber(profile.rated_power_w)} W` : "module"} increments.</p>
    </ProfileCard>
  );
}

function BatteryProfileCard({ onProfileChange, onRangeChange, profile, profiles, range }: {
  onProfileChange: (profileId: string) => void;
  onRangeChange: (range: NumericRange) => void;
  profile: CompleteBatterySolutionProfile | null;
  profiles: CompleteBatterySolutionProfile[];
  range: NumericRange;
}) {
  return (
    <ProfileCard icon={BatteryCharging} title="Battery">
      <SelectField label="Published Battery profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      {profile ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3">
          <ProfileFact label="Hardware" value={`${profile.manufacturer} ${profile.model}`} />
          <ProfileFact label="Chemistry / coupling" value={`${profile.chemistry} · ${profile.coupling.toUpperCase()}`} />
          <ProfileFact label="Unit size" value={`${formatNumber(profile.nominal_capacity_kwh_per_unit)} kWh / ${formatNumber(profile.continuous_power_kw_per_unit)} kW`} />
          <ProfileFact label="Pack RTE" value={`${formatNumber(profile.round_trip_efficiency_percent)}%`} />
          <ProfileFact label="Usable DoD" value={`${formatNumber(profile.usable_depth_of_discharge_percent)}%`} />
          <ProfileFact label="Source" value={profile.source_label} />
        </dl>
      ) : <MissingProfile />}
      <RangeFields label="Target battery range" onChange={onRangeChange} range={range} unit="kWh (0 includes PV-only)" />
      <p className="text-[11px] leading-4 text-slate-500">Actual capacity is rounded to whole units and a matched PV-only comparator is added automatically.</p>
    </ProfileCard>
  );
}

function InverterProfileCard({ onProfileChange, profile, profiles }: {
  onProfileChange: (profileId: string) => void;
  profile: CiInverterSolutionProfile | null;
  profiles: CiInverterSolutionProfile[];
}) {
  return (
    <ProfileCard icon={Cpu} title="Inverter / PCS">
      <SelectField label="Published Inverter profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      {profile ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3 xl:grid-cols-2">
          <ProfileFact label="Hardware" value={`${profile.manufacturer} ${profile.model}`} />
          <ProfileFact label="Active power" value={`${formatNumber(profile.rated_active_power_kw)} kW`} />
          <ProfileFact label="Apparent power" value={`${formatNumber(profile.rated_apparent_power_kva)} kVA`} />
          <ProfileFact label="Reactive cap" value={`${formatNumber(profile.maximum_reactive_power_kvar)} kvar`} />
          <ProfileFact label="European efficiency" value={`${formatNumber(profile.european_efficiency_percent)}%`} />
          <ProfileFact label="Source" value={profile.source_label} />
        </dl>
      ) : <MissingProfile />}
      <p className="text-[11px] leading-4 text-slate-500">The selected rated active power becomes the Python PCS sizing block; apparent and reactive limits are saved with the project design.</p>
    </ProfileCard>
  );
}

function ProfileCard({ children, icon: Icon, title }: { children: ReactNode; icon: typeof SunMedium; title: string }) {
  return (
    <section aria-label={`${title} profile`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-4 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-white text-cyan-800 shadow-sm"><Icon className="size-5" /></span><div><h4 className="font-semibold text-slate-950">{title}</h4><p className="text-xs text-slate-500">Reusable workspace performance profile</p></div></div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function RangeFields({ label, onChange, range, unit }: { label: string; onChange: (range: NumericRange) => void; range: NumericRange; unit: string }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold text-slate-700">{label} <span className="font-normal text-slate-500">· {unit}</span></legend>
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Minimum" onChange={(minimum) => onChange({ ...range, minimum })} value={range.minimum} />
        <NumberField label="Maximum" onChange={(maximum) => onChange({ ...range, maximum })} value={range.maximum} />
        <NumberField label="Step" onChange={(step) => onChange({ ...range, step })} value={range.step} />
      </div>
    </fieldset>
  );
}

function WorkflowSection({ children, description, step, title }: { children: ReactNode; description?: string; step: string; title: string }) {
  return <section><div className="mb-3 flex gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-950 text-xs font-semibold text-white">{step}</span><div><h3 className="font-semibold text-slate-950">{title}</h3>{description ? <p className="mt-0.5 max-w-4xl text-xs leading-5 text-slate-500">{description}</p> : null}</div></div>{children}</section>;
}

function OptionGroup({ children, title }: { children: ReactNode; title: string }) {
  return <section className="rounded-lg bg-white p-4"><h4 className="mb-3 text-sm font-semibold text-slate-900">{title}</h4><div className="grid gap-3 sm:grid-cols-2">{children}</div></section>;
}

function ReadOnlyFact({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><strong className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm font-semibold text-slate-900">{value}</strong></div>;
}

function NumberField({ allowBlank = false, label, onChange, value }: { allowBlank?: boolean; label: string; onChange: (value: string) => void; value: string }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><input aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm tabular-nums text-slate-950" min="0" onChange={(event) => onChange(event.target.value)} placeholder={allowBlank ? "Not modelled" : undefined} step="any" type="number" value={value} /></label>;
}

function TextField({ className = "", label, onChange, value }: { className?: string; label: string; onChange: (value: string) => void; value: string }) {
  return <label className={`grid gap-1 text-xs font-medium text-slate-600 ${className}`}><span>{label}</span><input aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950" maxLength={160} onChange={(event) => onChange(event.target.value)} type="text" value={value} /></label>;
}

function SelectField({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: Array<[string, string]>; value: string }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><select aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950" onChange={(event) => onChange(event.target.value)} value={value}>{options.length === 0 ? <option value="">No published profiles</option> : null}{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}

function CheckField({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="col-span-full flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700"><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />{label}</label>;
}

function ProfileFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400">{label}</dt><dd className="mt-1 truncate font-medium text-slate-800" title={value}>{value}</dd></div>;
}

function MissingProfile() {
  return <p className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-4 text-center text-xs text-amber-900">No published profile is available.</p>;
}

function isCompletePublishedAcBatteryProfile(profile: CiBatterySolutionProfile): profile is CompleteBatterySolutionProfile {
  return profile.status === "published" && profile.coupling === "ac" && [
    profile.nominal_capacity_kwh_per_unit,
    profile.continuous_power_kw_per_unit,
    profile.round_trip_efficiency_percent,
    profile.power_conversion_efficiency_percent,
    profile.usable_depth_of_discharge_percent,
    profile.standby_loss_percent_per_month,
    profile.annual_capacity_degradation_percent,
    profile.minimum_units,
    profile.maximum_units,
  ].every((value) => typeof value === "number" && Number.isFinite(value));
}

function buildGenerationRequest({ batteryProfile, batteryRange, connection, inverterProfile, pvRange, site, solarProfile }: {
  batteryProfile: CompleteBatterySolutionProfile | null;
  batteryRange: NumericRange;
  connection: ConnectionOptionsForm;
  inverterProfile: CiInverterSolutionProfile | null;
  pvRange: NumericRange;
  site: SiteFactorsForm;
  solarProfile: CiSolarSolutionProfile | null;
}): CiSolutionGenerationRequest | null {
  if (!solarProfile || !batteryProfile || !inverterProfile || !site.resource_label.trim()) return null;
  const pv = parsedRange(pvRange, true);
  const battery = parsedRange(batteryRange, false);
  const annualYield = parseNumber(site.annual_specific_yield_kwh_per_kw);
  const azimuth = parseNumber(site.array_azimuth_degrees);
  const tilt = parseNumber(site.array_tilt_degrees);
  const shading = parseNumber(site.shading_loss_percent);
  const soiling = parseNumber(site.soiling_loss_percent);
  const temperature = parseNumber(site.temperature_loss_percent);
  const wiring = parseNumber(site.wiring_mismatch_loss_percent);
  const other = parseNumber(site.other_system_loss_percent);
  const availability = parseNumber(site.system_availability_percent);
  const block = parseNumber(connection.inverter_block_size_kw);
  const headroom = parseNumber(connection.site_ac_headroom_kw);
  const reactive = connection.reactive_support_enabled ? parseNumber(connection.reactive_support_max_kvar) : 0;
  const emissions = connection.grid_emissions_factor_kg_co2e_per_kwh.trim() ? parseNumber(connection.grid_emissions_factor_kg_co2e_per_kwh) : null;
  const losses = [shading, soiling, temperature, wiring, other];
  if (
    !pv || !battery ||
    !between(annualYield, 500, 3000) || !between(azimuth, 0, 360) || !between(tilt, 0, 90) ||
    losses.some((value) => !between(value, 0, 99)) || !between(availability, 1, 100) ||
    !between(block, 0.1, 1000) || !positive(headroom) ||
    (connection.reactive_support_enabled && !positive(reactive)) ||
    (emissions !== null && !between(emissions, 0, 5))
  ) return null;
  return {
    contract_version: "ci_solution_generation_request_v1",
    pv_range: { minimum_kwp_dc: pv.minimum, maximum_kwp_dc: pv.maximum, step_kwp_dc: pv.step },
    battery_range: { minimum_kwh: battery.minimum, maximum_kwh: battery.maximum, step_kwh: battery.step },
    solar_profile_id: solarProfile.profile_id,
    battery_profile_id: batteryProfile.profile_id,
    inverter_profile_id: inverterProfile.profile_id,
    site_factors: {
      resource_basis: "gross_specific_yield_before_site_losses",
      resource_source: site.resource_source,
      resource_label: site.resource_label.trim(),
      annual_specific_yield_kwh_per_kw: annualYield,
      array_azimuth_degrees: azimuth,
      array_tilt_degrees: tilt,
      shading_loss_percent: shading,
      soiling_loss_percent: soiling,
      temperature_loss_percent: temperature,
      wiring_mismatch_loss_percent: wiring,
      other_system_loss_percent: other,
      system_availability_percent: availability,
    },
    connection_options: {
      inverter_block_size_kw: block,
      site_ac_headroom_kw: headroom,
      allow_grid_charging: connection.allow_grid_charging,
      reactive_support_enabled: connection.reactive_support_enabled,
      reactive_support_max_kvar: reactive,
      grid_emissions_factor_kg_co2e_per_kwh: emissions,
      initial_soc_basis: "full_soc_physical_upper_bound",
    },
  };
}

function restoreBuilderState(
  context: CiDesignContext | undefined,
  solutions: CiScenarioInput[] | undefined,
  deviceProfile: CiDeviceProfile,
  publishedSolar: CiSolarSolutionProfile[],
  publishedBattery: CompleteBatterySolutionProfile[],
): RestoredBuilderState {
  const defaults: RestoredBuilderState = {
    pvRange: defaultPvRange(),
    batteryRange: defaultBatteryRange(),
    site: defaultSiteFactors(),
    connection: defaultConnectionOptions(),
    solarProfileId: publishedId(deviceProfile.default_solution_profile_selection.solar_profile_id, publishedSolar),
    batteryProfileId: publishedId(deviceProfile.default_solution_profile_selection.battery_profile_id, publishedBattery),
    inverterProfileId: "",
  };
  if (!context) {
    if (!solutions?.length) return defaults;
    return {
      ...defaults,
      pvRange: rangeFromValues(solutions.map((item) => item.pv_capacity_kwp_dc).filter((value) => value > 0)),
      batteryRange: rangeFromValues(solutions.map((item) => item.nominal_capacity_kwh)),
    };
  }
  if (context.contract_version === "ci_design_context_v2") return restoreV2(context);
  const options = context.technical_options;
  return {
    ...defaults,
    pvRange: solutions?.length ? rangeFromValues(solutions.map((item) => item.pv_capacity_kwp_dc).filter((value) => value > 0)) : defaults.pvRange,
    batteryRange: solutions?.length ? rangeFromValues(solutions.map((item) => item.nominal_capacity_kwh)) : defaults.batteryRange,
    site: siteFormFromTechnical(options),
    connection: connectionFormFromTechnical(options),
  };
}

function restoreV2(context: CiDesignContextV2): RestoredBuilderState {
  const options = context.technical_options;
  return {
    pvRange: {
      minimum: formatNumber(context.search_space.pv_range.minimum_kwp_dc),
      maximum: formatNumber(context.search_space.pv_range.maximum_kwp_dc),
      step: formatNumber(context.search_space.pv_range.step_kwp_dc),
    },
    batteryRange: {
      minimum: formatNumber(context.search_space.battery_range.minimum_kwh),
      maximum: formatNumber(context.search_space.battery_range.maximum_kwh),
      step: formatNumber(context.search_space.battery_range.step_kwh),
    },
    site: {
      resource_source: context.site_factors.resource_source,
      resource_label: context.site_factors.resource_label,
      annual_specific_yield_kwh_per_kw: formatNumber(context.site_factors.annual_specific_yield_kwh_per_kw),
      array_azimuth_degrees: formatNumber(context.site_factors.array_azimuth_degrees),
      array_tilt_degrees: formatNumber(context.site_factors.array_tilt_degrees),
      shading_loss_percent: formatNumber(context.site_factors.shading_loss_percent),
      soiling_loss_percent: formatNumber(context.site_factors.soiling_loss_percent),
      temperature_loss_percent: formatNumber(context.site_factors.temperature_loss_percent),
      wiring_mismatch_loss_percent: formatNumber(context.site_factors.wiring_mismatch_loss_percent),
      other_system_loss_percent: formatNumber(context.site_factors.other_system_loss_percent),
      system_availability_percent: formatNumber(context.site_factors.system_availability_percent),
    },
    connection: connectionFormFromTechnical(options),
    solarProfileId: context.profile_selection.solar_profile_id,
    batteryProfileId: context.profile_selection.battery_profile_id,
    inverterProfileId: context.profile_selection.inverter_profile_id ?? "",
  };
}

function siteFormFromTechnical(options: CiDesignContext["technical_options"]): SiteFactorsForm {
  return {
    ...defaultSiteFactors(),
    annual_specific_yield_kwh_per_kw: formatNumber(options.annual_specific_yield_kwh_per_kw),
    shading_loss_percent: formatNumber(options.shading_loss_percent),
    soiling_loss_percent: formatNumber(options.soiling_loss_percent),
    temperature_loss_percent: formatNumber(options.temperature_loss_percent),
    wiring_mismatch_loss_percent: formatNumber(options.wiring_mismatch_loss_percent),
    other_system_loss_percent: formatNumber(options.other_system_loss_percent),
    system_availability_percent: formatNumber(options.system_availability_percent),
  };
}

function connectionFormFromTechnical(options: CiDesignContext["technical_options"]): ConnectionOptionsForm {
  return {
    inverter_block_size_kw: formatNumber(options.inverter_block_size_kw),
    site_ac_headroom_kw: formatNumber(options.site_ac_headroom_kw),
    allow_grid_charging: options.allow_grid_charging,
    reactive_support_enabled: options.reactive_support_enabled,
    reactive_support_max_kvar: options.reactive_support_enabled ? formatNumber(options.reactive_support_max_kvar) : "",
    grid_emissions_factor_kg_co2e_per_kwh: options.grid_emissions_factor_kg_co2e_per_kwh ? formatNumber(options.grid_emissions_factor_kg_co2e_per_kwh) : "",
  };
}

function publishedId<T extends { profile_id: string }>(preferred: string, profiles: T[]) {
  return profiles.some((profile) => profile.profile_id === preferred) ? preferred : (profiles[0]?.profile_id ?? "");
}

function parsedRange(range: NumericRange, strictlyPositiveMinimum: boolean): { minimum: number; maximum: number; step: number } | null {
  const minimum = parseNumber(range.minimum);
  const maximum = parseNumber(range.maximum);
  const step = parseNumber(range.step);
  if ((strictlyPositiveMinimum ? !positive(minimum) : minimum < 0) || !Number.isFinite(maximum) || maximum < minimum || !positive(step)) return null;
  const count = Math.floor((maximum - minimum) / step + 1e-7) + 1;
  return count >= 1 && count <= 200 ? { minimum, maximum, step } : null;
}

function rangeCount(range: NumericRange, strictlyPositiveMinimum: boolean) {
  const parsed = parsedRange(range, strictlyPositiveMinimum);
  return parsed ? Math.floor((parsed.maximum - parsed.minimum) / parsed.step + 1e-7) + 1 : 0;
}

function canonicalCandidateUpperBound(pvRange: NumericRange, batteryRange: NumericRange) {
  const pv = parsedRange(pvRange, true);
  const battery = parsedRange(batteryRange, false);
  if (!pv || !battery) return 0;
  const pvCount = Math.floor((pv.maximum - pv.minimum) / pv.step + 1e-7) + 1;
  const batteryCount = Math.floor((battery.maximum - battery.minimum) / battery.step + 1e-7) + 1;
  const comparatorCountPerPv = batteryCount - (battery.minimum === 0 ? 1 : 0);
  return pvCount * (batteryCount + comparatorCountPerPv);
}

function rangeFromValues(values: number[]): NumericRange {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (!sorted.length) return { minimum: "0", maximum: "0", step: "1" };
  const minimum = sorted[0];
  const maximum = sorted.at(-1) ?? minimum;
  const step = sorted.length > 1 ? (maximum - minimum) / (sorted.length - 1) : Math.max(1, minimum);
  return { minimum: formatNumber(minimum), maximum: formatNumber(maximum), step: formatNumber(step) };
}

function effectiveSpecificYield(site: SiteFactorsForm) {
  const annual = parseNumber(site.annual_specific_yield_kwh_per_kw);
  const availability = parseNumber(site.system_availability_percent);
  const losses = [site.shading_loss_percent, site.soiling_loss_percent, site.temperature_loss_percent, site.wiring_mismatch_loss_percent, site.other_system_loss_percent].map(parseNumber);
  if (!positive(annual) || !between(availability, 1, 100) || losses.some((loss) => !between(loss, 0, 99))) return null;
  return annual * availability / 100 * losses.reduce((factor, loss) => factor * (1 - loss / 100), 1);
}

function generatorStatus(request: CiSolutionGenerationRequest | null, count: number, candidateUpperBound: number, solarProfiles: number, batteryProfiles: number, inverterProfiles: number) {
  if (!solarProfiles || !batteryProfiles || !inverterProfiles) return "Publish profiles in Settings";
  if (!request) return "Complete required assumptions";
  if (candidateUpperBound > 200) return `${count} requested · up to ${candidateUpperBound} candidates (maximum 200)`;
  return `${count} requested · Python will snap & validate`;
}

function parseNumber(value: string) {
  return value.trim() ? Number(value) : Number.NaN;
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function between(value: number, minimum: number, maximum: number) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function formatNumber(value: number) {
  return String(Number(value.toFixed(6)));
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BatteryCharging,
  Cpu,
  ExternalLink,
  MapPin,
  Play,
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
const MAX_PV_CANDIDATES = 20;
const MAX_BATTERY_CANDIDATES = 15;
const MAX_SOLUTIONS = 200;
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
  allow_grid_charging: true,
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
  stcSettings,
}: {
  deviceProfile: CiDeviceProfile;
  error: string | null;
  initialContext?: CiDesignContext;
  initialSolutions?: CiScenarioInput[];
  isPending: boolean;
  onSubmit: (request: CiSolutionGenerationRequest) => void;
  siteAddress?: string | null;
  stcSettings?: ReactNode;
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
      if (current.inverter_block_size_kw === blockSize) return current;
      return {
        ...current,
        inverter_block_size_kw: blockSize,
      };
    });
  }, [inverterProfile]);

  const request = useMemo(
    () => buildGenerationRequest({ batteryProfile, batteryRange, connection, inverterProfile, pvRange, site, solarProfile }),
    [batteryProfile, batteryRange, connection, inverterProfile, pvRange, site, solarProfile],
  );
  const candidateUpperBound = canonicalCandidateUpperBound(pvRange, batteryRange);
  const pvCandidateCount = parsedRange(pvRange, true)?.count ?? 0;
  const batteryCandidateCount = parsedRange(batteryRange, false)?.count ?? 0;
  const candidateLimitError =
    pvCandidateCount > MAX_PV_CANDIDATES
      ? `Maximum ${MAX_PV_CANDIDATES} PV candidates. Current configuration: ${pvCandidateCount}.`
      : batteryCandidateCount > MAX_BATTERY_CANDIDATES
        ? `Maximum ${MAX_BATTERY_CANDIDATES} battery candidates. Current configuration: ${batteryCandidateCount}.`
        : candidateUpperBound > MAX_SOLUTIONS
          ? `Maximum ${MAX_SOLUTIONS} solutions. Current configuration: ${candidateUpperBound}.`
          : null;
  const generationBlocker = candidateLimitError ?? (!request
    ? "Complete the site resource, published profiles, capacity ranges and connection limits."
    : null);
  const effectiveYield = effectiveSpecificYield(site);

  const selectInverterProfile = (profileId: string) => {
    const selected = publishedInverter.find((profile) => profile.profile_id === profileId);
    setInverterProfileId(profileId);
    if (!selected) return;
    setConnection((current) => ({
      ...current,
      inverter_block_size_kw: formatNumber(selected.rated_active_power_kw),
    }));
  };

  return (
    <section aria-labelledby="search-space-title" className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
      <h2 className="text-xl font-semibold text-slate-950" id="search-space-title">Configure solutions</h2>

      <form
        aria-busy={isPending}
        className="mt-7 space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (request && !candidateLimitError) onSubmit(request);
        }}
      >
        <WorkflowSection title="Location & solar resource">
          <div className="grid gap-4 xl:grid-cols-[minmax(260px,.8fr)_minmax(0,2.2fr)]">
            <LocationCard address={siteAddress} />
            <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-slate-950">Site performance factors</h4>
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
                <span>Effective yield</span>
                <strong className="tabular-nums">{effectiveYield === null ? "Complete site factors" : `${formatNumber(effectiveYield)} kWh/kWp`}</strong>
              </div>
            </section>
          </div>
        </WorkflowSection>

        <WorkflowSection title="Setup Solar, Battery, Inverter & STC">
          <div className="grid gap-4 xl:grid-cols-3">
            <SolarProfileCard onProfileChange={setSolarProfileId} onRangeChange={setPvRange} profile={solarProfile} profiles={publishedSolar} range={pvRange} />
            <BatteryProfileCard onProfileChange={setBatteryProfileId} onRangeChange={setBatteryRange} profile={batteryProfile} profiles={publishedBattery} range={batteryRange} />
            <InverterProfileCard onProfileChange={selectInverterProfile} profile={inverterProfile} profiles={publishedInverter} />
          </div>
          {publishedSolar.length === 0 || publishedBattery.length === 0 || publishedInverter.length === 0 ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Published Solar, AC Battery and Inverter profiles are required.</p>
          ) : null}
          <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <h4 className="font-semibold text-slate-950">Connection &amp; environment</h4>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <OptionGroup title="Connection capacity">
                <NumberField label="Site AC headroom (kW)" onChange={(site_ac_headroom_kw) => setConnection({ ...connection, site_ac_headroom_kw })} value={connection.site_ac_headroom_kw} />
              </OptionGroup>
              <OptionGroup title="Environmental assumptions">
                <NumberField allowBlank label="Grid emissions factor (kg CO2-e/kWh)" onChange={(grid_emissions_factor_kg_co2e_per_kwh) => setConnection({ ...connection, grid_emissions_factor_kg_co2e_per_kwh })} value={connection.grid_emissions_factor_kg_co2e_per_kwh} />
              </OptionGroup>
            </div>
          </section>
          {stcSettings ? <div className="mt-4">{stcSettings}</div> : null}
        </WorkflowSection>

        <div className="flex flex-wrap items-center justify-end gap-4 border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-center justify-end gap-3">
            {error ? <p className="max-w-xl text-sm text-destructive" role="alert">{error}</p> : null}
            {generationBlocker ? <p className="max-w-xl text-right text-sm font-medium text-amber-800" id="generation-blocker" role="status">{generationBlocker}</p> : null}
            <Button aria-describedby={generationBlocker ? "generation-blocker" : undefined} aria-label={isPending ? "Saving and generating solutions" : "Save configuration & generate solutions"} className="min-w-48" disabled={!request || Boolean(candidateLimitError) || isPending} type="submit">
              {isPending ? "Generating solutions…" : "Generate solutions"}
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
      <SelectField label="Solar performance profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      {profile ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3">
          <ProfileFact label="Module efficiency" value={`${formatNumber(profile.module_efficiency_percent)}%`} />
          <ProfileFact label="Technology" value={humanize(profile.module_technology)} />
          <ProfileFact label="Temperature coefficient" value={`${formatNumber(profile.temperature_coefficient_percent_per_c)}% / °C`} />
          <ProfileFact label="Annual degradation" value={`${formatNumber(profile.annual_degradation_percent)}% / yr`} />
          <ProfileFact label="Default DC/AC" value={formatNumber(profile.default_dc_ac_ratio)} />
        </dl>
      ) : <MissingProfile />}
      <RangeFields label="Target PV range" onChange={onRangeChange} range={range} unit="kWp DC" />
      <CandidateValuesSummary range={range} strictlyPositiveMinimum unit="kWp" />
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
      <SelectField label="Battery performance profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      {profile ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3">
          <ProfileFact label="Chemistry / coupling" value={`${profile.chemistry} · ${profile.coupling.toUpperCase()}`} />
          <ProfileFact label="Power ratio" value={`${formatNumber(profile.continuous_power_kw_per_unit / profile.nominal_capacity_kwh_per_unit)} kW/kWh`} />
          <ProfileFact label="Pack RTE" value={`${formatNumber(profile.round_trip_efficiency_percent)}%`} />
          <ProfileFact label="Conversion efficiency" value={`${formatNumber(profile.power_conversion_efficiency_percent)}%`} />
          <ProfileFact label="Usable DoD" value={`${formatNumber(profile.usable_depth_of_discharge_percent)}%`} />
          <ProfileFact label="Standby loss" value={`${formatNumber(profile.standby_loss_percent_per_month)}% / month`} />
          <ProfileFact label="Annual degradation" value={`${formatNumber(profile.annual_capacity_degradation_percent)}% / yr`} />
        </dl>
      ) : <MissingProfile />}
      <RangeFields label="Target battery range" onChange={onRangeChange} range={range} unit="kWh (0 includes PV-only)" />
      <CandidateValuesSummary range={range} unit="kWh" />
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
      <SelectField label="Inverter performance profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      {profile ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3 xl:grid-cols-2">
          <ProfileFact label="Reactive compensation" value={profile.reactive_support_enabled ? "On" : "Off"} />
          <ProfileFact label="Cap per inverter" value={`${formatNumber(profile.maximum_reactive_power_kvar)} kvar`} />
          <ProfileFact label="Apparent / active ratio" value={formatNumber(profile.rated_apparent_power_kva / profile.rated_active_power_kw)} />
          <ProfileFact label="Reactive / active ratio" value={formatNumber(profile.maximum_reactive_power_kvar / profile.rated_active_power_kw)} />
          <ProfileFact label="European efficiency" value={`${formatNumber(profile.european_efficiency_percent)}%`} />
          <ProfileFact label="Maximum efficiency" value={`${formatNumber(profile.maximum_efficiency_percent)}%`} />
          <ProfileFact label="Source" value={profile.source_label} />
        </dl>
      ) : <MissingProfile />}
    </ProfileCard>
  );
}

function ProfileCard({ children, icon: Icon, title }: { children: ReactNode; icon: typeof SunMedium; title: string }) {
  return (
    <section aria-label={`${title} profile`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-4 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-white text-cyan-800 shadow-sm"><Icon className="size-5" /></span><h4 className="font-semibold text-slate-950">{title}</h4><span className="ml-auto rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold text-cyan-800">Performance reference</span></div>
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

function WorkflowSection({ children, title }: { children: ReactNode; title: string }) {
  return <section><h3 className="mb-3 font-semibold text-slate-950">{title}</h3>{children}</section>;
}

function CandidateValuesSummary({ range, strictlyPositiveMinimum = false, unit }: { range: NumericRange; strictlyPositiveMinimum?: boolean; unit: string }) {
  const parsed = parsedRange(range, strictlyPositiveMinimum);
  const values = parsed && parsed.count <= MAX_SOLUTIONS ? rangeValues(range, strictlyPositiveMinimum) : [];
  const count = parsed?.count ?? 0;
  const countLabel = `${count} ${count === 1 ? "candidate" : "candidates"}`;
  return (
    <div className="rounded-lg bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-950">
      <strong>{countLabel}:</strong>{" "}
      <span className="tabular-nums">{values.length ? `${values.map(formatCandidateValue).join(", ")} ${unit}` : count > MAX_SOLUTIONS ? "Reduce the range to view candidates" : "—"}</span>
    </div>
  );
}

function OptionGroup({ children, title }: { children: ReactNode; title: string }) {
  return <section className="rounded-lg bg-white p-4"><h4 className="mb-3 text-sm font-semibold text-slate-900">{title}</h4><div className="grid gap-3 sm:grid-cols-2">{children}</div></section>;
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
  const reactiveEnabled = inverterProfile.reactive_support_enabled;
  const reactive = reactiveEnabled ? inverterProfile.maximum_reactive_power_kvar : 0;
  const emissions = connection.grid_emissions_factor_kg_co2e_per_kwh.trim() ? parseNumber(connection.grid_emissions_factor_kg_co2e_per_kwh) : null;
  const losses = [shading, soiling, temperature, wiring, other];
  if (
    !pv || !battery ||
    !between(annualYield, 500, 3000) || !between(azimuth, 0, 360) || !between(tilt, 0, 90) ||
    losses.some((value) => !between(value, 0, 99)) || !between(availability, 1, 100) ||
    !between(block, 0.1, 1000) || !positive(headroom) ||
    (reactiveEnabled && !positive(reactive)) ||
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
      allow_grid_charging: true,
      reactive_support_enabled: reactiveEnabled,
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
      minimum: formatCandidateValue(context.search_space.pv_range.minimum_kwp_dc),
      maximum: formatCandidateValue(context.search_space.pv_range.maximum_kwp_dc),
      step: formatCandidateValue(context.search_space.pv_range.step_kwp_dc),
    },
    batteryRange: {
      minimum: formatCandidateValue(context.search_space.battery_range.minimum_kwh),
      maximum: formatCandidateValue(context.search_space.battery_range.maximum_kwh),
      step: formatCandidateValue(context.search_space.battery_range.step_kwh),
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
    allow_grid_charging: true,
    grid_emissions_factor_kg_co2e_per_kwh: options.grid_emissions_factor_kg_co2e_per_kwh ? formatNumber(options.grid_emissions_factor_kg_co2e_per_kwh) : "",
  };
}

function publishedId<T extends { profile_id: string }>(preferred: string, profiles: T[]) {
  return profiles.some((profile) => profile.profile_id === preferred) ? preferred : (profiles[0]?.profile_id ?? "");
}

function parsedRange(range: NumericRange, strictlyPositiveMinimum: boolean): { minimum: number; maximum: number; step: number; count: number } | null {
  const minimum = parseNumber(range.minimum);
  const maximum = parseNumber(range.maximum);
  const step = parseNumber(range.step);
  if (!Number.isFinite(minimum) || (strictlyPositiveMinimum ? minimum <= 0 : minimum < 0) || !Number.isFinite(maximum) || maximum < minimum || !positive(step)) return null;
  const count = decimalRangeCount(minimum, maximum, step);
  return count !== null && count >= 1 && count <= 10_000 ? { minimum, maximum, step, count } : null;
}

function rangeValues(range: NumericRange, strictlyPositiveMinimum: boolean) {
  const parsed = parsedRange(range, strictlyPositiveMinimum);
  if (!parsed) return [];
  const minimumParts = decimalParts(parsed.minimum);
  const stepParts = decimalParts(parsed.step);
  if (!minimumParts || !stepParts) return [];
  const commonExponent = Math.min(minimumParts.exponent, stepParts.exponent);
  const minimum = scaledDecimalCoefficient(minimumParts, commonExponent);
  const step = scaledDecimalCoefficient(stepParts, commonExponent);
  return Array.from({ length: parsed.count }, (_value, index) => {
    const exactCandidate = Number(`${minimum + step * BigInt(index)}e${commonExponent}`);
    return pythonRoundToNineDecimals(exactCandidate);
  });
}

function canonicalCandidateUpperBound(pvRange: NumericRange, batteryRange: NumericRange) {
  const pv = parsedRange(pvRange, true);
  const battery = parsedRange(batteryRange, false);
  if (!pv || !battery) return 0;
  return pv.count * battery.count;
}

function decimalRangeCount(minimum: number, maximum: number, step: number) {
  const values = [minimum, maximum, step].map(decimalParts);
  if (values.some((value) => value === null)) return null;
  const [minimumParts, maximumParts, stepParts] = values as DecimalParts[];
  const commonExponent = Math.min(minimumParts.exponent, maximumParts.exponent, stepParts.exponent);
  return Number(
    (scaledDecimalCoefficient(maximumParts, commonExponent) - scaledDecimalCoefficient(minimumParts, commonExponent))
      / scaledDecimalCoefficient(stepParts, commonExponent)
      + 1n,
  );
}

type DecimalParts = { coefficient: bigint; exponent: number };

function decimalParts(value: number): DecimalParts | null {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const fractional = match[3] ?? "";
  return {
    coefficient: BigInt(`${match[1]}${match[2]}${fractional}`),
    exponent: Number(match[4] ?? 0) - fractional.length,
  };
}

function scaledDecimalCoefficient(value: DecimalParts, exponent: number) {
  return value.coefficient * 10n ** BigInt(value.exponent - exponent);
}

function pythonRoundToNineDecimals(value: number) {
  const magnitude = Math.abs(value);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  let significand = bits & ((1n << 52n) - 1n);
  const binaryExponent = exponentBits === 0 ? -1074 : exponentBits - 1075;
  if (exponentBits !== 0) significand |= 1n << 52n;

  let numerator = significand * 5n ** 9n;
  const scaledBinaryExponent = binaryExponent + 9;
  let denominator = 1n;
  if (scaledBinaryExponent >= 0) numerator <<= BigInt(scaledBinaryExponent);
  else denominator <<= BigInt(-scaledBinaryExponent);

  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && rounded % 2n === 1n)) rounded += 1n;
  return (value < 0 ? -1 : 1) * Number(rounded) / 1_000_000_000;
}

function rangeFromValues(values: number[]): NumericRange {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (!sorted.length) return { minimum: "0", maximum: "0", step: "1" };
  const minimum = sorted[0];
  const maximum = sorted.at(-1) ?? minimum;
  const step = sorted.length > 1 ? (maximum - minimum) / (sorted.length - 1) : Math.max(1, minimum);
  return { minimum: formatCandidateValue(minimum), maximum: formatCandidateValue(maximum), step: formatCandidateValue(step) };
}

function effectiveSpecificYield(site: SiteFactorsForm) {
  const annual = parseNumber(site.annual_specific_yield_kwh_per_kw);
  const availability = parseNumber(site.system_availability_percent);
  const losses = [site.shading_loss_percent, site.soiling_loss_percent, site.temperature_loss_percent, site.wiring_mismatch_loss_percent, site.other_system_loss_percent].map(parseNumber);
  if (!positive(annual) || !between(availability, 1, 100) || losses.some((loss) => !between(loss, 0, 99))) return null;
  return annual * availability / 100 * losses.reduce((factor, loss) => factor * (1 - loss / 100), 1);
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

function formatCandidateValue(value: number) {
  return value.toFixed(9).replace(/\.?0+$/, "");
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BatteryCharging,
  ChevronDown,
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
  CiSiteFactors,
  CiDesignContextV2,
  CiSolutionGenerationRequest,
} from "@/features/ci/api/ci-projects";
import type { CiScenarioInput } from "@/features/ci/api/ci-scenarios";
import { refreshCiSolarResource, type CiSolarResource } from "@/features/ci/api/ci-solar-resource";

import type { CiSiteFactorsState } from "./api/ci-site-factors";

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
  pv_timing_model: "generic_normalized_solar_shape_v1" | "solar_geometry_screening_v1";
  latitude_degrees: string;
  longitude_degrees: string;
  location_source_label: string;
  location_confirmed: boolean;
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
  dispatch_topology: "shared_hybrid_dc" | "separate_ac";
  battery_efficiency_basis: "pack_plus_conversion" | "whole_system_ac";
  inverter_block_size_kw: string;
  inverter_quantity: string;
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
  pv_timing_model: "generic_normalized_solar_shape_v1",
  latitude_degrees: "",
  longitude_degrees: "",
  location_source_label: "",
  location_confirmed: false,
  resource_source: "analyst_assumption",
  resource_label: "Workspace screening assumption",
  annual_specific_yield_kwh_per_kw: "1000",
  array_azimuth_degrees: "0",
  array_tilt_degrees: "0",
  shading_loss_percent: "3",
  soiling_loss_percent: "2",
  temperature_loss_percent: "5",
  wiring_mismatch_loss_percent: "2",
  other_system_loss_percent: "0",
  system_availability_percent: "99",
});
function applySolarResource(site: SiteFactorsForm, resource: CiSolarResource): SiteFactorsForm {
  return {
    ...site,
    pv_timing_model: "solar_geometry_screening_v1",
    latitude_degrees: String(resource.latitude),
    longitude_degrees: String(resource.longitude),
    location_source_label: `Geoapify building match: ${resource.matched_address}`.slice(0, 240),
    location_confirmed: false,
    resource_source: "imported_resource_study",
    resource_label: `${resource.source}; ${resource.queried_at.slice(0, 10)}; 1 kWp; loss=0; free-mounted crystalline silicon`,
    annual_specific_yield_kwh_per_kw: String(resource.annual_specific_yield_kwh_per_kw),
    array_tilt_degrees: String(resource.tilt_degrees),
    array_azimuth_degrees: String(resource.azimuth_degrees),
    // PVGIS already includes temperature losses even when its system loss is zero.
    temperature_loss_percent: "0",
  };
}

const defaultConnectionOptions = (): ConnectionOptionsForm => ({
  dispatch_topology: "shared_hybrid_dc",
  battery_efficiency_basis: "pack_plus_conversion",
  inverter_block_size_kw: "5",
  inverter_quantity: "",
  site_ac_headroom_kw: "250",
  allow_grid_charging: true,
  grid_emissions_factor_kg_co2e_per_kwh: "",
});

export function CiScenarioBuilder({
  deviceProfile,
  error,
  initialContext,
  initialSiteFactors,
  onSaveSiteFactors,
  initialSolutions,
  isPending,
  onSubmit,
  siteAddress,
  projectId,
  solarResource,
  onSolarResourceUpdated,
  stcSettings,
}: {
  deviceProfile: CiDeviceProfile;
  error: string | null;
  initialContext?: CiDesignContext;
  initialSiteFactors?: CiSiteFactors;
  onSaveSiteFactors?: (factors: CiSiteFactors) => Promise<CiSiteFactorsState>;
  initialSolutions?: CiScenarioInput[];
  isPending: boolean;
  onSubmit: (request: CiSolutionGenerationRequest) => void;
  siteAddress?: string | null;
  projectId?: string;
  solarResource?: CiSolarResource;
  onSolarResourceUpdated?: () => void;
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
  const [site, setSite] = useState(() => initialSiteFactors ? siteFormFromFactors(initialSiteFactors) : restored.site);
  const [savedSite, setSavedSite] = useState<SiteFactorsForm | null>(() => initialSiteFactors ? siteFormFromFactors(initialSiteFactors) : initialContext?.contract_version === "ci_design_context_v2" ? restored.site : null);
  useEffect(() => {
    if (initialSiteFactors) { setSavedSite(siteFormFromFactors(initialSiteFactors)); setSavedYield(null); }
  }, [initialSiteFactors]);
  const [savedYield, setSavedYield] = useState<number | null>(null);
  const [siteSavePending, setSiteSavePending] = useState(false);
  const [siteSaveError, setSiteSaveError] = useState<string | null>(null);
  const siteDirty = !savedSite || !siteFactorsInput(site) || JSON.stringify(siteFactorsInput(site)) !== JSON.stringify(siteFactorsInput(savedSite));
  const siteInput = siteFactorsInput(site);
  const saveSite = async () => {
    if (!onSaveSiteFactors || !siteInput) return;
    setSiteSavePending(true);
    setSiteSaveError(null);
    const snapshot = { ...site };
    try {
      const saved = await onSaveSiteFactors(siteInput);
      setSavedSite(snapshot);
      setSavedYield(saved.effective_yield_kwh_per_kwp);
    } catch (error) {
      setSiteSaveError(error instanceof Error ? error.message : "Site factors could not be saved.");
    } finally { setSiteSavePending(false); }
  };
  const [resource, setResource] = useState(solarResource);
  const [resourcePending, setResourcePending] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);
  // A lookup can finish after the builder mounts. Expose it without overwriting
  // saved designs or an analyst's in-progress form edits.
  useEffect(() => {
    if (solarResource) setResource(solarResource);
  }, [solarResource]);
  const resourceMatchesOrientation = resource?.status === "ready"
    && resource.address === siteAddress
    && resource.tilt_degrees === Number(site.array_tilt_degrees)
    && resource.azimuth_degrees === Number(site.array_azimuth_degrees) % 360;
  const resourceApplied = resourceMatchesOrientation
    && site.resource_label.startsWith("PVGIS 5.3 / ERA5")
    && resource.annual_specific_yield_kwh_per_kw === Number(site.annual_specific_yield_kwh_per_kw)
    && resource.latitude === Number(site.latitude_degrees)
    && resource.longitude === Number(site.longitude_degrees)
    && Number(site.temperature_loss_percent) === 0
    && site.pv_timing_model === "solar_geometry_screening_v1";
  const resourceStale = site.resource_label.startsWith("PVGIS 5.3 / ERA5") && (!resource || resource.status !== "ready" ||
    resource.address !== siteAddress || resource.tilt_degrees !== Number(site.array_tilt_degrees) ||
    resource.azimuth_degrees !== Number(site.array_azimuth_degrees) % 360 ||
    resource.annual_specific_yield_kwh_per_kw !== Number(site.annual_specific_yield_kwh_per_kw) || Number(site.temperature_loss_percent) !== 0 ||
    resource.latitude !== Number(site.latitude_degrees) || resource.longitude !== Number(site.longitude_degrees));
  const refreshResource = async () => {
    if (!projectId) return;
    setResourcePending(true);
    setResourceError(null);
    try {
      const next = await refreshCiSolarResource(projectId, Number(site.array_tilt_degrees), Number(site.array_azimuth_degrees));
      setResource(next);
      onSolarResourceUpdated?.();
      if (next.status === "ready") setSite((current) => Number(current.array_tilt_degrees) === next.tilt_degrees && Number(current.array_azimuth_degrees) % 360 === next.azimuth_degrees ? applySolarResource(current, next) : current);
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : "Solar lookup failed.");
    } finally { setResourcePending(false); }
  };
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
  const quantityError = inverterQuantityError(connection.inverter_quantity);
  const emissionsValue = connection.grid_emissions_factor_kg_co2e_per_kwh.trim();
  const emissionsError = emissionsValue && !between(parseNumber(emissionsValue), 0, 5)
    ? "Grid emissions factor must be between 0 and 5 kg CO2-e/kWh, or blank. Check Environmental assumptions."
    : null;
  const generationBlocker = (siteSavePending ? "Saving site factors." : resourcePending ? "Solar resource lookup in progress." : resourceStale ? "Location or orientation changed. Refresh PVGIS before generating, or choose an explicitly labelled manual assumption." : null) ?? candidateLimitError ?? quantityError ?? emissionsError ?? (!request
    ? "Complete the site resource, published profiles, capacity ranges and connection limits."
    : null);
  const effectiveYield = !siteDirty && savedYield !== null ? savedYield : effectiveSpecificYield(site);

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
    <section aria-labelledby="search-space-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
        <h2 className="text-xl font-semibold tracking-tight text-slate-950" id="search-space-title">Configure solutions</h2>
        <span aria-label="Configured candidate ranges" className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium tabular-nums text-slate-600">{pvCandidateCount} PV × {batteryCandidateCount} battery candidates</span>
      </header>

      <form
        aria-busy={isPending}
        className="space-y-6 p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (request && !generationBlocker) onSubmit(request);
        }}
      >
        <WorkflowSection title="Location & solar resource">
          <div className="space-y-3">
            <LocationCard address={siteAddress} />
            <div className="rounded-xl border border-cyan-200 bg-cyan-50/40 p-4 text-sm" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="font-semibold">{resource?.status === "ready" ? "PVGIS solar resource" : "Solar resource · 1000 kWh/kWp default"}</h4>
                {projectId ? <Button type="button" variant="outline" disabled={resourcePending || isPending || !siteAddress} onClick={() => { void refreshResource(); }}>{resourcePending ? "Looking up location & PVGIS…" : "Refresh & apply PVGIS"}</Button> : null}
              </div>
              <p className="mt-2">{resource?.message ?? "Upload a bill to automatically look up its site address and solar resource. No lookup result: 1000 kWh/kWp screening assumption."}</p>
              {resourceError ? <p className="mt-2 text-red-800" role="alert">{resourceError}</p> : null}
              {resource?.status === "ready" ? <>
                {!resourceApplied ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
                  <p>PVGIS is available but not applied to this configuration. The form below still controls generation; existing results retain their saved inputs.</p>
                  {resourceMatchesOrientation ? <Button className="mt-2" type="button" variant="outline" disabled={resourcePending || isPending} onClick={() => setSite((current) => applySolarResource(current, resource))}>Apply available PVGIS to form</Button> : <p className="mt-1">Address or orientation differs. Use Refresh &amp; apply PVGIS to query the current location, tilt and azimuth.</p>}
                </div> : <p className="mt-2 font-medium">PVGIS applied to form. Confirm coordinates, then save and generate solutions; run analysis again to update results.</p>}
                <p className="mt-2 font-medium">{resource.annual_specific_yield_kwh_per_kw.toFixed(1)} kWh/kWp/year · {resource.tilt_degrees}° tilt · {resource.azimuth_degrees}° azimuth</p>
                <p className="mt-1 text-xs">{resource.matched_address} · {resource.latitude}, {resource.longitude} · Retrieved {resource.queried_at.slice(0, 10)}</p>
                <details className="mt-3"><summary className="cursor-pointer">Monthly generation per 1 kWp</summary><div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">{resource.monthly_kwh_per_kwp.map((value, index) => <div className="rounded border bg-white p-2 text-xs" key={index}>{["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][index]}<strong className="block">{value.toFixed(1)} kWh</strong></div>)}</div></details>
                <p className="mt-2 text-xs">Refresh & apply PVGIS replaces the 1000 default; it does not multiply it. Model includes temperature and terrain horizon, not nearby trees or buildings. Existing saved designs are unchanged until you apply and regenerate.</p>
              </> : null}
              <p className="mt-2 text-xs">Address geocoding: <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer" className="underline">Geoapify</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap</a>. Solar model: <a href="https://re.jrc.ec.europa.eu/pvg_tools/en/" target="_blank" rel="noreferrer" className="underline">European Commission JRC PVGIS</a>. Only the address is sent to Geoapify; PVGIS receives coordinates and system assumptions.</p>
            </div>
            <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-slate-950">Site performance factors</h4>
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">{site.resource_source === "analyst_assumption" ? "Analyst assumption" : site.resource_source === "site_assessment" ? "Site assessment" : "Imported resource study"}</span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <SelectField
                  label="Resource source"
                  onChange={(resource_source) => setSite({ ...site, resource_source: resource_source as SiteFactorsForm["resource_source"], ...(resource_source === "analyst_assumption" ? { resource_label: "Manual screening assumption" } : {}) })}
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
                <SelectField label="PV interval model" value={site.pv_timing_model} onChange={(pv_timing_model) => setSite({ ...site, pv_timing_model: pv_timing_model as SiteFactorsForm["pv_timing_model"] })} options={[["generic_normalized_solar_shape_v1", "Legacy generic timing"], ["solar_geometry_screening_v1", "Location & orientation screening"]]} />
                {site.pv_timing_model === "solar_geometry_screening_v1" ? <>
                  <NumberField min={-90} label="Latitude (°)" value={site.latitude_degrees} onChange={(latitude_degrees) => setSite({ ...site, latitude_degrees, location_confirmed: false })} />
                  <NumberField min={-180} label="Longitude (°)" value={site.longitude_degrees} onChange={(longitude_degrees) => setSite({ ...site, longitude_degrees, location_confirmed: false })} />
                  <TextField label="Coordinate source" value={site.location_source_label} onChange={(location_source_label) => setSite({ ...site, location_source_label })} />
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={site.location_confirmed} onChange={(event) => setSite({ ...site, location_confirmed: event.target.checked })} />Coordinates confirmed</label>
                  <p className="sm:col-span-2 lg:col-span-3 text-sm text-amber-900">Interval timing uses solar geometry, not hourly weather. Annual yield uses the selected resource above; PVGIS monthly values are reference values, not an hourly time series.</p>
                </> : <p className="sm:col-span-2 lg:col-span-3 text-sm text-amber-900">Legacy timing does not use location, tilt or azimuth.</p>}
              </div>
              <details className="mt-4 rounded-lg border border-slate-200 bg-white">
                <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-slate-700">Site losses & availability</summary>
                <div className="grid gap-3 border-t border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  <NumberField label="Shading loss (%)" onChange={(shading_loss_percent) => setSite({ ...site, shading_loss_percent })} value={site.shading_loss_percent} />
                  <NumberField label="Soiling loss (%)" onChange={(soiling_loss_percent) => setSite({ ...site, soiling_loss_percent })} value={site.soiling_loss_percent} />
                  <NumberField label="Temperature loss (%)" onChange={(temperature_loss_percent) => setSite({ ...site, temperature_loss_percent })} value={site.temperature_loss_percent} />
                  <NumberField label="Wiring & mismatch loss (%)" onChange={(wiring_mismatch_loss_percent) => setSite({ ...site, wiring_mismatch_loss_percent })} value={site.wiring_mismatch_loss_percent} />
                  <NumberField label="Other system loss (%)" onChange={(other_system_loss_percent) => setSite({ ...site, other_system_loss_percent })} value={site.other_system_loss_percent} />
                  <NumberField label="System availability (%)" onChange={(system_availability_percent) => setSite({ ...site, system_availability_percent })} value={site.system_availability_percent} />
                </div>
              </details>
              <div className="mt-4 rounded-xl border-2 border-emerald-600 bg-emerald-50 p-5 text-emerald-950" aria-live="polite">
                <p className="text-sm font-semibold">Effective yield</p>
                <p className="mt-2 text-3xl font-bold tabular-nums">{effectiveYield === null ? "Complete site factors" : effectiveYield.toLocaleString("en-AU", { maximumFractionDigits: 2 })}<span className="ml-2 text-sm font-medium">kWh/kWp/year</span></p>
                <p className="mt-2 text-sm">Gross yield × retained output after site losses × availability. Used for PV generation before inverter conversion and clipping.</p>
                <p className="mt-1 text-xs">{siteDirty ? "Unsaved site factors" : "Site factors saved"} · Regenerate solutions after changing these values to update subsequent calculations.</p>
              </div>
              {onSaveSiteFactors ? <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button type="button" disabled={siteSavePending || isPending || resourcePending || resourceStale || !siteInput || !siteDirty} onClick={() => { void saveSite(); }}>{siteSavePending ? "Saving site factors…" : "Save site factors"}</Button>
                {!siteDirty ? <span className="text-sm text-emerald-800">Saved for this project. Restored after refresh.</span> : null}
                {siteSaveError ? <p className="text-sm text-red-800" role="alert">{siteSaveError}</p> : null}
              </div> : null}
            </section>
          </div>
        </WorkflowSection>

        <WorkflowSection title="Setup Solar, Battery, Inverter & STC">
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <SolarProfileCard onProfileChange={setSolarProfileId} onRangeChange={setPvRange} profile={solarProfile} profiles={publishedSolar} range={pvRange} />
            <BatteryProfileCard onProfileChange={setBatteryProfileId} onRangeChange={setBatteryRange} profile={batteryProfile} profiles={publishedBattery} range={batteryRange} />
            <InverterProfileCard onProfileChange={selectInverterProfile} onQuantityChange={(inverter_quantity) => setConnection({ ...connection, inverter_quantity })} profile={inverterProfile} profiles={publishedInverter} quantity={connection.inverter_quantity} separateAc={connection.dispatch_topology === "separate_ac"} />
          </div>
          {publishedSolar.length === 0 || publishedBattery.length === 0 || publishedInverter.length === 0 ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Published Solar, AC Battery and Inverter profiles are required.</p>
          ) : null}
          <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50/40 p-4">
            <h4 className="text-sm font-semibold text-slate-950">Connection capacity</h4>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <SelectField label="Electrical topology" value={connection.dispatch_topology} onChange={(dispatch_topology) => setConnection({ ...connection, dispatch_topology: dispatch_topology as ConnectionOptionsForm["dispatch_topology"] })} options={[["shared_hybrid_dc", "Shared hybrid / DC charging (legacy)"], ["separate_ac", "Separate AC PV inverter & battery PCS"]]} />
                <SelectField label="Battery RTE basis" value={connection.battery_efficiency_basis} onChange={(battery_efficiency_basis) => setConnection({ ...connection, battery_efficiency_basis: battery_efficiency_basis as ConnectionOptionsForm["battery_efficiency_basis"] })} options={[["pack_plus_conversion", "Pack RTE + converter losses"], ["whole_system_ac", "Whole-system AC RTE (converter included)"]]} />
                <NumberField label="Site AC headroom (kW)" onChange={(site_ac_headroom_kw) => setConnection({ ...connection, site_ac_headroom_kw })} value={connection.site_ac_headroom_kw} />
            </div>
            <details className="mt-4 border-t border-slate-200 pt-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">Environmental assumptions{emissionsError ? <span className="ml-2 text-red-700">· Check emissions factor</span> : null}</summary>
              <div className="mt-3 max-w-sm"><NumberField allowBlank label="Grid emissions factor (kg CO2-e/kWh)" max={5} onChange={(grid_emissions_factor_kg_co2e_per_kwh) => setConnection({ ...connection, grid_emissions_factor_kg_co2e_per_kwh })} value={connection.grid_emissions_factor_kg_co2e_per_kwh} /></div>
            </details>
          </section>
          {stcSettings ? <div className="mt-4">{stcSettings}</div> : null}
        </WorkflowSection>

        <div className="space-y-3 border-t border-slate-200 pt-5">
            {error ? <p className="max-w-xl text-sm text-destructive" role="alert">{error}</p> : null}
            {generationBlocker ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800" id="generation-blocker" role="status">{generationBlocker}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-slate-500">{isPending ? "Saving configuration & checking feasibility…" : generationBlocker ? "Complete the configuration to continue" : "Configuration ready to generate"}</span>
            <Button aria-describedby={generationBlocker ? "generation-blocker" : undefined} aria-label={isPending ? "Saving and generating solutions" : "Save configuration & generate solutions"} className="min-w-48" disabled={Boolean(generationBlocker) || isPending} type="submit">
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
    <section aria-label="Detected project location" className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><MapPin className="size-4" /></span>
      <div className="min-w-0 flex-1"><p className="text-[11px] font-medium text-slate-500">Detected bill address</p><strong className="mt-1 block text-sm font-medium leading-5 text-slate-950">{address ?? "No site address detected"}</strong></div>
      {mapsHref ? <a className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-cyan-800 hover:bg-cyan-50 hover:text-cyan-950" href={mapsHref} rel="noreferrer" target="_blank">Directions in Google Maps <ExternalLink className="size-3.5" /></a> : null}
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
      <RangeFields label="Target PV range" onChange={onRangeChange} range={range} unit="kWp DC" />
      <CandidateValuesSummary range={range} strictlyPositiveMinimum unit="kWp" />
      {profile ? (
        <ProfileDetails label="Solar performance details">
          <ProfileFact label="Module efficiency" value={`${formatNumber(profile.module_efficiency_percent)}%`} />
          <ProfileFact label="Technology" value={humanize(profile.module_technology)} />
          <ProfileFact label="Temperature coefficient" value={`${formatNumber(profile.temperature_coefficient_percent_per_c)}% / °C`} />
          <ProfileFact label="Annual degradation" value={`${formatNumber(profile.annual_degradation_percent)}% / yr`} />
          <ProfileFact label="Default DC/AC" value={formatNumber(profile.default_dc_ac_ratio)} />
        </ProfileDetails>
      ) : <MissingProfile />}
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
      <RangeFields label="Target battery range" onChange={onRangeChange} range={range} unit="kWh (0 includes PV-only)" />
      <CandidateValuesSummary range={range} unit="kWh" />
      {profile ? (
        <ProfileDetails label="Battery performance details">
          <ProfileFact label="Chemistry / coupling" value={`${profile.chemistry} · ${profile.coupling.toUpperCase()}`} />
          <ProfileFact label="Power ratio" value={`${formatNumber(profile.continuous_power_kw_per_unit / profile.nominal_capacity_kwh_per_unit)} kW/kWh`} />
          <ProfileFact label="Pack RTE" value={`${formatNumber(profile.round_trip_efficiency_percent)}%`} />
          <ProfileFact label="Conversion efficiency" value={`${formatNumber(profile.power_conversion_efficiency_percent)}%`} />
          <ProfileFact label="Usable DoD" value={`${formatNumber(profile.usable_depth_of_discharge_percent)}%`} />
          <ProfileFact label="Standby loss" value={`${formatNumber(profile.standby_loss_percent_per_month)}% / month`} />
          <ProfileFact label="Annual degradation" value={`${formatNumber(profile.annual_capacity_degradation_percent)}% / yr`} />
        </ProfileDetails>
      ) : <MissingProfile />}
    </ProfileCard>
  );
}

function InverterProfileCard({ onProfileChange, onQuantityChange, profile, profiles, quantity, separateAc }: {
  onProfileChange: (profileId: string) => void;
  onQuantityChange: (value: string) => void;
  profile: CiInverterSolutionProfile | null;
  profiles: CiInverterSolutionProfile[];
  quantity: string;
  separateAc: boolean;
}) {
  const count = quantity.trim() && !inverterQuantityError(quantity) ? Number(quantity) : null;
  return (
    <ProfileCard icon={Cpu} title="Inverter / PCS">
      <SelectField label="Inverter performance profile" onChange={onProfileChange} options={profiles.map((item) => [item.profile_id, `${item.name} · v${item.version}`])} value={profile?.profile_id ?? ""} />
      <NumberField label={separateAc ? "Battery PCS quantity" : "Inverter quantity"} min={1} max={10_000} step={1} placeholder="Auto" onChange={onQuantityChange} value={quantity} />
      {profile && count !== null ? <div aria-label="Configured inverter totals" className="rounded-lg bg-cyan-50 p-3 text-xs text-cyan-950">
        <p className="font-semibold tabular-nums">{count} × {formatNumber(profile.rated_active_power_kw)} kW = {formatNumber(count * profile.rated_active_power_kw)} kW</p>
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <ProfileFact label="Total apparent power" value={`${formatNumber(count * profile.rated_apparent_power_kva)} kVA`} />
          <ProfileFact label="Total reactive cap" value={`${formatNumber(profile.reactive_support_enabled ? count * profile.maximum_reactive_power_kvar : 0)} kvar`} />
        </dl>
        {separateAc ? <p className="mt-2">Battery PCS total · PV inverter sized separately</p> : null}
      </div> : !quantity.trim() ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Automatic capacity sizing</p> : null}
      {profile ? <>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <ProfileFact label="Reactive compensation" value={profile.reactive_support_enabled ? "On" : "Off"} />
          <ProfileFact label="Cap per inverter" value={`${formatNumber(profile.maximum_reactive_power_kvar)} kvar`} />
        </dl>
        <ProfileDetails label="Inverter performance details">
          <ProfileFact label="Power per inverter" value={`${formatNumber(profile.rated_active_power_kw)} kW`} />
          <ProfileFact label="Apparent power per inverter" value={`${formatNumber(profile.rated_apparent_power_kva)} kVA`} />
          <ProfileFact label="Apparent / active ratio" value={formatNumber(profile.rated_apparent_power_kva / profile.rated_active_power_kw)} />
          <ProfileFact label="Reactive / active ratio" value={formatNumber(profile.maximum_reactive_power_kvar / profile.rated_active_power_kw)} />
          <ProfileFact label="European efficiency" value={`${formatNumber(profile.european_efficiency_percent)}%`} />
          <ProfileFact label="Maximum efficiency" value={`${formatNumber(profile.maximum_efficiency_percent)}%`} />
          <ProfileFact label="Source" value={profile.source_label} />
        </ProfileDetails>
      </> : <MissingProfile />}
    </ProfileCard>
  );
}

function ProfileCard({ children, icon: Icon, title }: { children: ReactNode; icon: typeof SunMedium; title: string }) {
  return (
    <section aria-label={`${title} profile`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-center gap-2.5"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Icon className="size-4" /></span><div><h4 className="text-sm font-semibold text-slate-950">{title}</h4><span className="text-[11px] text-slate-500">Performance reference</span></div></div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function ProfileDetails({ children, label }: { children: ReactNode; label: string }) {
  return <details className="group border-t border-slate-200 pt-3"><summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-slate-600 [&::-webkit-details-marker]:hidden">{label}<ChevronDown aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open:rotate-180" /></summary><dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-slate-50 p-3 text-xs">{children}</dl></details>;
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

function NumberField({ allowBlank = false, min = 0, max, step = "any", placeholder, label, onChange, value }: { allowBlank?: boolean; min?: number; max?: number; step?: number | "any"; placeholder?: string; label: string; onChange: (value: string) => void; value: string }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><input aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm tabular-nums text-slate-950" min={min} max={max} onChange={(event) => onChange(event.target.value)} placeholder={placeholder ?? (allowBlank ? "Not modelled" : undefined)} step={step} type="number" value={value} /></label>;
}

function TextField({ className = "", label, onChange, value }: { className?: string; label: string; onChange: (value: string) => void; value: string }) {
  return <label className={`grid gap-1 text-xs font-medium text-slate-600 ${className}`}><span>{label}</span><input aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950" maxLength={160} onChange={(event) => onChange(event.target.value)} type="text" value={value} /></label>;
}

function SelectField({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: Array<[string, string]>; value: string }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><select aria-label={label} className="min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950" onChange={(event) => onChange(event.target.value)} value={value}>{options.length === 0 ? <option value="">No published profiles</option> : null}{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}

function ProfileFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[10px] font-medium text-slate-500">{label}</dt><dd className="mt-1 break-words font-medium tabular-nums text-slate-800">{value}</dd></div>;
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
  if (inverterQuantityError(connection.inverter_quantity)) return null;
  const quantity = connection.inverter_quantity.trim() ? Number(connection.inverter_quantity) : null;
  const headroom = parseNumber(connection.site_ac_headroom_kw);
  const reactiveEnabled = inverterProfile.reactive_support_enabled;
  const reactive = reactiveEnabled ? inverterProfile.maximum_reactive_power_kvar : 0;
  const emissions = connection.grid_emissions_factor_kg_co2e_per_kwh.trim() ? parseNumber(connection.grid_emissions_factor_kg_co2e_per_kwh) : null;
  const losses = [shading, soiling, temperature, wiring, other];
  const latitude = parseNumber(site.latitude_degrees);
  const longitude = parseNumber(site.longitude_degrees);
  if (site.pv_timing_model === "solar_geometry_screening_v1" && (
    !between(latitude, -90, 90) || !between(longitude, -180, 180) ||
    !site.location_source_label.trim() || site.location_source_label.trim().length > 240 || !site.location_confirmed
  )) return null;
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
      pv_timing_model: site.pv_timing_model,
      ...(site.pv_timing_model === "solar_geometry_screening_v1" ? {
        latitude_degrees: latitude, longitude_degrees: longitude,
        location_source_label: site.location_source_label.trim(), location_confirmed: true,
      } : {}),
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
      dispatch_topology: connection.dispatch_topology,
      battery_efficiency_basis: connection.battery_efficiency_basis,
      inverter_block_size_kw: block,
      ...(quantity === null ? {} : { inverter_quantity: quantity }),
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
  if (context.contract_version === "ci_design_context_v2") {
    return isRestorableV2Context(context)
      ? restoreV2(context)
      : restoreRangesFromSolutions(defaults, solutions);
  }
  const options = context.technical_options;
  return {
    ...defaults,
    pvRange: solutions?.length ? rangeFromValues(solutions.map((item) => item.pv_capacity_kwp_dc).filter((value) => value > 0)) : defaults.pvRange,
    batteryRange: solutions?.length ? rangeFromValues(solutions.map((item) => item.nominal_capacity_kwh)) : defaults.batteryRange,
    site: siteFormFromTechnical(options),
    connection: connectionFormFromTechnical(options),
  };
}

function restoreRangesFromSolutions(
  defaults: RestoredBuilderState,
  solutions: CiScenarioInput[] | undefined,
): RestoredBuilderState {
  if (!solutions?.length) return defaults;
  return {
    ...defaults,
    pvRange: rangeFromValues(solutions.map((item) => item.pv_capacity_kwp_dc).filter((value) => value > 0)),
    batteryRange: rangeFromValues(solutions.map((item) => item.nominal_capacity_kwh)),
  };
}

function isRestorableV2Context(context: CiDesignContextV2): boolean {
  const candidate = context as unknown as Record<string, unknown>;
  const searchSpace = recordValue(candidate.search_space);
  const pvRange = recordValue(searchSpace?.pv_range);
  const batteryRange = recordValue(searchSpace?.battery_range);
  const siteFactors = recordValue(candidate.site_factors);
  const selection = recordValue(candidate.profile_selection);
  const technical = recordValue(candidate.technical_options);
  if (!pvRange || !batteryRange || !siteFactors || !selection || !technical) return false;

  const rangesAreFinite = [
    pvRange.minimum_kwp_dc,
    pvRange.maximum_kwp_dc,
    pvRange.step_kwp_dc,
    batteryRange.minimum_kwh,
    batteryRange.maximum_kwh,
    batteryRange.step_kwh,
  ].every(isFiniteNumber);
  const siteNumbersAreFinite = [
    siteFactors.annual_specific_yield_kwh_per_kw,
    siteFactors.array_azimuth_degrees,
    siteFactors.array_tilt_degrees,
    siteFactors.shading_loss_percent,
    siteFactors.soiling_loss_percent,
    siteFactors.temperature_loss_percent,
    siteFactors.wiring_mismatch_loss_percent,
    siteFactors.other_system_loss_percent,
    siteFactors.system_availability_percent,
  ].every(isFiniteNumber);
  const emissions = technical.grid_emissions_factor_kg_co2e_per_kwh;
  return rangesAreFinite && siteNumbersAreFinite &&
    typeof siteFactors.resource_source === "string" &&
    typeof siteFactors.resource_label === "string" &&
    typeof selection.solar_profile_id === "string" &&
    typeof selection.battery_profile_id === "string" &&
    (selection.inverter_profile_id === undefined || typeof selection.inverter_profile_id === "string") &&
    isFiniteNumber(technical.inverter_block_size_kw) &&
    isFiniteNumber(technical.site_ac_headroom_kw) &&
    (emissions === undefined || emissions === null || isFiniteNumber(emissions));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    site: siteFormFromFactors(context.site_factors),
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
    dispatch_topology: options.dispatch_topology ?? "shared_hybrid_dc",
    battery_efficiency_basis: options.battery_efficiency_basis ?? "pack_plus_conversion",
    inverter_block_size_kw: formatNumber(options.inverter_block_size_kw),
    inverter_quantity: options.inverter_quantity == null ? "" : String(options.inverter_quantity),
    site_ac_headroom_kw: formatNumber(options.site_ac_headroom_kw),
    allow_grid_charging: true,
    grid_emissions_factor_kg_co2e_per_kwh: options.grid_emissions_factor_kg_co2e_per_kwh ? formatNumber(options.grid_emissions_factor_kg_co2e_per_kwh) : "",
  };
}

function inverterQuantityError(value: string): string | null {
  if (!value.trim()) return null;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 10_000
    ? null
    : "Inverter quantity must be a whole number from 1 to 10,000.";
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

function siteFormFromFactors(factors: CiSiteFactors): SiteFactorsForm {
  return {
      pv_timing_model: factors.pv_timing_model ?? "generic_normalized_solar_shape_v1",
      latitude_degrees: factors.latitude_degrees == null ? "" : String(factors.latitude_degrees),
      longitude_degrees: factors.longitude_degrees == null ? "" : String(factors.longitude_degrees),
      location_source_label: factors.location_source_label ?? "",
      location_confirmed: factors.location_confirmed === true,
      resource_source: factors.resource_source,
      resource_label: factors.resource_label,
      annual_specific_yield_kwh_per_kw: formatNumber(factors.annual_specific_yield_kwh_per_kw),
      array_azimuth_degrees: formatNumber(factors.array_azimuth_degrees),
      array_tilt_degrees: formatNumber(factors.array_tilt_degrees),
      shading_loss_percent: formatNumber(factors.shading_loss_percent),
      soiling_loss_percent: formatNumber(factors.soiling_loss_percent),
      temperature_loss_percent: formatNumber(factors.temperature_loss_percent),
      wiring_mismatch_loss_percent: formatNumber(factors.wiring_mismatch_loss_percent),
      other_system_loss_percent: formatNumber(factors.other_system_loss_percent),
      system_availability_percent: formatNumber(factors.system_availability_percent),
  };
}

function siteFactorsInput(site: SiteFactorsForm): CiSiteFactors | null {
  const { latitude_degrees, longitude_degrees, location_source_label, location_confirmed, ...rest } = site;
  const numbers = Object.fromEntries(Object.entries(rest).filter(([key]) => !["resource_source", "resource_label", "pv_timing_model"].includes(key)).map(([key, value]) => [key, parseNumber(value)]));
  if (effectiveSpecificYield(site) === null || !between(numbers.annual_specific_yield_kwh_per_kw, 500, 3000) || !between(numbers.array_azimuth_degrees, 0, 360) || !between(numbers.array_tilt_degrees, 0, 90) || !site.resource_label.trim() || site.resource_label.trim().length > 160) return null;
  if (site.pv_timing_model === "solar_geometry_screening_v1" && (!between(parseNumber(latitude_degrees), -90, 90) || !between(parseNumber(longitude_degrees), -180, 180) || !location_source_label.trim() || !location_confirmed)) return null;
  return {
    ...numbers, resource_basis: "gross_specific_yield_before_site_losses", resource_source: site.resource_source,
    resource_label: site.resource_label.trim(), pv_timing_model: site.pv_timing_model,
    ...(site.pv_timing_model === "solar_geometry_screening_v1" ? { latitude_degrees: parseNumber(latitude_degrees), longitude_degrees: parseNumber(longitude_degrees), location_source_label, location_confirmed } : {}),
  } as CiSiteFactors;
}

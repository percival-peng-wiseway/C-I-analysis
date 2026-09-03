import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BatteryCharging, BadgeDollarSign, Check, CirclePlus, Library, Settings2, SunMedium, X, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { invalidateAllCiCalculationHandbooks } from "@/features/ci/api/ci-calculation-handbook";
import {
  ciDeviceProfileQueryKey,
  fetchCiDeviceProfile,
  saveCiDeviceProfile,
  type CiBatterySolutionProfile,
  type CiDeviceProfile,
  type CiInverterSolutionProfile,
  type CiSolarSolutionProfile,
  type CiSolutionProfileSourceType,
  type CiSolutionProfileStatus,
} from "@/features/ci/api/ci-device-profile";

type SettingsSection = "solution_profiles" | "equipment_finance";
type SolutionProfileKind = "solar" | "battery" | "inverter";

export function CiSettingsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const settingsTabsId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const profileQuery = useQuery({ queryKey: ciDeviceProfileQueryKey, queryFn: () => fetchCiDeviceProfile() });
  const [draft, setDraft] = useState<CiDeviceProfile | null>(null);
  const [section, setSection] = useState<SettingsSection>("solution_profiles");
  const [profileKind, setProfileKind] = useState<SolutionProfileKind>("solar");
  const [selectedSolarId, setSelectedSolarId] = useState<string | null>(null);
  const [selectedBatteryId, setSelectedBatteryId] = useState<string | null>(null);
  const [selectedInverterId, setSelectedInverterId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (profile: CiDeviceProfile) => saveCiDeviceProfile(profile),
    onSuccess: (state) => {
      queryClient.setQueryData(ciDeviceProfileQueryKey, structuredClone(state));
      if (state.profile) setDraft(structuredClone(state.profile));
      void queryClient.resetQueries({ queryKey: ["ci-design-price-preview"] });
      void queryClient.resetQueries({ queryKey: ["ci-project-rebate-profile"] });
      void queryClient.invalidateQueries({ queryKey: ["ci-project-annual-financial-comparison"] });
      void invalidateAllCiCalculationHandbooks(queryClient);
    },
  });

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !save.isPending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, save.isPending]);

  useEffect(() => {
    if (profileQuery.data && draft === null) {
      const next = structuredClone(profileQuery.data.profile ?? profileQuery.data.suggested_profile);
      setDraft(next);
      setSelectedSolarId(next.default_solution_profile_selection.solar_profile_id);
      setSelectedBatteryId(next.default_solution_profile_selection.battery_profile_id);
      setSelectedInverterId(next.solution_profiles.inverter_profiles[0]?.profile_id ?? null);
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

  const addProfile = (kind: SolutionProfileKind) => {
    if (!draft) return;
    if (kind === "solar") {
      if (draft.solution_profiles.solar_profiles.length >= 50) return;
      const source = draft.solution_profiles.solar_profiles.find((item) => item.profile_id === draft.default_solution_profile_selection.solar_profile_id) ?? draft.solution_profiles.solar_profiles[0];
      const profile: CiSolarSolutionProfile = { ...structuredClone(source), profile_id: stableProfileId("solar", draft.solution_profiles.solar_profiles), version: 1, status: "draft", name: "New solar profile", source_type: "analyst_assumption", source_label: "Analyst-entered draft assumptions", source_date: null };
      setDraft((current) => current ? { ...current, solution_profiles: { ...current.solution_profiles, solar_profiles: [...current.solution_profiles.solar_profiles, profile] } } : current);
      setSelectedSolarId(profile.profile_id);
      return;
    }
    if (kind === "battery") {
      if (draft.solution_profiles.battery_profiles.length >= 50) return;
      const source = draft.solution_profiles.battery_profiles.find((item) => item.profile_id === draft.default_solution_profile_selection.battery_profile_id) ?? draft.solution_profiles.battery_profiles[0];
      const profile: CiBatterySolutionProfile = { ...structuredClone(source), profile_id: stableProfileId("battery", draft.solution_profiles.battery_profiles), version: 1, status: "draft", name: "New battery profile", source_type: "analyst_assumption", source_label: "Analyst-entered draft assumptions", source_date: null };
      setDraft((current) => current ? { ...current, solution_profiles: { ...current.solution_profiles, battery_profiles: [...current.solution_profiles.battery_profiles, profile] } } : current);
      setSelectedBatteryId(profile.profile_id);
      return;
    }
    if (draft.solution_profiles.inverter_profiles.length >= 50) return;
    const source = draft.solution_profiles.inverter_profiles[0];
    const profile: CiInverterSolutionProfile = { ...structuredClone(source), profile_id: stableProfileId("inverter", draft.solution_profiles.inverter_profiles), version: 1, status: "draft", name: "New inverter profile", source_type: "analyst_assumption", source_label: "Analyst-entered draft assumptions", source_date: null };
    setDraft((current) => current ? { ...current, solution_profiles: { ...current.solution_profiles, inverter_profiles: [...current.solution_profiles.inverter_profiles, profile] } } : current);
    setSelectedInverterId(profile.profile_id);
  };

  const updateSolarProfile = (profile: CiSolarSolutionProfile) => setDraft((current) => current ? {
    ...current,
    solution_profiles: { ...current.solution_profiles, solar_profiles: current.solution_profiles.solar_profiles.map((item) => item.profile_id === profile.profile_id ? profile : item) },
  } : current);
  const updateBatteryProfile = (profile: CiBatterySolutionProfile) => setDraft((current) => current ? {
    ...current,
    solution_profiles: { ...current.solution_profiles, battery_profiles: current.solution_profiles.battery_profiles.map((item) => item.profile_id === profile.profile_id ? profile : item) },
  } : current);
  const updateInverterProfile = (profile: CiInverterSolutionProfile) => setDraft((current) => current ? {
    ...current,
    solution_profiles: { ...current.solution_profiles, inverter_profiles: current.solution_profiles.inverter_profiles.map((item) => item.profile_id === profile.profile_id ? profile : item) },
  } : current);

  const validationMessage = draft ? validateDraft(draft) : "Device profile is not available.";

  return (
    <div aria-busy={profileQuery.isPending || save.isPending} aria-label="Settings" aria-modal="true" className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-[2px]" onKeyDown={trapFocus} role="dialog">
      <button aria-hidden="true" className="min-w-0 flex-1 cursor-default" disabled={save.isPending} onClick={onClose} tabIndex={-1} type="button" />
      <section className="flex h-full w-full max-w-[760px] flex-col overflow-hidden bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Settings2 className="size-5" /></span><div><p className="text-xs font-semibold uppercase tracking-[.15em] text-cyan-700">Settings</p><h2 className="text-lg font-semibold text-slate-950">Device profile</h2></div></div>
          <Button aria-label="Close settings panel" className="size-9 p-0" disabled={save.isPending} onClick={onClose} ref={closeButtonRef} type="button" variant="ghost"><X className="size-4" /></Button>
        </header>

        <div aria-label="Settings sections" className="grid grid-cols-2 border-b border-slate-200 bg-slate-50 px-5 pt-3" onKeyDown={activateAdjacentTab} role="tablist">
          <SettingsTab active={section === "solution_profiles"} controls={`${settingsTabsId}-solution-profiles-panel`} id={`${settingsTabsId}-solution-profiles-tab`} label="Solution profiles" onClick={() => setSection("solution_profiles")} />
          <SettingsTab active={section === "equipment_finance"} controls={`${settingsTabsId}-equipment-finance-panel`} id={`${settingsTabsId}-equipment-finance-tab`} label="Equipment & finance" onClick={() => setSection("equipment_finance")} />
        </div>

        <div aria-labelledby={`${settingsTabsId}-${section === "solution_profiles" ? "solution-profiles" : "equipment-finance"}-tab`} className="flex-1 overflow-y-auto p-5 sm:p-6" id={`${settingsTabsId}-${section === "solution_profiles" ? "solution-profiles" : "equipment-finance"}-panel`} role="tabpanel">
          {profileQuery.isPending || !draft ? <p aria-live="polite" className="text-sm text-slate-500" role="status">Loading Device profile…</p> : null}
          {profileQuery.isError ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">Device profile could not be loaded.</p> : null}
          {draft ? (
            <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); if (!validationMessage) save.mutate(draft); }}>
              <fieldset className="space-y-6 disabled:opacity-70" disabled={save.isPending}>
                {section === "solution_profiles" ? (
                  <SolutionProfilesLibrary
                    defaultBatteryId={draft.default_solution_profile_selection.battery_profile_id}
                    defaultSolarId={draft.default_solution_profile_selection.solar_profile_id}
                    kind={profileKind}
                    onAdd={addProfile}
                    onDefaultBattery={(battery_profile_id) => setDraft((current) => current ? { ...current, default_solution_profile_selection: { ...current.default_solution_profile_selection, battery_profile_id } } : current)}
                    onDefaultSolar={(solar_profile_id) => setDraft((current) => current ? { ...current, default_solution_profile_selection: { ...current.default_solution_profile_selection, solar_profile_id } } : current)}
                    onKindChange={setProfileKind}
                    onSelectBattery={setSelectedBatteryId}
                    onSelectInverter={setSelectedInverterId}
                    onSelectSolar={setSelectedSolarId}
                    onUpdateBattery={updateBatteryProfile}
                    onUpdateInverter={updateInverterProfile}
                    onUpdateSolar={updateSolarProfile}
                    profiles={draft.solution_profiles}
                    selectedBatteryId={selectedBatteryId}
                    selectedInverterId={selectedInverterId}
                    selectedSolarId={selectedSolarId}
                  />
                ) : (
                  <EquipmentAndFinance
                    draft={draft}
                    onBatteryPrice={updateBatteryPrice}
                    onDraftChange={setDraft}
                    onInverterPrice={updateInverterPrice}
                    onPvPrice={updatePvPrice}
                  />
                )}
              </fieldset>

              {validationMessage ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert">{validationMessage}</p> : null}
              {save.error instanceof Error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{save.error.message}</p> : null}
              {save.isSuccess ? <p aria-live="polite" className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800" role="status"><Check className="size-4" />Device profile saved. Existing finance results are marked for recalculation.</p> : null}
              <div className="flex justify-end gap-2 border-t border-slate-200 pt-5"><Button disabled={save.isPending} onClick={onClose} type="button" variant="outline">Cancel</Button><Button disabled={save.isPending || Boolean(validationMessage)} type="submit">{save.isPending ? "Saving…" : "Save profile"}</Button></div>
            </form>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function SettingsTab({ active, controls, id, label, onClick }: { active: boolean; controls: string; id: string; label: string; onClick: () => void }) {
  return <button aria-controls={controls} aria-selected={active} className={`border-b-2 px-3 py-3 text-sm font-semibold ${active ? "border-cyan-600 text-cyan-900" : "border-transparent text-slate-500 hover:text-slate-800"}`} id={id} onClick={onClick} role="tab" tabIndex={active ? 0 : -1} type="button">{label}</button>;
}

function SolutionProfilesLibrary({ defaultBatteryId, defaultSolarId, kind, onAdd, onDefaultBattery, onDefaultSolar, onKindChange, onSelectBattery, onSelectInverter, onSelectSolar, onUpdateBattery, onUpdateInverter, onUpdateSolar, profiles, selectedBatteryId, selectedInverterId, selectedSolarId }: {
  defaultBatteryId: string;
  defaultSolarId: string;
  kind: SolutionProfileKind;
  onAdd: (kind: SolutionProfileKind) => void;
  onDefaultBattery: (profileId: string) => void;
  onDefaultSolar: (profileId: string) => void;
  onKindChange: (kind: SolutionProfileKind) => void;
  onSelectBattery: (profileId: string) => void;
  onSelectInverter: (profileId: string) => void;
  onSelectSolar: (profileId: string) => void;
  onUpdateBattery: (profile: CiBatterySolutionProfile) => void;
  onUpdateInverter: (profile: CiInverterSolutionProfile) => void;
  onUpdateSolar: (profile: CiSolarSolutionProfile) => void;
  profiles: CiDeviceProfile["solution_profiles"];
  selectedBatteryId: string | null;
  selectedInverterId: string | null;
  selectedSolarId: string | null;
}) {
  const profileTabsId = useId();
  const selectedSolar = profiles.solar_profiles.find((item) => item.profile_id === selectedSolarId) ?? profiles.solar_profiles[0];
  const selectedBattery = profiles.battery_profiles.find((item) => item.profile_id === selectedBatteryId) ?? profiles.battery_profiles[0];
  const selectedInverter = profiles.inverter_profiles.find((item) => item.profile_id === selectedInverterId) ?? profiles.inverter_profiles[0];
  return (
    <section aria-labelledby="solution-profiles-title" className="space-y-5">
      <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><Library className="size-5" /></span><div><h3 className="font-semibold text-slate-950" id="solution-profiles-title">Solution profile library</h3><p className="mt-1 text-xs leading-5 text-slate-500">Only Published solar and battery profiles can be selected as generator defaults. Drafts can be saved and retired profiles remain available for audit history.</p></div></div>
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">Draft evidence is stored for completion but is excluded from solution generation and reactive-support claims.</p>

      <div aria-label="Solution profile types" className="grid grid-cols-3 rounded-lg bg-slate-100 p-1" onKeyDown={activateAdjacentTab} role="tablist">
        <ProfileKindTab active={kind === "solar"} controls={`${profileTabsId}-solar-panel`} icon={SunMedium} id={`${profileTabsId}-solar-tab`} label="Solar" onClick={() => onKindChange("solar")} />
        <ProfileKindTab active={kind === "battery"} controls={`${profileTabsId}-battery-panel`} icon={BatteryCharging} id={`${profileTabsId}-battery-tab`} label="Battery" onClick={() => onKindChange("battery")} />
        <ProfileKindTab active={kind === "inverter"} controls={`${profileTabsId}-inverter-panel`} icon={Zap} id={`${profileTabsId}-inverter-tab`} label="Inverter" onClick={() => onKindChange("inverter")} />
      </div>

      <div aria-labelledby={`${profileTabsId}-${kind}-tab`} id={`${profileTabsId}-${kind}-panel`} role="tabpanel">
        {kind === "solar" ? (
        <>
          <ProfileList
            defaultId={defaultSolarId}
            kind="solar"
            onAdd={() => onAdd("solar")}
            onDefault={onDefaultSolar}
            onSelect={onSelectSolar}
            profiles={profiles.solar_profiles}
            selectedId={selectedSolar?.profile_id ?? null}
          />
          {selectedSolar ? <SolarProfileEditor isDefault={selectedSolar.profile_id === defaultSolarId} onDefault={() => onDefaultSolar(selectedSolar.profile_id)} onUpdate={onUpdateSolar} profile={selectedSolar} /> : null}
        </>
      ) : kind === "battery" ? (
        <>
          <ProfileList
            defaultId={defaultBatteryId}
            kind="battery"
            onAdd={() => onAdd("battery")}
            onDefault={onDefaultBattery}
            onSelect={onSelectBattery}
            profiles={profiles.battery_profiles}
            selectedId={selectedBattery?.profile_id ?? null}
          />
          {selectedBattery ? <BatteryProfileEditor isDefault={selectedBattery.profile_id === defaultBatteryId} onDefault={() => onDefaultBattery(selectedBattery.profile_id)} onUpdate={onUpdateBattery} profile={selectedBattery} /> : null}
        </>
      ) : (
        <>
          <ProfileList
            defaultId={null}
            kind="inverter"
            onAdd={() => onAdd("inverter")}
            onSelect={onSelectInverter}
            profiles={profiles.inverter_profiles}
            selectedId={selectedInverter?.profile_id ?? null}
          />
          {selectedInverter ? <InverterProfileEditor onUpdate={onUpdateInverter} profile={selectedInverter} /> : null}
        </>
        )}
      </div>
    </section>
  );
}

function ProfileKindTab({ active, controls, icon: Icon, id, label, onClick }: { active: boolean; controls: string; icon: typeof SunMedium; id: string; label: string; onClick: () => void }) {
  return <button aria-controls={controls} aria-selected={active} className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${active ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`} id={id} onClick={onClick} role="tab" tabIndex={active ? 0 : -1} type="button"><Icon className="size-4" />{label}</button>;
}

function ProfileList({ defaultId, kind, onAdd, onDefault, onSelect, profiles, selectedId }: {
  defaultId: string | null;
  kind: SolutionProfileKind;
  onAdd: () => void;
  onDefault?: (profileId: string) => void;
  onSelect: (profileId: string) => void;
  profiles: Array<CiSolarSolutionProfile | CiBatterySolutionProfile | CiInverterSolutionProfile>;
  selectedId: string | null;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-sm font-semibold capitalize text-slate-950">{kind} profiles</h4><Button className="h-8 px-3 text-xs" disabled={profiles.length >= 50} onClick={onAdd} type="button" variant="outline"><CirclePlus className="size-3.5" />Add profile</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">
        {profiles.map((profile) => {
          const selected = profile.profile_id === selectedId;
          const isDefault = profile.profile_id === defaultId;
          return (
            <article className={`rounded-xl border p-3 ${selected ? "border-cyan-300 bg-cyan-50/50" : "border-slate-200 bg-white"}`} key={profile.profile_id}>
              <button aria-label={`Edit ${kind} profile ${profile.name}`} className="w-full text-left" onClick={() => onSelect(profile.profile_id)} type="button"><span className="flex items-start justify-between gap-2"><span><strong className="block text-sm text-slate-950">{profile.name}</strong><small className="mt-1 block text-xs text-slate-500">{profile.manufacturer} · {profile.model}</small></span><StatusBadge status={profile.status} /></span><span className="mt-3 block text-[10px] text-slate-400">{profile.profile_id} · v{profile.version}</span></button>
              {onDefault ? <button aria-label={`Set ${profile.name} as default ${kind} profile`} className={`mt-3 w-full rounded-md border px-2 py-1.5 text-xs font-semibold ${isDefault ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 text-slate-600 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"}`} disabled={profile.status !== "published" || isDefault} onClick={() => onDefault(profile.profile_id)} type="button">{isDefault ? "Default" : profile.status === "published" ? "Set as default" : "Publish to use"}</button> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: CiSolutionProfileStatus }) {
  const tone = status === "published" ? "bg-emerald-100 text-emerald-800" : status === "retired" ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-800";
  return <span className={`rounded-full px-2 py-1 text-[10px] font-semibold capitalize ${tone}`}>{status}</span>;
}

function SolarProfileEditor({ isDefault, onDefault, onUpdate, profile }: { isDefault: boolean; onDefault: () => void; onUpdate: (profile: CiSolarSolutionProfile) => void; profile: CiSolarSolutionProfile }) {
  return (
    <ProfileEditorShell isDefault={isDefault} kind="solar" onDefault={onDefault} onStatusChange={(status) => onUpdate({ ...profile, status })} onVersionChange={(version) => onUpdate({ ...profile, version })} profile={profile}>
      <TextProfileField label="Name" onChange={(name) => onUpdate({ ...profile, name })} value={profile.name} />
      <TextProfileField label="Manufacturer" onChange={(manufacturer) => onUpdate({ ...profile, manufacturer })} value={profile.manufacturer} />
      <TextProfileField label="Model" onChange={(model) => onUpdate({ ...profile, model })} value={profile.model} />
      <label className="grid gap-1 text-xs font-medium text-slate-600"><span>Module technology</span><select aria-label="Module technology" className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" onChange={(event) => onUpdate({ ...profile, module_technology: event.target.value as CiSolarSolutionProfile["module_technology"] })} value={profile.module_technology}><option value="monocrystalline">Monocrystalline</option><option value="polycrystalline">Polycrystalline</option><option value="thin_film">Thin film</option><option value="other">Other</option></select></label>
      <NumberProfileField label="Rated power" onChange={(rated_power_w) => onUpdate({ ...profile, rated_power_w })} suffix="W" value={profile.rated_power_w} />
      <NumberProfileField label="Module efficiency" onChange={(module_efficiency_percent) => onUpdate({ ...profile, module_efficiency_percent })} suffix="%" value={profile.module_efficiency_percent} />
      <NumberProfileField label="Temperature coefficient" onChange={(temperature_coefficient_percent_per_c) => onUpdate({ ...profile, temperature_coefficient_percent_per_c })} suffix="% / °C" value={profile.temperature_coefficient_percent_per_c} />
      <NumberProfileField label="Annual degradation" onChange={(annual_degradation_percent) => onUpdate({ ...profile, annual_degradation_percent })} suffix="% / yr" value={profile.annual_degradation_percent} />
      <NumberProfileField label="Default DC/AC ratio" onChange={(default_dc_ac_ratio) => onUpdate({ ...profile, default_dc_ac_ratio })} value={profile.default_dc_ac_ratio} />
      <SourceFields onUpdate={(source) => onUpdate({ ...profile, ...source })} profile={profile} />
    </ProfileEditorShell>
  );
}

function BatteryProfileEditor({ isDefault, onDefault, onUpdate, profile }: { isDefault: boolean; onDefault: () => void; onUpdate: (profile: CiBatterySolutionProfile) => void; profile: CiBatterySolutionProfile }) {
  const missingFields = batteryMissingFields(profile);
  return (
    <ProfileEditorShell isDefault={isDefault} kind="battery" onDefault={onDefault} onStatusChange={(status) => onUpdate({ ...profile, status })} onVersionChange={(version) => onUpdate({ ...profile, version })} profile={profile}>
      {missingFields.length ? <p className="col-span-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Draft only — confirm before publishing: {missingFields.join(", ")}.</p> : null}
      <TextProfileField label="Name" onChange={(name) => onUpdate({ ...profile, name })} value={profile.name} />
      <TextProfileField label="Manufacturer" onChange={(manufacturer) => onUpdate({ ...profile, manufacturer })} value={profile.manufacturer} />
      <TextProfileField label="Model" onChange={(model) => onUpdate({ ...profile, model })} value={profile.model} />
      <TextProfileField label="Chemistry" onChange={(chemistry) => onUpdate({ ...profile, chemistry })} value={profile.chemistry} />
      <label className="grid gap-1 text-xs font-medium text-slate-600"><span>Coupling</span><select aria-label="Coupling" className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" onChange={(event) => onUpdate({ ...profile, coupling: event.target.value ? event.target.value as "ac" | "dc" : null })} value={profile.coupling ?? ""}><option value="">Needs confirmation</option><option value="ac">AC</option><option value="dc">DC</option></select></label>
      <NullableNumberProfileField label="Nominal capacity per unit" onChange={(nominal_capacity_kwh_per_unit) => onUpdate({ ...profile, nominal_capacity_kwh_per_unit })} suffix="kWh" value={profile.nominal_capacity_kwh_per_unit} />
      <NullableNumberProfileField label="Continuous power per unit" onChange={(continuous_power_kw_per_unit) => onUpdate({ ...profile, continuous_power_kw_per_unit })} suffix="kW" value={profile.continuous_power_kw_per_unit} />
      <NullableNumberProfileField label="Round-trip efficiency" onChange={(round_trip_efficiency_percent) => onUpdate({ ...profile, round_trip_efficiency_percent })} suffix="%" value={profile.round_trip_efficiency_percent} />
      <NullableNumberProfileField label="Power conversion efficiency" onChange={(power_conversion_efficiency_percent) => onUpdate({ ...profile, power_conversion_efficiency_percent })} suffix="%" value={profile.power_conversion_efficiency_percent} />
      <NullableNumberProfileField label="Usable depth of discharge" onChange={(usable_depth_of_discharge_percent) => onUpdate({ ...profile, usable_depth_of_discharge_percent })} suffix="%" value={profile.usable_depth_of_discharge_percent} />
      <NullableNumberProfileField label="Standby loss" onChange={(standby_loss_percent_per_month) => onUpdate({ ...profile, standby_loss_percent_per_month })} suffix="% / month" value={profile.standby_loss_percent_per_month} />
      <NullableNumberProfileField label="Annual capacity degradation" onChange={(annual_capacity_degradation_percent) => onUpdate({ ...profile, annual_capacity_degradation_percent })} suffix="% / yr" value={profile.annual_capacity_degradation_percent} />
      <NullableNumberProfileField integer label="Minimum units" onChange={(minimum_units) => onUpdate({ ...profile, minimum_units })} value={profile.minimum_units} />
      <NullableNumberProfileField integer label="Maximum units" onChange={(maximum_units) => onUpdate({ ...profile, maximum_units })} value={profile.maximum_units} />
      <SourceFields onUpdate={(source) => onUpdate({ ...profile, ...source })} profile={profile} />
    </ProfileEditorShell>
  );
}

function InverterProfileEditor({ onUpdate, profile }: { onUpdate: (profile: CiInverterSolutionProfile) => void; profile: CiInverterSolutionProfile }) {
  return (
    <ProfileEditorShell isDefault={false} kind="inverter" onStatusChange={(status) => onUpdate({ ...profile, status })} onVersionChange={(version) => onUpdate({ ...profile, version })} profile={profile}>
      <TextProfileField label="Name" onChange={(name) => onUpdate({ ...profile, name })} value={profile.name} />
      <TextProfileField label="Manufacturer" onChange={(manufacturer) => onUpdate({ ...profile, manufacturer })} value={profile.manufacturer} />
      <TextProfileField label="Model" onChange={(model) => onUpdate({ ...profile, model })} value={profile.model} />
      <NumberProfileField label="Rated active power" onChange={(rated_active_power_kw) => onUpdate({ ...profile, rated_active_power_kw })} suffix="kW" value={profile.rated_active_power_kw} />
      <NumberProfileField label="Rated apparent power" onChange={(rated_apparent_power_kva) => onUpdate({ ...profile, rated_apparent_power_kva })} suffix="kVA" value={profile.rated_apparent_power_kva} />
      <NumberProfileField label="Reactive support cap" onChange={(maximum_reactive_power_kvar) => onUpdate({ ...profile, maximum_reactive_power_kvar })} suffix="kvar" value={profile.maximum_reactive_power_kvar} />
      <NumberProfileField label="Leading power factor limit" onChange={(power_factor_leading_limit) => onUpdate({ ...profile, power_factor_leading_limit })} value={profile.power_factor_leading_limit} />
      <NumberProfileField label="Lagging power factor limit" onChange={(power_factor_lagging_limit) => onUpdate({ ...profile, power_factor_lagging_limit })} value={profile.power_factor_lagging_limit} />
      <BooleanProfileField label="P–Q capability curve available" onChange={(pq_capability_curve_available) => onUpdate({ ...profile, pq_capability_curve_available })} value={profile.pq_capability_curve_available} />
      <BooleanProfileField label="Reactive power at zero active power" onChange={(reactive_power_at_zero_active_power) => onUpdate({ ...profile, reactive_power_at_zero_active_power })} value={profile.reactive_power_at_zero_active_power} />
      <BooleanProfileField label="Night reactive capability" onChange={(night_reactive_capability) => onUpdate({ ...profile, night_reactive_capability })} value={profile.night_reactive_capability} />
      <NumberProfileField label="European efficiency" onChange={(european_efficiency_percent) => onUpdate({ ...profile, european_efficiency_percent })} suffix="%" value={profile.european_efficiency_percent} />
      <NumberProfileField label="Maximum efficiency" onChange={(maximum_efficiency_percent) => onUpdate({ ...profile, maximum_efficiency_percent })} suffix="%" value={profile.maximum_efficiency_percent} />
      <SourceFields onUpdate={(source) => onUpdate({ ...profile, ...source })} profile={profile} />
    </ProfileEditorShell>
  );
}

function ProfileEditorShell({ children, isDefault, kind, onDefault, onStatusChange, onVersionChange, profile }: { children: ReactNode; isDefault: boolean; kind: SolutionProfileKind; onDefault?: () => void; onStatusChange: (status: CiSolutionProfileStatus) => void; onVersionChange: (version: number) => void; profile: CiSolarSolutionProfile | CiBatterySolutionProfile | CiInverterSolutionProfile }) {
  return (
    <section aria-label={`Edit ${kind} profile`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold text-slate-950">Edit {kind} profile</h4><p className="mt-1 text-xs text-slate-500">The profile ID is stable. Increase the version when publishing revised assumptions.</p></div>{onDefault ? <Button disabled={profile.status !== "published" || isDefault} onClick={onDefault} type="button" variant="outline">{isDefault ? "Current default" : "Set as default"}</Button> : null}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-medium text-slate-600"><span>Profile ID</span><input aria-label="Profile ID" className="rounded-md border border-slate-200 bg-slate-100 px-2.5 py-2 text-sm text-slate-600" readOnly value={profile.profile_id} /></label>
        <NumberProfileField integer label="Version" onChange={onVersionChange} value={profile.version} />
        <label className="grid gap-1 text-xs font-medium text-slate-600"><span>Status</span><select aria-label="Status" className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm capitalize" onChange={(event) => onStatusChange(event.target.value as CiSolutionProfileStatus)} value={profile.status}><option value="draft">Draft</option><option value="published">Published</option><option value="retired">Retired</option></select></label>
        {children}
      </div>
    </section>
  );
}

function SourceFields({ onUpdate, profile }: { onUpdate: (source: Pick<CiSolarSolutionProfile, "source_type" | "source_label" | "source_date">) => void; profile: Pick<CiSolarSolutionProfile, "source_type" | "source_label" | "source_date"> }) {
  return <><label className="grid gap-1 text-xs font-medium text-slate-600"><span>Source type</span><select aria-label="Source type" className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" onChange={(event) => onUpdate({ ...profile, source_type: event.target.value as CiSolutionProfileSourceType })} value={profile.source_type}><option value="manufacturer_datasheet">Manufacturer datasheet</option><option value="supplier_data">Supplier data</option><option value="analyst_assumption">Analyst assumption</option></select></label><TextProfileField label="Source label" onChange={(source_label) => onUpdate({ ...profile, source_label })} value={profile.source_label} /><label className="grid gap-1 text-xs font-medium text-slate-600"><span>Source date <span className="font-normal text-slate-400">(optional)</span></span><input aria-label="Source date" className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" onChange={(event) => onUpdate({ ...profile, source_date: nullable(event.target.value) })} type="date" value={profile.source_date ?? ""} /></label></>;
}

function TextProfileField({ label, onChange, optional = false, value }: { label: string; onChange: (value: string) => void; optional?: boolean; value: string }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}{optional ? <span className="font-normal text-slate-400"> (optional)</span> : null}</span><input aria-label={label} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" maxLength={240} onChange={(event) => onChange(event.target.value)} type="text" value={value} /></label>;
}

function NumberProfileField({ integer = false, label, onChange, suffix, value }: { integer?: boolean; label: string; onChange: (value: number) => void; suffix?: string; value: number }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><span className="relative"><input aria-label={label} className={`w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm tabular-nums ${suffix ? "pr-20" : ""}`} onChange={(event) => onChange(integer ? Math.round(Number(event.target.value)) : Number(event.target.value))} step={integer ? "1" : "any"} type="number" value={value} />{suffix ? <span className="absolute right-2.5 top-2 text-xs text-slate-400">{suffix}</span> : null}</span></label>;
}

function NullableNumberProfileField({ integer = false, label, onChange, suffix, value }: { integer?: boolean; label: string; onChange: (value: number | null) => void; suffix?: string; value: number | null }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><span className="relative"><input aria-label={label} className={`w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm tabular-nums ${suffix ? "pr-20" : ""}`} onChange={(event) => { const raw = event.target.value; onChange(raw === "" ? null : integer ? Math.round(Number(raw)) : Number(raw)); }} placeholder="Required to publish" step={integer ? "1" : "any"} type="number" value={value ?? ""} />{suffix ? <span className="absolute right-2.5 top-2 text-xs text-slate-400">{suffix}</span> : null}</span></label>;
}

function BooleanProfileField({ label, onChange, value }: { label: string; onChange: (value: boolean) => void; value: boolean }) {
  return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span><select aria-label={label} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm" onChange={(event) => onChange(event.target.value === "yes")} value={value ? "yes" : "no"}><option value="yes">Yes</option><option value="no">No</option></select></label>;
}

function batteryMissingFields(profile: CiBatterySolutionProfile) {
  const fields: Array<[keyof CiBatterySolutionProfile, string]> = [
    ["coupling", "AC or DC coupling basis"],
    ["nominal_capacity_kwh_per_unit", "nominal capacity"],
    ["continuous_power_kw_per_unit", "continuous power"],
    ["round_trip_efficiency_percent", "round-trip efficiency"],
    ["power_conversion_efficiency_percent", "PCS conversion efficiency"],
    ["usable_depth_of_discharge_percent", "usable depth of discharge"],
    ["standby_loss_percent_per_month", "standby loss"],
    ["annual_capacity_degradation_percent", "annual capacity degradation"],
    ["minimum_units", "minimum units"],
    ["maximum_units", "maximum units"],
  ];
  return fields.filter(([key]) => profile[key] === null).map(([, label]) => label);
}

function EquipmentAndFinance({ draft, onBatteryPrice, onDraftChange, onInverterPrice, onPvPrice }: { draft: CiDeviceProfile; onBatteryPrice: (index: number, field: "capital_cost_aud" | "replacement_cost_aud" | "annual_om_aud", value: number) => void; onDraftChange: Dispatch<SetStateAction<CiDeviceProfile | null>>; onInverterPrice: (index: number, field: "capital_cost_aud" | "replacement_cost_aud" | "annual_om_aud", value: number) => void; onPvPrice: (field: "capital_cost_aud_per_kwp_dc" | "replacement_cost_aud_per_kwp_dc" | "annual_om_aud", value: number) => void }) {
  return <section aria-labelledby="equipment-finance-title" className="space-y-6"><div><h3 className="font-semibold text-slate-950" id="equipment-finance-title">Equipment &amp; finance</h3><p className="mt-1 text-xs leading-5 text-slate-500">AUD ex GST. The pricing catalog currently supports these three products only.</p><div className="mt-4 space-y-4"><EquipmentCard icon={SunMedium} manufacturer="Astronergy" model="ASTRO N7 600–630W" summary="Continuous PV capacity pricing"><PriceGridHeader first="Rate basis" /><PriceGridRow first="Per kWp DC" onCapital={(value) => onPvPrice("capital_cost_aud_per_kwp_dc", value)} onOm={(value) => onPvPrice("annual_om_aud", value)} onReplacement={(value) => onPvPrice("replacement_cost_aud_per_kwp_dc", value)} values={[draft.equipment_catalog.pv_products[0].capital_cost_aud_per_kwp_dc, draft.equipment_catalog.pv_products[0].replacement_cost_aud_per_kwp_dc, draft.equipment_catalog.pv_products[0].annual_om_aud]} /></EquipmentCard><EquipmentCard icon={BatteryCharging} manufacturer="Fox ESS" model="CQ7 C&I" summary="LFP · continuous capacity cost curve"><PriceGridHeader first="Reference capacity" />{draft.equipment_catalog.battery_products[0].cost_curve.map((point, index) => <PriceGridRow first={`${formatNumber(point.quantity * draft.equipment_catalog.battery_products[0].module_capacity_kwh)} kWh`} key={point.quantity} onCapital={(value) => onBatteryPrice(index, "capital_cost_aud", value)} onOm={(value) => onBatteryPrice(index, "annual_om_aud", value)} onReplacement={(value) => onBatteryPrice(index, "replacement_cost_aud", value)} values={[point.capital_cost_aud, point.replacement_cost_aud, point.annual_om_aud]} />)}</EquipmentCard><EquipmentCard icon={Zap} manufacturer="Fox ESS" model="H3 Plus Hybrid Inverter / PCS" summary="Continuous PCS capacity cost curve"><PriceGridHeader first="Reference capacity" />{draft.equipment_catalog.inverter_products[0].cost_curve.map((point, index) => <PriceGridRow first={`${point.capacity_kw_ac} kW`} key={point.capacity_kw_ac} onCapital={(value) => onInverterPrice(index, "capital_cost_aud", value)} onOm={(value) => onInverterPrice(index, "annual_om_aud", value)} onReplacement={(value) => onInverterPrice(index, "replacement_cost_aud", value)} values={[point.capital_cost_aud, point.replacement_cost_aud, point.annual_om_aud]} />)}</EquipmentCard></div></div><div className="border-t border-slate-200 pt-5"><div className="flex items-center gap-2"><BadgeDollarSign className="size-4 text-cyan-700" /><h3 className="text-sm font-semibold text-slate-950">Finance defaults</h3></div><div className="mt-3 grid grid-cols-2 gap-3"><RateField label="Discount rate" onChange={(value) => onDraftChange((current) => current ? { ...current, discount_rate: value / 100 } : current)} suffix="%" value={draft.discount_rate * 100} /><RateField label="Analysis term" onChange={(value) => onDraftChange((current) => current ? { ...current, analysis_term_years: Math.round(value) } : current)} suffix="years" value={draft.analysis_term_years} /><RateField label="Value escalation" onChange={(value) => onDraftChange((current) => current ? { ...current, annual_value_escalation_rate: value / 100 } : current)} suffix="% / yr" value={draft.annual_value_escalation_rate * 100} /><RateField label="PV degradation" onChange={(value) => onDraftChange((current) => current ? { ...current, annual_value_degradation_rate: value / 100 } : current)} suffix="% / yr" value={draft.annual_value_degradation_rate * 100} /><RateField label="Annual O&M" onChange={(value) => onDraftChange((current) => current ? { ...current, annual_om_fraction_of_capex: value / 100 } : current)} suffix="% CAPEX" value={draft.annual_om_fraction_of_capex * 100} /></div></div><div className="rounded-xl bg-slate-950 p-4 text-white"><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-300">Automatic CAPEX</p><p className="mt-2 text-sm leading-6 text-slate-300">PV uses the saved $/kWp rate. Battery and PCS prices use continuous interpolation from the saved capacity cost curves.</p></div></section>;
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

function activateAdjacentTab(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'));
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (currentIndex < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}

function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden], [aria-hidden="true"], details:not([open])'));
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function stableProfileId(kind: SolutionProfileKind, existing: Array<{ profile_id: string }>): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now()}${Math.round(Math.random() * 1_000_000)}`;
  const candidate = `${kind}_${random}`;
  return existing.some((item) => item.profile_id === candidate) ? stableProfileId(kind, existing) : candidate;
}

function formatNumber(value: number) {
  return String(Number(value.toFixed(6)));
}

function nullable(value: string) {
  return value.trim() ? value : null;
}

function validateDraft(profile: CiDeviceProfile) {
  const solarProfiles = profile.solution_profiles.solar_profiles;
  const batteryProfiles = profile.solution_profiles.battery_profiles;
  const inverterProfiles = profile.solution_profiles.inverter_profiles;
  if (!solarProfiles.every(validSolarProfile) || !batteryProfiles.every(validBatteryProfile) || !inverterProfiles.every(validInverterProfile)) return "Complete every Published or Retired profile with valid performance values. Draft battery profiles may keep unknown fields blank.";
  if (solarProfiles.length > 50 || batteryProfiles.length > 50 || inverterProfiles.length > 50) return "Each profile library can contain at most 50 profiles.";
  const allProfiles = [...solarProfiles, ...batteryProfiles, ...inverterProfiles];
  if (new Set(allProfiles.map((item) => item.profile_id)).size !== allProfiles.length) return "Profile IDs must be globally unique.";
  if (!solarProfiles.some((item) => item.profile_id === profile.default_solution_profile_selection.solar_profile_id && item.status === "published")) return "Choose a Published solar profile as the default.";
  if (!batteryProfiles.some((item) => item.profile_id === profile.default_solution_profile_selection.battery_profile_id && item.status === "published")) return "Choose a Published battery profile as the default.";
  const pv = profile.equipment_catalog.pv_products[0];
  const battery = profile.equipment_catalog.battery_products[0];
  const inverter = profile.equipment_catalog.inverter_products[0];
  const catalogPricesValid =
    validNonNegativeMoney(pv.capital_cost_aud_per_kwp_dc) &&
    validNonNegativeMoney(pv.replacement_cost_aud_per_kwp_dc) &&
    validNonNegativeMoney(pv.annual_om_aud) &&
    [...battery.cost_curve, ...inverter.cost_curve].every((point) => validPositiveMoney(point.capital_cost_aud) && validNonNegativeMoney(point.replacement_cost_aud) && validNonNegativeMoney(point.annual_om_aud));
  const financeValid =
    validPositiveMoney(profile.pv_cost_aud_per_kwp_dc) &&
    validPositiveMoney(profile.battery_cost_aud_per_kwh) &&
    validPositiveMoney(profile.inverter_cost_aud_per_kw_ac) &&
    [profile.discount_rate, profile.annual_value_escalation_rate, profile.annual_value_degradation_rate].every((value) => Number.isFinite(value) && value >= 0 && value < 1) &&
    Number.isFinite(profile.annual_om_fraction_of_capex) && profile.annual_om_fraction_of_capex >= 0 && profile.annual_om_fraction_of_capex < 0.201 &&
    Number.isInteger(profile.analysis_term_years) && profile.analysis_term_years >= 1 && profile.analysis_term_years <= 50;
  if (!catalogPricesValid || !financeValid) return "Complete the supported equipment prices and finance defaults within the allowed ranges before saving.";
  return null;
}

function validPositiveMoney(value: number) {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function validNonNegativeMoney(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}

function validSolarProfile(profile: CiSolarSolutionProfile) {
  return Boolean(profile.profile_id && profile.name.trim() && profile.manufacturer.trim() && profile.model.trim() && profile.module_technology && profile.source_label.trim() && Number.isInteger(profile.version) && profile.version >= 1 && profile.version <= 10_000 && profile.rated_power_w >= 100 && profile.rated_power_w <= 2_000 && profile.module_efficiency_percent >= 1 && profile.module_efficiency_percent <= 40 && profile.temperature_coefficient_percent_per_c >= -2 && profile.temperature_coefficient_percent_per_c <= 0 && profile.annual_degradation_percent >= 0 && profile.annual_degradation_percent <= 10 && profile.default_dc_ac_ratio >= 0.8 && profile.default_dc_ac_ratio <= 2);
}

function validBatteryProfile(profile: CiBatterySolutionProfile) {
  const common = Boolean(profile.profile_id && profile.name.trim() && profile.manufacturer.trim() && profile.model.trim() && profile.chemistry.trim() && profile.source_label.trim() && Number.isInteger(profile.version) && profile.version >= 1 && profile.version <= 10_000);
  if (!common) return false;
  const allowMissing = profile.status === "draft";
  const validOrMissing = (value: number | null, validate: (candidate: number) => boolean) => value === null ? allowMissing : validate(value);
  const unitsValid = validOrMissing(profile.minimum_units, (value) => Number.isInteger(value) && value >= 1 && value <= 10_000) && validOrMissing(profile.maximum_units, (value) => Number.isInteger(value) && value >= 1 && value <= 10_000);
  const unitOrderValid = profile.minimum_units === null || profile.maximum_units === null || profile.maximum_units >= profile.minimum_units;
  return Boolean((profile.coupling === null ? allowMissing : ["ac", "dc"].includes(profile.coupling)) && validOrMissing(profile.nominal_capacity_kwh_per_unit, (value) => value > 0) && validOrMissing(profile.continuous_power_kw_per_unit, (value) => value > 0) && validOrMissing(profile.round_trip_efficiency_percent, (value) => value >= 1 && value <= 100) && validOrMissing(profile.power_conversion_efficiency_percent, (value) => value >= 1 && value <= 100) && validOrMissing(profile.usable_depth_of_discharge_percent, (value) => value >= 1 && value <= 100) && validOrMissing(profile.standby_loss_percent_per_month, (value) => value >= 0 && value < 100) && validOrMissing(profile.annual_capacity_degradation_percent, (value) => value >= 0 && value < 100) && unitsValid && unitOrderValid);
}

function validInverterProfile(profile: CiInverterSolutionProfile) {
  return Boolean(profile.profile_id && profile.name.trim() && profile.manufacturer.trim() && profile.model.trim() && profile.source_label.trim() && Number.isInteger(profile.version) && profile.version >= 1 && profile.version <= 10_000 && profile.rated_active_power_kw > 0 && profile.rated_apparent_power_kva >= profile.rated_active_power_kw && profile.maximum_reactive_power_kvar >= 0 && profile.maximum_reactive_power_kvar <= profile.rated_apparent_power_kva && profile.power_factor_leading_limit >= 0 && profile.power_factor_leading_limit <= 1 && profile.power_factor_lagging_limit >= 0 && profile.power_factor_lagging_limit <= 1 && profile.european_efficiency_percent >= 1 && profile.european_efficiency_percent <= 100 && profile.maximum_efficiency_percent >= profile.european_efficiency_percent && profile.maximum_efficiency_percent <= 100);
}

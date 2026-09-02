import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeDollarSign, Check, CircleAlert, FileCheck2, MapPin, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  ciSolarStcZoneRatings,
  ciProjectRebateProfileQueryKey,
  fetchCiProjectRebateProfile,
  saveCiProjectRebateProfile,
  type CiProjectRebateProfile,
  type CiProjectRebateProfileState,
} from "@/features/ci/api/ci-rebate-profile";

type ProgramKey = keyof CiProjectRebateProfile["programs"];

const programDetails: Array<{
  key: ProgramKey;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    key: "solar_stc",
    label: "Solar STCs",
    shortLabel: "STC",
    description: "Upfront certificate screening for eligible new solar capacity.",
  },
  {
    key: "battery_stc",
    label: "Battery STCs",
    shortLabel: "Battery STC",
    description: "Upfront certificate screening for eligible battery capacity.",
  },
  {
    key: "vic_deemed_veec",
    label: "Victorian Deemed VEECs",
    shortLabel: "VEEC",
    description: "Deemed Victorian certificate screening for eligible C&I solar projects.",
  },
];

export function CiRebateProfilePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ciProjectRebateProfileQueryKey(projectId),
    queryFn: () => fetchCiProjectRebateProfile(projectId),
    retry: false,
  });
  const [draft, setDraft] = useState<CiProjectRebateProfile | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<"draft" | "approve" | null>(null);

  useEffect(() => {
    if (!state.data || draftProjectId === projectId) return;
    setDraft(structuredClone(state.data.profile ?? state.data.suggested_profile));
    setDraftProjectId(projectId);
    setLastAction(null);
  }, [draftProjectId, projectId, state.data]);

  const save = useMutation({
    mutationFn: ({ approve, profile, targetProjectId }: { approve: boolean; profile: CiProjectRebateProfile; targetProjectId: string }) =>
      saveCiProjectRebateProfile(targetProjectId, { profile, approveForCalculation: approve }),
    onSuccess: (next, variables) => {
      queryClient.setQueryData(ciProjectRebateProfileQueryKey(variables.targetProjectId), next);
      if (variables.targetProjectId === projectId) {
        setDraft(structuredClone(next.profile ?? next.suggested_profile));
        setDraftProjectId(projectId);
        setLastAction(variables.approve ? "approve" : "draft");
      }
      void queryClient.invalidateQueries({ queryKey: ["ci-project-annual-financial-comparison", variables.targetProjectId] });
    },
  });

  if (state.isPending || !draft || draftProjectId !== projectId) {
    return <PanelState text="Loading the project rebate profile…" />;
  }
  if (state.isError) {
    return <PanelState error text="The project rebate profile could not be loaded safely." />;
  }

  const enabledPrograms = programDetails.filter(({ key }) => draft.programs[key].enabled);
  const status = state.data.status;
  const isDirty = JSON.stringify(draft) !== JSON.stringify(state.data.profile ?? state.data.suggested_profile);
  const obviousApprovalGaps = approvalGaps(draft, state.data.site_evidence);

  const updateProfile = (patch: Partial<CiProjectRebateProfile>) => {
    save.reset();
    setLastAction(null);
    setDraft((current) => current ? { ...current, ...patch } : current);
  };

  const updateProgram = <K extends ProgramKey>(key: K, patch: Partial<CiProjectRebateProfile["programs"][K]>) => {
    save.reset();
    setLastAction(null);
    setDraft((current) => current ? {
      ...current,
      programs: {
        ...current.programs,
        [key]: { ...current.programs[key], ...patch },
      },
    } : current);
  };

  return (
    <section aria-labelledby="rebate-profile-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-800"><BadgeDollarSign className="size-5" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.15em] text-emerald-700">Project finance inputs</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950" id="rebate-profile-title" tabIndex={-1}>Rebates &amp; certificates</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">Select the certificate programs to screen for this project. Saved values are auditable assumptions; they do not guarantee eligibility, certificate creation or the price ultimately received.</p>
          </div>
        </div>
        <StatusBadge dirty={isDirty} enabledCount={enabledPrograms.length} status={status} />
      </header>

      <div className="space-y-6 p-5 sm:p-6">
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <CircleAlert className="mt-1 size-4 shrink-0" />
          <p>Python is authoritative for certificate quantities and rebate dollars. Confirm current scheme eligibility, installation timing, accredited products and a price source before approving these assumptions for Finance.</p>
        </div>

        <section aria-labelledby="rebate-project-basis-title" className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="flex items-start gap-3"><MapPin className="mt-0.5 size-4 text-cyan-800" /><div><h3 className="text-sm font-semibold text-slate-950" id="rebate-project-basis-title">Certificate date &amp; confirmed site</h3><p className="mt-1 text-xs leading-5 text-slate-500">Detected Evidence can prefill the location, but an analyst must confirm the structured fields used by the rebate ruleset.</p></div></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Target certificate date"><input aria-label="Target certificate date" className={inputClass} onChange={(event) => updateProfile({ target_certificate_date: event.target.value })} type="date" value={draft.target_certificate_date} /></Field>
            <Field label="Site state"><input aria-label="Site state" className={inputClass} maxLength={3} onChange={(event) => updateProfile({ site_state_code: event.target.value.toUpperCase() })} placeholder="VIC" value={draft.site_state_code} /></Field>
            <Field label="Site postcode"><input aria-label="Site postcode" className={inputClass} inputMode="numeric" maxLength={4} onChange={(event) => updateProfile({ site_postcode: event.target.value })} placeholder="3000" value={draft.site_postcode} /></Field>
            <Field label="Location source"><input aria-label="Location source" className={inputClass} maxLength={240} onChange={(event) => updateProfile({ site_location_source_label: event.target.value })} placeholder="Reviewed electricity bill" value={draft.site_location_source_label} /></Field>
          </div>
          <label className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700"><input checked={draft.site_location_confirmed} className="mt-0.5 size-4" onChange={(event) => updateProfile({ site_location_confirmed: event.target.checked })} type="checkbox" /><span><strong className="font-semibold text-slate-900">I have confirmed the project site</strong><span className="mt-0.5 block text-xs leading-5 text-slate-500">Detected: {state.data.site_evidence.detected_site_address ?? "No labelled site address in Evidence"}</span></span></label>
        </section>

        <div className="grid gap-4 xl:grid-cols-3">
          <ProgramCard
            checked={draft.programs.solar_stc.enabled}
            description={programDetails[0].description}
            label={programDetails[0].label}
            onEnabled={(enabled) => updateProgram("solar_stc", { enabled })}
          >
            <CommonProgramFields program={draft.programs.solar_stc} programLabel="Solar STCs" update={(patch) => updateProgram("solar_stc", patch)} />
            <Field label="Postcode zone rating"><select aria-label="Postcode zone rating" className={inputClass} onChange={(event) => updateProgram("solar_stc", { postcode_zone_rating: event.target.value === "" ? null : Number(event.target.value) })} value={draft.programs.solar_stc.postcode_zone_rating ?? ""}><option value="">Select from confirmed postcode evidence</option>{ciSolarStcZoneRatings.map((rating) => <option key={rating} value={rating}>{rating}</option>)}</select></Field>
            <TextInput label="Zone source" onChange={(zone_source_label) => updateProgram("solar_stc", { zone_source_label })} placeholder="Approved postcode-zone reference" value={draft.programs.solar_stc.zone_source_label} />
          </ProgramCard>

          <ProgramCard
            checked={draft.programs.battery_stc.enabled}
            description={programDetails[1].description}
            label={programDetails[1].label}
            onEnabled={(enabled) => updateProgram("battery_stc", { enabled })}
          >
            <CommonProgramFields program={draft.programs.battery_stc} programLabel="Battery STCs" update={(patch) => updateProgram("battery_stc", patch)} />
            <NullableNumberField label="Certified usable / nominal capacity (0–1)" max={1} onChange={(certified_usable_capacity_fraction) => updateProgram("battery_stc", { certified_usable_capacity_fraction })} step="0.001" value={draft.programs.battery_stc.certified_usable_capacity_fraction} />
            <TextInput label="Capacity source" onChange={(capacity_source_label) => updateProgram("battery_stc", { capacity_source_label })} placeholder="Certification or approved datasheet" value={draft.programs.battery_stc.capacity_source_label} />
          </ProgramCard>

          <ProgramCard
            checked={draft.programs.vic_deemed_veec.enabled}
            description={programDetails[2].description}
            label={programDetails[2].label}
            onEnabled={(enabled) => updateProgram("vic_deemed_veec", { enabled })}
          >
            <CommonProgramFields program={draft.programs.vic_deemed_veec} programLabel="Victorian Deemed VEECs" update={(patch) => updateProgram("vic_deemed_veec", patch)} />
            <Field label="Victorian region"><select aria-label="Victorian region" className={inputClass} onChange={(event) => updateProgram("vic_deemed_veec", { victoria_region: event.target.value ? event.target.value as "metropolitan" | "regional" : null })} value={draft.programs.vic_deemed_veec.victoria_region ?? ""}><option value="">Select from confirmed evidence</option><option value="metropolitan">Metropolitan</option><option value="regional">Regional</option></select></Field>
            <NullableNumberField label="Inverter apparent power (kVA per kW AC)" max={10} min={1} onChange={(inverter_apparent_power_kva_per_kw_ac) => updateProgram("vic_deemed_veec", { inverter_apparent_power_kva_per_kw_ac })} step="0.001" value={draft.programs.vic_deemed_veec.inverter_apparent_power_kva_per_kw_ac} />
            <TextInput label="Inverter apparent power source" onChange={(inverter_apparent_power_source_label) => updateProgram("vic_deemed_veec", { inverter_apparent_power_source_label })} placeholder="Approved inverter datasheet or connection contract" value={draft.programs.vic_deemed_veec.inverter_apparent_power_source_label} />
          </ProgramCard>
        </div>

        {enabledPrograms.length > 1 ? (
          <label className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${draft.stacking_confirmed ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
            <input checked={draft.stacking_confirmed} className="mt-0.5 size-4" onChange={(event) => updateProfile({ stacking_confirmed: event.target.checked })} type="checkbox" />
            <span><strong className="font-semibold">Confirm the selected programs can be combined</strong><span className="mt-1 block text-xs leading-5">Python will enforce the approved ruleset. This confirmation records the analyst review; it does not override a prohibited combination.</span></span>
          </label>
        ) : null}

        {state.data.blockers.length ? <BlockerList blockers={state.data.blockers} /> : null}
        {isDirty ? <p className="rounded-lg border border-cyan-200 bg-cyan-50 px-4 py-3 text-xs leading-5 text-cyan-950" role="status">Unsaved edits are not used by Finance. Save the draft, or approve it with “Save &amp; use in Finance”, before relying on the changed values.</p> : null}
        {obviousApprovalGaps.length ? <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600"><strong className="text-slate-800">Before approval:</strong> {obviousApprovalGaps.join(" · ")}</div> : null}
        {save.error instanceof Error ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{save.error.message}</p> : null}
        {save.isSuccess && !isDirty ? <p aria-live="polite" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800" role="status"><Check className="size-4" />{lastAction === "approve" ? "Rebate profile approved for Finance." : "Rebate draft saved. Finance will use it only after approval."}</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-5">
          <div className="max-w-2xl text-xs leading-5 text-slate-500"><p>Ruleset: {state.data.ruleset.ruleset_id}. Official sources and calculation operands are retained by the backend for audit.</p><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{state.data.ruleset.official_sources.map((source) => <a className="font-medium text-cyan-800 underline decoration-cyan-300 underline-offset-2" href={source.url} key={source.source_id} rel="noreferrer" target="_blank">{source.label}{source.status === "proposal_not_enabled" ? " · proposal not enabled" : ""}</a>)}</div></div>
          <div className="flex gap-2">
            <Button disabled={save.isPending} onClick={() => { setLastAction("draft"); save.mutate({ approve: false, profile: draft, targetProjectId: projectId }); }} type="button" variant="outline">{save.isPending && lastAction === "draft" ? "Saving…" : "Save draft"}</Button>
            <Button disabled={save.isPending || obviousApprovalGaps.length > 0} onClick={() => { setLastAction("approve"); save.mutate({ approve: true, profile: draft, targetProjectId: projectId }); }} type="button"><FileCheck2 className="size-4" />{save.isPending && lastAction === "approve" ? "Approving…" : "Save & use in Finance"}</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProgramCard({ checked, children, description, label, onEnabled }: { checked: boolean; children: ReactNode; description: string; label: string; onEnabled: (checked: boolean) => void }) {
  return <section aria-label={`${label} rebate program`} className={`rounded-xl border p-4 ${checked ? "border-emerald-200 bg-emerald-50/35" : "border-slate-200 bg-slate-50/60"}`}>
    <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-950">{label}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{description}</p></div><label className="inline-flex shrink-0 items-center gap-2 text-xs font-semibold text-slate-700"><span className="sr-only">Enable {label}</span><input aria-label={`Enable ${label}`} checked={checked} className="size-4" onChange={(event) => onEnabled(event.target.checked)} type="checkbox" />{checked ? "On" : "Off"}</label></div>
    {checked ? <div className="mt-4 space-y-3 border-t border-emerald-100 pt-4">{children}</div> : <p className="mt-4 rounded-lg bg-white px-3 py-2 text-xs text-slate-500">Not included in Finance.</p>}
  </section>;
}

type CommonProgram = CiProjectRebateProfile["programs"][ProgramKey];

function CommonProgramFields({ program, programLabel, update }: { program: CommonProgram; programLabel: string; update: (patch: Partial<CommonProgram>) => void }) {
  return <>
    <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700"><input aria-label={`${programLabel} eligibility reviewed`} checked={program.eligibility_confirmed} className="mt-0.5 size-4" onChange={(event) => update({ eligibility_confirmed: event.target.checked })} type="checkbox" /><span><strong className="text-slate-900">Eligibility reviewed</strong><span className="block text-slate-500">Confirm against current official requirements.</span></span></label>
    <TextInput label="Eligibility source" onChange={(eligibility_source_label) => update({ eligibility_source_label })} placeholder={`Eligibility evidence for ${programLabel}`} value={program.eligibility_source_label} />
    <NullableNumberField label="Price received (AUD ex GST / certificate)" onChange={(certificate_price_aud_ex_gst) => update({ certificate_price_aud_ex_gst: certificate_price_aud_ex_gst ?? 0 })} step="0.01" value={program.certificate_price_aud_ex_gst} />
    <TextInput label="Price source" onChange={(price_source_label) => update({ price_source_label })} placeholder="Net price source after fees" value={program.price_source_label} />
    <Field label="Price as-of"><input aria-label={`${programLabel} price as-of`} className={inputClass} onChange={(event) => update({ price_as_of_date: event.target.value })} type="date" value={program.price_as_of_date} /></Field>
  </>;
}

function BlockerList({ blockers }: { blockers: CiProjectRebateProfileState["blockers"] }) {
  return <section aria-label="Rebate approval blockers" className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-amber-950"><ShieldCheck className="size-4" />Approval still needs</div><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-900">{blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}>{blocker.message}</li>)}</ul></section>;
}

function StatusBadge({ dirty, enabledCount, status }: { dirty: boolean; enabledCount: number; status: CiProjectRebateProfileState["status"] }) {
  const approved = status === "approved";
  const label = dirty ? "Unsaved changes" : enabledCount === 0 && status === "not_configured" ? "No rebates selected" : approved ? "Approved for Finance" : status === "stale" ? "Re-approval required" : "Draft";
  return <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${dirty ? "bg-cyan-100 text-cyan-900" : approved ? "bg-emerald-100 text-emerald-800" : status === "stale" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"}`}>{label}</span>;
}

function approvalGaps(profile: CiProjectRebateProfile, evidence: CiProjectRebateProfileState["site_evidence"]) {
  const enabled = programDetails.filter(({ key }) => profile.programs[key].enabled);
  if (!enabled.length) return [];
  const gaps: string[] = [];
  if (!profile.target_certificate_date) gaps.push("target certificate date");
  if (!evidence.detected_site_address || !evidence.state_code || !evidence.postcode) gaps.push("current bill Evidence with a labelled site address");
  if (!profile.site_state_code || !profile.site_postcode || profile.site_state_code !== evidence.state_code || profile.site_postcode !== evidence.postcode || !profile.site_location_confirmed || !profile.site_location_source_label.trim()) gaps.push("confirmed site location matching Evidence");
  const target = profile.target_certificate_date;
  const today = sydneyDate();
  for (const { key, shortLabel } of enabled) {
    const program = profile.programs[key];
    if (!program.eligibility_confirmed || !program.eligibility_source_label.trim()) gaps.push(`${shortLabel} eligibility evidence`);
    if (program.certificate_price_aud_ex_gst <= 0 || !program.price_source_label.trim() || !program.price_as_of_date) gaps.push(`${shortLabel} current price and source`);
    if (program.price_as_of_date > today) gaps.push(`${shortLabel} price date cannot be in the future`);
    if (key === "solar_stc" && (target < "2026-01-01" || target > "2030-12-31")) gaps.push("Solar STC target date supported by the active ruleset");
    if (key === "battery_stc" && (target < "2025-07-01" || target > "2030-12-31")) gaps.push("Battery STC target date supported by the active ruleset");
    if (key === "vic_deemed_veec" && (profile.site_state_code !== "VIC" || target < "2026-07-21" || target > "2026-12-31")) gaps.push("Victorian VEEC site and V25-supported target date");
    if (key === "solar_stc" && (profile.programs.solar_stc.postcode_zone_rating === null || !profile.programs.solar_stc.zone_source_label.trim())) gaps.push("STC postcode zone evidence");
    if (key === "battery_stc" && (profile.programs.battery_stc.certified_usable_capacity_fraction === null || !profile.programs.battery_stc.capacity_source_label.trim())) gaps.push("battery certified usable capacity evidence");
    if (key === "vic_deemed_veec" && profile.programs.vic_deemed_veec.victoria_region === null) gaps.push("Victorian Metro/Regional classification");
    if (key === "vic_deemed_veec") {
      const kvaRatio = profile.programs.vic_deemed_veec.inverter_apparent_power_kva_per_kw_ac;
      if (kvaRatio === null || kvaRatio < 1 || kvaRatio > 10 || !profile.programs.vic_deemed_veec.inverter_apparent_power_source_label.trim()) gaps.push("VEEC inverter apparent-power evidence");
    }
  }
  if (enabled.length > 1 && !profile.stacking_confirmed) gaps.push("program stacking confirmation");
  return [...new Set(gaps)];
}

function sydneyDate() {
  const parts = new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "2-digit", timeZone: "Australia/Sydney", year: "numeric" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function Field({ children, label }: { children: ReactNode; label: string }) { return <label className="grid gap-1 text-xs font-medium text-slate-600"><span>{label}</span>{children}</label>; }
function TextInput({ label, onChange, placeholder, value }: { label: string; onChange: (value: string) => void; placeholder: string; value: string }) { return <Field label={label}><input aria-label={label} className={inputClass} maxLength={240} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} /></Field>; }
function NullableNumberField({ label, max, min = 0, onChange, step, value }: { label: string; max?: number; min?: number; onChange: (value: number | null) => void; step: string; value: number | null }) { return <Field label={label}><input aria-label={label} className={inputClass} max={max} min={min} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))} placeholder="Evidence required" step={step} type="number" value={value ?? ""} /></Field>; }
function PanelState({ error = false, text }: { error?: boolean; text: string }) { return <section className={`rounded-xl border p-5 text-sm ${error ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-white text-slate-500"}`}>{text}</section>; }

const inputClass = "min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950";

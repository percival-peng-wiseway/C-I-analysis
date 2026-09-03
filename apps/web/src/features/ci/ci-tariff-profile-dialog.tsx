import { Download, FileJson, ShieldCheck, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  assertCiProjectTariffProfile,
  type CiProjectTariffProfile,
  type CiProjectTariffProfileState,
} from "@/features/ci/api/ci-tariff-profile";

type RateKey = keyof CiProjectTariffProfile["rates"];
type WindowKey = keyof CiProjectTariffProfile["windows"];

const rateFields: Array<{ key: RateKey; label: string; unit: string }> = [
  { key: "retail_peak_c_per_kwh", label: "Retail peak", unit: "c/kWh" },
  { key: "retail_off_peak_c_per_kwh", label: "Retail off-peak", unit: "c/kWh" },
  { key: "incentive_demand_aud_per_kva_month", label: "Incentive demand", unit: "AUD/kVA/month" },
  { key: "rolling_demand_aud_per_kva_month", label: "Rolling demand", unit: "AUD/kVA/month" },
  { key: "network_peak_c_per_kwh", label: "Network peak", unit: "c/kWh" },
  { key: "network_off_peak_c_per_kwh", label: "Network off-peak", unit: "c/kWh" },
  { key: "aemo_ancillary_c_per_kwh", label: "AEMO ancillary", unit: "c/kWh" },
  { key: "aemo_participant_c_per_kwh", label: "AEMO participant", unit: "c/kWh" },
  { key: "aemo_frc_c_per_day", label: "AEMO FRC", unit: "c/day" },
  { key: "environmental_c_per_kwh", label: "Environmental", unit: "c/kWh" },
  { key: "environmental_certificate_fraction", label: "Environmental certificate fraction", unit: "fraction" },
  { key: "metering_aud_per_day", label: "Metering", unit: "AUD/day" },
  { key: "value_added_c_per_day", label: "Value-added service", unit: "c/day" },
];

const windowFields: Array<{ key: WindowKey; label: string }> = [
  { key: "retail_energy", label: "Retail energy" },
  { key: "network_energy", label: "Network energy" },
  { key: "rolling_demand", label: "Rolling demand" },
  { key: "incentive_demand", label: "Incentive demand" },
];

export function CiTariffProfileDialog({
  busy,
  detectedTariffCode,
  error,
  onClose,
  onSave,
  open,
  state,
}: {
  busy: boolean;
  detectedTariffCode: string;
  error: string | null;
  onClose: () => void;
  onSave: (profile: CiProjectTariffProfile, approveForCalculation: boolean) => void;
  open: boolean;
  state: CiProjectTariffProfileState | null;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<CiProjectTariffProfile>(() => initialDraft(state, detectedTariffCode));
  const [importMessage, setImportMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraft(initialDraft(state, detectedTariffCode));
    setImportMessage(null);
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
    };
    // The draft is deliberately refreshed only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const validationMessage = validateProfile(draft);
  const updateRate = (key: RateKey, value: string) => setDraft((current) => ({
    ...current,
    rates: { ...current.rates, [key]: parseNumber(value) },
  }));
  const updateWindow = (key: WindowKey, edge: "start" | "end", value: string) => setDraft((current) => ({
    ...current,
    windows: { ...current.windows, [key]: { ...current.windows[key], [edge]: value } },
  }));

  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-3 backdrop-blur-[2px] sm:p-6"
      onKeyDown={trapFocus}
      role="dialog"
    >
      <section className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Project calculation input</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950" id={titleId}>Tariff profile</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500" id={descriptionId}>Review every rate, factor and time window against approved tariff evidence. A detected invoice category is a starting point, not an approved calculation rate.</p>
          </div>
          <button aria-label="Close tariff profile" className="inline-grid size-9 shrink-0 place-items-center rounded-md transition-colors hover:bg-slate-100 disabled:opacity-50" disabled={busy} onClick={onClose} ref={closeRef} type="button"><X className="size-4" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6">
          {state?.blockers.length ? (
            <section aria-labelledby={`${titleId}-blockers`} className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <h3 className="font-semibold" id={`${titleId}-blockers`}>Before this profile can be used</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5">{state.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul>
            </section>
          ) : null}

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div>
              <p className="text-xs font-semibold text-slate-800">Local JSON</p>
              <p className="text-xs leading-5 text-slate-500">Import fills this draft only. Saving still requires server validation and approval.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input accept="application/json,.json" aria-label="Import tariff profile JSON file" className="sr-only" onChange={(event) => void importJson(event, setDraft, setImportMessage)} ref={fileInputRef} tabIndex={-1} type="file" />
              <Button disabled={busy} onClick={() => fileInputRef.current?.click()} type="button" variant="outline"><Upload className="size-4" />Import JSON</Button>
              <Button disabled={busy || Boolean(validationMessage)} onClick={() => exportJson(draft)} type="button" variant="outline"><Download className="size-4" />Export JSON</Button>
            </div>
            {importMessage ? <p aria-live="polite" className={`w-full text-xs ${importMessage.startsWith("Imported") ? "text-emerald-700" : "text-red-700"}`}>{importMessage}</p> : null}
          </div>

          <fieldset className="space-y-6 disabled:opacity-70" disabled={busy}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Display label" onChange={(value) => setDraft((current) => ({ ...current, display_label: value }))} value={draft.display_label} />
              <TextField label="Network tariff code" onChange={(value) => setDraft((current) => ({ ...current, network_tariff_code: value.toUpperCase() }))} value={draft.network_tariff_code} />
            </div>

            <section aria-labelledby={`${titleId}-rates`}>
              <div className="mb-3"><h3 className="font-semibold text-slate-950" id={`${titleId}-rates`}>Rates</h3><p className="mt-1 text-xs text-slate-500">Enter ex-GST rates exactly as documented in the approved evidence.</p></div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Charge</th><th className="px-4 py-3">Rate</th><th className="px-4 py-3">Unit</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rateFields.map((field) => (
                      <tr key={field.key}><th className="px-4 py-2.5 font-medium text-slate-800" scope="row">{field.label}</th><td className="px-4 py-2.5"><NumberField ariaLabel={`${field.label} rate`} max={field.key === "environmental_certificate_fraction" ? "1" : "1000000"} onChange={(value) => updateRate(field.key, value)} value={draft.rates[field.key]} /></td><td className="px-4 py-2.5 text-xs text-slate-500">{field.unit}</td></tr>
                    ))}
                    <tr>
                      <th className="px-4 py-2.5 font-medium text-slate-800" scope="row">Source bill adjustment</th>
                      <td className="px-4 py-2.5"><NumberField ariaLabel="Source bill adjustment" min="-1000000" onChange={(value) => setDraft((current) => ({ ...current, additional_bill_adjustment_aud: parseNumber(value) }))} value={draft.additional_bill_adjustment_aud ?? 0} /></td>
                      <td className="px-4 py-2.5 text-xs leading-5 text-slate-500">AUD/source bill · checked against Evidence, not repeated annually</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby={`${titleId}-factors`}>
              <h3 className="font-semibold text-slate-950" id={`${titleId}-factors`}>Loss factors and demand floor</h3>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <NumberLabel label="MLF" max="5" min="0.01" onChange={(value) => setDraft((current) => ({ ...current, factors: { ...current.factors, mlf: parseNumber(value) } }))} step="any" value={draft.factors.mlf} />
                <NumberLabel label="DLF" max="5" min="0.01" onChange={(value) => setDraft((current) => ({ ...current, factors: { ...current.factors, dlf: parseNumber(value) } }))} step="any" value={draft.factors.dlf} />
                <NumberLabel label="Minimum chargeable rolling demand (kVA)" max="1000000" min="0" onChange={(value) => setDraft((current) => ({ ...current, minimum_chargeable_rolling_kva: parseNumber(value) }))} step="any" value={draft.minimum_chargeable_rolling_kva} />
              </div>
            </section>

            <section aria-labelledby={`${titleId}-windows`}>
              <div className="mb-3"><h3 className="font-semibold text-slate-950" id={`${titleId}-windows`}>Billing windows</h3><p className="mt-1 text-xs text-slate-500">Times use the project tariff's local billing time. End must be later than start.</p></div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Window</th><th className="px-4 py-3">Start</th><th className="px-4 py-3">End</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{windowFields.map((field) => (
                    <tr key={field.key}><th className="px-4 py-3 font-medium text-slate-800" scope="row">{field.label}</th><td className="px-4 py-3"><input aria-label={`${field.label} start`} className="h-9 rounded-md border border-slate-300 px-3 text-sm" onChange={(event) => updateWindow(field.key, "start", event.target.value)} type="time" value={draft.windows[field.key].start} /></td><td className="px-4 py-3"><input aria-label={`${field.label} end`} className="h-9 rounded-md border border-slate-300 px-3 text-sm" onChange={(event) => updateWindow(field.key, "end", event.target.value)} type="time" value={draft.windows[field.key].end} /></td></tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          </fieldset>
        </div>

        <footer className="border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
          {error ? <p aria-live="polite" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
          {validationMessage ? <p className="mb-3 text-xs text-amber-800">{validationMessage}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={busy} onClick={onClose} type="button" variant="ghost">Cancel</Button>
            <Button disabled={busy || Boolean(validationMessage)} onClick={() => onSave(draft, false)} type="button" variant="outline"><FileJson className="size-4" />{busy ? "Saving…" : "Save draft"}</Button>
            <Button disabled={busy || Boolean(validationMessage)} onClick={() => onSave(draft, true)} type="button"><ShieldCheck className="size-4" />{busy ? "Saving…" : "Save & use in calculations"}</Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function initialDraft(state: CiProjectTariffProfileState | null, detectedTariffCode: string): CiProjectTariffProfile {
  const source = state?.status === "stale"
    ? state.suggested_profile ?? state.profile
    : state?.profile ?? state?.suggested_profile;
  if (source) return structuredClone(source);
  return {
    contract_version: "ci_project_tariff_profile_v1",
    display_label: "",
    network_tariff_code: detectedTariffCode,
    additional_bill_adjustment_aud: Number.NaN,
    rates: Object.fromEntries(rateFields.map((field) => [field.key, Number.NaN])) as CiProjectTariffProfile["rates"],
    factors: { mlf: Number.NaN, dlf: Number.NaN },
    windows: Object.fromEntries(windowFields.map((field) => [field.key, { start: "", end: "" }])) as CiProjectTariffProfile["windows"],
    minimum_chargeable_rolling_kva: Number.NaN,
  };
}

function validateProfile(profile: CiProjectTariffProfile) {
  try {
    assertCiProjectTariffProfile(profile);
    return null;
  } catch {
    return "Complete every tariff field with valid evidence-backed values before saving.";
  }
}

async function importJson(event: ChangeEvent<HTMLInputElement>, setDraft: (profile: CiProjectTariffProfile) => void, setMessage: (message: string) => void) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const text = await readFileText(file);
    const profile = assertCiProjectTariffProfile(JSON.parse(text));
    setDraft(structuredClone(profile));
    setMessage(`Imported ${file.name} into the unsaved draft.`);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "The selected JSON file could not be imported.");
  }
}

function readFileText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(new Error("The selected JSON file could not be read.")));
    reader.readAsText(file);
  });
}

function exportJson(profile: CiProjectTariffProfile) {
  const blob = new Blob([`${JSON.stringify(profile, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${profile.network_tariff_code.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "project-tariff"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function TextField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return <label className="grid gap-1.5 text-sm font-medium text-slate-700"><span>{label}</span><input className="h-10 rounded-md border border-slate-300 px-3 text-sm text-slate-950" onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}

function NumberLabel({ label, max, min, onChange, step, value }: { label: string; max: string; min: string; onChange: (value: string) => void; step: string; value: number }) {
  return <label className="grid gap-1.5 text-sm font-medium text-slate-700"><span>{label}</span><NumberField ariaLabel={label} max={max} min={min} onChange={onChange} step={step} value={value} /></label>;
}

function NumberField({ ariaLabel, max = "1000000", min = "0", onChange, step = "any", value }: { ariaLabel: string; max?: string; min?: string; onChange: (value: string) => void; step?: string; value: number }) {
  return <input aria-label={ariaLabel} className="h-9 w-full min-w-28 rounded-md border border-slate-300 px-3 text-sm tabular-nums text-slate-950" max={max} min={min} onChange={(event) => onChange(event.target.value)} step={step} type="number" value={Number.isFinite(value) ? String(value) : ""} />;
}

function parseNumber(value: string) {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute("hidden"));
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

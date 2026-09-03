import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { ciDesignPricePreviewQueryKey } from "@/features/ci/api/ci-design-price-preview";
import {
  ciProjectRebateProfileQueryKey,
  fetchCiProjectRebateProfile,
  saveCiProjectStcSettings,
  type CiProjectRebateProfile,
  type CiProjectRebateProfileState,
  type CiProjectStcSettings,
} from "@/features/ci/api/ci-rebate-profile";

export interface CiRebateProfilePanelHandle {
  settingsForGeneration: () => CiProjectStcSettings;
}

export const CiRebateProfilePanel = forwardRef<CiRebateProfilePanelHandle, { projectId: string }>(function CiRebateProfilePanel({ projectId }, ref) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ciProjectRebateProfileQueryKey(projectId),
    queryFn: () => fetchCiProjectRebateProfile(projectId),
    retry: false,
  });
  const [draft, setDraft] = useState<CiProjectStcSettings | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data || draftProjectId === projectId) return;
    setDraft(settingsFromProfile(state.data.profile ?? state.data.suggested_profile));
    setDraftProjectId(projectId);
  }, [draftProjectId, projectId, state.data]);

  const save = useMutation({
    mutationFn: ({ settings, targetProjectId }: { settings: CiProjectStcSettings; targetProjectId: string }) =>
      saveCiProjectStcSettings(targetProjectId, settings),
    onSuccess: async (next, variables) => {
      queryClient.setQueryData(ciProjectRebateProfileQueryKey(variables.targetProjectId), next);
      if (variables.targetProjectId === projectId) {
        setDraft(settingsFromProfile(next.profile ?? next.suggested_profile));
        setDraftProjectId(projectId);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ci-project-annual-financial-comparison", variables.targetProjectId] }),
        queryClient.invalidateQueries({ queryKey: ciDesignPricePreviewQueryKey(variables.targetProjectId) }),
      ]);
    },
  });

  const activeProfile = state.data?.profile ?? state.data?.suggested_profile ?? null;
  const savedSettings = activeProfile ? settingsFromProfile(activeProfile) : null;
  const legacyVeecEnabled = activeProfile?.programs.vic_deemed_veec.enabled ?? false;
  const isDirty = Boolean(draft && savedSettings) && (JSON.stringify(draft) !== JSON.stringify(savedSettings) || legacyVeecEnabled);
  const invalidPrice = draft ? (
    (draft.solarStcEnabled && !isPositiveFinite(draft.solarStcPriceAudExGst)) ||
    (draft.batteryStcEnabled && !isPositiveFinite(draft.batteryStcPriceAudExGst))
  ) : false;
  const enabledCount = draft ? Number(draft.solarStcEnabled) + Number(draft.batteryStcEnabled) : 0;
  const needsSave = isDirty || (enabledCount > 0 && state.data?.status !== "approved");

  useImperativeHandle(ref, () => ({
    settingsForGeneration() {
      if (state.isError) {
        throw new Error("The project STC settings could not be loaded safely.");
      }
      if (state.isPending || !draft || draftProjectId !== projectId || !savedSettings) {
        throw new Error("The project STC settings are not ready yet.");
      }
      if (invalidPrice) {
        throw new Error("Enter a price greater than $0 for each included STC type.");
      }
      return { ...draft };
    },
  }));

  if (state.isError) {
    return <PanelState error text="The project STC settings could not be loaded safely." />;
  }
  if (state.isPending || !draft || draftProjectId !== projectId) {
    return <PanelState text="Loading the project STC settings…" />;
  }

  const update = (patch: Partial<CiProjectStcSettings>) => {
    save.reset();
    setDraft((current) => current ? { ...current, ...patch } : current);
  };

  return (
    <section aria-labelledby="rebate-profile-title">
      <h4 className="mb-3 font-semibold text-slate-950" id="rebate-profile-title" tabIndex={-1}>STC</h4>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <header className="flex justify-end border-b border-slate-200 px-5 py-3 sm:px-6">
        <StatusBadge dirty={isDirty} enabledCount={enabledCount} status={state.data.status} />
        </header>

        <div className="space-y-5 p-5 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <StcCard
            checked={draft.solarStcEnabled}
            label="Solar STCs"
            onChecked={(solarStcEnabled) => update({ solarStcEnabled })}
            onPrice={(solarStcPriceAudExGst) => update({ solarStcPriceAudExGst })}
            price={draft.solarStcPriceAudExGst}
          />
          <StcCard
            checked={draft.batteryStcEnabled}
            label="Battery STCs"
            onChecked={(batteryStcEnabled) => update({ batteryStcEnabled })}
            onPrice={(batteryStcPriceAudExGst) => update({ batteryStcPriceAudExGst })}
            price={draft.batteryStcPriceAudExGst}
          />
        </div>

        {state.data.blockers.length && !isDirty ? <BlockerList blockers={state.data.blockers} /> : null}
        {invalidPrice ? <p className="text-sm text-red-700" role="alert">Enter a price greater than $0 for each included STC type.</p> : null}
        {save.error instanceof Error ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{save.error.message}</p> : null}
        {save.isSuccess && !needsSave ? <p aria-live="polite" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800" role="status"><Check className="size-4" />Saved</p> : null}

        <div className="flex justify-end border-t border-slate-200 pt-5">
          <Button
            disabled={save.isPending || invalidPrice || !needsSave}
            onClick={() => save.mutate({ settings: draft, targetProjectId: projectId })}
            type="button"
          >
            <Save className="size-4" />{save.isPending ? "Saving…" : "Save STC settings"}
          </Button>
        </div>
        </div>
      </div>
    </section>
  );
});

function StcCard({ checked, label, onChecked, onPrice, price }: { checked: boolean; label: string; onChecked: (checked: boolean) => void; onPrice: (price: number) => void; price: number }) {
  return (
    <section aria-label={`${label} settings`} className={`rounded-xl border p-4 ${checked ? "border-emerald-200 bg-emerald-50/35" : "border-slate-200 bg-slate-50/60"}`}>
      <label className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-900">
        <span>Include {label}</span>
        <span className="inline-flex items-center gap-2 text-xs text-slate-600"><input aria-label={`Include ${label}`} checked={checked} className="size-4" onChange={(event) => onChecked(event.target.checked)} type="checkbox" />{checked ? "Yes" : "No"}</span>
      </label>
      <label className="mt-4 grid gap-1 text-xs font-medium text-slate-600">
        <span>{label} price (AUD ex GST / certificate)</span>
        <span className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span><input aria-label={`${label} price`} className={`${inputClass} w-full pl-7`} min="0.01" onChange={(event) => onPrice(Number(event.target.value))} onKeyDown={preventParentFormSubmit} step="0.01" type="number" value={price} /></span>
      </label>
    </section>
  );
}

function BlockerList({ blockers }: { blockers: CiProjectRebateProfileState["blockers"] }) {
  return <section aria-label="STC calculation blockers" className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm font-semibold text-amber-950">STCs are not currently applied</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-900">{blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}>{blocker.message}</li>)}</ul></section>;
}

function StatusBadge({ dirty, enabledCount, status }: { dirty: boolean; enabledCount: number; status: CiProjectRebateProfileState["status"] }) {
  const label = dirty ? "Unsaved changes" : enabledCount === 0 ? "No STCs included" : status === "approved" ? "Saved for pricing" : status === "stale" ? "Re-save required" : "Not applied";
  return <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${dirty ? "bg-cyan-100 text-cyan-900" : status === "approved" ? "bg-emerald-100 text-emerald-800" : status === "stale" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"}`}>{label}</span>;
}

function settingsFromProfile(profile: CiProjectRebateProfile): CiProjectStcSettings {
  return {
    solarStcEnabled: profile.programs.solar_stc.enabled,
    solarStcPriceAudExGst: profile.programs.solar_stc.certificate_price_aud_ex_gst,
    batteryStcEnabled: profile.programs.battery_stc.enabled,
    batteryStcPriceAudExGst: profile.programs.battery_stc.certificate_price_aud_ex_gst,
  };
}

function PanelState({ error = false, text }: { error?: boolean; text: string }) { return <section className={`rounded-xl border p-5 text-sm ${error ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-white text-slate-500"}`}>{text}</section>; }

const inputClass = "min-w-0 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-950";

function preventParentFormSubmit(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopPropagation();
}

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

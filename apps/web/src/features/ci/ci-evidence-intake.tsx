import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CircleAlert, Database, FileSearch, FileText, RefreshCw, ShieldCheck, TableProperties } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ciProjectEvidenceQueryKey,
  fetchCiProjectEvidence,
  inspectCiEvidencePair,
  reviewSavedCiEvidence,
  type CiBillReviewInput,
  type CiEvidenceIntakeResult,
  type CiProjectEvidenceState,
} from "@/features/ci/api/ci-evidence-intake";
import { CiAnnualDemandHeatmap } from "@/features/ci/ci-annual-demand-heatmap";
import { CiBillBreakdown } from "@/features/ci/ci-bill-breakdown";

export function CiEvidenceIntake({
  onReady,
  projectId,
  profileReady,
}: {
  onReady: () => void;
  projectId: string;
  profileReady: boolean;
}) {
  const queryClient = useQueryClient();
  const [bill, setBill] = useState<File | null>(null);
  const [nem12, setNem12] = useState<File | null>(null);
  const [replacing, setReplacing] = useState(false);
  const savedEvidence = useQuery({
    queryKey: ciProjectEvidenceQueryKey(projectId),
    queryFn: () => fetchCiProjectEvidence(projectId),
  });
  const inspection = useMutation({
    mutationFn: ({ billFile, billReview, nem12File }: { billFile: File; billReview?: CiBillReviewInput; nem12File: File }) => inspectCiEvidencePair(projectId, billFile, nem12File, undefined, billReview),
    onSuccess: () => {
      setReplacing(false);
      void queryClient.invalidateQueries({ queryKey: ciProjectEvidenceQueryKey(projectId) });
    },
  });
  const savedReview = useMutation({
    mutationFn: (billReview: CiBillReviewInput) => reviewSavedCiEvidence(projectId, billReview),
    onSuccess: async (result) => {
      await queryClient.cancelQueries({ queryKey: ciProjectEvidenceQueryKey(projectId) });
      queryClient.setQueryData<CiProjectEvidenceState>(ciProjectEvidenceQueryKey(projectId), (current) => current?.status === "saved" && current.evidence ? {
        ...current,
        evidence: { ...current.evidence, saved_at: new Date().toISOString(), inspection: result },
      } : current);
    },
  });
  const resetResult = () => inspection.reset();
  const saved = savedEvidence.data?.status === "saved" ? savedEvidence.data.evidence : null;
  const showUploader = replacing || savedEvidence.isError || (!savedEvidence.isPending && !saved);
  const result = savedReview.data ?? inspection.data ?? (!replacing ? saved?.inspection : undefined);
  const pairReady = result?.intake_status === "ready_for_profile_review";
  const fullTariffReady = result?.nem12.full_tariff_analysis_ready ?? false;
  const activeError = inspection.error ?? savedReview.error;

  return (
    <section className="scroll-mt-20 space-y-4" id="evidence-intake">
      <div className="premium-section-heading">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700">01 · Input check</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold">Start with the files you actually receive</h2>
          <Badge variant="outline">PDF + NEM12</Badge>
        </div>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          Upload the electricity bill and matching interval file together. Python checks their structure, site identity and coverage before any tariff or optimisation calculation is allowed.
        </p>
      </div>

      {savedEvidence.isPending ? (
        <Card><CardContent className="flex items-center gap-3 p-5 text-sm text-muted-foreground"><RefreshCw className="size-4 animate-spin" />Restoring this project&apos;s saved evidence…</CardContent></Card>
      ) : null}

      {saved && !replacing ? (
        <Card className="border-emerald-200 bg-emerald-50/40">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex gap-3"><span className="grid size-10 place-items-center rounded-lg bg-emerald-100 text-emerald-800"><Database className="size-5" /></span><div><CardTitle as="h3">Saved project evidence</CardTitle><CardDescription>Restored from this project · saved {formatSavedAt(saved.saved_at)}</CardDescription></div></div>
              <Badge variant="secondary">Saved locally</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <SavedFile icon={<FileText className="size-4" />} label="Electricity bill PDF" filename={saved.files.bill.filename} size={saved.files.bill.size_bytes} />
            <SavedFile icon={<TableProperties className="size-4" />} label="Interval CSV / NEM12" filename={saved.files.interval.filename} size={saved.files.interval.size_bytes} />
            <Button onClick={() => { setReplacing(true); inspection.reset(); }} type="button" variant="outline"><RefreshCw className="mr-2 size-4" />Replace files</Button>
          </CardContent>
        </Card>
      ) : null}

      {showUploader ? (
        <Card>
          <CardContent className="grid gap-4 p-5 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
            <FileInput
              accept=".pdf,application/pdf"
              file={bill}
              icon={<FileText className="size-4" />}
              label="Electricity bill PDF"
              onChange={(file) => { setBill(file); resetResult(); }}
            />
            <FileInput
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              file={nem12}
              icon={<TableProperties className="size-4" />}
              label="Matching interval CSV / NEM12"
              onChange={(file) => { setNem12(file); resetResult(); }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-w-40"
                disabled={!bill || !nem12 || inspection.isPending}
                onClick={() => { if (bill && nem12) inspection.mutate({ billFile: bill, nem12File: nem12 }); }}
                type="button"
              >
                <FileSearch className="mr-2 size-4" />
                {inspection.isPending ? "Inspecting inputs" : saved ? "Inspect & replace" : "Inspect both files"}
              </Button>
              {saved ? <Button onClick={() => { setReplacing(false); setBill(null); setNem12(null); inspection.reset(); }} type="button" variant="ghost">Cancel</Button> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {savedEvidence.isError ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>Saved evidence could not be restored.</strong><p className="mt-1">You can replace the bill and interval files below.</p></div> : null}

      {activeError instanceof Error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <div className="flex gap-3"><CircleAlert className="mt-0.5 size-4 shrink-0" /><div><strong>Input check stopped</strong><p className="mt-1">{activeError.message}</p></div></div>
        </div>
      ) : null}

      {result ? (
        <div className="space-y-4">
          <div className={`rounded-xl border p-4 text-sm ${pairReady && fullTariffReady ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex gap-3">
                {pairReady && fullTariffReady ? <BadgeCheck className="mt-0.5 size-5 shrink-0" /> : <CircleAlert className="mt-0.5 size-5 shrink-0" />}
                <div>
                  <strong>{pairReady ? "The bill and NEM12 form a coherent input pair" : "One or more input checks need attention"}</strong>
                  <p className="mt-1 opacity-80">{pairReady ? (fullTariffReady ? "The pair can proceed to private tariff-profile review." : "Setup and the active-demand heatmap can continue; later tariff analysis still needs the missing aligned streams.") : "Resolve the failed checks before preparing a tariff profile."}</p>
                </div>
              </div>
              <Badge variant={pairReady && fullTariffReady ? "secondary" : "warning"}>{pairReady ? (fullTariffReady ? "Input pair ready" : "Setup ready · limited streams") : "Action required"}</Badge>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><div className="flex flex-wrap items-start justify-between gap-2"><div><CardTitle as="h3">Bill detected</CardTitle><CardDescription>{result.bill.retailer} · {result.bill.invoice_kind}</CardDescription></div><Badge variant={result.bill.review_status === "not_required" ? "secondary" : result.bill.review_status === "analyst_confirmed" ? "secondary" : "warning"}>{result.bill.review_status === "not_required" ? "Verified template" : result.bill.review_status === "analyst_confirmed" ? "Analyst confirmed" : "Review required"}</Badge></div></CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <Fact label="Invoice period" value={result.bill.billing_period_start && result.bill.billing_period_end ? `${result.bill.billing_period_start} to ${result.bill.billing_period_end}` : "Needs confirmation"} />
                <Fact label="Network tariff" value={result.bill.network_tariff_code ?? "Needs confirmation"} />
                <Fact label="Consumption" value={result.bill.consumption_kwh === null ? "Needs confirmation" : `${formatNumber(result.bill.consumption_kwh)} kWh`} />
                <Fact label="Highest metered demand" value={result.bill.highest_metered_demand_kva === null ? "Needs confirmation" : `${formatNumber(result.bill.highest_metered_demand_kva)} kVA`} />
                <Fact label="Power factor at maximum" value={result.bill.power_factor_at_highest_demand === null ? "Needs confirmation" : result.bill.power_factor_at_highest_demand.toFixed(3)} />
                <Fact label="Invoice total" value={result.bill.total_inc_gst_aud === null ? "Needs confirmation" : formatAud(result.bill.total_inc_gst_aud)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle as="h3">Interval data detected</CardTitle><CardDescription>{result.nem12.days_per_stream} days · {result.nem12.input_format === "nem12_standard" ? "standard NEM12" : "30-minute wide export"}</CardDescription></CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <Fact label="Coverage" value={`${result.nem12.coverage_start} to ${result.nem12.coverage_end}`} />
                <Fact label="Interval" value={`${result.nem12.interval_minutes} minutes`} />
                <Fact label="Streams supplied" value={result.nem12.stream_ids.join(" · ")} />
                <Fact label="Aligned to E1" value={result.nem12.aligned_stream_ids.join(" · ")} />
                <Fact label="Missing formal streams" value={result.nem12.missing_stream_ids.length ? result.nem12.missing_stream_ids.join(" · ") : "None"} />
                <Fact label="Unaligned streams" value={result.nem12.unaligned_stream_ids.length ? result.nem12.unaligned_stream_ids.join(" · ") : "None"} />
                <Fact label="Available capability" value={capabilityLabel(result.nem12.capability_status)} />
                <Fact label="Quality methods" value={Object.entries(result.nem12.quality_method_counts).map(([key, value]) => `${key}: ${value}`).join(" · ")} />
                <Fact label="Quality overrides" value={String(result.nem12.quality_override_count)} />
                <Fact label="Private fingerprint" value={result.nem12.fingerprint} />
              </CardContent>
            </Card>
          </div>

          <CiBillBreakdown bill={result.bill} />

          {!fullTariffReady ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <div className="flex gap-3"><CircleAlert className="mt-0.5 size-4 shrink-0" /><div><strong>Limited interval evidence</strong><p className="mt-1 leading-6">Setup can continue with the uploaded measured demand. The heatmap is shown in {result.annual_demand_heatmap.unit} at {result.annual_demand_heatmap.interval_minutes}-minute resolution. Formal kVA, power-factor, export, tariff and annual financial analysis remains locked until a complete aligned five-minute E1, B1, Q1 and K1 NEM12 export is uploaded.</p></div></div>
            </div>
          ) : null}

          {result.bill.review_status === "confirmation_required" ? (
            <BillReviewForm
              bill={result.bill}
              busy={savedReview.isPending}
              onConfirm={(billReview) => savedReview.mutate(billReview)}
            />
          ) : null}

          <Card>
            <CardHeader><CardTitle as="h3">Pair checks</CardTitle><CardDescription>No customer identifier is returned to the browser.</CardDescription></CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {result.pair_checks.map((check) => (
                <div className={`flex gap-2 rounded-lg border p-3 text-sm ${check.severity === "pass" ? "border-emerald-200 bg-emerald-50" : check.severity === "warning" ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50"}`} key={check.code}>
                  {check.severity === "pass" ? <BadgeCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" /> : <CircleAlert className={`mt-0.5 size-4 shrink-0 ${check.severity === "warning" ? "text-amber-700" : "text-red-700"}`} />}
                  <span>{check.message}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <CiAnnualDemandHeatmap heatmap={result.annual_demand_heatmap} key={result.nem12.fingerprint} />

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="flex max-w-3xl gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan-800" /><p><strong>Next step:</strong> {pairReady ? "The input pair is ready for System design. " : "Confirm the bill fields and resolve every failed pair check. "}{profileReady ? "The private tariff profile is available for a later dispatch run." : "Tariff windows and customer-dollar analysis remain locked until private evidence is configured."}</p></div>
            {pairReady ? <Button onClick={() => onReady()} type="button">Continue to System design</Button> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BillReviewForm({ bill, busy, onConfirm }: { bill: CiEvidenceIntakeResult["bill"]; busy: boolean; onConfirm: (review: CiBillReviewInput) => void }) {
  const [fields, setFields] = useState({
    retailer: bill.retailer === "Electricity retailer — confirm name" ? "" : bill.retailer,
    invoice_kind: bill.invoice_kind,
    nmi: "",
    billing_period_start: bill.billing_period_start ?? "",
    billing_period_end: bill.billing_period_end ?? "",
    network_tariff_code: bill.network_tariff_code ?? "",
    consumption_kwh: numberInput(bill.consumption_kwh),
    highest_metered_demand_kva: numberInput(bill.highest_metered_demand_kva),
    power_factor_at_highest_demand: numberInput(bill.power_factor_at_highest_demand),
    subtotal_ex_gst_aud: numberInput(bill.subtotal_ex_gst_aud),
    gst_aud: numberInput(bill.gst_aud),
    total_inc_gst_aud: numberInput(bill.total_inc_gst_aud),
  });
  const update = (key: keyof typeof fields, value: string) => setFields((current) => ({ ...current, [key]: value }));
  const requiresNmi = bill.site_identity_status === "missing";
  const numericKeys: Array<keyof typeof fields> = ["consumption_kwh", "highest_metered_demand_kva", "power_factor_at_highest_demand", "subtotal_ex_gst_aud", "gst_aud", "total_inc_gst_aud"];
  const valid = fields.retailer.trim() && fields.invoice_kind.trim() && fields.billing_period_start && fields.billing_period_end && fields.network_tariff_code.trim() && (!requiresNmi || /^[A-Za-z0-9]{10,11}$/.test(fields.nmi)) && numericKeys.every((key) => fields[key] !== "" && Number.isFinite(Number(fields[key])) && Number(fields[key]) >= 0) && Number(fields.power_factor_at_highest_demand) <= 1;
  return (
    <Card className="border-amber-300 bg-amber-50/40">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle as="h3">Confirm bill fields</CardTitle><CardDescription>The generic parser prefilled what it could. Check these values against the PDF; confirmed corrections are saved to this project.</CardDescription></div>
          <Badge variant="warning">Retailer-neutral review</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onConfirm({
            confirmed: true,
            retailer: fields.retailer.trim(),
            invoice_kind: fields.invoice_kind.trim(),
            ...(fields.nmi ? { nmi: fields.nmi.trim().toUpperCase() } : {}),
            billing_period_start: fields.billing_period_start,
            billing_period_end: fields.billing_period_end,
            network_tariff_code: fields.network_tariff_code.trim().toUpperCase(),
            consumption_kwh: Number(fields.consumption_kwh),
            highest_metered_demand_kva: Number(fields.highest_metered_demand_kva),
            power_factor_at_highest_demand: Number(fields.power_factor_at_highest_demand),
            subtotal_ex_gst_aud: Number(fields.subtotal_ex_gst_aud),
            gst_aud: Number(fields.gst_aud),
            total_inc_gst_aud: Number(fields.total_inc_gst_aud),
          });
        }}>
          {bill.extraction_method === "manual_review_only" ? <p className="rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-950">This PDF has no searchable text. Enter the fields from the visible bill; OCR is optional and no retailer-specific code is required.</p> : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <ReviewField label="Retailer" onChange={(value) => update("retailer", value)} value={fields.retailer} />
            <ReviewField label="Invoice type" onChange={(value) => update("invoice_kind", value)} value={fields.invoice_kind} />
            {requiresNmi ? <ReviewField label="NMI (kept private)" maxLength={11} onChange={(value) => update("nmi", value)} value={fields.nmi} /> : <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm"><span className="block text-xs text-muted-foreground">Site identity</span><strong className="mt-1 block font-medium">Extracted privately</strong></p>}
            <ReviewField label="Billing period start" onChange={(value) => update("billing_period_start", value)} type="date" value={fields.billing_period_start} />
            <ReviewField label="Billing period end" onChange={(value) => update("billing_period_end", value)} type="date" value={fields.billing_period_end} />
            <ReviewField label="Network tariff code" onChange={(value) => update("network_tariff_code", value)} value={fields.network_tariff_code} />
            <ReviewField label="Consumption (kWh)" min="0" onChange={(value) => update("consumption_kwh", value)} step="any" type="number" value={fields.consumption_kwh} />
            <ReviewField label="Highest demand (kVA)" min="0" onChange={(value) => update("highest_metered_demand_kva", value)} step="any" type="number" value={fields.highest_metered_demand_kva} />
            <ReviewField label="Power factor at maximum" max="1" min="0" onChange={(value) => update("power_factor_at_highest_demand", value)} step="0.001" type="number" value={fields.power_factor_at_highest_demand} />
            <ReviewField label="Subtotal ex GST (AUD)" min="0" onChange={(value) => update("subtotal_ex_gst_aud", value)} step="0.01" type="number" value={fields.subtotal_ex_gst_aud} />
            <ReviewField label="GST (AUD)" min="0" onChange={(value) => update("gst_aud", value)} step="0.01" type="number" value={fields.gst_aud} />
            <ReviewField label="Total inc GST (AUD)" min="0" onChange={(value) => update("total_inc_gst_aud", value)} step="0.01" type="number" value={fields.total_inc_gst_aud} />
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-amber-200 pt-4"><Button disabled={!valid || busy} type="submit">{busy ? "Checking confirmed fields…" : "Confirm fields and re-check"}</Button><span className="text-xs text-muted-foreground">Subtotal + GST must equal the invoice total. The current tariff evidence gate still applies.</span></div>
        </form>
      </CardContent>
    </Card>
  );
}

function ReviewField({ label, max, maxLength, min, onChange, step, type = "text", value }: { label: string; max?: string; maxLength?: number; min?: string; onChange: (value: string) => void; step?: string; type?: string; value: string }) {
  return <label className="grid gap-1 text-sm"><span className="font-medium">{label}</span><input className="rounded-md border border-border bg-white px-3 py-2" max={max} maxLength={maxLength} min={min} onChange={(event) => onChange(event.target.value)} step={step} type={type} value={value} /></label>;
}

function FileInput({ accept, file, icon, label, onChange }: { accept: string; file: File | null; icon: ReactNode; label: string; onChange: (file: File | null) => void }) {
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      <span className="flex items-center gap-2 font-medium">{icon}{label}</span>
      <input accept={accept} aria-label={label} className="min-w-0 w-full rounded-md border border-border bg-background px-3 py-2" onChange={(event) => onChange(event.target.files?.item(0) ?? null)} type="file" />
      <span className="truncate text-xs text-muted-foreground">{file ? `${file.name} · ${formatBytes(file.size)}` : "Select a local file"}</span>
    </label>
  );
}

function SavedFile({ filename, icon, label, size }: { filename: string; icon: ReactNode; label: string; size: number }) {
  return <div className="min-w-0 rounded-lg border border-emerald-200 bg-white p-3 text-sm"><span className="flex items-center gap-2 font-medium">{icon}{label}</span><strong className="mt-2 block truncate font-medium">{filename}</strong><span className="text-xs text-muted-foreground">{formatBytes(size)}</span></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <p><span className="block text-xs text-muted-foreground">{label}</span><strong className="mt-0.5 block break-words font-medium">{value}</strong></p>;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 3 }).format(value);
}

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSavedAt(value: string) {
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function numberInput(value: number | null) {
  return value === null ? "" : String(value);
}

function capabilityLabel(value: CiEvidenceIntakeResult["nem12"]["capability_status"]) {
  return {
    active_import_only: "Active import (E1)",
    active_import_export: "Active import/export (E1 + B1)",
    active_reactive_import: "Active/reactive import (E1 + Q1)",
    full_active_reactive_import_export: "Full import/export active/reactive",
    measured_active_demand: "Reported active demand (kW)",
    measured_apparent_demand: "Reported apparent demand (kVA)",
  }[value];
}

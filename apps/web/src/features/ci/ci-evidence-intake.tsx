import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleAlert, FileSearch, FileText, MapPin, Navigation, ReceiptText, RefreshCw, TableProperties, UploadCloud, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import { CiNem12LoadProfile } from "@/features/ci/ci-nem12-load-profile";
import { CiTariffAnnualEstimate } from "@/features/ci/ci-tariff-annual-estimate";

export function CiEvidenceIntake({
  onReady,
  projectId,
  setupReady = false,
}: {
  onReady: () => void;
  projectId: string;
  setupReady?: boolean;
}) {
  const queryClient = useQueryClient();
  const [bill, setBill] = useState<File | null>(null);
  const [nem12, setNem12] = useState<File | null>(null);
  const [manualTariffCode, setManualTariffCode] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [billBreakdownOpen, setBillBreakdownOpen] = useState(false);
  const savedEvidence = useQuery({
    queryKey: ciProjectEvidenceQueryKey(projectId),
    queryFn: () => fetchCiProjectEvidence(projectId),
  });
  const inspection = useMutation({
    mutationFn: ({ billFile, billReview, nem12File }: { billFile: File; billReview?: CiBillReviewInput; nem12File: File }) => inspectCiEvidencePair(projectId, billFile, nem12File, undefined, billReview),
    onSuccess: async (result) => {
      setReplacing(false);
      await queryClient.invalidateQueries({ queryKey: ciProjectEvidenceQueryKey(projectId) });
      setBill(null);
      setNem12(null);
      if (result.intake_status === "ready_for_profile_review") onReady();
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
      if (result.intake_status === "ready_for_profile_review") onReady();
    },
  });
  const resetResult = () => inspection.reset();
  const saved = savedEvidence.data?.status === "saved" ? savedEvidence.data.evidence : null;
  const result = savedReview.data ?? inspection.data ?? (!replacing ? saved?.inspection : undefined);
  const fullTariffReady = result?.nem12.full_tariff_analysis_ready ?? false;
  const activeError = inspection.error ?? savedReview.error;
  const detectedTariffCode = result?.bill.network_tariff_code?.trim() ?? "";
  const detectedSiteAddress = result?.bill.site_address?.trim() ?? "";
  const directionsUrl = detectedSiteAddress ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(detectedSiteAddress)}` : null;
  const savedBillName = !replacing ? saved?.files.bill.filename ?? (setupReady ? "Saved to project" : null) : null;
  const savedNem12Name = !replacing ? saved?.files.interval.filename ?? (setupReady ? "Saved to project" : null) : null;
  const detectedChargeGroups = result?.contract_version === "ci_evidence_intake_v9" ? result.detected_tariff : undefined;
  const annualBillReadiness = result?.contract_version === "ci_evidence_intake_v9" ? result.annual_bill_estimate : undefined;

  return (
    <section className="scroll-mt-20 space-y-4" id="evidence-intake">
      <section aria-label="Evidence sources" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <EvidenceFileCard
          accept=".pdf,application/pdf"
          description="Charges, demand and GST."
          file={bill}
          icon={FileText}
          inputLabel="Electricity bill PDF"
          label="Electricity bill"
          onChange={(file) => { setBill(file); if (file) setReplacing(true); resetResult(); }}
          savedName={savedBillName}
        />
        <EvidenceFileCard
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          description="Import, export and reactive intervals."
          file={nem12}
          icon={TableProperties}
          inputLabel="Matching interval CSV / NEM12"
          label="NEM12"
          onChange={(file) => { setNem12(file); if (file) setReplacing(true); resetResult(); }}
          savedName={savedNem12Name}
        />
        <article className="flex min-h-56 flex-col rounded-xl border border-slate-200 bg-white p-4">
          <EvidenceCardHeader icon={ReceiptText} ready={Boolean(detectedTariffCode)} status={detectedTariffCode ? "Detected" : result ? "Manual input" : "From bill"} />
          <h3 className="mt-4 text-sm font-semibold text-slate-950">Tariff</h3>
          <div className="mt-auto pt-4">
            {detectedTariffCode ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2"><span className="block text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Network tariff</span><strong className="mt-1 block text-sm text-emerald-950">{detectedTariffCode}</strong></div>
            ) : result ? (
              <label className="grid gap-1 text-xs font-medium text-slate-700"><span>Tariff code</span><input aria-label="Manual tariff code" className="rounded-md border border-amber-300 bg-amber-50/40 px-3 py-2 text-sm uppercase" onChange={(event) => setManualTariffCode(event.target.value)} placeholder="Enter if not detected" value={manualTariffCode} /><span className="font-normal text-slate-500">Confirm it in the bill review below.</span></label>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-xs leading-5 text-slate-500">Upload and inspect the bill. Manual entry appears only if no tariff is found.</p>
            )}
          </div>
        </article>
        <article className="flex min-h-56 flex-col rounded-xl border border-slate-200 bg-white p-4">
          <EvidenceCardHeader icon={MapPin} ready={Boolean(detectedSiteAddress)} status={detectedSiteAddress ? "Detected" : result ? "Unavailable" : "From bill"} />
          <h3 className="mt-4 text-sm font-semibold text-slate-950">Site address</h3>
          <div className="mt-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"><MapPin className="size-3" />Detected address</span>
            {detectedSiteAddress ? <p className="mt-1 text-xs font-medium leading-5 text-slate-800">{detectedSiteAddress}</p> : <p className="mt-1 text-xs leading-5 text-slate-500">No supply address detected from the bill.</p>}
            {directionsUrl ? <a className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-cyan-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-cyan-800 transition hover:bg-cyan-50" href={directionsUrl} rel="noreferrer" target="_blank"><Navigation className="size-3.5" />Directions</a> : null}
          </div>
        </article>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={!bill || !nem12 || inspection.isPending} onClick={() => { if (bill && nem12) inspection.mutate({ billFile: bill, nem12File: nem12 }); }} type="button">
            <FileSearch className="mr-2 size-4" />{inspection.isPending ? "Inspecting inputs" : saved ? "Inspect & replace" : "Inspect & save"}
          </Button>
          {saved && replacing ? <Button onClick={() => { setReplacing(false); setBill(null); setNem12(null); inspection.reset(); }} type="button" variant="ghost">Cancel replacement</Button> : null}
      </div>

      {savedEvidence.isPending ? <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><RefreshCw className="size-3.5 animate-spin" />Restoring saved evidence…</p> : null}

      {savedEvidence.isError ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>Saved evidence could not be restored.</strong><p className="mt-1">You can replace the bill and interval files below.</p></div> : null}

      {activeError instanceof Error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <div className="flex gap-3"><CircleAlert className="mt-0.5 size-4 shrink-0" /><div><strong>Input check stopped</strong><p className="mt-1">{activeError.message}</p></div></div>
        </div>
      ) : null}

      {result ? (
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><div className="flex flex-wrap items-start justify-between gap-2"><div><CardTitle as="h3">Bill detected</CardTitle><CardDescription>{result.bill.retailer} · {result.bill.invoice_kind}</CardDescription></div><div className="flex items-center gap-2"><Badge variant={result.bill.review_status === "not_required" ? "secondary" : result.bill.review_status === "analyst_confirmed" ? "secondary" : "warning"}>{result.bill.review_status === "not_required" ? "Verified template" : result.bill.review_status === "analyst_confirmed" ? "Analyst confirmed" : "Review required"}</Badge><button aria-controls="detected-bill-breakdown" aria-expanded={billBreakdownOpen} className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 transition hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800" onClick={() => setBillBreakdownOpen((current) => !current)} type="button">{billBreakdownOpen ? "Hide breakdown" : "Show breakdown"}<ChevronDown className={`size-3.5 transition-transform ${billBreakdownOpen ? "rotate-180" : ""}`} /></button></div></div></CardHeader>
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
                <Fact label="Available capability" value={capabilityLabel(result.nem12.capability_status)} />
              </CardContent>
            </Card>
          </div>

          {billBreakdownOpen ? <div id="detected-bill-breakdown"><CiBillBreakdown bill={result.bill} /></div> : null}

          <CiNem12LoadProfile heatmap={result.annual_demand_heatmap} key={`profile-${result.nem12.fingerprint}`} />

          {!fullTariffReady ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <div className="flex gap-3"><CircleAlert className="mt-0.5 size-4 shrink-0" /><div><strong>Limited interval evidence</strong><p className="mt-1 leading-6">Setup can continue with the uploaded measured demand. The heatmap is shown in {result.annual_demand_heatmap.unit} at {result.annual_demand_heatmap.interval_minutes}-minute resolution. Formal kVA, power-factor, export, tariff and annual financial analysis remains locked until a complete aligned five-minute E1, B1, Q1 and K1 NEM12 export is uploaded.</p></div></div>
            </div>
          ) : null}

          {result.bill.review_status === "confirmation_required" ? (
            <BillReviewForm
              bill={result.bill}
              busy={savedReview.isPending}
              initialNetworkTariffCode={manualTariffCode}
              onConfirm={(billReview) => savedReview.mutate(billReview)}
            />
          ) : null}

          <CiAnnualDemandHeatmap heatmap={result.annual_demand_heatmap} key={result.nem12.fingerprint} />

        </div>
      ) : null}

      <CiTariffAnnualEstimate detectedTariff={detectedChargeGroups} estimate={annualBillReadiness} tariffCode={detectedTariffCode || null} />
    </section>
  );
}

function BillReviewForm({ bill, busy, initialNetworkTariffCode, onConfirm }: { bill: CiEvidenceIntakeResult["bill"]; busy: boolean; initialNetworkTariffCode: string; onConfirm: (review: CiBillReviewInput) => void }) {
  const [fields, setFields] = useState({
    retailer: bill.retailer === "Electricity retailer — confirm name" ? "" : bill.retailer,
    invoice_kind: bill.invoice_kind,
    nmi: "",
    billing_period_start: bill.billing_period_start ?? "",
    billing_period_end: bill.billing_period_end ?? "",
    network_tariff_code: bill.network_tariff_code ?? initialNetworkTariffCode,
    consumption_kwh: numberInput(bill.consumption_kwh),
    highest_metered_demand_kva: numberInput(bill.highest_metered_demand_kva),
    power_factor_at_highest_demand: numberInput(bill.power_factor_at_highest_demand),
    subtotal_ex_gst_aud: numberInput(bill.subtotal_ex_gst_aud),
    gst_aud: numberInput(bill.gst_aud),
    total_inc_gst_aud: numberInput(bill.total_inc_gst_aud),
  });
  useEffect(() => {
    if (!initialNetworkTariffCode.trim()) return;
    setFields((current) => ({ ...current, network_tariff_code: initialNetworkTariffCode }));
  }, [initialNetworkTariffCode]);
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

function EvidenceFileCard({ accept, description, file, icon, inputLabel, label, onChange, savedName }: { accept: string; description: string; file: File | null; icon: LucideIcon; inputLabel: string; label: string; onChange: (file: File | null) => void; savedName: string | null }) {
  const displayName = file?.name ?? savedName;
  return (
    <article className="flex min-h-56 flex-col rounded-xl border border-slate-200 bg-white p-4">
      <EvidenceCardHeader icon={icon} ready={Boolean(savedName)} status={file ? "Selected" : savedName ? "Saved" : "Input required"} />
      <h3 className="mt-4 text-sm font-semibold text-slate-950">{label}</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      <label className="mt-auto min-w-0 cursor-pointer pt-4">
        <span className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-cyan-300 bg-cyan-50/40 px-3 py-3 text-xs font-semibold text-cyan-800 hover:bg-cyan-50"><UploadCloud className="size-4" />{displayName ? "Replace file" : "Choose file"}</span>
        <input accept={accept} aria-label={inputLabel} className="sr-only" onChange={(event) => onChange(event.target.files?.item(0) ?? null)} type="file" />
        <span className="mt-2 block truncate text-xs text-slate-500">{displayName ? `${displayName}${file ? ` · ${formatBytes(file.size)}` : ""}` : "No file selected"}</span>
      </label>
    </article>
  );
}

function EvidenceCardHeader({ icon: Icon, ready, status }: { icon: LucideIcon; ready: boolean; status: string }) {
  const statusClass = ready ? "bg-emerald-50 text-emerald-700" : status === "Selected" || status.includes("selected") ? "bg-cyan-50 text-cyan-700" : "bg-amber-50 text-amber-700";
  return <div className="flex items-center justify-between gap-3"><span className={`grid size-9 place-items-center rounded-lg ${ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}><Icon className="size-4" /></span><span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${statusClass}`}>{status}</span></div>;
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

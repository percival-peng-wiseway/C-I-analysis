import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  BadgeDollarSign,
  BarChart3,
  BatteryCharging,
  Check,
  CircleAlert,
  Clock3,
  Cpu,
  FileCheck2,
  Gauge,
  Play,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  SunMedium,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { invalidateCiCalculationHandbook } from "@/features/ci/api/ci-calculation-handbook";
import {
  ciProjectEvidenceQueryKey,
  fetchCiProjectEvidence,
} from "@/features/ci/api/ci-evidence-intake";
import {
  ciSavedFeasibilityQueryKey,
  fetchCiSavedFeasibility,
  runCiDesignFeasibility,
} from "@/features/ci/api/ci-design-feasibility";
import {
  ciSavedDesignQueryKey,
  fetchCiSavedDesign,
  type CiDesignCandidateResult,
  type CiProject,
} from "@/features/ci/api/ci-projects";
import {
  ciProjectTariffReplayQueryKey,
  fetchCiSavedTariffReplay,
  runCiProjectTariffReplay,
  type CiPhysicalScenarioResult,
} from "@/features/ci/api/ci-scenarios";
import {
  ciAnnualFinancialComparisonQueryKey,
  compareCiAnnualFinancialScenarios,
  fetchCiSavedAnnualFinancialComparison,
  type CiAnnualFinancialComparisonResult,
} from "@/features/ci/api/ci-annual-financial-comparison";
import {
  ciDeviceProfileQueryKey,
  fetchCiDeviceProfile,
  type CiDeviceProfile,
  type CiEquipmentSelection,
} from "@/features/ci/api/ci-device-profile";
import {
  ciProjectTariffProfileQueryKey,
  fetchCiProjectTariffProfile,
} from "@/features/ci/api/ci-tariff-profile";
import {
  ciProjectRebateProfileQueryKey,
  fetchCiProjectRebateProfile,
  type CiProjectRebateProfileState,
} from "@/features/ci/api/ci-rebate-profile";
import { CiPortfolioReturnChart } from "@/features/ci/ci-annual-financial-workspace";

type ReplayTab = "summary" | "bills" | "financial" | "demand" | "interval" | "assumptions";

const tabs: Array<{ id: ReplayTab; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "bills", label: "Bills" },
  { id: "financial", label: "Financial" },
  { id: "demand", label: "Demand" },
  { id: "interval", label: "Intervals" },
  { id: "assumptions", label: "Assumptions" },
];

export function CiTariffReplay({
  onConfigureRebates,
  onConfigureTariff,
  project,
}: {
  onConfigureRebates: () => void;
  onConfigureTariff: () => void;
  project: CiProject;
}) {
  const queryClient = useQueryClient();
  const evidence = useQuery({
    queryKey: ciProjectEvidenceQueryKey(project.project_id),
    queryFn: () => fetchCiProjectEvidence(project.project_id),
  });
  const design = useQuery({
    queryKey: ciSavedDesignQueryKey(project.project_id),
    queryFn: () => fetchCiSavedDesign(project.project_id),
  });
  const dispatch = useQuery({
    queryKey: ciSavedFeasibilityQueryKey(project.project_id),
    queryFn: () => fetchCiSavedFeasibility(project.project_id),
  });
  const replay = useQuery({
    queryKey: ciProjectTariffReplayQueryKey(project.project_id),
    queryFn: () => fetchCiSavedTariffReplay(project.project_id),
    retry: false,
  });
  const finance = useQuery({
    queryKey: ciAnnualFinancialComparisonQueryKey(project.project_id),
    queryFn: () => fetchCiSavedAnnualFinancialComparison(project.project_id),
    retry: false,
  });
  const deviceProfile = useQuery({ queryKey: ciDeviceProfileQueryKey, queryFn: () => fetchCiDeviceProfile() });
  const tariffProfile = useQuery({
    queryKey: ciProjectTariffProfileQueryKey(project.project_id),
    queryFn: () => fetchCiProjectTariffProfile(project.project_id),
    retry: false,
  });
  const rebateProfile = useQuery({
    queryKey: ciProjectRebateProfileQueryKey(project.project_id),
    queryFn: () => fetchCiProjectRebateProfile(project.project_id),
    retry: false,
  });
  const [equipmentSelection, setEquipmentSelection] = useState<CiEquipmentSelection | null>(null);

  useEffect(() => {
    if (deviceProfile.data?.status === "ready" && deviceProfile.data.profile) {
      setEquipmentSelection(deviceProfile.data.profile.default_equipment_selection);
    } else if (deviceProfile.data?.status === "not_configured") {
      setEquipmentSelection(null);
    }
  }, [deviceProfile.data?.profile_sha256, deviceProfile.data?.status]);

  const runReplay = useMutation({
    mutationFn: async () => {
      if (tariffProfile.data?.status !== "approved") throw new Error("Approve this project's tariff profile before calculating.");
      const savedManualPrices = finance.data?.status === "ready" && finance.data.result?.assumptions.price_source === "analyst_entered_total_solution_price"
        ? finance.data.result.solutions.map((solution) => ({ scenarioId: solution.scenario_id, upfrontCostAudExGst: solution.upfront_cost_aud_ex_gst }))
        : null;
      if (!savedManualPrices && !equipmentSelection) throw new Error("Select the supported PV, battery and hybrid inverter / PCS before calculating.");
      const feasibilityResult = await runCiDesignFeasibility(project.project_id);
      const tariffResult = await runCiProjectTariffReplay(project.project_id);
      const financeResult = await compareCiAnnualFinancialScenarios({
        projectId: project.project_id,
        pricingMode: savedManualPrices ? "manual_quotes" : "device_profile",
        prices: savedManualPrices ?? undefined,
        equipmentSelection: savedManualPrices ? undefined : equipmentSelection ?? undefined,
      });
      return { feasibilityResult, tariffResult, financeResult };
    },
    onSuccess: ({ feasibilityResult, financeResult, tariffResult }) => {
      queryClient.setQueryData(ciSavedFeasibilityQueryKey(project.project_id), {
        contract_version: "ci_project_feasibility_state_v1",
        status: "ready",
        saved_at: new Date().toISOString(),
        stale_reasons: [],
        result: feasibilityResult,
      });
      queryClient.setQueryData(ciProjectTariffReplayQueryKey(project.project_id), {
        contract_version: "ci_project_tariff_replay_state_v1",
        status: "ready",
        saved_at: new Date().toISOString(),
        stale_reasons: [],
        result: tariffResult,
      });
      queryClient.setQueryData(ciAnnualFinancialComparisonQueryKey(project.project_id), {
        contract_version: "ci_project_annual_financial_state_v1",
        status: "ready",
        saved_at: new Date().toISOString(),
        stale_reasons: [],
        result: financeResult,
      });
      void invalidateCiCalculationHandbook(queryClient, project.project_id);
    },
  });

  if (evidence.isPending || design.isPending || dispatch.isPending || replay.isPending || finance.isPending || deviceProfile.isPending || tariffProfile.isPending || rebateProfile.isPending) {
    return <section aria-labelledby="tariff-replay-title" className="space-y-5"><FinanceRunHeader canRun={false} count={project.design_candidate_count} hasResult={false} onRun={() => undefined} pending={false} /><ReplayLoading /></section>;
  }
  if (evidence.isError || design.isError || dispatch.isError || replay.isError || finance.isError || deviceProfile.isError || tariffProfile.isError || rebateProfile.isError) {
    const failed = [
      evidence.isError ? "Evidence" : null,
      design.isError ? "solution space" : null,
      dispatch.isError ? "Dispatch" : null,
      replay.isError ? "saved tariff replay" : null,
      finance.isError ? "saved Finance result" : null,
      deviceProfile.isError ? "equipment profile" : null,
      tariffProfile.isError ? "tariff profile" : null,
      rebateProfile.isError ? "rebate profile" : null,
    ].filter((value): value is string => value !== null);
    const retry = () => { void Promise.all([evidence.refetch(), design.refetch(), dispatch.refetch(), replay.refetch(), finance.refetch(), deviceProfile.refetch(), tariffProfile.refetch(), rebateProfile.refetch()]); };
    return <section aria-labelledby="tariff-replay-title" className="space-y-5"><FinanceRunHeader canRun={false} count={project.design_candidate_count} hasResult={false} onRun={() => undefined} pending={false} /><ReplayError failed={failed} onRetry={retry} /></section>;
  }

  const inspection = evidence.data.evidence?.inspection ?? null;
  const billApproved = Boolean(
    inspection && ["not_required", "analyst_confirmed"].includes(inspection.bill.review_status),
  );
  const tariffIdentified = Boolean(inspection?.bill.network_tariff_code);
  const intervalReady = inspection?.nem12.full_tariff_analysis_ready === true;
  const annualIntervalReady = inspection?.annual_bill_estimate?.status === "estimated";
  const dispatchReady = dispatch.data.status === "ready";
  const designReady = Boolean(design.data && design.data.candidate_count > 0);
  const savedDeviceProfile = deviceProfile.data.status === "ready" ? deviceProfile.data.profile : null;
  const hasSavedManualQuotes = finance.data.status === "ready" && finance.data.result?.assumptions.price_source === "analyst_entered_total_solution_price";
  const tariffApproved = tariffProfile.data?.status === "approved";
  const enabledRebateCount = countEnabledRebates(rebateProfile.data);
  const rebateReady = enabledRebateCount === 0 || rebateProfile.data.status === "approved";
  const rebateDetail = enabledRebateCount === 0
    ? "No rebate programs selected; Finance will use $0 upfront rebates."
    : rebateProfile.data.status === "approved"
      ? `${enabledRebateCount} approved program${enabledRebateCount === 1 ? "" : "s"} will be calculated by Python.`
      : rebateProfile.data.blockers.map((blocker) => blocker.message).join(" ") || "Save and approve the project rebate profile in Solution Generator.";
  const profileLabel = tariffProfile.data?.profile?.display_label ?? tariffProfile.data?.suggested_profile?.display_label ?? null;
  const tariffDetail = tariffProfile.isError
    ? "The project tariff profile could not be loaded."
    : tariffProfile.data?.blockers.map((blocker) => blocker.message).join(" ") || (tariffApproved ? `Approved: ${profileLabel ?? "project tariff"}.` : "Review and approve the project tariff profile in Evidence.");
  const checks = [
    { label: "Solution space saved", ready: designReady },
    { detail: dispatchReady ? "The saved result will be recalculated." : "Scenario Analysis will run before tariff and Finance.", label: "Scenario Analysis ready to run", ready: designReady },
    { label: "Bill reviewed", ready: billApproved },
    { label: "Tariff code identified", ready: tariffIdentified },
    { label: "E1 / B1 / Q1 / K1 aligned", ready: intervalReady },
    {
      detail: annualIntervalReady
        ? `${inspection?.annual_bill_estimate?.coverage_start} to ${inspection?.annual_bill_estimate?.coverage_end}`
        : inspection?.annual_bill_estimate?.warning ?? "Upload at least 365 consecutive complete days of interval data.",
      label: "365 consecutive-day annual interval",
      ready: annualIntervalReady,
    },
    { detail: tariffDetail, label: "Project tariff profile approved", ready: tariffApproved },
    { detail: rebateDetail, label: "Rebate plan resolved", ready: rebateReady },
    { label: "Equipment & finance profile saved", ready: Boolean(savedDeviceProfile) },
    { detail: hasSavedManualQuotes ? "The saved custom Net CAPEX quotations will be reused." : undefined, label: "Equipment selected or quotations saved", ready: Boolean(equipmentSelection) || hasSavedManualQuotes },
  ];
  const canRun = checks.every((item) => item.ready);
  const savedResult = runReplay.data?.tariffResult ?? replay.data.result;
  const savedFinanceResult = runReplay.data?.financeResult ?? (finance.data.status === "ready" ? finance.data.result : null);
  const result = tariffApproved ? savedResult : null;
  const financeResult = tariffApproved ? savedFinanceResult : null;
  const error = runReplay.error instanceof Error ? runReplay.error.message : null;

  return (
    <section aria-labelledby="tariff-replay-title" className="space-y-5">
      <FinanceRunHeader blockedCount={checks.filter((item) => !item.ready).length} canRun={canRun} count={design.data?.candidate_count ?? 0} hasResult={Boolean(result)} onRun={() => runReplay.mutate()} pending={runReplay.isPending} />

      {error ? <p aria-live="assertive" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      {replay.data.status === "stale" ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The saved replay no longer matches the current project inputs. Run the scenarios again to refresh the annual bills.</p> : null}
      {finance.data.status === "stale" ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{financeStaleMessage(finance.data.stale_reasons)}</p> : null}

      <EquipmentSelectionPanel onChange={setEquipmentSelection} profile={savedDeviceProfile} selection={equipmentSelection} />

      {result ? (
        financeResult ? <CiTariffReplayResult evidenceCode={inspection?.bill.network_tariff_code ?? "Not recorded"} financeResult={financeResult} profileLabel={profileLabel} result={result} /> : <ReplayReadyState canRun={canRun} checks={checks} design={design.data} onConfigureRebates={onConfigureRebates} onConfigureTariff={onConfigureTariff} profileLabel={profileLabel} replayed />
      ) : (
        <ReplayReadyState canRun={canRun} checks={checks} design={design.data} onConfigureRebates={onConfigureRebates} onConfigureTariff={onConfigureTariff} profileLabel={profileLabel} replayed={false} />
      )}
    </section>
  );
}

export function CiTariffReplayResult({
  evidenceCode,
  financeResult,
  profileLabel,
  result,
}: {
  evidenceCode: string;
  financeResult: CiAnnualFinancialComparisonResult;
  profileLabel: string | null;
  result: CiPhysicalScenarioResult;
}) {
  const ordered = useMemo(
    () => [...result.scenarios].sort((left, right) => left.physical_review_rank - right.physical_review_rank),
    [result],
  );
  const [selectedId, setSelectedId] = useState(financeResult.solutions[0]?.scenario_id ?? ordered[0]?.scenario_id ?? "");
  const [tab, setTab] = useState<ReplayTab>("summary");
  const [detailOpen, setDetailOpen] = useState(false);
  const selected = ordered.find((item) => item.scenario_id === selectedId) ?? ordered[0];
  const selectedFinance = financeResult.solutions.find((item) => item.scenario_id === selected?.scenario_id) ?? financeResult.solutions[0];

  if (!selected || !selectedFinance) return null;

  const openSolution = (scenarioId: string) => {
    setSelectedId(scenarioId);
    setTab("summary");
    setDetailOpen(true);
  };

  if (!detailOpen) {
    return (
      <div className="space-y-5">
        <CiPortfolioReturnChart onSelect={openSolution} result={financeResult} selectedScenarioId={selected.scenario_id} />
        <SolutionGallery financeResult={financeResult} onOpen={openSolution} result={result} />
      </div>
    );
  }

  return (
    <section aria-label="Solution analysis" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <button className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-800 hover:text-cyan-950" onClick={() => setDetailOpen(false)} type="button"><ArrowLeft className="size-4" />Back to all solutions</button>
        <label className="w-full text-xs font-medium text-slate-600 sm:w-auto sm:min-w-[390px]">Solution
          <select aria-label="Select solution analysis" className="mt-1 block h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950" onChange={(event) => { setSelectedId(event.target.value); setTab("summary"); }} value={selected.scenario_id}>
            {financeResult.solutions.map((item) => <option key={item.scenario_id} value={item.scenario_id}>#{item.financial_review_rank} · {capacityLabel(item.pv_capacity_kwp_dc)} kWp PV · {capacityLabel(item.battery_capacity_kwh)} kWh battery</option>)}
          </select>
        </label>
      </div>

      <header className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-cyan-700">Solution #{selectedFinance.financial_review_rank}</p><h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{configuration(selected)}</h2><p className="mt-2 text-sm text-slate-500">Physical rank #{selected.physical_review_rank} · {selected.annual_tariff_value.period_start} to {selected.annual_tariff_value.period_end} · AUD ex GST</p></div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700"><Check className="size-3.5" />Calculated</span>
        </div>
        <SystemConfiguration scenario={selected} />
        <KeyMetricStrip result={result} scenario={selected} solution={selectedFinance} />
      </header>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <nav aria-label="Solution analysis sections" className="flex gap-1 overflow-x-auto border-b border-slate-200 px-3 sm:px-5">
          {tabs.map((item) => <button aria-pressed={tab === item.id} className={`whitespace-nowrap border-b-2 px-3 py-4 text-sm font-semibold transition ${tab === item.id ? "border-cyan-600 text-cyan-800" : "border-transparent text-slate-500 hover:text-slate-800"}`} key={item.id} onClick={() => setTab(item.id)} type="button">{item.label}</button>)}
        </nav>
        <div className="p-5 sm:p-6">
          {tab === "summary" ? <Overview result={result} scenario={selected} /> : null}
          {tab === "bills" ? <BillComparison scenario={selected} /> : null}
          {tab === "financial" ? <SelectedFinancialView result={financeResult} solution={selectedFinance} /> : null}
          {tab === "demand" ? <BillingDemand result={result} scenario={selected} /> : null}
          {tab === "interval" ? <IntervalReplay scenario={selected} /> : null}
          {tab === "assumptions" ? <TariffBasis evidenceCode={evidenceCode} profileLabel={profileLabel} result={result} scenario={selected} /> : null}
        </div>
      </section>
    </section>
  );
}

function SolutionGallery({ financeResult, onOpen, result }: { financeResult: CiAnnualFinancialComparisonResult; onOpen: (scenarioId: string) => void; result: CiPhysicalScenarioResult }) {
  return <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 p-5 sm:p-6"><div><p className="text-xs font-semibold uppercase tracking-[.15em] text-cyan-700">Solutions</p><h2 className="mt-1 text-xl font-semibold text-slate-950">Open a solution to inspect the full analysis</h2></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{financeResult.solutions.length} calculated</span></div>
    <div className="grid gap-3 p-4 md:grid-cols-2 2xl:grid-cols-3 sm:p-5">
      {financeResult.solutions.map((solution) => {
        const scenario = result.scenarios.find((item) => item.scenario_id === solution.scenario_id);
        if (!scenario) return null;
        return <button aria-label={`View details for solution ${solution.financial_review_rank}: ${configuration(scenario)}`} className="group rounded-xl border border-slate-200 p-4 text-left transition hover:border-cyan-300 hover:bg-cyan-50/40 hover:shadow-sm" key={solution.scenario_id} onClick={() => onOpen(solution.scenario_id)} type="button">
          <div className="flex items-center justify-between gap-3"><span className="grid size-8 place-items-center rounded-full bg-slate-950 text-xs font-semibold text-white">#{solution.financial_review_rank}</span><span className="text-sm font-semibold tabular-nums text-emerald-700">{signedAud(solution.metrics.net_present_value_aud)} NPV</span></div>
          <h3 className="mt-4 text-sm font-semibold leading-6 text-slate-950">{configuration(scenario)}</h3>
          <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4 sm:grid-cols-4"><GalleryMetric label="Net upfront" value={aud(solution.upfront_cost_aud_ex_gst)} /><GalleryMetric label="Rebates" value={solution.upfront_rebate_aud_ex_gst > 0 ? `−${aud(solution.upfront_rebate_aud_ex_gst)}` : aud(0)} /><GalleryMetric label="Bill after" value={aud(solution.annual_cost_aud_ex_gst)} /><GalleryMetric label="Payback" value={payback(solution.metrics.payback_period_years)} /></dl>
          <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-cyan-800">View analysis <span aria-hidden="true" className="transition group-hover:translate-x-0.5">→</span></span>
        </button>;
      })}
    </div>
  </section>;
}

function SystemConfiguration({ scenario }: { scenario: CiPhysicalScenarioResult["scenarios"][number] }) {
  const input = scenario.authored_inputs;
  const duration = input.max_discharge_kw > 0 ? input.nominal_capacity_kwh / input.max_discharge_kw : 0;
  return <div className="grid gap-px border-y border-slate-200 bg-slate-200 sm:grid-cols-3">
    <SystemTile icon={SunMedium} label="Solar PV" value={`${capacityLabel(input.pv_capacity_kwp_dc)} kWp DC`} detail={`${numberLabel(input.pv_annual_specific_yield_kwh_per_kw, 0)} kWh/kWp annual yield`} />
    <SystemTile icon={BatteryCharging} label="Battery" value={`${capacityLabel(input.nominal_capacity_kwh)} kWh`} detail={`${numberLabel(input.max_discharge_kw)} kW · ${numberLabel(duration)} h`} />
    <SystemTile icon={Cpu} label="Hybrid inverter / PCS" value={`${capacityLabel(input.pv_inverter_capacity_kw_ac)} kW AC`} detail="System-sized integrated power conversion" />
  </div>;
}

function KeyMetricStrip({ result, scenario, solution }: { result: CiPhysicalScenarioResult; scenario: CiPhysicalScenarioResult["scenarios"][number]; solution: CiAnnualFinancialComparisonResult["solutions"][number] }) {
  const demandReduction = Math.max(0, result.baseline.raw_rolling_demand_kva - scenario.post_dispatch.raw_rolling_demand_kva);
  return <div className="grid gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8"><DetailMetric label="Gross CAPEX" value={aud(solution.gross_upfront_cost_aud_ex_gst)} /><DetailMetric label="Upfront rebates" positive={solution.upfront_rebate_aud_ex_gst > 0} value={solution.upfront_rebate_aud_ex_gst > 0 ? `−${aud(solution.upfront_rebate_aud_ex_gst)}` : aud(0)} /><DetailMetric label="Net upfront cost" value={aud(solution.upfront_cost_aud_ex_gst)} /><DetailMetric label="Annual saving" positive value={aud(solution.first_year_value_aud_ex_gst)} /><DetailMetric label="Payback" value={payback(solution.metrics.payback_period_years)} /><DetailMetric label="IRR" value={percent(solution.metrics.internal_rate_of_return)} /><DetailMetric label="NPV" positive={solution.metrics.net_present_value_aud >= 0} value={signedAud(solution.metrics.net_present_value_aud)} /><DetailMetric label="Demand reduction" value={`${numberLabel(demandReduction)} kVA`} /></div>;
}

function SelectedFinancialView({ result, solution }: { result: CiAnnualFinancialComparisonResult; solution: CiAnnualFinancialComparisonResult["solutions"][number] }) {
  const breakdown = solution.capex_breakdown_aud_ex_gst;
  let cumulative = -solution.upfront_cost_aud_ex_gst;
  const cashflowRows = [
    { year: 0, annual: -solution.upfront_cost_aud_ex_gst, cumulative },
    ...solution.metrics.annual_cashflows_aud.map((annual, index) => ({ year: index + 1, annual, cumulative: cumulative += annual })),
  ];
  const capexParts = breakdown ? [
    { label: "PV", value: breakdown.pv_aud, color: "bg-amber-400" },
    { label: "Battery", value: breakdown.battery_aud, color: "bg-cyan-600" },
    { label: "Hybrid inverter / PCS", value: breakdown.inverter_aud, color: "bg-violet-500" },
  ] : [];
  return <div className="space-y-5">
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <Metric icon={BadgeDollarSign} label="Gross CAPEX" value={aud(solution.gross_upfront_cost_aud_ex_gst)} detail="Equipment · ex GST" />
      <Metric icon={ShieldCheck} label="Upfront rebates" value={solution.upfront_rebate_aud_ex_gst > 0 ? `−${aud(solution.upfront_rebate_aud_ex_gst)}` : aud(0)} detail="Python-calculated · ex GST" tone="emerald" />
      <Metric icon={BadgeDollarSign} label="Net upfront cost" value={aud(solution.upfront_cost_aud_ex_gst)} detail="Used for year 0" />
      <Metric icon={BarChart3} label="Net present value" value={signedAud(solution.metrics.net_present_value_aud)} detail={`${(result.assumptions.discount_rate * 100).toFixed(1)}% discount rate`} tone="emerald" />
      <Metric icon={Activity} label="Internal rate of return" value={percent(solution.metrics.internal_rate_of_return)} detail={`${result.assumptions.analysis_term_years}-year analysis`} />
      <Metric icon={Clock3} label="Simple payback" value={payback(solution.metrics.payback_period_years)} detail={`${aud(solution.first_year_value_aud_ex_gst)} year-1 tariff value`} />
    </div>
    <div className="grid gap-5 2xl:grid-cols-[minmax(0,.8fr)_minmax(620px,1.2fr)]">
      <section className="rounded-xl border border-slate-200 p-5">
        <h3 className="font-semibold text-slate-950">Cost composition</h3>
        <p className="mt-1 text-sm text-slate-500">Python-priced equipment and annual operating cost.</p>
        {capexParts.length ? <><div className="mt-6 flex h-5 overflow-hidden rounded-full bg-slate-100">{capexParts.map((part) => <div className={part.color} key={part.label} style={{ width: `${part.value / solution.gross_upfront_cost_aud_ex_gst * 100}%` }}><span className="sr-only">{part.label} {aud(part.value)}</span></div>)}</div><dl className="mt-5 divide-y divide-slate-100">{capexParts.map((part) => <div className="flex items-center justify-between gap-4 py-3" key={part.label}><dt className="flex items-center gap-2 text-sm text-slate-600"><span className={`size-2.5 rounded-sm ${part.color}`} />{part.label}</dt><dd className="font-semibold tabular-nums text-slate-950">{aud(part.value)}</dd></div>)}<div className="flex items-center justify-between gap-4 py-3"><dt className="font-medium text-slate-800">Gross CAPEX</dt><dd className="font-semibold tabular-nums text-slate-950">{aud(solution.gross_upfront_cost_aud_ex_gst)}</dd></div><div className="flex items-center justify-between gap-4 py-3"><dt className="font-medium text-emerald-800">Approved upfront rebates</dt><dd className="font-semibold tabular-nums text-emerald-700">{solution.upfront_rebate_aud_ex_gst > 0 ? `−${aud(solution.upfront_rebate_aud_ex_gst)}` : aud(0)}</dd></div><div className="flex items-center justify-between gap-4 bg-slate-50 px-2 py-3"><dt className="font-semibold text-slate-950">Net upfront cost</dt><dd className="font-bold tabular-nums text-slate-950">{aud(solution.upfront_cost_aud_ex_gst)}</dd></div><div className="flex items-center justify-between gap-4 py-3"><dt className="text-sm text-slate-600">Annual O&amp;M</dt><dd className="font-semibold tabular-nums text-slate-950">{aud(solution.annual_om_cost_aud_ex_gst)} / yr</dd></div></dl></> : <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">A component breakdown is unavailable for a manually entered total quotation. Modelled rebates are not deducted from manual quotes.</p>}
      </section>
      <section className="overflow-hidden rounded-xl border border-slate-200">
        <div className="border-b border-slate-200 p-5"><h3 className="font-semibold text-slate-950">Annual cash flow</h3><p className="mt-1 text-sm text-slate-500">Year 0 CAPEX followed by Python-calculated net operating cash flow.</p></div>
        <div className="max-h-[430px] overflow-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="sticky top-0 bg-slate-50 text-xs text-slate-500"><tr><th className="px-5 py-3 font-medium">Year</th><th className="px-4 py-3 text-right font-medium">Annual cash flow</th><th className="px-5 py-3 text-right font-medium">Cumulative</th></tr></thead><tbody className="divide-y divide-slate-100">{cashflowRows.map((row) => <tr className={row.cumulative >= 0 && cashflowRows[row.year - 1]?.cumulative < 0 ? "bg-emerald-50/70" : ""} key={row.year}><td className="px-5 py-3 font-medium text-slate-700">{row.year === 0 ? "0 · Investment" : row.year}</td><td className={`px-4 py-3 text-right font-semibold tabular-nums ${row.annual >= 0 ? "text-emerald-700" : "text-slate-900"}`}>{signedAud(row.annual)}</td><td className={`px-5 py-3 text-right font-semibold tabular-nums ${row.cumulative >= 0 ? "text-emerald-700" : "text-slate-700"}`}>{signedAud(row.cumulative)}</td></tr>)}</tbody></table></div>
      </section>
    </div>
    <RebateAudit solution={solution} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Basis label="Discount rate" value={`${(result.assumptions.discount_rate * 100).toFixed(1)}%`} /><Basis label="Value escalation" value={`${(result.assumptions.annual_value_escalation_rate * 100).toFixed(1)}% / yr`} /><Basis label="Value degradation" value={`${(result.assumptions.annual_value_degradation_rate * 100).toFixed(1)}% / yr`} /><Basis label="Analysis term" value={`${result.assumptions.analysis_term_years} years`} /><Basis label="Pricing basis" value={result.assumptions.price_source === "workspace_device_profile" ? "Device profile" : "Manual quote"} /></div>
  </div>;
}

function RebateAudit({ solution }: { solution: CiAnnualFinancialComparisonResult["solutions"][number] }) {
  const applicationLabel = solution.rebate_application_status === "applied_to_device_profile_gross_cost"
    ? "Applied to device-profile gross cost"
    : "Information only · not deducted from manual quote";
  return <section aria-labelledby="rebate-audit-title" className="overflow-hidden rounded-xl border border-slate-200">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 p-5"><div><h3 className="font-semibold text-slate-950" id="rebate-audit-title">Rebate calculation audit</h3><p className="mt-1 text-sm text-slate-500">Indicative certificate values from the approved project profile. Eligibility and the final certificate price are not guaranteed.</p></div><span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">{applicationLabel}</span></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-sm"><thead className="bg-white text-xs text-slate-500"><tr><th className="px-5 py-3 font-medium">Program</th><th className="px-3 py-3 font-medium">Status</th><th className="px-3 py-3 text-right font-medium">Certificates</th><th className="px-3 py-3 text-right font-medium">Price ex GST</th><th className="px-3 py-3 text-right font-medium">Calculated</th><th className="px-5 py-3 font-medium">Audit basis</th></tr></thead><tbody className="divide-y divide-slate-100">{solution.rebate_breakdown.map((item) => {
      const audit = solution.rebate_calculation.programs[item.program_id];
      return <tr key={item.program_id}><td className="px-5 py-4 font-semibold text-slate-950">{item.label}</td><td className="px-3 py-4"><RebateStatus status={item.status} /></td><td className="px-3 py-4 text-right tabular-nums text-slate-700">{numberLabel(item.certificate_quantity, 0)}</td><td className="px-3 py-4 text-right tabular-nums text-slate-700">{item.unit_price_aud_ex_gst === null ? "Not configured" : `${aud2(item.unit_price_aud_ex_gst)} / cert`}</td><td className="px-3 py-4 text-right font-semibold tabular-nums text-emerald-700">{aud2(item.rebate_aud_ex_gst)}</td><td className="px-5 py-4 text-xs leading-5 text-slate-500"><strong className="block text-slate-700">{titleCase(audit.formula.rule_id)}</strong><span className="block">{audit.reason_messages.length ? audit.reason_messages.join(" ") : `${humanize(audit.formula.rounding)} · ${formatOperands(audit.formula.operands)}`}</span><span className="mt-1 block text-slate-400">{formatSources(audit.sources)}</span></td></tr>;
    })}</tbody><tfoot className="border-t border-slate-200 bg-emerald-50"><tr><th className="px-5 py-3 text-left font-semibold text-emerald-950" colSpan={4}>Total calculated rebate</th><td className="px-3 py-3 text-right font-bold tabular-nums text-emerald-800">{aud2(solution.rebate_calculation.total_rebate_aud_ex_gst)}</td><td className="px-5 py-3 text-xs text-emerald-900">Target date: {solution.rebate_calculation.target_certificate_date ?? "No approved rebate profile"}</td></tr></tfoot></table></div>
  </section>;
}

function RebateStatus({ status }: { status: CiAnnualFinancialComparisonResult["solutions"][number]["rebate_breakdown"][number]["status"] }) {
  const tone = status === "applied" ? "bg-emerald-100 text-emerald-800" : status === "ineligible" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{humanize(status)}</span>;
}

function EquipmentSelectionPanel({ onChange, profile, selection }: { onChange: (selection: CiEquipmentSelection) => void; profile: CiDeviceProfile | null; selection: CiEquipmentSelection | null }) {
  if (!profile || !selection) return <section className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-950">Equipment catalog required</h2><p className="mt-1 text-sm text-amber-800">Open Settings and save the supported PV, battery and hybrid inverter / PCS catalog before calculating.</p></section>;
  const pv = profile.equipment_catalog.pv_products[0];
  const battery = profile.equipment_catalog.battery_products[0];
  const inverter = profile.equipment_catalog.inverter_products[0];
  return <section aria-labelledby="equipment-selection-title" className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">Equipment</p><h2 className="mt-1 text-lg font-semibold text-slate-950" id="equipment-selection-title">Select pricing references</h2></div><div className="mt-4 grid gap-3 lg:grid-cols-3"><EquipmentSelect label="PV" onChange={(productId) => onChange({ ...selection, pv_product_id: productId as CiEquipmentSelection["pv_product_id"] })} options={profile.equipment_catalog.pv_products.map((item) => ({ id: item.product_id, label: `${item.manufacturer} ${item.model}` }))} summary={`${aud(pv.capital_cost_aud_per_kwp_dc)} / kWp DC`} value={selection.pv_product_id} /><EquipmentSelect label="Battery" onChange={(productId) => onChange({ ...selection, battery_product_id: productId as CiEquipmentSelection["battery_product_id"] })} options={profile.equipment_catalog.battery_products.map((item) => ({ id: item.product_id, label: `${item.manufacturer} ${item.model}` }))} summary="Continuous capacity cost curve" value={selection.battery_product_id} /><EquipmentSelect label="Hybrid inverter / PCS" onChange={(productId) => onChange({ ...selection, inverter_product_id: productId as CiEquipmentSelection["inverter_product_id"] })} options={profile.equipment_catalog.inverter_products.map((item) => ({ id: item.product_id, label: `${item.manufacturer} ${item.model}` }))} summary="Continuous capacity cost curve" value={selection.inverter_product_id} /></div></section>;
}

function EquipmentSelect({ label, onChange, options, summary, value }: { label: string; onChange: (value: string) => void; options: Array<{ id: string; label: string }>; summary: string; value: string }) {
  return <label className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"><span className="text-xs font-semibold text-slate-600">{label}</span><select aria-label={label} className="mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><span className="mt-2 block text-xs text-slate-500">{summary}</span></label>;
}

function ReplayReadyState({
  canRun,
  checks,
  design,
  onConfigureRebates,
  onConfigureTariff,
  profileLabel,
  replayed,
}: {
  canRun: boolean;
  checks: Array<{ detail?: string; label: string; ready: boolean }>;
  design: CiDesignCandidateResult | null;
  onConfigureRebates: () => void;
  onConfigureTariff: () => void;
  profileLabel: string | null;
  replayed: boolean;
}) {
  return (
    <section className="grid overflow-hidden rounded-xl border border-slate-200 bg-white xl:grid-cols-[330px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50/70 p-4 xl:border-b-0 xl:border-r">
        <p className="text-xs font-semibold uppercase tracking-[.14em] text-slate-500">Generated solutions</p>
        <div className="mt-3 max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {design?.candidates.length ? design.candidates.map((scenario, index) => (
            <div className="rounded-lg border border-slate-200 bg-white p-3" key={scenario.scenario_id}>
              <div className="flex items-center justify-between gap-2"><strong className="text-xs text-slate-900">Solution {index + 1}</strong><span className="text-[11px] text-slate-400">{replayed ? "Replayed · finance pending" : "Not replayed"}</span></div>
              <p className="mt-1 text-xs tabular-nums leading-5 text-slate-600">{capacityLabel(scenario.pv_capacity_kwp_dc)} kWp PV · {capacityLabel(scenario.nominal_capacity_kwh)} kWh battery · {capacityLabel(scenario.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS</p>
            </div>
          )) : <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No saved solutions yet.</p>}
        </div>
      </aside>
      <div className="p-6 sm:p-8">
        <div className="mx-auto max-w-3xl">
          <span className={`grid size-14 place-items-center rounded-2xl ${canRun ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {canRun ? <FileCheck2 className="size-6" /> : <CircleAlert className="size-6" />}
          </span>
          <h2 className="mt-5 text-xl font-semibold text-slate-950">{canRun ? `Ready to reconstruct ${design?.candidate_count ?? 0} annual bills` : "Tariff replay needs project inputs"}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">{canRun ? `Python will apply ${profileLabel ?? "the approved project tariff profile"} to every interval and rebuild annual charge categories for each scenario.` : "Complete the missing project items below. No tariff, demand-charge or customer-dollar value is inferred while the evidence gate is incomplete."}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {checks.map((item) => (
              <div className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${item.ready ? "border-emerald-200 bg-emerald-50/60 text-emerald-950" : "border-slate-200 bg-slate-50 text-slate-600"}`} key={item.label}>
                <span className={`grid size-6 shrink-0 place-items-center rounded-full ${item.ready ? "bg-emerald-600 text-white" : "bg-white text-slate-400"}`}>{item.ready ? <Check className="size-3.5" /> : <Clock3 className="size-3.5" />}</span>
                <span className="min-w-0 flex-1"><span className="block">{item.label}</span>{item.detail ? <span className="mt-1 block text-xs leading-5 text-slate-500">{item.detail}</span> : null}</span>
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${item.ready ? "text-emerald-700" : "text-slate-400"}`}>{item.ready ? "Ready" : "Required"}</span>
              </div>
            ))}
          </div>
          {!checks.find((item) => item.label === "Project tariff profile approved")?.ready ? <Button className="mt-4" onClick={onConfigureTariff} type="button" variant="outline">Review tariff profile in Evidence</Button> : null}
          {!checks.find((item) => item.label === "Rebate plan resolved")?.ready ? <Button className="ml-2 mt-4" onClick={onConfigureRebates} type="button" variant="outline">Review rebates in Solution Generator</Button> : null}
          <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-3">
            <ProcessStep icon={Activity} label="1. Interval replay" text="Apply scenario grid import and export to each metered interval." />
            <ProcessStep icon={Gauge} label="2. Billing demand" text="Recalculate chargeable kVA inside approved billing windows." />
            <ProcessStep icon={BadgeDollarSign} label="3. Annual bill" text="Aggregate energy, network, demand, environmental and fixed charges." />
          </div>
        </div>
      </div>
    </section>
  );
}

function Overview({ result, scenario }: { result: CiPhysicalScenarioResult; scenario: CiPhysicalScenarioResult["scenarios"][number] }) {
  const tariff = scenario.annual_tariff_value;
  const savingPercent = tariff.baseline_cost_ex_gst_aud > 0 ? tariff.first_year_value_ex_gst_aud / tariff.baseline_cost_ex_gst_aud * 100 : 0;
  const maximum = Math.max(tariff.baseline_cost_ex_gst_aud, tariff.scenario_cost_ex_gst_aud, 1);
  const post = scenario.post_dispatch;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(330px,.85fr)]">
      <section className="rounded-xl border border-slate-200 p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="font-semibold text-slate-950">Annual bill outcome</h3><p className="mt-1 text-sm text-slate-500">Approved tariff replay · ex GST</p></div><strong className="text-lg tabular-nums text-emerald-700">{numberLabel(savingPercent)}% saved</strong></div>
        <div className="mt-6 space-y-5">
          <BillBar label="Before system" maximum={maximum} value={tariff.baseline_cost_ex_gst_aud} colour="bg-slate-700" />
          <BillBar label="After system" maximum={maximum} value={tariff.scenario_cost_ex_gst_aud} colour="bg-cyan-600" />
        </div>
        <div className="mt-5 flex items-center justify-between rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-950"><span>First-year tariff value</span><strong className="tabular-nums">{aud(tariff.first_year_value_ex_gst_aud)}</strong></div>
      </section>
      <section className="overflow-hidden rounded-xl border border-slate-200"><div className="border-b border-slate-200 bg-slate-50 px-5 py-4"><h3 className="font-semibold text-slate-950">Operational outcome</h3></div><dl className="divide-y divide-slate-100 px-5"><OutcomeRow label="PV generation" value={`${numberLabel(post.pv_generation_kwh / 1000)} MWh`} /><OutcomeRow label="PV curtailed" value={`${numberLabel(post.pv_curtailed_kwh / 1000)} MWh`} /><OutcomeRow label="Rolling demand before" value={`${numberLabel(result.baseline.raw_rolling_demand_kva)} kVA`} /><OutcomeRow label="Rolling demand after" value={`${numberLabel(post.raw_rolling_demand_kva)} kVA`} /><OutcomeRow label="Peak-day replay" value={scenario.dispatch_review_projection.peak_local_date} /></dl></section>
    </div>
  );
}

function BillComparison({ scenario }: { scenario: CiPhysicalScenarioResult["scenarios"][number] }) {
  const tariff = scenario.annual_tariff_value;
  const baseline = tariff.baseline_categories_ex_gst_aud;
  const after = tariff.scenario_categories_ex_gst_aud;
  const keys = baseline && after
    ? [...new Set([...Object.keys(baseline), ...Object.keys(after)])]
      .sort((left, right) => Math.abs(baseline[right] ?? 0) - Math.abs(baseline[left] ?? 0))
    : [];
  const maximum = Math.max(
    1,
    ...keys.flatMap((key) => [Math.abs(baseline?.[key] ?? 0), Math.abs(after?.[key] ?? 0)]),
  );
  const totalMaximum = Math.max(tariff.baseline_cost_ex_gst_aud, tariff.scenario_cost_ex_gst_aud, 1);
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h3 className="font-semibold text-slate-950">Bill before &amp; after</h3><p className="mt-1 text-sm text-slate-500">Annual tariff charges · ex GST</p></div>
          <div className="text-right"><p className="text-xs text-slate-500">Annual saving</p><p className="mt-1 text-lg font-semibold tabular-nums text-emerald-700">{aud(tariff.first_year_value_ex_gst_aud)}</p></div>
        </div>
        <div className="mt-6 space-y-5">
          <BillBar label="Before system" maximum={totalMaximum} value={tariff.baseline_cost_ex_gst_aud} colour="bg-slate-700" />
          <BillBar label="After system" maximum={totalMaximum} value={tariff.scenario_cost_ex_gst_aud} colour="bg-cyan-600" />
        </div>
      </section>

      {keys.length && baseline && after ? (
        <section className="overflow-hidden rounded-xl border border-slate-200">
          <div className="grid grid-cols-[minmax(130px,1fr)_auto] items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
            <h3 className="text-sm font-semibold text-slate-950">Charge categories</h3>
            <span className="text-xs font-medium text-slate-500">Before → After</span>
          </div>
          <div className="divide-y divide-slate-100">
            {keys.map((key) => {
              const beforeValue = baseline[key] ?? 0;
              const afterValue = after[key] ?? 0;
              const saving = beforeValue - afterValue;
              return (
                <div className="grid gap-4 px-4 py-4 sm:grid-cols-[170px_minmax(0,1fr)_120px] sm:items-center sm:px-5" key={key}>
                  <div><p className="text-sm font-medium text-slate-800">{categoryLabel(key)}</p><p className={`mt-1 text-xs font-medium tabular-nums ${saving >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{saving >= 0 ? `${aud(saving)} saved` : `${aud(Math.abs(saving))} increase`}</p></div>
                  <div className="space-y-2.5">
                    <BillCategoryBar colour="bg-slate-600" label="Before" maximum={maximum} value={beforeValue} />
                    <BillCategoryBar colour="bg-cyan-500" label="After" maximum={maximum} value={afterValue} />
                  </div>
                  <div className="text-left text-sm tabular-nums sm:text-right"><span className="text-slate-500">{aud(beforeValue)}</span><span className="mx-1.5 text-slate-300">→</span><strong className="text-slate-950">{aud(afterValue)}</strong></div>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">Re-run tariff + finance to load the category-level before-and-after bill.</section>
      )}
    </div>
  );
}

function BillingDemand({ result, scenario }: { result: CiPhysicalScenarioResult; scenario: CiPhysicalScenarioResult["scenarios"][number] }) {
  const post = scenario.post_dispatch;
  const hasMonthlyThresholds = scenario.selected_monthly_thresholds_kw.some((value) => value !== null);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric icon={Gauge} label="Baseline rolling maximum" value={`${numberLabel(result.baseline.raw_rolling_demand_kva)} kVA`} detail={`Chargeable ${numberLabel(result.baseline.chargeable_rolling_demand_kva)} kVA`} />
        <Metric icon={Gauge} label="Scenario rolling maximum" value={`${numberLabel(post.raw_rolling_demand_kva)} kVA`} detail={`Chargeable ${numberLabel(post.chargeable_rolling_demand_kva)} kVA`} />
        <Metric icon={BarChart3} label="Rolling-demand reduction" value={`${numberLabel(Math.max(0, result.baseline.raw_rolling_demand_kva - post.raw_rolling_demand_kva))} kVA`} detail="Representative calendar year" tone={post.raw_rolling_demand_kva < result.baseline.raw_rolling_demand_kva ? "emerald" : "default"} />
      </div>
      {hasMonthlyThresholds ? (
        <section className="rounded-xl border border-slate-200 p-5"><h3 className="font-semibold text-slate-950">Selected monthly demand thresholds</h3><p className="mt-1 text-sm text-slate-500">Optimizer thresholds used by the annual representative-year replay.</p><MonthlyThresholds values={scenario.selected_monthly_thresholds_kw} /></section>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-5"><h3 className="font-semibold text-slate-950">Demand replay basis</h3><p className="mt-1 text-sm leading-6 text-slate-500">This run reports the evidence-bound annual rolling maximum directly. No separate monthly target series was selected by the optimizer.</p></section>
      )}
    </div>
  );
}

function IntervalReplay({ scenario }: { scenario: CiPhysicalScenarioResult["scenarios"][number] }) {
  const points = scenario.dispatch_review_projection.points;
  const width = 920; const height = 300; const left = 48; const right = 16; const top = 20; const bottom = 42;
  const maximum = Math.max(1, ...points.flatMap((point) => [point.baseline_kva, point.post_dispatch_kva])) * 1.05;
  const x = (index: number) => left + (width - left - right) * index / Math.max(1, points.length - 1);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / maximum);
  const path = (key: "baseline_kva" | "post_dispatch_kva") => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  return (
    <section><h3 className="font-semibold text-slate-950">Peak-day interval replay</h3><p className="mt-1 text-sm text-slate-500">Apparent demand before and after Dispatch on {scenario.dispatch_review_projection.peak_local_date}.</p><div className="mt-5 overflow-x-auto"><svg aria-label="Tariff interval demand replay" className="min-w-[720px]" role="img" viewBox={`0 0 ${width} ${height}`}><rect fill="#fbfdff" x={left} y={top} width={width-left-right} height={height-top-bottom} />{[0,.25,.5,.75,1].map((tick)=><line key={tick} stroke="#e2e8f0" x1={left} x2={width-right} y1={y(maximum*tick)} y2={y(maximum*tick)} />)}<path d={path("baseline_kva")} fill="none" stroke="#64748b" strokeWidth="3" /><path d={path("post_dispatch_kva")} fill="none" stroke="#0891b2" strokeWidth="3" />{[0,.25,.5,.75,1].map((tick)=>{const index=Math.min(points.length-1,Math.round((points.length-1)*tick));return <text fill="#64748b" fontSize="11" key={tick} textAnchor={tick===0?"start":tick===1?"end":"middle"} x={x(index)} y={height-12}>{points[index]?.local_time_label}</text>;})}<text fill="#475569" fontSize="11" x="6" y="15">kVA</text></svg></div><div className="mt-3 flex flex-wrap gap-5 text-xs text-slate-600"><Legend colour="#64748b" label="Baseline kVA" /><Legend colour="#0891b2" label="Post-dispatch kVA" /></div></section>
  );
}

function TariffBasis({ evidenceCode, profileLabel, result, scenario }: { evidenceCode: string; profileLabel: string | null; result: CiPhysicalScenarioResult; scenario: CiPhysicalScenarioResult["scenarios"][number] }) {
  const rows = [
    ["Network tariff code", evidenceCode],
    ["Active tariff profile", profileLabel ?? "Evidence-bound private profile"],
    ["Replay period", `${scenario.annual_tariff_value.period_start} to ${scenario.annual_tariff_value.period_end}`],
    ["Rate basis", humanize(scenario.annual_tariff_value.rate_basis)],
    ["Calculation method", humanize(scenario.annual_tariff_value.calculation_method)],
    ["Result permission", "Internal evidence review only"],
  ];
  return <div className="space-y-6"><section><h3 className="font-semibold text-slate-950">Evidence and calculation basis</h3><div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 px-4">{rows.map(([label,value])=><div className="grid gap-1 py-3 text-sm sm:grid-cols-[190px_minmax(0,1fr)]" key={label}><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-800">{value}</dd></div>)}</div></section><section><h3 className="font-semibold text-slate-950">Python assumptions</h3><ul className="mt-3 space-y-2">{result.assumptions.map((item)=><li className="flex gap-2 text-sm leading-6 text-slate-600" key={item}><span className="mt-2 size-1.5 shrink-0 rounded-full bg-cyan-500" />{item}</li>)}</ul></section></div>;
}

function FinanceRunHeader({ blockedCount = 0, canRun, count, hasResult, onRun, pending }: { blockedCount?: number; canRun: boolean; count: number; hasResult: boolean; onRun: () => void; pending: boolean }) {
  const blockerId = blockedCount > 0 ? "finance-run-blocker" : undefined;
  return <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><div className="flex items-start gap-3"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><ReceiptText className="size-5" /></span><div><h1 className="text-xl font-semibold text-slate-950" id="tariff-replay-title">Annual bill reconstruction</h1><p className="mt-1 text-sm text-slate-500">One action recalculates Scenario Analysis, tariff and Finance for all {count} solutions.</p></div></div><div className="flex flex-col items-end gap-2">{blockedCount > 0 ? <p className="text-xs font-semibold text-amber-800" id={blockerId} role="status">{blockedCount} {blockedCount === 1 ? "input" : "inputs"} required</p> : null}<Button aria-describedby={blockerId} disabled={!canRun || pending} onClick={onRun} type="button">{pending ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : hasResult ? <RefreshCw className="size-4" /> : <Play className="size-4" />}{pending ? "Analysis running…" : hasResult ? "Re-run analysis" : "Start analysis"}</Button></div></header>;
}

function ReplayLoading() { return <section className="grid min-h-[420px] place-items-center rounded-xl border border-slate-200 bg-white"><div className="text-center"><RefreshCw className="mx-auto size-6 animate-spin text-cyan-700" /><h2 className="mt-4 font-semibold text-slate-950">Loading tariff replay</h2><p className="mt-1 text-sm text-slate-500">Checking project evidence and completed scenarios.</p></div></section>; }
function ReplayError({ failed, onRetry }: { failed: string[]; onRetry: () => void }) { return <section aria-live="assertive" className="rounded-xl border border-red-200 bg-red-50 p-5" role="alert"><h2 className="font-semibold text-red-950">Finance inputs unavailable</h2><p className="mt-1 text-sm text-red-800">Could not safely load: {failed.join(", ")}.</p><Button className="mt-4" onClick={onRetry} type="button" variant="outline"><RefreshCw className="size-4" />Retry loading</Button></section>; }
function ProcessStep({ icon: Icon, label, text }: { icon: typeof Activity; label: string; text: string }) { return <div className="bg-white p-4"><Icon className="size-4 text-cyan-700" /><h3 className="mt-3 text-sm font-semibold text-slate-900">{label}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{text}</p></div>; }
function Metric({ detail, icon: Icon, label, tone = "default", value }: { detail: string; icon: typeof Activity; label: string; tone?: "default" | "emerald"; value: string }) { return <div className={`rounded-xl border p-4 ${tone === "emerald" ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200 bg-white"}`}><Icon className={`size-4 ${tone === "emerald" ? "text-emerald-700" : "text-cyan-700"}`} /><p className="mt-4 text-xs text-slate-500">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>; }
function GalleryMetric({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt><dd className="mt-1 truncate text-xs font-semibold tabular-nums text-slate-800">{value}</dd></div>; }
function SystemTile({ detail, icon: Icon, label, value }: { detail: string; icon: typeof Activity; label: string; value: string }) { return <div className="bg-white p-4 sm:p-5"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Icon className="size-4" /></span><div className="min-w-0"><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-1 text-base font-semibold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></div></div></div>; }
function DetailMetric({ label, positive = false, value }: { label: string; positive?: boolean; value: string }) { return <div className="bg-white p-4"><p className="text-[10px] font-medium uppercase tracking-[.12em] text-slate-400">{label}</p><p className={`mt-2 text-lg font-semibold tabular-nums ${positive ? "text-emerald-700" : "text-slate-950"}`}>{value}</p></div>; }
function OutcomeRow({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-4 py-3.5"><dt className="text-sm text-slate-500">{label}</dt><dd className="text-right text-sm font-semibold tabular-nums text-slate-950">{value}</dd></div>; }
function BillBar({ colour, label, maximum, value }: { colour: string; label: string; maximum: number; value: number }) { return <div><div className="mb-2 flex justify-between gap-3 text-sm"><span className="text-slate-600">{label}</span><strong className="tabular-nums text-slate-950">{aud(value)}</strong></div><div className="h-4 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.max(1, value / maximum * 100)}%` }} /></div></div>; }
function BillCategoryBar({ colour, label, maximum, value }: { colour: string; label: string; maximum: number; value: number }) { return <div className="grid grid-cols-[42px_minmax(0,1fr)] items-center gap-2"><span className="text-[11px] text-slate-500">{label}</span><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.max(value === 0 ? 0 : 2, Math.abs(value) / maximum * 100)}%` }} /></div></div>; }
function MonthlyThresholds({ values }: { values: Array<number | null> }) { const maximum=Math.max(1,...values.map((value)=>value??0)); return <div className="mt-6 grid h-48 grid-cols-12 items-end gap-2 border-b border-slate-200 px-1">{values.map((value,index)=><div className="flex h-full flex-col justify-end" key={index}><div className="group relative rounded-t bg-cyan-500" style={{height:value===null?"2px":`${Math.max(4,(value/maximum)*100)}%`}} title={value===null?"Not selected":`${numberLabel(value)} kW`} /><span className="mt-2 text-center text-[10px] text-slate-500">{new Intl.DateTimeFormat("en-AU",{month:"short"}).format(new Date(2026,index,1)).slice(0,1)}</span></div>)}</div>; }
function Legend({ colour, label }: { colour: string; label: string }) { return <span className="flex items-center gap-2"><span className="h-0.5 w-5" style={{backgroundColor:colour}} />{label}</span>; }
function configuration(scenario: CiPhysicalScenarioResult["scenarios"][number]) { return `${capacityLabel(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp PV · ${capacityLabel(scenario.authored_inputs.nominal_capacity_kwh)} kWh battery · ${capacityLabel(scenario.authored_inputs.pv_inverter_capacity_kw_ac)} kW hybrid inverter / PCS`; }
function categoryLabel(value: string) { const labels: Record<string,string>={energy_charges:"Energy charges",network_charges:"Network charges",demand_charges:"Demand charges",environmental_charges:"Environmental charges",metering_charges:"Metering charges",fixed_charges:"Fixed charges",export_credit:"Export credit"}; return labels[value]??humanize(value); }
function nullableUnit(value: number | null, unit: string) { return value === null ? "Not evaluated" : `${numberLabel(value)} ${unit}`; }
function capacityLabel(value: number) { return new Intl.NumberFormat("en-AU",{maximumFractionDigits:9}).format(value); }
function numberLabel(value: number, digits = 1) { return new Intl.NumberFormat("en-AU",{maximumFractionDigits:digits}).format(value); }
function aud(value: number) { return new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD",maximumFractionDigits:0}).format(value); }
function aud2(value: number) { return new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD",minimumFractionDigits:2,maximumFractionDigits:2}).format(value); }
function signedAud(value: number) { return `${value >= 0 ? "+" : "−"}${aud(Math.abs(value))}`; }
function percent(value: number | null) { return value === null ? "No IRR" : `${(value * 100).toFixed(1)}%`; }
function payback(value: number | null) { return value === null ? "Beyond term" : `${value.toFixed(1)} yrs`; }
function Basis({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-950">{value}</dd></div>; }
function humanize(value: string) { return value.replaceAll("_"," ").replace(/\bv\d+\b/g,"").replace(/\s+/g," ").trim().replace(/^./,(character)=>character.toUpperCase()); }
function titleCase(value: string) { return value.replaceAll("_"," ").replace(/^./,(character)=>character.toUpperCase()); }
function formatOperands(operands: Record<string, unknown>) {
  const values = Object.entries(operands).map(([label, value]) => {
    const display = typeof value === "number" ? numberLabel(value, 3) : value === null ? "Not set" : String(value);
    return `${titleCase(label)} ${display}`;
  });
  return values.length ? values.join(" · ") : "No calculation operands";
}
function formatSources(sources: Record<string, unknown>) {
  const values = Object.entries(sources).filter(([, value]) => typeof value === "string" && value.trim()).map(([label, value]) => `${titleCase(label)}: ${String(value)}`);
  return values.length ? `Sources · ${values.join(" · ")}` : "No approved source recorded";
}
function financeStaleMessage(reasons: string[]) {
  if (reasons.includes("rebate_profile_approval_required")) return "The selected rebate plan is not approved. Review it in Solution Generator before running Finance.";
  if (reasons.includes("rebate_profile_changed")) return "The approved rebate profile changed. Run tariff + finance again to refresh gross CAPEX, rebates and net upfront cost.";
  if (reasons.includes("device_profile_changed")) return "The equipment catalog changed. Run tariff + finance again to refresh the financial result.";
  if (reasons.includes("tariff_replay_changed")) return "The tariff replay changed. Run tariff + finance again to refresh the financial result.";
  return "The saved financial result is out of date. Run tariff + finance again.";
}
function countEnabledRebates(state: CiProjectRebateProfileState) {
  const profile = state.profile ?? state.suggested_profile;
  return Object.values(profile.programs).filter((program) => program.enabled).length;
}

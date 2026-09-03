import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CiAnalysisResult } from "@/features/ci/api/ci-analysis";
import {
  listCiFinancialSolutions,
  setCiFinancialSolutionStarred,
  type CiFinancialSolution,
} from "@/features/ci/api/ci-financial-solutions";
import {
  ciInternalReportDownloadPath,
  fetchLatestCiInternalReport,
  prepareCiInternalReport,
  type CiInternalReportArtifact,
} from "@/features/ci/api/ci-internal-report";
import {
  analyzeCiThreeCaseComparison,
  type CiPhysicalScenarioResult,
  type CiScenarioInput,
  type CiThreeCaseComparisonResult,
} from "@/features/ci/api/ci-scenarios";

const financialSolutionsQueryKey = ["ci-financial-solutions"] as const;
const internalReportQueryKey = ["ci-internal-review-report"] as const;

type PhysicalScenario = CiPhysicalScenarioResult["scenarios"][number];

export function CiConsultantReviewWorkspace({
  analysis,
  file,
  scenarioInputs,
  scenarioResult,
}: {
  analysis: CiAnalysisResult;
  file?: File | null;
  scenarioInputs?: CiScenarioInput[];
  scenarioResult: CiPhysicalScenarioResult | null;
}) {
  const queryClient = useQueryClient();
  const solutionsQuery = useQuery({
    queryKey: financialSolutionsQueryKey,
    queryFn: () => listCiFinancialSolutions(),
  });
  const starMutation = useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) =>
      setCiFinancialSolutionStarred(id, starred),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: financialSolutionsQueryKey }),
  });
  const reportQuery = useQuery({
    queryKey: internalReportQueryKey,
    queryFn: () => fetchLatestCiInternalReport(),
  });
  const comparisonMutation = useMutation({
    mutationFn: (selection: { pvOnlyScenarioId: string; pvBatteryScenarioId: string }) => {
      if (!file || !scenarioInputs?.length) {
        throw new Error("The current evidence file and authored scenarios are unavailable.");
      }
      return analyzeCiThreeCaseComparison(file, scenarioInputs, selection);
    },
  });
  const reportMutation = useMutation({
    mutationFn: ({ financial, comparison }: { financial: CiFinancialSolution; comparison: CiThreeCaseComparisonResult }) => {
      if (!file || !scenarioInputs?.length) throw new Error("The current evidence file and authored scenarios are unavailable.");
      const pvOnlyScenarioId = comparison.cases.find((item) => item.case_id === "pv_only")?.scenario_id;
      const pvBatteryScenarioId = comparison.cases.find((item) => item.case_id === "pv_battery")?.scenario_id;
      if (!pvOnlyScenarioId || !pvBatteryScenarioId || financial.scenario_id !== pvBatteryScenarioId) {
        throw new Error("View the saved PV-and-battery solution used by the current three-case comparison.");
      }
      return prepareCiInternalReport({
        file,
        financialSolutionId: financial.solution_id,
        scenarios: scenarioInputs,
        pvOnlyScenarioId,
        pvBatteryScenarioId,
      });
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: internalReportQueryKey }),
  });

  const scenarioIds = useMemo(
    () => new Set((scenarioResult?.scenarios ?? []).map((scenario) => scenario.scenario_id)),
    [scenarioResult],
  );
  const matchingFinancialSolutions = (solutionsQuery.data ?? []).filter((solution) =>
    scenarioIds.has(solution.scenario_id)
  );

  return (
    <CiConsultantReviewContent
      analysis={analysis}
      comparison={comparisonMutation.data ?? null}
      comparisonError={comparisonMutation.error instanceof Error ? comparisonMutation.error.message : null}
      comparisonLoading={comparisonMutation.isPending}
      financialError={solutionsQuery.isError ? solutionsQuery.error.message : null}
      financialLoading={solutionsQuery.isPending}
      financialSolutions={matchingFinancialSolutions}
      onStar={(solution) => starMutation.mutate({ id: solution.solution_id, starred: !solution.starred })}
      onRetryFinancial={() => void solutionsQuery.refetch()}
      onPrepareReport={(financial, comparison) => reportMutation.mutate({ financial, comparison })}
      onRunComparison={(selection) => comparisonMutation.mutate(selection)}
      scenarioResult={scenarioResult}
      reportArtifact={reportMutation.data ?? reportQuery.data ?? null}
      reportError={reportMutation.error instanceof Error ? reportMutation.error.message : reportQuery.isError ? reportQuery.error.message : null}
      reportPreparing={reportMutation.isPending}
      starError={starMutation.isError ? starMutation.error.message : null}
      starPendingId={starMutation.isPending ? starMutation.variables?.id ?? null : null}
    />
  );
}

export function CiConsultantReviewContent({
  analysis,
  comparison = null,
  comparisonError = null,
  comparisonLoading = false,
  financialError = null,
  financialLoading = false,
  financialSolutions,
  onRetryFinancial = () => undefined,
  onRunComparison = () => undefined,
  onPrepareReport = () => undefined,
  onStar = () => undefined,
  scenarioResult,
  reportArtifact = null,
  reportError = null,
  reportPreparing = false,
  starError = null,
  starPendingId = null,
}: {
  analysis: CiAnalysisResult;
  comparison?: CiThreeCaseComparisonResult | null;
  comparisonError?: string | null;
  comparisonLoading?: boolean;
  financialError?: string | null;
  financialLoading?: boolean;
  financialSolutions: CiFinancialSolution[];
  onRetryFinancial?: () => void;
  onRunComparison?: (selection: { pvOnlyScenarioId: string; pvBatteryScenarioId: string }) => void;
  onPrepareReport?: (financial: CiFinancialSolution, comparison: CiThreeCaseComparisonResult) => void;
  onStar?: (solution: CiFinancialSolution) => void;
  scenarioResult: CiPhysicalScenarioResult | null;
  reportArtifact?: CiInternalReportArtifact | null;
  reportError?: string | null;
  reportPreparing?: boolean;
  starError?: string | null;
  starPendingId?: string | null;
}) {
  const [viewedFinancialId, setViewedFinancialId] = useState<string | null | undefined>(undefined);
  const [viewedScenarioId, setViewedScenarioId] = useState<string | null>(null);
  const viewedFinancial = viewedFinancialId === null
    ? null
    : financialSolutions.find((item) => item.solution_id === viewedFinancialId)
      ?? financialSolutions[0]
      ?? null;
  const scenarios = scenarioResult?.scenarios ?? [];
  const viewedScenario = scenarios.find((item) => item.scenario_id === viewedScenarioId)
    ?? scenarios.find((item) => item.scenario_id === viewedFinancial?.scenario_id)
    ?? scenarios[0]
    ?? null;
  const shortlistedCount = financialSolutions.filter((item) => item.starred).length;

  return (
    <section aria-labelledby="ci-consultant-review-title" className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle as="h2" id="ci-consultant-review-title">Consultant review</CardTitle>
                <Badge variant="secondary">Internal review only</Badge>
                <Badge variant="outline">No automatic recommendation</Badge>
              </div>
              <CardDescription className="mt-2">
                Guide the investment discussion from reconciled evidence to saved solution economics without changing calculation authority.
              </CardDescription>
            </div>
            <div className="grid min-w-[13rem] gap-1 text-right text-sm">
              <span className="text-muted-foreground">Shortlist</span>
              <strong>{shortlistedCount} starred solution{shortlistedCount === 1 ? "" : "s"}</strong>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="self-start lg:sticky lg:top-6">
          <Card>
            <CardHeader><CardTitle as="h3" className="text-sm">Review map</CardTitle></CardHeader>
            <CardContent>
              <nav aria-label="C&I consultant review sections" className="grid gap-1 text-sm">
                <ReviewLink href="#ci-decision-overview">Decision overview</ReviewLink>
                <ReviewLink href="#ci-baseline-evidence">Baseline &amp; evidence</ReviewLink>
                <ReviewLink href="#ci-solution-explorer">Solution explorer</ReviewLink>
                <ReviewLink href="#ci-physical-evidence">Physical evidence</ReviewLink>
                <ReviewLink href="#ci-financial-assessment">Financial assessment</ReviewLink>
                <ReviewLink href="#ci-assumptions-provenance">Assumptions &amp; provenance</ReviewLink>
                <ReviewLink href="#ci-output-status">Output status</ReviewLink>
              </nav>
            </CardContent>
          </Card>
        </aside>

        <div className="min-w-0 space-y-6">
          <DecisionOverview
            financial={viewedFinancial}
            financialError={financialError}
            financialLoading={financialLoading}
            onRetryFinancial={onRetryFinancial}
            scenario={viewedScenario}
          />
          <BaselineEvidence analysis={analysis} />
          <SolutionExplorer
            financialSolutions={financialSolutions}
            onStar={onStar}
            onViewFinancial={(solution) => {
              setViewedFinancialId(solution.solution_id);
              setViewedScenarioId(solution.scenario_id);
            }}
            onViewScenario={(scenario) => {
              setViewedFinancialId(null);
              setViewedScenarioId(scenario.scenario_id);
            }}
            scenarios={scenarios}
            viewedFinancial={viewedFinancial}
            viewedScenario={viewedScenario}
            starError={starError}
            starPendingId={starPendingId}
          />
          <PhysicalEvidence
            comparison={comparison}
            comparisonError={comparisonError}
            comparisonLoading={comparisonLoading}
            onRunComparison={onRunComparison}
            result={scenarioResult}
            scenario={viewedScenario}
          />
          <FinancialAssessment financial={viewedFinancial} loading={financialLoading} />
          <AssumptionsAndProvenance analysis={analysis} result={scenarioResult} scenario={viewedScenario} />
          <OutputStatus
            comparison={comparison}
            financial={viewedFinancial}
            onPrepare={() => viewedFinancial && comparison ? onPrepareReport(viewedFinancial, comparison) : undefined}
            report={reportArtifact}
            reportError={reportError}
            reportPreparing={reportPreparing}
            result={scenarioResult}
          />
        </div>
      </div>
    </section>
  );
}

function ReviewLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="rounded-md px-2 py-2 text-muted-foreground hover:bg-muted hover:text-foreground" href={href}>{children}</a>;
}

function DecisionOverview({
  financial,
  financialError,
  financialLoading,
  onRetryFinancial,
  scenario,
}: {
  financial: CiFinancialSolution | null;
  financialError: string | null;
  financialLoading: boolean;
  onRetryFinancial: () => void;
  scenario: PhysicalScenario | null;
}) {
  return (
    <section aria-labelledby="ci-decision-overview-heading" id="ci-decision-overview">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle as="h2" id="ci-decision-overview-heading">Decision overview</CardTitle>
              <CardDescription>
                The currently viewed solution is a review focus, not a recommendation.
              </CardDescription>
            </div>
            {financial?.starred ? <Badge variant="secondary">★ Shortlisted</Badge> : <Badge variant="outline">Viewed only</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {financialLoading ? <p className="text-sm text-muted-foreground">Loading saved financial solutions…</p> : null}
          {financialError ? (
            <div className="rounded-lg border border-destructive/40 p-4 text-sm">
              <p className="font-medium text-destructive">Saved financial solutions could not be loaded.</p>
              <p className="mt-1 text-muted-foreground">{financialError}</p>
              <Button className="mt-3" onClick={onRetryFinancial} type="button" variant="outline">Reload saved solutions</Button>
            </div>
          ) : financial ? (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Viewed solution</p>
                <p className="mt-1 text-2xl font-semibold">{financial.label}</p>
                {scenario ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatCapacity(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp PV · {formatCapacity(scenario.authored_inputs.nominal_capacity_kwh)} kWh BESS · {formatCapacity(scenario.authored_inputs.max_discharge_kw)} kW discharge
                  </p>
                ) : null}
              </div>
              <div className="grid gap-3 xl:grid-cols-3 2xl:grid-cols-7">
                <DecisionMetric label="Upfront cost" value={formatAud(financial.assumptions.upfront_cost_aud)} />
                <DecisionMetric label="Year-1 net value" value={formatAud(financial.assumptions.first_year_net_value_aud)} />
                <DecisionMetric label="NPV" value={formatAud(financial.metrics.net_present_value_aud)} />
                <DecisionMetric label="Payback" value={financial.metrics.payback_period_years === null ? "Beyond term" : `${financial.metrics.payback_period_years.toFixed(2)} yr`} />
                <DecisionMetric label="IRR" value={financial.metrics.internal_rate_of_return === null ? "—" : `${(financial.metrics.internal_rate_of_return * 100).toFixed(1)}%`} />
              </div>
              <p className="text-xs text-muted-foreground">
                Financial tax basis: {financial.assumptions.pricing_resolution.tax_basis === "gst_inclusive" ? "GST inclusive" : "GST exclusive"}. Metrics are displayed exactly from the saved Python-owned financial solution.
              </p>
            </>
          ) : scenario ? (
            <div className="rounded-lg border border-dashed p-5">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Viewed physical scenario</p>
              <p className="mt-1 text-xl font-semibold">{scenario.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatCapacity(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp PV · {formatCapacity(scenario.authored_inputs.nominal_capacity_kwh)} kWh BESS · no matching saved financial assessment
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-5">
              <p className="font-medium">No backend scenario result is available for review.</p>
              <p className="mt-1 text-sm text-muted-foreground">Return to Analyse and run physical scenarios before using Review.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function BaselineEvidence({ analysis }: { analysis: CiAnalysisResult }) {
  const demand = analysis.demand_evidence;
  const bill = analysis.bill_reconciliation;
  return (
    <section aria-labelledby="ci-baseline-evidence-heading" id="ci-baseline-evidence">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle as="h2" id="ci-baseline-evidence-heading">Baseline &amp; evidence</CardTitle>
              <CardDescription>Establish whether the investment discussion rests on reconciled site evidence.</CardDescription>
            </div>
            <Badge variant="secondary">Bill reconciled</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 xl:grid-cols-5">
            <DecisionMetric label="12-month rolling demand" value={`${demand.rolling_demand_kva.toFixed(2)} kVA`} />
            <DecisionMetric label="Billing maximum" value={`${demand.billing_period_max_kva.toFixed(2)} kVA`} />
            <DecisionMetric label="Power factor at maximum" value={demand.billing_period_max_power_factor.toFixed(3)} />
            <DecisionMetric label="Bill total" value={formatAud(bill.calculated_total_inc_gst_aud)} />
            <DecisionMetric label="Reconciliation checks" value={`${bill.checks.length} passed`} />
          </div>
          <div className="grid gap-3 text-sm xl:grid-cols-2">
            <ReviewFact label="Evidence period" value={`${analysis.data_quality.coverage_start} to ${analysis.data_quality.coverage_end}`} />
            <ReviewFact label="Tariff" value={`${analysis.profile.network_tariff_code} · ${analysis.profile.source_version}`} />
            <ReviewFact label="Interval structure" value={`${analysis.data_quality.interval_minutes}-minute E/B/Q/K streams`} />
            <ReviewFact label="Demand basis" value={`${analysis.tariff_mapping.demand_interval_minutes}-minute kVA · ${analysis.tariff_mapping.rolling_demand_months}-month rolling`} />
          </div>
          <details className="rounded-lg border border-border p-4 text-sm">
            <summary className="cursor-pointer font-medium">Technical evidence</summary>
            <div className="mt-3 grid gap-2 xl:grid-cols-2">
              <ReviewFact label="Rolling maximum timestamp" value={formatTimestamp(demand.rolling_demand_timestamp)} />
              <ReviewFact label="Incentive maximum timestamp" value={formatTimestamp(demand.incentive_demand_timestamp)} />
              <ReviewFact label="Billing maximum kW / kVAr" value={`${demand.billing_period_max_kw.toFixed(2)} / ${demand.billing_period_max_kvar.toFixed(2)}`} />
              <ReviewFact label="Quality status" value={analysis.data_quality.status === "review" ? "Review noted; reconciliation passed" : "Passed"} />
            </div>
          </details>
        </CardContent>
      </Card>
    </section>
  );
}

function SolutionExplorer({
  financialSolutions,
  onStar,
  onViewFinancial,
  onViewScenario,
  scenarios,
  viewedFinancial,
  viewedScenario,
  starError,
  starPendingId,
}: {
  financialSolutions: CiFinancialSolution[];
  onStar: (solution: CiFinancialSolution) => void;
  onViewFinancial: (solution: CiFinancialSolution) => void;
  onViewScenario: (scenario: PhysicalScenario) => void;
  scenarios: PhysicalScenario[];
  viewedFinancial: CiFinancialSolution | null;
  viewedScenario: PhysicalScenario | null;
  starError: string | null;
  starPendingId: string | null;
}) {
  return (
    <section aria-labelledby="ci-solution-explorer-heading" id="ci-solution-explorer">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ci-solution-explorer-heading">Solution explorer</CardTitle>
          <CardDescription>Compare backend-returned physical and financial facts; selecting a row changes review focus only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {starError ? <p className="text-sm text-destructive">{starError}</p> : null}
          {financialSolutions.length ? (
            <div>
              <p className="mb-2 text-sm font-medium">Saved financial solutions</p>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-muted/60"><tr><th className="px-3 py-2">Solution</th><th className="px-3 py-2">Upfront</th><th className="px-3 py-2">Year-1 value</th><th className="px-3 py-2">NPV</th><th className="px-3 py-2">Payback</th><th className="px-3 py-2">IRR</th><th className="px-3 py-2">Review</th></tr></thead>
                  <tbody>{financialSolutions.map((solution) => {
                    const viewed = solution.solution_id === viewedFinancial?.solution_id;
                    const starPending = solution.solution_id === starPendingId;
                    return <tr className={viewed ? "border-t border-border bg-muted/40" : "border-t border-border"} key={solution.solution_id}><td className="px-3 py-3 font-medium">{solution.starred ? "★ " : ""}{solution.label}</td><td className="px-3 py-3 tabular-nums">{formatAud(solution.assumptions.upfront_cost_aud)}</td><td className="px-3 py-3 tabular-nums">{formatAud(solution.assumptions.first_year_net_value_aud)}</td><td className="px-3 py-3 tabular-nums">{formatAud(solution.metrics.net_present_value_aud)}</td><td className="px-3 py-3 tabular-nums">{solution.metrics.payback_period_years === null ? "Beyond term" : `${solution.metrics.payback_period_years.toFixed(2)} yr`}</td><td className="px-3 py-3 tabular-nums">{solution.metrics.internal_rate_of_return === null ? "—" : `${(solution.metrics.internal_rate_of_return * 100).toFixed(1)}%`}</td><td className="px-3 py-3"><div className="flex gap-2"><Button onClick={() => onViewFinancial(solution)} className="h-8 px-2" type="button" variant={viewed ? "secondary" : "outline"}>{viewed ? "Viewed" : "View"}</Button><Button aria-label={solution.starred ? `Remove ${solution.label} from shortlist` : `Add ${solution.label} to shortlist`} disabled={starPending} onClick={() => onStar(solution)} className="h-8 px-2" type="button" variant="ghost">{starPending ? "…" : solution.starred ? "★" : "☆"}</Button></div></td></tr>;
                  })}</tbody>
                </table>
              </div>
            </div>
          ) : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Financial comparison becomes available after a solution is saved in Analyse.</p>}

          {scenarios.length ? (
            <details open={!financialSolutions.length}>
              <summary className="cursor-pointer text-sm font-medium">Physical scenario comparison · {scenarios.length} solutions</summary>
              <div className="mt-3 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-muted/60"><tr><th className="px-3 py-2">Rank</th><th className="px-3 py-2">System</th><th className="px-3 py-2">PV</th><th className="px-3 py-2">Battery</th><th className="px-3 py-2">Rolling kVA</th><th className="px-3 py-2">Year-1 tariff value</th><th className="px-3 py-2">Peak effect</th><th className="px-3 py-2">Review</th></tr></thead>
                  <tbody>{scenarios.map((scenario) => {
                    const viewed = scenario.scenario_id === viewedScenario?.scenario_id;
                    return <tr className={viewed ? "border-t border-border bg-muted/40" : "border-t border-border"} key={scenario.scenario_id}><td className="px-3 py-3 font-semibold">#{scenario.physical_review_rank}</td><td className="px-3 py-3">{scenario.label}</td><td className="px-3 py-3 tabular-nums">{formatCapacity(scenario.authored_inputs.pv_capacity_kwp_dc)} kWp</td><td className="px-3 py-3 tabular-nums">{formatCapacity(scenario.authored_inputs.nominal_capacity_kwh)} kWh · {formatCapacity(scenario.authored_inputs.max_discharge_kw)} kW</td><td className="px-3 py-3 tabular-nums">{scenario.post_dispatch.raw_rolling_demand_kva.toFixed(2)}</td><td className="px-3 py-3 tabular-nums">{formatAud(scenario.annual_tariff_value.first_year_value_ex_gst_aud)} ex GST</td><td className="px-3 py-3 capitalize">{formatPeakEffect(scenario)}</td><td className="px-3 py-3"><Button onClick={() => onViewScenario(scenario)} className="h-8 px-2" type="button" variant={viewed ? "secondary" : "outline"}>{viewed ? "Viewed" : "View"}</Button></td></tr>;
                  })}</tbody>
                </table>
              </div>
            </details>
          ) : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Run physical scenarios in Analyse to open solution comparison.</p>}
        </CardContent>
      </Card>
    </section>
  );
}

function PhysicalEvidence({
  comparison,
  comparisonError,
  comparisonLoading,
  onRunComparison,
  result,
  scenario,
}: {
  comparison: CiThreeCaseComparisonResult | null;
  comparisonError: string | null;
  comparisonLoading: boolean;
  onRunComparison: (selection: { pvOnlyScenarioId: string; pvBatteryScenarioId: string }) => void;
  result: CiPhysicalScenarioResult | null;
  scenario: PhysicalScenario | null;
}) {
  return (
    <section aria-labelledby="ci-physical-evidence-heading" id="ci-physical-evidence">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ci-physical-evidence-heading">Physical / peak evidence</CardTitle>
          <CardDescription>Explain what changed physically before discussing the investment return.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {result && scenario ? (
            <>
              <div className="grid gap-3 xl:grid-cols-5">
                <DecisionMetric label="Baseline rolling demand" value={`${result.baseline.raw_rolling_demand_kva.toFixed(2)} kVA`} />
                <DecisionMetric label="Viewed rolling demand" value={`${scenario.post_dispatch.raw_rolling_demand_kva.toFixed(2)} kVA`} />
                <DecisionMetric label="Billing maximum" value={scenario.post_dispatch.billing_period_max_kva === null ? "Not evaluated" : `${scenario.post_dispatch.billing_period_max_kva.toFixed(2)} kVA`} />
                <DecisionMetric label="PV generation" value={`${Math.round(scenario.post_dispatch.pv_generation_kwh).toLocaleString("en-AU")} kWh`} />
                <DecisionMetric label="Reactive support" value={scenario.authored_inputs.reactive_support_enabled ? `${scenario.post_dispatch.maximum_reactive_support_kvar.toFixed(2)} kvar max` : "Disabled"} />
                <DecisionMetric label="Post-grid reactive" value={`${scenario.post_dispatch.maximum_post_grid_reactive_kvar.toFixed(2)} kvar max`} />
                <DecisionMetric label="Peak effect" value={formatPeakEffect(scenario)} />
              </div>
              <ThreeCaseComparison
                comparison={comparison}
                error={comparisonError}
                isPending={comparisonLoading}
                onRun={onRunComparison}
                scenarios={result.scenarios}
              />
              <DispatchReviewEvidence scenario={scenario} />
              {scenario.optimizer_run_snapshot ? (
                <details className="rounded-lg border border-border p-4 text-sm">
                  <summary className="cursor-pointer font-medium">Optimizer evidence</summary>
                  <div className="mt-3 grid gap-2 xl:grid-cols-2">
                    <ReviewFact label="Algorithm" value={scenario.optimizer_run_snapshot.algorithm_id} />
                    <ReviewFact label="Snapshot" value={scenario.optimizer_run_snapshot.snapshot_sha256} />
                  </div>
                </details>
              ) : null}
            </>
          ) : <p className="text-sm text-muted-foreground">Physical evidence becomes available after scenario execution.</p>}
        </CardContent>
      </Card>
    </section>
  );
}

function ThreeCaseComparison({
  comparison,
  error,
  isPending,
  onRun,
  scenarios,
}: {
  comparison: CiThreeCaseComparisonResult | null;
  error: string | null;
  isPending: boolean;
  onRun: (selection: { pvOnlyScenarioId: string; pvBatteryScenarioId: string }) => void;
  scenarios: PhysicalScenario[];
}) {
  const [pvOnlyScenarioId, setPvOnlyScenarioId] = useState("");
  const [pvBatteryScenarioId, setPvBatteryScenarioId] = useState("");
  const pvOnlyCandidates = scenarios.filter((item) => item.authored_inputs.nominal_capacity_kwh === 0 && item.authored_inputs.pv_capacity_kwp_dc > 0);
  const pvBatteryCandidates = scenarios.filter((item) => item.authored_inputs.nominal_capacity_kwh > 0 && item.authored_inputs.pv_capacity_kwp_dc > 0);
  const labels = Object.fromEntries(comparison?.cases.map((item) => [item.case_id, item.label]) ?? []);
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">Compare no system, PV only and PV + battery on one common peak day</summary>
      <div className="mt-4 space-y-5">
        <p className="text-sm text-muted-foreground">Choose both returned scenario identities explicitly. Python accepts only an exact PV-matched pair, selects one common local day and returns all aligned values. This comparison is not a recommendation.</p>
        <div className="grid gap-3 rounded-lg bg-muted/30 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="grid gap-1 text-sm font-medium">PV-only scenario
            <select className="h-10 rounded-md border border-input bg-background px-3 font-normal" onChange={(event) => setPvOnlyScenarioId(event.target.value)} value={pvOnlyScenarioId}>
              <option value="">Select an explicit PV-only case</option>
              {pvOnlyCandidates.map((item) => <option key={item.scenario_id} value={item.scenario_id}>{item.label} · {formatCapacity(item.authored_inputs.pv_capacity_kwp_dc)} kWp</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">PV + battery scenario
            <select className="h-10 rounded-md border border-input bg-background px-3 font-normal" onChange={(event) => setPvBatteryScenarioId(event.target.value)} value={pvBatteryScenarioId}>
              <option value="">Select an explicit PV + battery case</option>
              {pvBatteryCandidates.map((item) => <option key={item.scenario_id} value={item.scenario_id}>{item.label} · {formatCapacity(item.authored_inputs.pv_capacity_kwp_dc)} kWp + {formatCapacity(item.authored_inputs.nominal_capacity_kwh)} kWh</option>)}
            </select>
          </label>
          <Button disabled={!pvOnlyScenarioId || !pvBatteryScenarioId || isPending} onClick={() => onRun({ pvOnlyScenarioId, pvBatteryScenarioId })} type="button">{isPending ? "Comparing…" : "Compare selected cases"}</Button>
        </div>
        {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
        {comparison ? (
          <div className="space-y-5">
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">Common returned day: {comparison.common_local_date}</p>
              <p className="mt-1 text-muted-foreground">{comparison.coverage.interval_count} aligned {comparison.coverage.interval_minutes}-minute intervals · selected from the PV + battery maximum post-dispatch rolling kVA interval, earliest timestamp on ties.</p>
            </div>
            <TraceFigure
              points={comparison.points}
              series={[
                { label: labels.no_system ?? "No system", color: "#475569", dash: "7 4", values: comparison.points.map((point) => point.no_system.import_kw) },
                { label: labels.pv_only ?? "PV only", color: "#0f766e", dash: "4 3", values: comparison.points.map((point) => point.pv_only.import_kw) },
                { label: labels.pv_battery ?? "PV + battery", color: "#be123c", dash: "", values: comparison.points.map((point) => point.pv_battery.import_kw) },
              ]}
              subtitle="Three Python-returned cases on identical timestamps"
              title="Grid import on common returned day"
              unit="kW"
            />
            <TraceFigure
              points={comparison.points}
              series={[
                { label: labels.no_system ?? "No system", color: "#475569", dash: "7 4", values: comparison.points.map((point) => point.no_system.import_kva) },
                { label: labels.pv_only ?? "PV only", color: "#0f766e", dash: "4 3", values: comparison.points.map((point) => point.pv_only.import_kva) },
                { label: labels.pv_battery ?? "PV + battery", color: "#be123c", dash: "", values: comparison.points.map((point) => point.pv_battery.import_kva) },
              ]}
              subtitle="Exact grid kVA after Python-owned active dispatch and reactive support"
              title="Apparent power on common returned day"
              unit="kVA"
            />
            <TraceFigure
              points={comparison.points}
              series={[
                { label: `${labels.no_system ?? "No system"} post-grid`, color: "#475569", dash: "7 4", values: comparison.points.map((point) => point.no_system.post_grid_reactive_kvar) },
                { label: `${labels.pv_only ?? "PV only"} post-grid`, color: "#0f766e", dash: "4 3", values: comparison.points.map((point) => point.pv_only.post_grid_reactive_kvar) },
                { label: `${labels.pv_battery ?? "PV + battery"} post-grid`, color: "#be123c", dash: "", values: comparison.points.map((point) => point.pv_battery.post_grid_reactive_kvar) },
              ]}
              subtitle="Post-grid reactive import returned by Python; overcompensation and reactive export are unavailable"
              title="Reactive import on common returned day"
              unit="kvar"
            />
            <TraceFigure
              points={comparison.points}
              series={[
                { label: "Grid charge", color: "#64748b", dash: "", values: comparison.points.map((point) => point.pv_battery.grid_charge_kw) },
                { label: "PV charge", color: "#0f766e", dash: "4 3", values: comparison.points.map((point) => point.pv_battery.pv_charge_kw) },
                { label: "Battery discharge", color: "#be123c", dash: "7 4", values: comparison.points.map((point) => point.pv_battery.battery_discharge_kw) },
              ]}
              subtitle="PV + battery case; no-system and PV-only battery flows are explicitly zero"
              title="Battery charge and discharge"
              unit="kW"
            />
            <TraceFigure
              points={comparison.points}
              series={[{ label: "Ending SOC", color: "#0f766e", dash: "", values: comparison.points.map((point) => point.pv_battery.soc_end_kwh ?? 0) }]}
              subtitle="PV + battery case; SOC is not applicable for the other two cases"
              title="Battery state of charge"
              unit="kWh"
              zeroBased={false}
            />
            <details className="rounded-lg border border-border p-4 text-sm">
              <summary className="cursor-pointer font-medium">Exact values for the three aligned cases</summary>
              <div className="mt-3 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[1680px] text-left text-xs tabular-nums">
                  <caption className="caption-top px-3 py-3 text-left text-sm text-muted-foreground">Exact Python-returned values · {comparison.common_local_date} local coverage.</caption>
                  <thead className="bg-muted/60"><tr><th className="px-3 py-2">Local time</th><th className="px-3 py-2">No system kW</th><th className="px-3 py-2">No system kVA</th><th className="px-3 py-2">No system kvar</th><th className="px-3 py-2">PV only kW</th><th className="px-3 py-2">PV only kVA</th><th className="px-3 py-2">PV support kvar</th><th className="px-3 py-2">PV post-grid kvar</th><th className="px-3 py-2">PV + battery kW</th><th className="px-3 py-2">PV + battery kVA</th><th className="px-3 py-2">PV + battery support kvar</th><th className="px-3 py-2">PV + battery post-grid kvar</th><th className="px-3 py-2">Grid charge kW</th><th className="px-3 py-2">PV charge kW</th><th className="px-3 py-2">Discharge kW</th><th className="px-3 py-2">Ending SOC kWh</th></tr></thead>
                  <tbody>{comparison.points.map((point) => <tr className="border-t border-border" key={point.interval_timestamp}><td className="whitespace-nowrap px-3 py-2">{point.local_time_label}</td><td className="px-3 py-2">{point.no_system.import_kw.toFixed(3)}</td><td className="px-3 py-2">{point.no_system.import_kva.toFixed(3)}</td><td className="px-3 py-2">{point.no_system.post_grid_reactive_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.pv_only.import_kw.toFixed(3)}</td><td className="px-3 py-2">{point.pv_only.import_kva.toFixed(3)}</td><td className="px-3 py-2">{point.pv_only.reactive_support_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.pv_only.post_grid_reactive_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.import_kw.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.import_kva.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.reactive_support_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.post_grid_reactive_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.grid_charge_kw.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.pv_charge_kw.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.battery_discharge_kw.toFixed(3)}</td><td className="px-3 py-2">{point.pv_battery.soc_end_kwh?.toFixed(3)}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
            <details className="rounded-lg border border-border p-4 text-sm">
              <summary className="cursor-pointer font-medium">Comparison provenance and permissions</summary>
              <div className="mt-3 grid gap-2 xl:grid-cols-2">
                <ReviewFact label="Pairing" value="Explicit consultant selection · exact PV match verified by Python" />
                <ReviewFact label="Comparison digest" value={comparison.comparison_sha256} />
                <ReviewFact label="PV-only scenario digest" value={comparison.provenance.pv_only_scenario_sha256} />
                <ReviewFact label="PV + battery scenario digest" value={comparison.provenance.pv_battery_scenario_sha256} />
                <ReviewFact label="Customer-facing / recommendation / delivery" value="Unavailable / unavailable / unavailable" />
              </div>
            </details>
          </div>
        ) : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No comparison has been requested. Neither scenario is selected automatically.</p>}
      </div>
    </details>
  );
}

function DispatchReviewEvidence({ scenario }: { scenario: PhysicalScenario }) {
  const projection = scenario.dispatch_review_projection;
  const battery = projection.soc_status === "available";
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">Returned peak-day traces</summary>
      <div className="mt-4 space-y-5">
        <div className="rounded-lg bg-muted/30 p-3 text-sm">
          <p className="font-medium">Returned peak day: {projection.peak_local_date}</p>
          <p className="mt-1 text-muted-foreground">{projection.coverage.interval_count} returned {projection.coverage.interval_minutes}-minute intervals · local time · selection basis: highest post-dispatch rolling kVA (earliest timestamp on ties).</p>
        </div>
        <TraceFigure
          title="Grid import on returned peak day"
          subtitle="Baseline and post-dispatch import returned by Python"
          unit="kW"
          points={projection.points}
          series={[{ label: "Baseline import", color: "#475569", dash: "7 4", values: projection.points.map((p) => p.baseline_import_kw) }, { label: "Post-dispatch import", color: "#0f766e", dash: "", values: projection.points.map((p) => p.post_dispatch_import_kw) }]}
        />
        <TraceFigure
          title="Reactive import and inverter support"
          subtitle="Site import, inverter support and post-grid kvar returned by Python"
          unit="kvar"
          points={projection.points}
          series={[{ label: "Site reactive import", color: "#475569", dash: "7 4", values: projection.points.map((p) => p.site_reactive_import_kvar) }, { label: "Inverter support", color: "#0f766e", dash: "4 3", values: projection.points.map((p) => p.inverter_reactive_support_kvar) }, { label: "Post-grid reactive import", color: "#be123c", dash: "", values: projection.points.map((p) => p.post_grid_reactive_kvar) }]}
        />
        <TraceFigure
          title="Battery charge and discharge"
          subtitle={battery ? "Separate returned grid-charge, PV-charge and discharge series; values are not netted" : "PV-only scenario: returned battery charge and discharge are zero"}
          unit="kW"
          points={projection.points}
          series={[{ label: "Grid charge", color: "#64748b", dash: "", values: projection.points.map((p) => p.grid_charge_kw) }, { label: "PV charge", color: "#0f766e", dash: "4 3", values: projection.points.map((p) => p.pv_charge_kw) }, { label: "Battery discharge", color: "#be123c", dash: "7 4", values: projection.points.map((p) => p.battery_discharge_kw) }]}
        />
        {battery ? <TraceFigure title="Battery state of charge" subtitle="Ending state of charge returned by Python" unit="kWh" points={projection.points} zeroBased={false} series={[{ label: "Ending SOC", color: "#0f766e", dash: "", values: projection.points.map((p) => p.soc_end_kwh ?? 0) }]} /> : <div className="rounded-lg border border-dashed p-3 text-sm"><p className="font-medium">Battery state of charge</p><p className="mt-1 text-muted-foreground">Not applicable — no battery is present in this returned scenario.</p></div>}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1360px] text-left text-xs tabular-nums">
            <caption className="caption-top px-3 py-3 text-left text-sm text-muted-foreground">Exact returned intervals · {projection.peak_local_date} local coverage · values are Python-returned facts.</caption>
            <thead className="bg-muted/60"><tr><th className="px-3 py-2">Local time</th><th className="px-3 py-2">Baseline import (kW)</th><th className="px-3 py-2">Post-dispatch import (kW)</th><th className="px-3 py-2">Baseline (kVA)</th><th className="px-3 py-2">Post-dispatch (kVA)</th><th className="px-3 py-2">Site kvar</th><th className="px-3 py-2">Support kvar</th><th className="px-3 py-2">Post-grid kvar</th><th className="px-3 py-2">Grid charge (kW)</th><th className="px-3 py-2">PV charge (kW)</th><th className="px-3 py-2">Discharge (kW)</th><th className="px-3 py-2">Ending SOC (kWh)</th></tr></thead>
            <tbody>{projection.points.map((point) => <tr className="border-t border-border" key={point.interval_timestamp}><td className="whitespace-nowrap px-3 py-2">{point.local_time_label}</td><td className="px-3 py-2">{point.baseline_import_kw.toFixed(3)}</td><td className="px-3 py-2">{point.post_dispatch_import_kw.toFixed(3)}</td><td className="px-3 py-2">{point.baseline_kva.toFixed(3)}</td><td className="px-3 py-2">{point.post_dispatch_kva.toFixed(3)}</td><td className="px-3 py-2">{point.site_reactive_import_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.inverter_reactive_support_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.post_grid_reactive_kvar.toFixed(3)}</td><td className="px-3 py-2">{point.grid_charge_kw.toFixed(3)}</td><td className="px-3 py-2">{point.pv_charge_kw.toFixed(3)}</td><td className="px-3 py-2">{point.battery_discharge_kw.toFixed(3)}</td><td className="px-3 py-2">{point.soc_end_kwh === null ? "Not applicable" : point.soc_end_kwh.toFixed(3)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

function TraceFigure({ title, subtitle, unit, points, series, zeroBased = true }: { title: string; subtitle: string; unit: string; points: Array<{ local_time_label: string }>; series: Array<{ label: string; color: string; dash: string; values: number[] }>; zeroBased?: boolean }) {
  const width = 720;
  const height = 190;
  const left = 44;
  const right = 12;
  const top = 24;
  const bottom = 30;
  const values = series.flatMap((item) => item.values);
  const maximum = Math.max(1, ...values);
  const minimum = zeroBased ? 0 : Math.min(...values);
  const span = Math.max(1, maximum - minimum);
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const y = (value: number) => top + ((maximum - value) / span) * (height - top - bottom);
  return <figure className="min-w-0"><figcaption><p className="font-medium">{title}</p><p className="text-sm text-muted-foreground">{subtitle} · {unit} · {zeroBased ? "zero-based scale" : "returned-value range"}</p></figcaption><div className="mt-2 overflow-x-auto"><svg aria-label={`${title}, ${unit}`} className="h-auto min-w-[640px]" role="img" viewBox={`0 0 ${width} ${height}`}><line stroke="currentColor" strokeOpacity=".2" x1={left} x2={width - right} y1={y(minimum)} y2={y(minimum)} /><text fill="currentColor" fontSize="10" x="4" y={y(maximum) + 3}>{maximum.toFixed(1)}</text><text fill="currentColor" fontSize="10" x="4" y={y(minimum) + 3}>{minimum.toFixed(1)}</text>{series.map((item) => <polyline fill="none" key={item.label} points={item.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")} stroke={item.color} strokeDasharray={item.dash || undefined} strokeWidth="2" />)}<text fill="currentColor" fontSize="10" x={left} y={height - 7}>{points[0]?.local_time_label ?? ""}</text><text fill="currentColor" fontSize="10" textAnchor="end" x={width - right} y={height - 7}>{points.at(-1)?.local_time_label ?? ""}</text></svg></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{series.map((item) => <span className="inline-flex items-center gap-2" key={item.label}><span aria-hidden="true" className="inline-block w-6 border-t-2" style={{ borderColor: item.color, borderTopStyle: item.dash ? "dashed" : "solid" }} />{item.label}</span>)}</div></figure>;
}

function FinancialAssessment({ financial, loading }: { financial: CiFinancialSolution | null; loading: boolean }) {
  const maximumCashflow = useMemo(
    () => Math.max(...(financial?.metrics.annual_cashflows_aud ?? [1]).map((value) => Math.abs(value)), 1),
    [financial],
  );
  return (
    <section aria-labelledby="ci-financial-assessment-heading" id="ci-financial-assessment">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ci-financial-assessment-heading">Financial assessment</CardTitle>
          <CardDescription>Review saved Python-calculated economics and the assumptions that produced them.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? <p className="text-sm text-muted-foreground">Loading saved financial solutions…</p> : null}
          {financial ? (
            <>
              <div className="grid gap-3 xl:grid-cols-4">
                <DecisionMetric label="Lifetime net value" value={formatAud(financial.metrics.lifetime_net_value_undiscounted_aud)} />
                <DecisionMetric label="Annual O&M" value={formatAud(financial.assumptions.annual_om_cost_aud)} />
                <DecisionMetric label="Discount rate" value={`${(financial.assumptions.discount_rate * 100).toFixed(1)}%`} />
                <DecisionMetric label="Analysis term" value={`${financial.assumptions.analysis_term_years} years`} />
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Annual cashflows</p>
                <div className="space-y-2 rounded-lg border border-border p-4">
                  {financial.metrics.annual_cashflows_aud.map((cashflow, year) => (
                    <div className="grid grid-cols-[4rem_minmax(0,1fr)_8rem] items-center gap-3 text-sm" key={year}>
                      <span className="text-muted-foreground">Year {year}</span>
                      <span className="h-4 rounded bg-muted"><span className="block h-4 rounded bg-slate-700" style={{ width: `${Math.max(2, Math.abs(cashflow) / maximumCashflow * 100)}%` }} /></span>
                      <strong className="text-right tabular-nums">{formatAud(cashflow)}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 text-sm xl:grid-cols-2">
                <ReviewFact label="Annual value degradation" value={`${(financial.assumptions.annual_value_degradation_rate * 100).toFixed(1)}%`} />
                <ReviewFact label="Pricing catalog" value={`v${financial.assumptions.pricing_resolution.catalog_version_number} · ${formatTaxBasis(financial.assumptions.pricing_resolution.tax_basis)}`} />
                <ReviewFact label="Value source" value={financial.assumptions.value_source === "evidence_bound_tariff_scenario" ? "Evidence-bound tariff scenario" : "Expert authored"} />
                <ReviewFact label="Replacement events" value={financial.assumptions.replacement_events_aud.length ? financial.assumptions.replacement_events_aud.map((event) => `Year ${event.year}: ${formatAud(event.amount_aud)}`).join(" · ") : "None authored"} />
              </div>
            </>
          ) : <p className="text-sm text-muted-foreground">Save a financial solution in Analyse to review NPV, payback, IRR and cashflows here.</p>}
        </CardContent>
      </Card>
    </section>
  );
}

function AssumptionsAndProvenance({ analysis, result, scenario }: { analysis: CiAnalysisResult; result: CiPhysicalScenarioResult | null; scenario: PhysicalScenario | null }) {
  return (
    <section aria-labelledby="ci-assumptions-provenance-heading" id="ci-assumptions-provenance">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ci-assumptions-provenance-heading">Assumptions &amp; provenance</CardTitle>
          <CardDescription>Keep review assumptions close to the decision while leaving technical identities behind progressive disclosure.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <details open>
            <summary className="cursor-pointer font-medium">Material analysis assumptions</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {(analysis.assumptions.length ? analysis.assumptions : ["No additional baseline assumptions were returned by the active contract."]).map((assumption) => <li key={assumption}>{assumption}</li>)}
              {result?.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
          </details>
          <details className="rounded-lg border border-border p-4 text-sm">
            <summary className="cursor-pointer font-medium">Technical provenance</summary>
            <div className="mt-3 grid gap-2 xl:grid-cols-2">
              <ReviewFact label="Profile" value={`${analysis.profile.display_label} · ${analysis.profile.source_version}`} />
              <ReviewFact label="Time basis" value={`${analysis.tariff_mapping.meter_time_basis} → ${analysis.tariff_mapping.local_timezone}`} />
              {scenario?.optimizer_run_snapshot ? <ReviewFact label="Optimizer snapshot" value={scenario.optimizer_run_snapshot.snapshot_sha256} /> : null}
              {scenario?.optimizer_audit_projection ? <ReviewFact label="Audit snapshot match" value={scenario.optimizer_audit_projection.snapshot_sha256} /> : null}
            </div>
          </details>
        </CardContent>
      </Card>
    </section>
  );
}

function OutputStatus({
  comparison,
  financial,
  onPrepare,
  report,
  reportError,
  reportPreparing,
  result,
}: {
  comparison: CiThreeCaseComparisonResult | null;
  financial: CiFinancialSolution | null;
  onPrepare: () => void;
  report: CiInternalReportArtifact | null;
  reportError: string | null;
  reportPreparing: boolean;
  result: CiPhysicalScenarioResult | null;
}) {
  const preview = result?.report_preview ?? null;
  const currentReport = report && financial && comparison
    && report.financial_solution_id === financial.solution_id
    && report.comparison_sha256 === comparison.comparison_sha256
    ? report
    : null;
  const canPrepare = Boolean(financial && comparison && result);
  return (
    <section aria-labelledby="ci-output-status-heading" id="ci-output-status">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ci-output-status-heading">Output status</CardTitle>
          <CardDescription>Report availability is a backend-owned gate, not a presentation decision.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 xl:grid-cols-3">
            <DecisionMetric label="Customer-facing permission" value={result?.customer_facing_permission === false ? "Unavailable" : "Not available"} />
            <DecisionMetric label="Recommendation permission" value={result?.recommendation_permitted === false ? "Unavailable" : "Not available"} />
            <DecisionMetric label="Internal report" value={currentReport ? "Ready" : canPrepare ? "Not prepared" : "Unavailable"} />
          </div>
          <div className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">Private internal review report</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {currentReport ? "The exact three-page HTML/PDF pair is ready." : "Prepare a report after viewing a matching saved PV-and-battery solution and running the explicit three-case comparison."}
                </p>
              </div>
              {currentReport ? (
                <a className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90" href={ciInternalReportDownloadPath(currentReport.artifact_id, "pdf")}>Download report</a>
              ) : (
                <Button disabled={!canPrepare || reportPreparing} onClick={onPrepare} type="button">
                  {reportPreparing ? "Preparing…" : "Prepare report"}
                </Button>
              )}
            </div>
            {reportError ? <p className="mt-3 text-sm text-destructive">{reportError}</p> : null}
            {currentReport ? (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-medium">Report details</summary>
                <div className="mt-3 grid gap-2 xl:grid-cols-2">
                  <ReviewFact label="HTML source" value={`${currentReport.html_sha256} · ${currentReport.html_byte_size} bytes`} />
                  <ReviewFact label="PDF" value={`${currentReport.pdf_sha256} · ${currentReport.page_count} pages`} />
                  <ReviewFact label="Renderer" value={`${currentReport.renderer_id} ${currentReport.renderer_version}`} />
                  <ReviewFact label="Permissions" value="Internal only · customer/recommendation/delivery unavailable" />
                </div>
                <a className="mt-3 inline-block text-primary underline" href={ciInternalReportDownloadPath(currentReport.artifact_id, "html")}>Download canonical HTML</a>
              </details>
            ) : null}
          </div>
          {preview ? (
            <div className="rounded-lg border border-border p-4 text-sm">
              <p className="font-medium">C&amp;I report preview</p>
              <p className="mt-1 text-muted-foreground">{preview.disclaimer}</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">{preview.sections.map((section) => <li key={section}>{section}</li>)}</ul>
            </div>
          ) : <p className="text-sm text-muted-foreground">Run physical scenarios before report-preview status can be reviewed.</p>}
        </CardContent>
      </Card>
    </section>
  );
}

function DecisionMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>;
}

function ReviewFact({ label, value }: { label: string; value: string }) {
  return <p><span className="text-muted-foreground">{label}:</span> {value}</p>;
}

function formatPeakEffect(scenario: PhysicalScenario): string {
  const projection = scenario.post_dispatch;
  if (projection.billing_period_projection_status === "not_evaluated_disjoint_analysis_period") return "Not evaluated · disjoint bill period";
  if (projection.billing_period_peak_change_kw === null) return projection.billing_period_peak_effect;
  return `${projection.billing_period_peak_effect} · ${projection.billing_period_peak_change_kw.toFixed(2)} kW`;
}

function formatAud(value: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value);
}

function formatCapacity(value: number): string {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 9 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value);
}

function formatTaxBasis(value: "gst_inclusive" | "gst_exclusive"): string {
  return value === "gst_inclusive" ? "GST inclusive" : "GST exclusive";
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Melbourne" }).format(new Date(value));
}

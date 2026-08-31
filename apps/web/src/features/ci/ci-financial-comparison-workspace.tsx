import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";

import {
  ciAnnualFinancialComparisonQueryKey,
  fetchCiSavedAnnualFinancialComparison,
} from "@/features/ci/api/ci-annual-financial-comparison";
import type { CiProject } from "@/features/ci/api/ci-projects";
import { CiAnnualFinancialComparisonView } from "@/features/ci/ci-annual-financial-workspace";

export function CiFinancialComparisonWorkspace({ project }: { project: CiProject }) {
  const comparison = useQuery({
    queryKey: ciAnnualFinancialComparisonQueryKey(project.project_id),
    queryFn: () => fetchCiSavedAnnualFinancialComparison(project.project_id),
  });
  if (comparison.isPending) return <State text="Loading the saved quoted-solution comparison…" />;
  if (comparison.isError) return <State error text="The saved comparison could not be restored." />;
  if (comparison.data.status !== "ready" || !comparison.data.result) return <State error text="Select solutions, enter quotations and run Annual finance before opening Comparison." />;
  return <section aria-labelledby="comparison-title" className="space-y-5">
    <header className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cyan-50 text-cyan-800"><BarChart3 className="size-5" /></span><div><p className="text-xs font-semibold uppercase tracking-[.16em] text-cyan-700">Comparison</p><h1 className="mt-1 text-xl font-semibold text-slate-950" id="comparison-title">Quoted solution comparison</h1><p className="mt-1 text-sm text-slate-500">Commercial ranking for the scenarios and prices selected in Annual finance.</p></div></header>
    <CiAnnualFinancialComparisonView result={comparison.data.result} />
  </section>;
}

function State({ error = false, text }: { error?: boolean; text: string }) { return <div className={`rounded-xl border p-6 text-sm ${error ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-600"}`}>{text}</div>; }

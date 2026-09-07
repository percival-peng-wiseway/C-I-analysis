import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchCalculationGuide } from "./api/ci-calculation-guide";

export function CiCalculationGuide() {
  const guide = useQuery({ queryKey: ["ci-calculation-guide", "v1"], queryFn: fetchCalculationGuide, retry: false });
  const [chapterId, setChapterId] = useState("evidence");
  const data = guide.data;
  const chapter = data?.chapters.find(c => c.id === chapterId) ?? data?.chapters[0];
  return <div className="h-full overflow-y-auto px-4 py-6 sm:px-8">
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h3 className="text-2xl font-semibold">How this system calculates</h3>
        <p className="mt-2 leading-7 text-slate-600">Follow the inputs, formulas and a worked solution from measured energy to investment value.</p>
        <ol aria-label="Calculation chain" className="mt-4 flex flex-wrap gap-2 text-sm">
          {["Evidence", "Solution Generator", "Scenario Analysis", "Finance Analysis"].map((label, i) => <li className="rounded-lg border border-slate-200 px-3 py-2" key={label}>{i + 1}. {label}{i < 3 ? " →" : ""}</li>)}
        </ol>
      </header>
      {guide.isPending ? <p role="status">Loading formulas and worked example. No project analysis is running.</p> : null}
      {guide.isError ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5"><p>{guide.error.message}</p><Button className="mt-3" onClick={() => void guide.refetch()} type="button" variant="outline">Retry guide</Button></div> : null}
      {data && chapter ? <>
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">{data.disclosure}</p>
        <section className="rounded-xl border border-slate-200 p-5" aria-label="Teaching solution assumptions">
          <h4 className="text-lg font-semibold">{data.example.label}</h4>
          <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">{data.example.inputs.map(([key, value]) => <div key={key}><dt className="text-xs text-slate-500">{key}</dt><dd className="mt-1 text-sm font-medium">{value}</dd></div>)}</dl>
        </section>
        <nav aria-label="Calculation guide chapters" className="flex flex-wrap gap-2">{data.chapters.map(c => <button type="button" key={c.id} aria-current={c.id === chapter.id ? "step" : undefined} onClick={() => setChapterId(c.id)} className={`rounded-lg border px-3 py-2 text-sm ${c.id === chapter.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700"}`}>{c.title.split(" · ")[0]}</button>)}</nav>
        <section key={chapter.id} aria-label={chapter.title} className="space-y-5">
          <header><h4 className="text-xl font-semibold">{chapter.title}</h4><p className="mt-2 leading-7 text-slate-600">{chapter.summary}</p></header>
          {chapter.steps.map((step, i) => <article className="rounded-xl border border-slate-200 p-5 sm:p-6" key={step.title}>
            <h5 className="text-lg font-semibold">{i + 1}. {step.title}</h5>
            <dl className="mt-4 space-y-4">
              <div><dt className="text-xs font-semibold text-slate-500">Formula</dt><dd className="mt-1 break-words rounded-lg bg-slate-50 p-3 font-mono text-sm leading-6">{step.formula}</dd></div>
              <div><dt className="text-xs font-semibold text-slate-500">Substitute the example inputs</dt><dd className="mt-1 break-words text-sm leading-6 tabular-nums">{step.substitution}</dd></div>
              <div><dt className="text-xs font-semibold text-slate-500">Example result</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{step.result}</dd></div>
            </dl>
            <p className="mt-4 text-sm leading-7 text-slate-600">{step.explanation}</p>
            <details className="mt-4 text-xs text-slate-500"><summary>Python source</summary><code className="mt-2 block break-all leading-5">{step.source_reference}</code></details>
          </article>)}
        </section>
        <details className="rounded-xl border border-slate-200 p-5"><summary className="font-semibold">Units & terminology</summary><dl className="mt-4 grid gap-4 sm:grid-cols-2">{data.glossary.map(([term, meaning]) => <div key={term}><dt className="font-medium">{term}</dt><dd className="mt-1 text-sm leading-6 text-slate-600">{meaning}</dd></div>)}</dl></details>
      </> : null}
    </div>
  </div>;
}

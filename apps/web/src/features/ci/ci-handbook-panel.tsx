import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BookOpenText,
  Calculator,
  Database,
  FileInput,
  FlaskConical,
  Pencil,
  ReceiptText,
  Search,
  Settings2,
  SunMedium,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ciCalculationHandbookQueryKey,
  fetchCiCalculationHandbook,
  type CiHandbookCalculation,
  type CiHandbookModule,
  type CiHandbookValue,
} from "@/features/ci/api/ci-calculation-handbook";
import { useCiWorkspace, type CiWorkspaceStage } from "@/features/ci/ci-workspace-context";

const moduleMeta: Record<CiHandbookModule["module_id"], { icon: typeof Database }> = {
  evidence: { icon: Database },
  solution_generator: { icon: SunMedium },
  scenario_analysis: { icon: Activity },
  finance_analysis: { icon: ReceiptText },
};

export function CiHandbookPanel({ onClose, open }: { onClose: () => void; open: boolean }) {
  const workspace = useCiWorkspace();
  const projectId = workspace.activeProject?.projectId ?? "";
  const [selectedModuleId, setSelectedModuleId] = useState<CiHandbookModule["module_id"]>(() => moduleForStage(workspace.stage));
  const [search, setSearch] = useState("");
  const handbook = useQuery({
    enabled: open && Boolean(projectId),
    queryKey: ciCalculationHandbookQueryKey(projectId),
    queryFn: () => fetchCiCalculationHandbook(projectId),
  });

  useEffect(() => {
    if (!open) return;
    setSelectedModuleId(moduleForStage(workspace.stage));
    setSearch("");
  }, [open, workspace.stage]);

  const selected = handbook.data?.modules.find((module) => module.module_id === selectedModuleId) ?? null;
  const filtered = useMemo(() => selected ? filterModule(selected, search) : null, [search, selected]);

  return (
    <Drawer
      description="Formulas, current values, parameter sources, optimizer methods and saved results."
      label={`Handbook${workspace.activeProject ? ` - ${workspace.activeProject.displayName}` : ""}`}
      onClose={onClose}
      open={open}
    >
      {handbook.isPending ? <HandbookLoading /> : null}
      {handbook.isError ? <HandbookError message={handbook.error instanceof Error ? handbook.error.message : "Handbook is unavailable."} onRetry={() => void handbook.refetch()} /> : null}
      {handbook.data && selected && filtered ? (
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1">
          <aside className="border-b border-slate-200 bg-slate-50 px-3 py-3 lg:border-b-0 lg:border-r lg:px-4 lg:py-5">
            <div className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-2 lg:overflow-visible lg:pb-0">
              {handbook.data.modules.map((module) => {
                const Icon = moduleMeta[module.module_id].icon;
                const active = module.module_id === selectedModuleId;
                return (
                  <button
                    aria-current={active ? "page" : undefined}
                    className={`flex min-w-44 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors lg:w-full lg:min-w-0 ${active ? "border-cyan-200 bg-white text-slate-950 shadow-sm" : "border-transparent text-slate-600 hover:bg-white hover:text-slate-950"}`}
                    key={module.module_id}
                    onClick={() => setSelectedModuleId(module.module_id)}
                    type="button"
                  >
                    <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${active ? "bg-cyan-100 text-cyan-800" : "bg-slate-200 text-slate-600"}`}><Icon className="size-4" /></span>
                    <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{module.label}</strong><small className="mt-0.5 block text-[10px] uppercase tracking-wide text-slate-400">{statusLabel(module.status)}</small></span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 hidden rounded-xl border border-slate-200 bg-white p-3 lg:block">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-800"><BookOpenText className="size-4 text-cyan-700" />Ledger coverage</div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums">
                <Stat label="Parameters" value={handbook.data.summary.parameter_count} />
                <Stat label="Formulas" value={handbook.data.summary.calculation_count} />
                <Stat label="Models" value={handbook.data.summary.model_count} />
                <Stat label="Results" value={handbook.data.summary.result_row_count} />
              </dl>
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
            <section className="rounded-xl border border-cyan-200 bg-cyan-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2"><h3 className="text-lg font-semibold text-slate-950">{selected.label}</h3><StatusBadge status={selected.status} /></div>
                  <p className="mt-1 text-sm leading-5 text-slate-600">{selected.description}</p>
                </div>
                <p className="text-xs tabular-nums text-slate-500">Snapshot {formatDate(handbook.data.project.snapshot_at)}</p>
              </div>
              <div className="mt-3 flex items-start gap-2 border-t border-cyan-200 pt-3 text-xs leading-5 text-cyan-950"><FileInput className="mt-0.5 size-4 shrink-0" /><p>{handbook.data.authority.statement} Parameters are changed at their governed source and calculations run only after an explicit Generate or Analysis action.</p></div>
            </section>

            <label className="relative mt-5 block">
              <span className="sr-only">Search current Handbook module</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100" onChange={(event) => setSearch(event.target.value)} placeholder="Search parameters, formulas, models or results" type="search" value={search} />
            </label>

            <div className="mt-6 space-y-7">
              <ParametersSection module={filtered} onEdit={(stage) => { workspace.setStage(stage); onClose(); }} />
              <CalculationsSection module={filtered} />
              <ModelsSection module={filtered} />
              <ResultsSection module={filtered} />
              <BoundariesSection boundaries={filtered.boundaries} />
              {!hasVisibleContent(filtered) ? <EmptySearch /> : null}
            </div>
          </main>
        </div>
      ) : null}
    </Drawer>
  );
}

function ParametersSection({ module, onEdit }: { module: CiHandbookModule; onEdit: (stage: CiWorkspaceStage) => void }) {
  if (!module.parameters.length) return null;
  return (
    <section aria-labelledby="handbook-parameters">
      <SectionTitle count={module.parameters.length} icon={Settings2} id="handbook-parameters" title="Inputs & parameters" />
      <div className="mt-3 rounded-xl border border-slate-200">
        <Table scrollLabel={`${module.label} parameters`}>
          <TableHeader><TableRow><TableHead>Parameter</TableHead><TableHead>Current value</TableHead><TableHead>Source</TableHead><TableHead className="text-right">Change</TableHead></TableRow></TableHeader>
          <TableBody>{module.parameters.map((parameter) => (
            <TableRow className={!parameter.active_in_current_model ? "bg-amber-50/40" : undefined} key={parameter.parameter_id}>
              <TableCell><strong className="block min-w-44 text-xs font-semibold text-slate-900">{parameter.label}</strong><code className="mt-1 block max-w-72 break-all text-[10px] text-slate-400">{parameter.parameter_id}</code>{!parameter.active_in_current_model ? <Badge className="mt-1" variant="warning">Not active in model</Badge> : null}</TableCell>
              <TableCell className="whitespace-nowrap font-medium tabular-nums text-slate-900">{formatValue(parameter.value, parameter.unit)}</TableCell>
              <TableCell><span className="block text-xs text-slate-700">{sourceKindLabel(parameter.source_kind)}</span><span className="mt-0.5 block max-w-52 text-[11px] leading-4 text-slate-400">{parameter.source_label}</span></TableCell>
              <TableCell className="text-right">{parameter.editable && parameter.edit_stage ? <Button aria-label={`Edit ${parameter.label} at source`} className="h-8 px-2.5 text-xs" onClick={() => onEdit(parameter.edit_stage!)} type="button" variant="ghost"><Pencil className="size-3.5" />Edit</Button> : <span className="text-[11px] text-slate-400">Read only</span>}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </div>
    </section>
  );
}

function CalculationsSection({ module }: { module: CiHandbookModule }) {
  if (!module.calculations.length) return null;
  return (
    <section aria-labelledby="handbook-calculations">
      <SectionTitle count={module.calculations.length} icon={Calculator} id="handbook-calculations" title="Calculation steps" />
      <div className="mt-3 space-y-2">{module.calculations.map((calculation, index) => (
        <CalculationDisclosure calculation={calculation} defaultOpen={index === 0 && module.calculations.length <= 5} index={index} key={calculation.calculation_id} />
      ))}</div>
    </section>
  );
}

function CalculationDisclosure({ calculation, defaultOpen, index }: { calculation: CiHandbookCalculation; defaultOpen: boolean; index: number }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="group rounded-xl border border-slate-200 bg-white open:border-cyan-200 open:shadow-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 marker:hidden"><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-bold tabular-nums text-slate-600">{index + 1}</span><span className="min-w-0 flex-1"><strong className="block text-sm text-slate-950">{calculation.label}</strong><code className="mt-0.5 block truncate text-[11px] text-slate-400">{calculation.calculation_id}</code></span><span className="text-xs text-cyan-700 group-open:hidden">Show</span><span className="hidden text-xs text-cyan-700 group-open:inline">Hide</span></summary>
      <div className="border-t border-slate-100 px-4 pb-4 pt-3">
        <p className="text-sm leading-6 text-slate-600">{calculation.description}</p>
        <div className="mt-3 overflow-x-auto rounded-lg bg-[#071525] px-4 py-3 text-cyan-50"><code className="whitespace-pre-wrap font-mono text-xs leading-5">{calculation.formula}</code></div>
        {calculation.current_example ? <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs"><p className="font-semibold text-emerald-900">Current substitution</p><code className="mt-1 block break-words text-emerald-950">{calculation.current_example.substitution} = {formatValue(calculation.current_example.result, calculation.current_example.unit)}</code></div> : null}
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="font-semibold text-slate-700">Inputs</dt><dd className="mt-1 leading-5 text-slate-500">{calculation.inputs.join(", ")}</dd></div><div><dt className="font-semibold text-slate-700">Python authority</dt><dd className="mt-1 break-all font-mono text-[11px] leading-5 text-slate-500">{calculation.source_reference}</dd></div></dl>
      </div>
    </details>
  );
}

function ModelsSection({ module }: { module: CiHandbookModule }) {
  if (!module.models.length) return null;
  return (
    <section aria-labelledby="handbook-models">
      <SectionTitle count={module.models.length} icon={FlaskConical} id="handbook-models" title="Models & algorithms" />
      <div className="mt-3 grid gap-3 xl:grid-cols-2">{module.models.map((model) => (
        <article className="rounded-xl border border-slate-200 bg-slate-50 p-4" key={model.model_id}>
          <Badge variant="outline">{model.method}</Badge>
          <h4 className="mt-3 font-semibold text-slate-950">{model.label}</h4>
          <p className="mt-1 text-sm leading-5 text-slate-600">{model.objective}</p>
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-5 text-slate-500">{model.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
          <code className="mt-3 block break-all border-t border-slate-200 pt-3 text-[10px] leading-4 text-slate-400">{model.source_reference}</code>
        </article>
      ))}</div>
    </section>
  );
}

function ResultsSection({ module }: { module: CiHandbookModule }) {
  if (!module.result_sets.some((set) => set.rows.length)) return null;
  return (
    <section aria-labelledby="handbook-results">
      <SectionTitle count={module.result_sets.reduce((sum, set) => sum + set.rows.length, 0)} icon={ReceiptText} id="handbook-results" title="Saved results" />
      <div className="mt-3 space-y-4">{module.result_sets.filter((set) => set.rows.length).map((set) => (
        <div className="rounded-xl border border-slate-200" key={set.result_set_id}>
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3"><h4 className="text-sm font-semibold text-slate-900">{set.label}</h4></div>
          <Table scrollLabel={set.label}>
            <TableHeader><TableRow><TableHead>Solution</TableHead>{set.columns.map((column) => <TableHead key={column.key}>{column.label}{column.unit ? <span className="ml-1 normal-case tracking-normal text-slate-400">({column.unit})</span> : null}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{set.rows.map((row) => <TableRow key={row.result_id}><TableCell><strong className="block min-w-48 text-xs text-slate-900">{row.label}</strong><code className="mt-1 block max-w-52 truncate text-[10px] text-slate-400">{row.result_id}</code></TableCell>{set.columns.map((column) => <TableCell className="whitespace-nowrap tabular-nums" key={column.key}>{formatValue(row.values[column.key] ?? null, column.unit)}</TableCell>)}</TableRow>)}</TableBody>
          </Table>
        </div>
      ))}</div>
    </section>
  );
}

function BoundariesSection({ boundaries }: { boundaries: string[] }) {
  if (!boundaries.length) return null;
  return <section aria-labelledby="handbook-boundaries" className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="text-sm font-semibold text-amber-950" id="handbook-boundaries">Model boundaries</h3><ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-5 text-amber-900">{boundaries.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}

function SectionTitle({ count, icon: Icon, id, title }: { count: number; icon: typeof Database; id: string; title: string }) {
  return <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Icon className="size-4" /></span><h3 className="font-semibold text-slate-950" id={id}>{title}</h3><Badge variant="secondary">{count}</Badge></div>;
}

function StatusBadge({ status }: { status: CiHandbookModule["status"] }) {
  const variant = status === "ready" ? "success" : status === "stale" ? "warning" : "secondary";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg bg-slate-50 p-2"><dt className="text-[10px] text-slate-400">{label}</dt><dd className="mt-0.5 font-semibold text-slate-900">{value}</dd></div>;
}

function HandbookLoading() {
  return <div aria-live="polite" className="grid h-full place-items-center p-8"><div className="text-center"><BookOpenText className="mx-auto size-8 animate-pulse text-cyan-700" /><p className="mt-3 text-sm font-semibold text-slate-900">Loading saved calculation ledger</p><p className="mt-1 text-xs text-slate-500">No analysis is being run.</p></div></div>;
}

function HandbookError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="grid h-full place-items-center p-8"><div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-5 text-center"><p className="font-semibold text-red-950">Handbook unavailable</p><p className="mt-2 text-sm leading-5 text-red-800">{message}</p><Button className="mt-4" onClick={onRetry} type="button" variant="outline">Try again</Button></div></div>;
}

function EmptySearch() {
  return <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center"><Search className="mx-auto size-6 text-slate-400" /><p className="mt-2 text-sm font-semibold text-slate-800">No matching Handbook records</p><p className="mt-1 text-xs text-slate-500">Clear the search to see this module's ledger.</p></div>;
}

function filterModule(module: CiHandbookModule, search: string): CiHandbookModule {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return module;
  const matches = (...values: unknown[]) => values.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
  return {
    ...module,
    parameters: module.parameters.filter((item) => matches(item.label, item.parameter_id, item.source_kind, item.source_label, item.value)),
    calculations: module.calculations.filter((item) => matches(item.label, item.calculation_id, item.formula, item.description, item.inputs.join(" "), item.source_reference)),
    models: module.models.filter((item) => matches(item.label, item.model_id, item.method, item.objective, item.constraints.join(" "), item.source_reference)),
    result_sets: module.result_sets.map((set) => ({ ...set, rows: set.rows.filter((row) => matches(row.label, row.result_id, ...Object.values(row.values))) })),
    boundaries: module.boundaries.filter((item) => matches(item)),
  };
}

function hasVisibleContent(module: CiHandbookModule) {
  return module.parameters.length > 0 || module.calculations.length > 0 || module.models.length > 0 || module.boundaries.length > 0 || module.result_sets.some((set) => set.rows.length > 0);
}

function formatValue(value: CiHandbookValue, unit: string | null) {
  if (value === null || value === "") return <span className="text-slate-400">Not available</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(", ") : <span className="text-slate-400">None</span>;
  if (typeof value === "number") {
    const display = unit?.startsWith("AUD")
      ? new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)
      : new Intl.NumberFormat("en-AU", { maximumFractionDigits: 6 }).format(value);
    return `${display}${unit && !unit.startsWith("AUD") ? ` ${unit}` : ""}`;
  }
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function sourceKindLabel(value: string) {
  return value.split("_").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function statusLabel(status: CiHandbookModule["status"]) {
  if (status === "input_required") return "Input required";
  if (status === "not_saved") return "Not run";
  return status[0].toUpperCase() + status.slice(1);
}

function moduleForStage(stage: CiWorkspaceStage): CiHandbookModule["module_id"] {
  return stage === "physical_feasibility" ? "solution_generator" : stage === "dispatch" ? "scenario_analysis" : stage === "tariff_replay" ? "finance_analysis" : "evidence";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

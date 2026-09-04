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

type HandbookSectionId = "overview" | "parameters" | "calculations" | "models" | "results" | "boundaries";

const handbookSections: Array<{ id: HandbookSectionId; label: string; icon: typeof Database }> = [
  { id: "overview", label: "Overview", icon: BookOpenText },
  { id: "parameters", label: "Inputs", icon: Settings2 },
  { id: "calculations", label: "Formulas", icon: Calculator },
  { id: "models", label: "Models", icon: FlaskConical },
  { id: "results", label: "Results", icon: ReceiptText },
  { id: "boundaries", label: "Boundaries", icon: FileInput },
];

export function CiHandbookPanel({ onClose, open }: { onClose: () => void; open: boolean }) {
  const workspace = useCiWorkspace();
  const projectId = workspace.activeProject?.projectId ?? "";
  const [selectedModuleId, setSelectedModuleId] = useState<CiHandbookModule["module_id"]>(() => moduleForStage(workspace.stage));
  const [selectedSectionId, setSelectedSectionId] = useState<HandbookSectionId>("overview");
  const [search, setSearch] = useState("");
  const handbook = useQuery({
    enabled: open && Boolean(projectId),
    queryKey: ciCalculationHandbookQueryKey(projectId),
    queryFn: () => fetchCiCalculationHandbook(projectId),
  });

  useEffect(() => {
    if (!open) return;
    setSelectedModuleId(moduleForStage(workspace.stage));
    setSelectedSectionId("overview");
    setSearch("");
  }, [open, workspace.stage]);

  const selected = handbook.data?.modules.find((module) => module.module_id === selectedModuleId) ?? null;
  const filtered = useMemo(() => selected ? filterModule(selected, search) : null, [search, selected]);
  const searching = search.trim().length > 0;
  const matchingRecords = filtered ? visibleRecordCount(filtered) : 0;
  const visibleSections = selected
    ? handbookSections.filter((section) => section.id === "overview" || sectionCount(selected, section.id) > 0)
    : handbookSections.slice(0, 1);

  return (
    <Drawer
      description="Formulas, current values, parameter sources, optimizer methods and saved results."
      label={`Handbook${workspace.activeProject ? ` - ${workspace.activeProject.displayName}` : ""}`}
      onClose={onClose}
      open={open}
      presentation="fullscreen"
    >
      {handbook.isPending ? <HandbookLoading /> : null}
      {handbook.isError ? <HandbookError message={handbook.error instanceof Error ? handbook.error.message : "Handbook is unavailable."} onRetry={() => void handbook.refetch()} /> : null}
      {handbook.data && selected && filtered ? (
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)] lg:grid-rows-1">
          <aside className="border-b border-slate-200 bg-slate-50 px-3 py-3 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-4 lg:py-5">
            <nav aria-label="Handbook modules" className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-2 lg:overflow-visible lg:pb-0">
              {handbook.data.modules.map((module) => {
                const Icon = moduleMeta[module.module_id].icon;
                const active = module.module_id === selectedModuleId;
                return (
                  <button
                    aria-current={active ? "page" : undefined}
                    className={`flex min-w-56 items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors lg:w-full lg:min-w-0 ${active ? "border-cyan-200 bg-white text-slate-950 shadow-sm" : "border-transparent text-slate-600 hover:bg-white hover:text-slate-950"}`}
                    key={module.module_id}
                    onClick={() => { setSelectedModuleId(module.module_id); setSelectedSectionId("overview"); setSearch(""); }}
                    type="button"
                  >
                    <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${active ? "bg-cyan-100 text-cyan-800" : "bg-slate-200 text-slate-600"}`}><Icon className="size-4" /></span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{module.label}</strong>
                      <span className="mt-1 block text-xs text-slate-500">{module.parameters.length} inputs, {module.calculations.length} formulas</span>
                    </span>
                    <StatusMark status={module.status} />
                  </button>
                );
              })}
            </nav>
            <div className="mt-5 hidden border-t border-slate-200 pt-5 lg:block">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><BookOpenText className="size-4 text-cyan-700" />Project coverage</div>
              <dl className="mt-3 grid grid-cols-2 gap-2 tabular-nums">
                <Stat label="Parameters" value={handbook.data.summary.parameter_count} />
                <Stat label="Formulas" value={handbook.data.summary.calculation_count} />
                <Stat label="Models" value={handbook.data.summary.model_count} />
                <Stat label="Results" value={handbook.data.summary.result_row_count} />
              </dl>
            </div>
          </aside>

          <div className="min-h-0 overflow-y-auto bg-slate-50/40">
            <div className="mx-auto min-h-full w-full max-w-[1600px] bg-white">
              <section className="border-b border-slate-200 px-4 py-5 sm:px-6 lg:px-8">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="text-xl font-semibold text-slate-950">{selected.label}</h3><StatusBadge status={selected.status} /></div>
                    <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{selected.description}</p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-xs font-medium text-slate-500">Project snapshot</p>
                    <p className="mt-1 text-sm tabular-nums text-slate-800">{formatDate(handbook.data.project.snapshot_at)}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2.5 text-sm leading-5 text-cyan-950"><FileInput className="mt-0.5 size-4 shrink-0" /><p>{handbook.data.authority.statement} Change inputs in their source module. Generate and Analysis remain the only actions that run calculations.</p></div>
              </section>

              <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
                <div className="grid gap-3 xl:grid-cols-[minmax(280px,420px)_minmax(0,1fr)] xl:items-center">
                  <label className="relative block">
                    <span className="sr-only">Search current Handbook module</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                    <input className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-20 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100" onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${selected.label}`} type="search" value={search} />
                    <span aria-live="polite" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-slate-400">{searching ? `${matchingRecords} found` : ""}</span>
                  </label>
                  <nav aria-label="Handbook sections" className="flex gap-1 overflow-x-auto pb-1 xl:justify-end xl:pb-0">
                    {visibleSections.map((section) => {
                      const Icon = section.icon;
                      const active = !searching && selectedSectionId === section.id;
                      const count = sectionCount(selected, section.id);
                      return <button aria-current={active ? "page" : undefined} className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`} key={section.id} onClick={() => { setSelectedSectionId(section.id); setSearch(""); }} type="button"><Icon className="size-4" />{section.label}{section.id !== "overview" ? <span className={active ? "text-slate-300" : "text-slate-400"}>{count}</span> : null}</button>;
                    })}
                  </nav>
                </div>
              </div>

              <div className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                {searching ? (
                  <SearchResults module={filtered} onEdit={(stage) => { workspace.setStage(stage); onClose(); }} query={search.trim()} />
                ) : (
                  <HandbookSection module={selected} onEdit={(stage) => { workspace.setStage(stage); onClose(); }} onSelectSection={setSelectedSectionId} sectionId={selectedSectionId} />
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

function HandbookSection({
  module,
  onEdit,
  onSelectSection,
  sectionId,
}: {
  module: CiHandbookModule;
  onEdit: (stage: CiWorkspaceStage) => void;
  onSelectSection: (section: HandbookSectionId) => void;
  sectionId: HandbookSectionId;
}) {
  if (sectionId !== "overview" && sectionCount(module, sectionId) === 0) {
    return <ModuleOverview module={module} onSelectSection={onSelectSection} />;
  }
  if (sectionId === "parameters") return <ParametersSection module={module} onEdit={onEdit} />;
  if (sectionId === "calculations") return <CalculationsSection module={module} />;
  if (sectionId === "models") return <ModelsSection module={module} />;
  if (sectionId === "results") return <ResultsSection module={module} />;
  if (sectionId === "boundaries") return <BoundariesSection boundaries={module.boundaries} />;
  return <ModuleOverview module={module} onSelectSection={onSelectSection} />;
}

function ModuleOverview({ module, onSelectSection }: { module: CiHandbookModule; onSelectSection: (section: HandbookSectionId) => void }) {
  const available = handbookSections.filter((section) => section.id !== "overview" && sectionCount(module, section.id) > 0);
  return (
    <div className="space-y-7">
      <section aria-labelledby="handbook-overview">
        <h3 className="text-lg font-semibold text-slate-950" id="handbook-overview">Module overview</h3>
        <dl className="mt-4 grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-5">
          <OverviewStat label="Status" value={statusLabel(module.status)} />
          <OverviewStat label="Inputs" value={module.parameters.length} />
          <OverviewStat label="Formulas" value={module.calculations.length} />
          <OverviewStat label="Models" value={module.models.length} />
          <OverviewStat label="Saved result rows" value={resultRowCount(module)} />
        </dl>
      </section>

      <section aria-labelledby="handbook-browse-sections">
        <h3 className="text-lg font-semibold text-slate-950" id="handbook-browse-sections">Browse this module</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {available.map((section) => {
            const Icon = section.icon;
            return (
              <button className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-cyan-300 hover:bg-cyan-50/40" key={section.id} onClick={() => onSelectSection(section.id)} type="button">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Icon className="size-4" /></span>
                <span className="min-w-0"><strong className="block text-sm text-slate-950">{section.label}</strong><span className="mt-1 block text-sm leading-5 text-slate-500">{sectionDescription(section.id, sectionCount(module, section.id))}</span></span>
              </button>
            );
          })}
        </div>
      </section>

      {module.boundaries.length ? (
        <section aria-labelledby="handbook-overview-boundaries" className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold text-amber-950" id="handbook-overview-boundaries">Important model boundaries</h3><Button onClick={() => onSelectSection("boundaries")} size="sm" type="button" variant="outline">View all {module.boundaries.length}</Button></div>
          <ul className="mt-3 grid gap-2 text-sm leading-6 text-amber-900 lg:grid-cols-2">{module.boundaries.slice(0, 4).map((item) => <li className="flex gap-2" key={item}><span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-amber-500" />{item}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function SearchResults({ module, onEdit, query }: { module: CiHandbookModule; onEdit: (stage: CiWorkspaceStage) => void; query: string }) {
  const count = visibleRecordCount(module);
  if (!hasVisibleContent(module)) return <EmptySearch query={query} />;
  return (
    <div className="space-y-8">
      <div><h3 className="text-lg font-semibold text-slate-950">Search results</h3><p className="mt-1 text-sm text-slate-500">{count} matching records in this module for “{query}”.</p></div>
      <ParametersSection module={module} onEdit={onEdit} showAll />
      <CalculationsSection module={module} />
      <ModelsSection module={module} />
      <ResultsSection module={module} />
      <BoundariesSection boundaries={module.boundaries} />
    </div>
  );
}

function OverviewStat({ label, value }: { label: string; value: number | string }) {
  return <div className="bg-white px-4 py-4"><dt className="text-xs font-medium text-slate-500">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{value}</dd></div>;
}

function ParametersSection({ module, onEdit, showAll = false }: { module: CiHandbookModule; onEdit: (stage: CiWorkspaceStage) => void; showAll?: boolean }) {
  const [includeInactive, setIncludeInactive] = useState(false);
  if (!module.parameters.length) return null;
  const inactiveCount = module.parameters.filter((parameter) => !parameter.active_in_current_model).length;
  const visibleParameters = showAll || includeInactive
    ? module.parameters
    : module.parameters.filter((parameter) => parameter.active_in_current_model);
  const groups = groupParameters(visibleParameters);
  return (
    <section aria-labelledby="handbook-parameters">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle count={visibleParameters.length} icon={Settings2} id="handbook-parameters" title="Inputs & parameters" />
        {!showAll && inactiveCount ? <Button onClick={() => setIncludeInactive((current) => !current)} size="sm" type="button" variant="outline">{includeInactive ? "Hide inactive" : `Show ${inactiveCount} inactive`}</Button> : null}
      </div>
      <div className="mt-4 space-y-5">
        {groups.map((group) => (
          <section aria-labelledby={`handbook-parameter-group-${group.key}`} key={group.key}>
            <div className="mb-2 flex items-center gap-2"><h4 className="text-sm font-semibold text-slate-800" id={`handbook-parameter-group-${group.key}`}>{group.label}</h4><span className="text-xs tabular-nums text-slate-400">{group.parameters.length}</span></div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <Table className="min-w-[920px]" scrollLabel={`${module.label} ${group.label} parameters`}>
                <TableHeader><TableRow><TableHead>Input</TableHead><TableHead>Current value</TableHead><TableHead>Governed source</TableHead><TableHead className="text-right">Change</TableHead></TableRow></TableHeader>
                <TableBody>{group.parameters.map((parameter) => (
                  <TableRow className={!parameter.active_in_current_model ? "bg-amber-50/40" : undefined} key={parameter.parameter_id}>
                    <TableCell className="min-w-72 align-top">
                      <div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-semibold text-slate-900">{parameter.label}</strong>{!parameter.active_in_current_model ? <Badge variant="warning">Inactive</Badge> : null}</div>
                      <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer select-none font-medium text-cyan-800">Technical details</summary><dl className="mt-2 grid gap-1.5 rounded-lg bg-slate-50 p-2.5"><div><dt className="inline font-medium text-slate-600">Parameter ID: </dt><dd className="inline"><code className="break-all text-[11px]">{parameter.parameter_id}</code></dd></div><div><dt className="inline font-medium text-slate-600">Source path: </dt><dd className="inline"><code className="break-all text-[11px]">{parameter.source_path}</code></dd></div></dl></details>
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-nowrap align-top font-semibold tabular-nums text-slate-950">{formatValue(parameter.value, parameter.unit)}</TableCell>
                    <TableCell className="min-w-64 align-top"><span className="block text-sm font-medium text-slate-800">{sourceKindLabel(parameter.source_kind)}</span><span className="mt-1 block max-w-sm text-xs leading-5 text-slate-500">{parameter.source_label}</span></TableCell>
                    <TableCell className="align-top text-right">{parameter.editable && parameter.edit_stage ? <Button aria-label={`Edit ${parameter.label} at source`} className="h-8 px-2.5 text-xs" onClick={() => onEdit(parameter.edit_stage!)} type="button" variant="ghost"><Pencil className="size-3.5" />Edit source</Button> : <span className="text-xs text-slate-400">Read only</span>}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function CalculationsSection({ module }: { module: CiHandbookModule }) {
  if (!module.calculations.length) return null;
  return (
    <section aria-labelledby="handbook-calculations">
      <SectionTitle count={module.calculations.length} icon={Calculator} id="handbook-calculations" title="Formulas & calculation logic" />
      <div className="mt-3 space-y-2">{module.calculations.map((calculation, index) => (
        <CalculationDisclosure calculation={calculation} defaultOpen={index === 0} key={calculation.calculation_id} />
      ))}</div>
    </section>
  );
}

function CalculationDisclosure({ calculation, defaultOpen }: { calculation: CiHandbookCalculation; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="group rounded-xl border border-slate-200 bg-white open:border-cyan-200 open:shadow-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 marker:hidden"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Calculator className="size-4" /></span><span className="min-w-0 flex-1"><strong className="block text-sm text-slate-950">{calculation.label}</strong><code className="mt-1 block truncate text-xs text-slate-500">{calculation.formula}</code></span><span className="text-xs font-medium text-cyan-700 group-open:hidden">Details</span><span className="hidden text-xs font-medium text-cyan-700 group-open:inline">Close</span></summary>
      <div className="border-t border-slate-100 px-4 pb-5 pt-4 sm:px-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)]">
          <div>
            <p className="text-sm leading-6 text-slate-600">{calculation.description}</p>
            <div className="mt-3 overflow-x-auto rounded-lg bg-[#071525] px-4 py-3.5 text-cyan-50"><code className="whitespace-pre-wrap font-mono text-sm leading-6">{calculation.formula}</code></div>
            {calculation.current_example ? <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5"><p className="text-xs font-semibold text-emerald-900">Current project substitution</p><code className="mt-1.5 block break-words text-sm leading-6 text-emerald-950">{calculation.current_example.substitution} = {formatValue(calculation.current_example.result, calculation.current_example.unit)}</code></div> : null}
          </div>
          <dl className="grid content-start gap-4 rounded-lg bg-slate-50 p-4 text-sm"><div><dt className="font-semibold text-slate-800">Inputs</dt><dd className="mt-1.5 leading-6 text-slate-600">{calculation.inputs.join(", ")}</dd></div><div><dt className="font-semibold text-slate-800">Python authority</dt><dd className="mt-1.5 break-all font-mono text-xs leading-5 text-slate-500">{calculation.source_reference}</dd></div><div><dt className="font-semibold text-slate-800">Formula ID</dt><dd className="mt-1.5 break-all font-mono text-xs leading-5 text-slate-500">{calculation.calculation_id}</dd></div></dl>
        </div>
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
  const [selectedResultSetId, setSelectedResultSetId] = useState<string | null>(null);
  const resultSets = module.result_sets.filter((set) => set.rows.length);
  const selectedSet = resultSets.find((set) => set.result_set_id === selectedResultSetId) ?? resultSets[0];
  if (!selectedSet) return null;
  const totalRows = resultSets.reduce((sum, set) => sum + set.rows.length, 0);
  return (
    <section aria-labelledby="handbook-results">
      <SectionTitle count={totalRows} icon={ReceiptText} id="handbook-results" title="Saved results" />
      {resultSets.length > 1 ? <nav aria-label="Saved result sets" className="mt-4 flex gap-2 overflow-x-auto pb-1">{resultSets.map((set) => <button aria-current={set.result_set_id === selectedSet.result_set_id ? "page" : undefined} className={`shrink-0 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${set.result_set_id === selectedSet.result_set_id ? "border-cyan-300 bg-cyan-50 text-cyan-950" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-950"}`} key={set.result_set_id} onClick={() => setSelectedResultSetId(set.result_set_id)} type="button">{set.label}<span className="ml-2 text-xs tabular-nums text-slate-400">{set.rows.length}</span></button>)}</nav> : null}
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3"><h4 className="text-sm font-semibold text-slate-900">{selectedSet.label}</h4><p className="mt-0.5 text-xs text-slate-500">{selectedSet.rows.length} saved records</p></div>
          <Table className="min-w-[960px]" scrollLabel={selectedSet.label}>
            <TableHeader><TableRow><TableHead>Record</TableHead>{selectedSet.columns.map((column) => <TableHead key={column.key}>{column.label}{column.unit ? <span className="ml-1 normal-case tracking-normal text-slate-400">({column.unit})</span> : null}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{selectedSet.rows.map((row) => <TableRow key={row.result_id}><TableCell className="align-top"><strong className="block min-w-56 text-sm text-slate-900">{row.label}</strong><code className="mt-1 block max-w-64 truncate text-[11px] text-slate-400" title={row.result_id}>{row.result_id}</code></TableCell>{selectedSet.columns.map((column) => <TableCell className="max-w-80 whitespace-nowrap align-top tabular-nums" key={column.key}>{formatValue(row.values[column.key] ?? null, column.unit)}</TableCell>)}</TableRow>)}</TableBody>
          </Table>
      </div>
    </section>
  );
}

function BoundariesSection({ boundaries }: { boundaries: string[] }) {
  if (!boundaries.length) return null;
  return <section aria-labelledby="handbook-boundaries" className="rounded-xl border border-amber-200 bg-amber-50 p-5"><SectionTitle count={boundaries.length} icon={FileInput} id="handbook-boundaries" title="Model boundaries" /><ul className="mt-4 grid gap-3 text-sm leading-6 text-amber-950 lg:grid-cols-2">{boundaries.map((item) => <li className="rounded-lg border border-amber-200 bg-white/60 p-3" key={item}>{item}</li>)}</ul></section>;
}

function SectionTitle({ count, icon: Icon, id, title }: { count: number; icon: typeof Database; id: string; title: string }) {
  return <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-cyan-50 text-cyan-800"><Icon className="size-4" /></span><h3 className="font-semibold text-slate-950" id={id}>{title}</h3><Badge variant="secondary">{count}</Badge></div>;
}

function StatusBadge({ status }: { status: CiHandbookModule["status"] }) {
  const variant = status === "ready" ? "success" : status === "stale" ? "warning" : "secondary";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

function StatusMark({ status }: { status: CiHandbookModule["status"] }) {
  const tone = status === "ready" ? "text-emerald-700" : status === "stale" ? "text-amber-700" : "text-slate-500";
  return <span className={`shrink-0 text-xs font-medium ${tone}`}>{statusLabel(status)}</span>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-2.5"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-base font-semibold text-slate-900">{value}</dd></div>;
}

function HandbookLoading() {
  return <div aria-live="polite" className="grid h-full place-items-center p-8"><div className="text-center"><BookOpenText className="mx-auto size-8 animate-pulse text-cyan-700" /><p className="mt-3 text-sm font-semibold text-slate-900">Loading saved calculation ledger</p><p className="mt-1 text-xs text-slate-500">No analysis is being run.</p></div></div>;
}

function HandbookError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="grid h-full place-items-center p-8"><div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-5 text-center"><p className="font-semibold text-red-950">Handbook unavailable</p><p className="mt-2 text-sm leading-5 text-red-800">{message}</p><Button className="mt-4" onClick={onRetry} type="button" variant="outline">Try again</Button></div></div>;
}

function EmptySearch({ query }: { query: string }) {
  return <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center"><Search className="mx-auto size-6 text-slate-400" /><p className="mt-3 font-semibold text-slate-800">No matching Handbook records</p><p className="mt-1 text-sm text-slate-500">No records in this module match “{query}”. Clear the search to continue.</p></div>;
}

function filterModule(module: CiHandbookModule, search: string): CiHandbookModule {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return module;
  const matches = (...values: unknown[]) => values.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
  if (matches(module.label, module.description, module.status)) return module;
  return {
    ...module,
    parameters: module.parameters.filter((item) => matches(item.label, item.parameter_id, item.unit, item.source_kind, item.source_label, item.source_path, item.value)),
    calculations: module.calculations.filter((item) => matches(item.label, item.calculation_id, item.formula, item.description, item.inputs.join(" "), item.source_reference, item.current_example?.substitution, item.current_example?.result, item.current_example?.unit)),
    models: module.models.filter((item) => matches(item.label, item.model_id, item.method, item.objective, item.constraints.join(" "), item.source_reference)),
    result_sets: module.result_sets.map((set) => {
      const setMatches = matches(set.label, set.result_set_id, ...set.columns.flatMap((column) => [column.key, column.label, column.unit]));
      return { ...set, rows: setMatches ? set.rows : set.rows.filter((row) => matches(row.label, row.result_id, ...Object.values(row.values))) };
    }),
    boundaries: module.boundaries.filter((item) => matches(item)),
  };
}

function hasVisibleContent(module: CiHandbookModule) {
  return module.parameters.length > 0 || module.calculations.length > 0 || module.models.length > 0 || module.boundaries.length > 0 || module.result_sets.some((set) => set.rows.length > 0);
}

function visibleRecordCount(module: CiHandbookModule) {
  return module.parameters.length + module.calculations.length + module.models.length + module.boundaries.length + resultRowCount(module);
}

function resultRowCount(module: CiHandbookModule) {
  return module.result_sets.reduce((sum, set) => sum + set.rows.length, 0);
}

function sectionCount(module: CiHandbookModule, sectionId: HandbookSectionId) {
  if (sectionId === "parameters") return module.parameters.length;
  if (sectionId === "calculations") return module.calculations.length;
  if (sectionId === "models") return module.models.length;
  if (sectionId === "results") return resultRowCount(module);
  if (sectionId === "boundaries") return module.boundaries.length;
  return 0;
}

function sectionDescription(sectionId: HandbookSectionId, count: number) {
  if (sectionId === "parameters") return `${count} current values with their governed source and edit location.`;
  if (sectionId === "calculations") return `${count} Python formulas with inputs, substitutions and source references.`;
  if (sectionId === "models") return `${count} optimizer or analysis methods with objectives and constraints.`;
  if (sectionId === "results") return `${count} saved project result rows grouped by result set.`;
  if (sectionId === "boundaries") return `${count} assumptions and limits that affect interpretation.`;
  return "Module status and ledger coverage.";
}

function groupParameters(parameters: CiHandbookModule["parameters"]) {
  const groups = new Map<string, { key: string; label: string; parameters: CiHandbookModule["parameters"] }>();
  parameters.forEach((parameter) => {
    const metadata = parameterGroup(parameter.parameter_id);
    const group = groups.get(metadata.key) ?? { ...metadata, parameters: [] };
    group.parameters.push(parameter);
    groups.set(metadata.key, group);
  });
  return Array.from(groups.values());
}

function parameterGroup(parameterId: string) {
  const parts = parameterId.split(".");
  const scope = parts[0] ?? "parameter";
  const family = parts[1] ?? "general";
  const detail = parts[2] ?? "general";
  if (scope === "evidence") {
    if (family === "bill") return { key: "evidence-bill", label: "Bill evidence" };
    if (family === "nem12") return { key: "evidence-nem12", label: "Interval evidence" };
  }
  if (scope === "solution") {
    if (family === "pv_range") return { key: "solution-pv", label: "PV candidates" };
    if (family === "battery_range") return { key: "solution-battery", label: "Battery candidates" };
    if (family === "site") return { key: "solution-site", label: "Site yield and losses" };
    if (family === "technical") return { key: "solution-technical", label: "Connection and operating settings" };
    if (family === "profile") return { key: "solution-profile", label: "Selected profiles" };
    if (family === "profile_snapshot") return { key: `solution-profile-${detail}`, label: `${titleCase(detail)} profile performance` };
    if (family === "cost") return { key: `solution-cost-${detail}`, label: `${titleCase(detail)} equipment pricing` };
    if (family === "rebate") return { key: `solution-rebate-${detail}`, label: rebateGroupLabel(detail) };
  }
  if (scope === "scenario") {
    if (family === "coverage") return { key: "scenario-coverage", label: "Analysis coverage" };
    if (family === "optimizer") return { key: "scenario-optimizer", label: "Optimizer policy" };
  }
  if (scope === "finance") {
    if (family === "assumption") return { key: "finance-assumptions", label: "Financial assumptions" };
    if (family === "one_click_fallback") return { key: "finance-fallbacks", label: "One-click fallback assumptions" };
    if (family === "tariff") return { key: `finance-tariff-${detail}`, label: tariffGroupLabel(detail) };
  }
  return { key: `${scope}-${family}`, label: titleCase(family) };
}

function rebateGroupLabel(value: string) {
  if (value === "solar_stc") return "Solar STCs";
  if (value === "battery_stc") return "Battery STCs";
  if (value === "vic_deemed_veec") return "Victorian VEECs";
  return "Rebate settings";
}

function tariffGroupLabel(value: string) {
  if (value === "rate") return "Tariff rates";
  if (value === "factor") return "Tariff loss factors";
  if (value === "window") return "Tariff time windows";
  return "Tariff settings";
}

function titleCase(value: string) {
  return value.split("_").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function formatValue(value: CiHandbookValue, unit: string | null) {
  if (value === null || value === "") return <span className="text-slate-400">Not available</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-slate-400">None</span>;
    const entries = value.map((item) => Array.isArray(item) ? item.map(String).join(", ") : scalarValue(item, unit));
    if (entries.length <= 6) return entries.join(", ");
    return <details className="min-w-32 whitespace-normal"><summary className="cursor-pointer select-none text-sm font-medium text-cyan-800">{entries.length} values</summary><div className="mt-2 max-h-48 min-w-64 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-600">{entries.map((entry, index) => <div key={`${index}-${entry}`}>{index + 1}. {entry}</div>)}</div></details>;
  }
  if (typeof value === "number") {
    return scalarValue(value, unit);
  }
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function scalarValue(value: string | number | boolean | null, unit: string | null) {
  if (value === null || value === "") return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
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

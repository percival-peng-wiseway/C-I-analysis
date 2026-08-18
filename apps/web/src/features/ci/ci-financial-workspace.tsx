import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  listCiFinancialSolutions,
  saveCiFinancialSolution,
  setCiFinancialSolutionStarred,
  type CiFinancialSolution,
  type PhysicalScenario,
} from "@/features/ci/api/ci-financial-solutions";
import {
  createCiPricingDraft,
  getCiComponentCostLibrary,
  listCiPricingCatalog,
  publishCiPricingDraft,
  saveCiPricingDraft,
  type CiCostRow,
  type CiComponentCostLibrary,
  type CiComponentCostLibraryEntry,
  type CiPriceItem,
  type CiPricingCatalogVersion,
} from "@/features/ci/api/ci-pricing-catalog";

const queryKey = ["ci-financial-solutions"] as const;
const pricingQueryKey = ["ci-pricing-catalog"] as const;
const componentLibraryQueryKey = ["ci-component-cost-library"] as const;

export function CiFinancialWorkspace({
  file,
  scenarios,
  showCatalogManager = true,
}: {
  file: File;
  scenarios: PhysicalScenario[];
  showCatalogManager?: boolean;
}) {
  const queryClient = useQueryClient();
  const solutionsQuery = useQuery({ queryKey, queryFn: () => listCiFinancialSolutions() });
  const pricingQuery = useQuery({ queryKey: pricingQueryKey, queryFn: () => listCiPricingCatalog() });
  const componentLibraryQuery = useQuery({ queryKey: componentLibraryQueryKey, queryFn: () => getCiComponentCostLibrary() });
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.scenario_id ?? "");
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    label: scenarios[0]?.label ?? "",
    discountRate: "8",
    degradationRate: "0",
    termYears: "15",
  });
  const [productIds, setProductIds] = useState<string[]>([]);
  const [installationItemIds, setInstallationItemIds] = useState<string[]>([]);
  const publishedCatalog = pricingQuery.data?.find((version) => version.status === "published") ?? null;
  useEffect(() => {
    setProductIds([]);
    setInstallationItemIds([]);
  }, [publishedCatalog?.catalog_version_id]);
  const selectedScenario = scenarios.find((item) => item.scenario_id === scenarioId) ?? scenarios[0];
  const saveMutation = useMutation({
    mutationFn: () => {
      if (!selectedScenario || !publishedCatalog) throw new Error("Select a physical scenario and publish the C&I price catalog first.");
      return saveCiFinancialSolution({
        file,
        label: form.label.trim(),
        scenario: selectedScenario,
        discountRate: Number(form.discountRate) / 100,
        degradationRate: Number(form.degradationRate) / 100,
        termYears: Number(form.termYears),
        pricingCatalogVersionId: publishedCatalog.catalog_version_id,
        productIds,
        installationItemIds,
      });
    },
    onSuccess: async (solution) => {
      setViewedId(solution.solution_id);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const starMutation = useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) =>
      setCiFinancialSolutionStarred(id, starred),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey }),
  });
  const solutions = solutionsQuery.data ?? [];

  useEffect(() => {
    if (!viewedId && solutions[0]) setViewedId(solutions[0].solution_id);
  }, [solutions, viewedId]);

  const valid = Boolean(
    selectedScenario && publishedCatalog && form.label.trim() &&
    productIds.length + installationItemIds.length > 0 &&
    Number(form.discountRate) >= 0 &&
    Number(form.degradationRate) >= 0 && Number(form.termYears) >= 1,
  );

  return (
    <section aria-labelledby="ci-financial-workspace" className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold" id="ci-financial-workspace">Financial solution finder</h2>
          <Badge variant="secondary">Tariff-calculated value</Badge>
          <Badge variant="outline">No automatic recommendation</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Save solutions, star the shortlist, and compare Python-calculated NPV and payback.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h3">Save a financial solution</CardTitle>
          <CardDescription>
            Python recalculates the selected scenario against the uploaded NEM12 and tariff. Capital, replacement and annual O&amp;M resolve from the published catalog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 lg:grid-cols-3" onSubmit={(event) => { event.preventDefault(); if (valid) saveMutation.mutate(); }}>
            <FinancialField label="Solution name" value={form.label} onChange={(value) => setForm({ ...form, label: value })} />
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Physical scenario</span>
              <select className="rounded-md border border-border bg-background px-3 py-2" value={scenarioId} onChange={(event) => {
                const next = scenarios.find((item) => item.scenario_id === event.target.value);
                setScenarioId(event.target.value);
                if (next) setForm((current) => ({ ...current, label: next.label }));
              }}>
                {scenarios.map((scenario) => <option key={scenario.scenario_id} value={scenario.scenario_id}>{scenario.label}</option>)}
              </select>
            </label>
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm"><span className="text-muted-foreground">Automatic first-year tariff value</span><strong className="mt-1 block text-lg">{formatAud(publishedCatalog?.catalog.tax_basis === "gst_inclusive" ? selectedScenario?.annual_tariff_value.first_year_value_inc_gst_aud ?? 0 : selectedScenario?.annual_tariff_value.first_year_value_ex_gst_aud ?? 0)}</strong><span className="text-xs text-muted-foreground">{publishedCatalog?.catalog.tax_basis === "gst_inclusive" ? "GST inclusive" : "GST exclusive"} · before catalog O&amp;M</span></div>
            <FinancialField label="Discount rate (%)" numeric value={form.discountRate} onChange={(value) => setForm({ ...form, discountRate: value })} />
            <FinancialField label="Annual value degradation (%)" numeric value={form.degradationRate} onChange={(value) => setForm({ ...form, degradationRate: value })} />
            <FinancialField label="Analysis term (years)" numeric value={form.termYears} onChange={(value) => setForm({ ...form, termYears: value })} />
            <PriceSelection heading="Products" items={publishedCatalog?.catalog.products ?? []} selected={productIds} onChange={setProductIds} />
            <PriceSelection heading="Installation" items={publishedCatalog?.catalog.installation_items ?? []} selected={installationItemIds} onChange={setInstallationItemIds} />
            <div className="flex items-end"><Button disabled={!valid || saveMutation.isPending} type="submit">{saveMutation.isPending ? "Saving" : "Save solution"}</Button></div>
          </form>
          {saveMutation.isError ? <p className="mt-3 text-sm text-destructive">{saveMutation.error.message}</p> : null}
        </CardContent>
      </Card>

      {showCatalogManager ? <CiPricingCatalogManager library={componentLibraryQuery.data} versions={pricingQuery.data ?? []} /> : null}

      {solutionsQuery.isPending ? <p className="text-sm text-muted-foreground">Loading saved solutions…</p> : null}
      {solutionsQuery.isError ? <p className="text-sm text-destructive">{solutionsQuery.error.message}</p> : null}
      {solutions.length ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <SolutionChart
              format={(value) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value)}
              heading="Net present value"
              higherIsBetter
              solutions={solutions}
              value={(item) => item.metrics.net_present_value_aud}
              viewedId={viewedId}
              onView={setViewedId}
            />
            <SolutionChart
              format={(value) => `${value.toFixed(2)} yr`}
              heading="Payback period"
              solutions={solutions.filter((item) => item.metrics.payback_period_years !== null)}
              value={(item) => item.metrics.payback_period_years ?? 0}
              viewedId={viewedId}
              onView={setViewedId}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {solutions.map((solution) => (
              <SolutionCard key={solution.solution_id} solution={solution} viewed={solution.solution_id === viewedId} onView={() => setViewedId(solution.solution_id)} onStar={() => starMutation.mutate({ id: solution.solution_id, starred: !solution.starred })} />
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">Save at least one solution to start the comparison.</p>
      )}
    </section>
  );
}

export function CiCatalogWorkspace() {
  const pricingQuery = useQuery({ queryKey: pricingQueryKey, queryFn: () => listCiPricingCatalog() });
  const componentLibraryQuery = useQuery({ queryKey: componentLibraryQueryKey, queryFn: () => getCiComponentCostLibrary() });
  const error = pricingQuery.error ?? componentLibraryQuery.error;
  if (error) {
    return <Card><CardContent className="p-5 text-sm text-destructive">The C&amp;I price catalog could not be loaded. {error.message}</CardContent></Card>;
  }
  if (pricingQuery.isPending || componentLibraryQuery.isPending) {
    return <Card><CardContent className="p-5 text-sm text-muted-foreground">Loading the component and pricing catalog…</CardContent></Card>;
  }
  return <CiPricingCatalogManager library={componentLibraryQuery.data} versions={pricingQuery.data ?? []} />;
}

function FinancialField({ label, numeric = false, onChange, value }: { label: string; numeric?: boolean; onChange: (value: string) => void; value: string }) {
  return <label className="grid gap-1 text-sm"><span className="font-medium">{label}</span><input className="rounded-md border border-border bg-background px-3 py-2" min={numeric ? 0 : undefined} onChange={(event) => onChange(event.target.value)} step={numeric ? "any" : undefined} type={numeric ? "number" : "text"} value={value} /></label>;
}

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value);
}

function PriceSelection({ heading, items, onChange, selected }: { heading: string; items: CiPriceItem[]; onChange: (ids: string[]) => void; selected: string[] }) {
  const active = items.filter((item) => item.effective_status === "active");
  return <fieldset className="rounded-md border border-border p-3"><legend className="px-1 text-sm font-medium">{heading}</legend>{active.length ? active.map((item) => <label className="mt-2 flex items-center gap-2 text-sm" key={item.item_id}><input checked={selected.includes(item.item_id)} onChange={(event) => onChange(event.target.checked ? [...selected, item.item_id] : selected.filter((id) => id !== item.item_id))} type="checkbox" />{item.label} · {basisLabel(item)}</label>) : <p className="text-xs text-muted-foreground">Publish catalog items first.</p>}</fieldset>;
}

function basisLabel(item: CiPriceItem) {
  if (item.pricing_basis === "size_cost_table") return `${sizeMetricLabel(item.size_metric)} cost table · ${item.cost_rows?.length ?? 0} points`;
  const suffix = item.pricing_basis === "fixed" ? "fixed" : item.pricing_basis === "per_kwh_capacity" ? "/ battery kWh" : item.pricing_basis === "per_kw_pv_dc" ? "/ PV kWp" : "/ battery kW";
  return `$${item.unit_price_aud.toLocaleString("en-AU")} ${suffix}`;
}

export function CiPricingCatalogManager({ library, versions }: { library?: CiComponentCostLibrary; versions: CiPricingCatalogVersion[] }) {
  const queryClient = useQueryClient();
  const serverDraft = versions.find((version) => version.status === "draft") ?? null;
  const [draft, setDraft] = useState<CiPricingCatalogVersion | null>(serverDraft);
  useEffect(() => { setDraft(serverDraft); }, [serverDraft]);
  const createMutation = useMutation({ mutationFn: () => createCiPricingDraft(), onSuccess: async (value) => { setDraft(value); await queryClient.invalidateQueries({ queryKey: pricingQueryKey }); } });
  const saveMutation = useMutation({ mutationFn: (value: CiPricingCatalogVersion) => saveCiPricingDraft(value), onSuccess: async (value) => { setDraft(value); await queryClient.invalidateQueries({ queryKey: pricingQueryKey }); } });
  const publishMutation = useMutation({ mutationFn: async (value: CiPricingCatalogVersion) => publishCiPricingDraft(await saveCiPricingDraft(value)), onSuccess: async () => { setDraft(null); await queryClient.invalidateQueries({ queryKey: pricingQueryKey }); } });
  const error = createMutation.error ?? saveMutation.error ?? publishMutation.error;

  const addFromLibrary = (entry: CiComponentCostLibraryEntry) => {
    if (!draft || !entry.pricing_catalog_template) return;
    setDraft({
      ...draft,
      catalog: {
        ...draft.catalog,
        products: [...draft.catalog.products, structuredClone(entry.pricing_catalog_template)],
      },
    });
  };

  return <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle as="h3">C&amp;I product and installation prices</CardTitle><CardDescription>Published versions price new solutions; saved solutions retain their exact price snapshot.</CardDescription></div>{!draft ? <Button onClick={() => createMutation.mutate()} type="button" variant="outline">Edit price catalog</Button> : null}</div></CardHeader><CardContent className="space-y-4">{draft ? <><ComponentCostLibrary entries={library?.entries ?? []} existingIds={new Set(draft.catalog.products.map((item) => item.item_id))} onAdd={addFromLibrary} /><label className="grid max-w-xs gap-1 text-sm"><span className="font-medium">Tax basis</span><select className="rounded-md border border-border bg-background px-3 py-2" value={draft.catalog.tax_basis} onChange={(event) => setDraft({ ...draft, catalog: { ...draft.catalog, tax_basis: event.target.value as "gst_inclusive" | "gst_exclusive" } })}><option value="gst_exclusive">GST exclusive</option><option value="gst_inclusive">GST inclusive</option></select><span className="text-xs text-muted-foreground">Provided screenshots did not state GST. Set the basis used by this catalog before publishing.</span></label><CatalogItems group="products" items={draft.catalog.products} onChange={(items) => setDraft({ ...draft, catalog: { ...draft.catalog, products: items } })} /><CatalogItems group="installation_items" items={draft.catalog.installation_items} onChange={(items) => setDraft({ ...draft, catalog: { ...draft.catalog, installation_items: items } })} /><div className="flex flex-wrap gap-2"><Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(draft)} type="button" variant="outline">Save draft</Button><Button disabled={publishMutation.isPending} onClick={() => publishMutation.mutate(draft)} type="button">Publish version {draft.version_number}</Button></div></> : <p className="text-sm text-muted-foreground">{versions.find((version) => version.status === "published") ? `Published version ${versions.find((version) => version.status === "published")?.version_number} is active.` : "No published price catalog. Create one before saving financial solutions."}</p>}{error ? <p className="text-sm text-destructive">{error.message}</p> : null}</CardContent></Card>;
}

function ComponentCostLibrary({ entries, existingIds, onAdd }: { entries: CiComponentCostLibraryEntry[]; existingIds: Set<string>; onAdd: (entry: CiComponentCostLibraryEntry) => void }) {
  return <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"><div><h4 className="font-semibold">Reusable component cost library</h4><p className="text-sm text-muted-foreground">Cost points transcribed from the provided component screenshots. Import a component, then review its GST basis and replacement interval before publishing.</p></div><div className="grid gap-3 lg:grid-cols-3">{entries.map((entry) => {
    const templateId = entry.pricing_catalog_template?.item_id;
    const added = templateId ? existingIds.has(templateId) : false;
    return <div className="rounded-md border border-border bg-background p-3" key={entry.component_id}><div className="flex items-start justify-between gap-2"><div><h5 className="font-medium">{entry.label}</h5><p className="text-xs text-muted-foreground">{entry.abbreviation} · {entry.cost_rows.length} cost points · {sizeMetricLabel(entry.source_size_metric)}</p></div><Badge variant="outline">Library</Badge></div>{entry.module_nominal_capacity_kwh ? <p className="mt-2 text-xs text-muted-foreground">CQ7 module: {entry.module_nominal_capacity_kwh} kWh nominal; source quantities converted to kWh.</p> : null}{entry.reuse_status === "replacement_interval_required" ? <p className="mt-2 text-xs text-amber-700">Enter the expert replacement interval after import; it was not shown in the cost screenshot and is required before saving.</p> : null}<Button className="mt-3" disabled={!entry.pricing_catalog_template || added} onClick={() => onAdd(entry)} type="button" variant="outline">{added ? "Added to draft" : "Add to price draft"}</Button></div>;
  })}</div></section>;
}

function CatalogItems({ group, items, onChange }: { group: "products" | "installation_items"; items: CiPriceItem[]; onChange: (items: CiPriceItem[]) => void }) {
  const add = () => onChange([...items, { item_id: `${group === "products" ? "product" : "install"}-${items.length + 1}`, label: "", ...(group === "products" ? { category: "battery" as const } : {}), pricing_basis: "fixed", unit_price_aud: 0, effective_status: "active" }]);
  const update = (index: number, patch: Partial<CiPriceItem>) => onChange(items.map((item, current) => current === index ? { ...item, ...patch } : item));
  return <fieldset className="space-y-3 rounded-lg border border-border p-4">
    <legend className="px-1 font-semibold">{group === "products" ? "Products" : "Installation and project costs"}</legend>
    {items.map((item, index) => <div className="space-y-3 rounded-md bg-muted/40 p-3" key={`${item.item_id}-${index}`}>
      <div className="grid gap-2 md:grid-cols-6">
        <FinancialField label="ID" value={item.item_id} onChange={(value) => update(index, { item_id: value })} />
        <FinancialField label="Label" value={item.label} onChange={(value) => update(index, { label: value })} />
        {group === "products" ? <label className="grid gap-1 text-sm"><span className="font-medium">Category</span><select className="rounded-md border border-border bg-background px-3 py-2" value={item.category} onChange={(event) => update(index, { category: event.target.value as CiPriceItem["category"] })}><option value="solar_pv">Solar PV</option><option value="battery">Battery</option><option value="pcs_inverter">PCS / inverter</option><option value="switchgear">Switchgear</option><option value="ems">EMS</option><option value="other">Other</option></select></label> : <span />}
        <label className="grid gap-1 text-sm"><span className="font-medium">Price basis</span><select className="rounded-md border border-border bg-background px-3 py-2" value={item.pricing_basis} onChange={(event) => update(index, priceBasisPatch(event.target.value as CiPriceItem["pricing_basis"]))}><option value="fixed">Fixed</option><option value="per_kw_pv_dc">Per PV kWp DC</option><option value="per_kwh_capacity">Per battery kWh</option><option value="per_kw_discharge">Per battery kW discharge</option><option value="size_cost_table">Size cost table</option></select></label>
        {item.pricing_basis === "size_cost_table" ? <label className="grid gap-1 text-sm"><span className="font-medium">Sizing metric</span><select className="rounded-md border border-border bg-background px-3 py-2" value={item.size_metric ?? "battery_kwh"} onChange={(event) => update(index, { size_metric: event.target.value as CiPriceItem["size_metric"] })}><option value="pv_kwp_dc">PV kWp DC</option><option value="pv_inverter_kw_ac">PV inverter kW AC</option><option value="battery_kwh">Battery kWh</option><option value="battery_kw_discharge">Battery kW discharge</option></select></label> : <FinancialField label="Unit price (AUD)" numeric value={String(item.unit_price_aud)} onChange={(value) => update(index, { unit_price_aud: Number(value) })} />}
        <label className="grid gap-1 text-sm"><span className="font-medium">Status</span><select className="rounded-md border border-border bg-background px-3 py-2" value={item.effective_status} onChange={(event) => update(index, { effective_status: event.target.value as CiPriceItem["effective_status"] })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      {item.pricing_basis === "size_cost_table" ? <CostTable item={item} onChange={(patch) => update(index, patch)} /> : null}
      <Button aria-label={`Remove ${item.label || item.item_id}`} onClick={() => onChange(items.filter((_, current) => current !== index))} type="button" variant="ghost">Remove item</Button>
    </div>)}
    <Button onClick={add} type="button" variant="outline">Add {group === "products" ? "product" : "installation item"}</Button>
  </fieldset>;
}

function priceBasisPatch(pricingBasis: CiPriceItem["pricing_basis"]): Partial<CiPriceItem> {
  return pricingBasis === "size_cost_table"
    ? { pricing_basis: pricingBasis, size_metric: "battery_kwh", replacement_interval_years: null, cost_rows: [{ size: 0, capital_cost_aud: 0, replacement_cost_aud: 0, annual_om_cost_aud: 0 }, { size: 1, capital_cost_aud: 0, replacement_cost_aud: 0, annual_om_cost_aud: 0 }] }
    : { pricing_basis: pricingBasis, unit_price_aud: 0, size_metric: undefined, replacement_interval_years: undefined, cost_rows: undefined };
}

function CostTable({ item, onChange }: { item: CiPriceItem; onChange: (patch: Partial<CiPriceItem>) => void }) {
  const rows = item.cost_rows ?? [];
  const updateRow = (index: number, patch: Partial<CiCostRow>) => onChange({ cost_rows: rows.map((row, current) => current === index ? { ...row, ...patch } : row) });
  const updateReplacement = (index: number, value: number) => {
    const nextRows = rows.map((row, current) => current === index ? { ...row, replacement_cost_aud: value } : row);
    onChange({ cost_rows: nextRows, ...(nextRows.every((row) => row.replacement_cost_aud === 0) ? { replacement_interval_years: null } : {}) });
  };
  const hasReplacement = rows.some((row) => row.replacement_cost_aud > 0);
  return <section className="space-y-3 rounded-md border border-border bg-background p-3"><div className="flex flex-wrap items-end justify-between gap-3"><div><h4 className="text-sm font-semibold">Size cost table</h4><p className="text-xs text-muted-foreground">Costs are linear between points and use the nearest two points outside the entered range. Zero size always costs zero.</p></div>{hasReplacement ? <FinancialField label="Replacement interval (years)" numeric value={item.replacement_interval_years == null ? "" : String(item.replacement_interval_years)} onChange={(value) => onChange({ replacement_interval_years: value === "" ? null : Number(value) })} /> : null}</div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="border-b border-border"><th className="p-2">{sizeMetricLabel(item.size_metric)}</th><th className="p-2">Capital (AUD)</th><th className="p-2">Replacement (AUD)</th><th className="p-2">O&amp;M (AUD/year)</th><th className="p-2" /></tr></thead><tbody>{rows.map((row, index) => <tr className="border-b border-border" key={index}><td className="p-2"><FinancialField label={`Cost row ${index + 1} size`} numeric value={String(row.size)} onChange={(value) => updateRow(index, { size: Number(value) })} /></td><td className="p-2"><FinancialField label={`Cost row ${index + 1} capital`} numeric value={String(row.capital_cost_aud)} onChange={(value) => updateRow(index, { capital_cost_aud: Number(value) })} /></td><td className="p-2"><FinancialField label={`Cost row ${index + 1} replacement`} numeric value={String(row.replacement_cost_aud)} onChange={(value) => updateReplacement(index, Number(value))} /></td><td className="p-2"><FinancialField label={`Cost row ${index + 1} annual O&M`} numeric value={String(row.annual_om_cost_aud)} onChange={(value) => updateRow(index, { annual_om_cost_aud: Number(value) })} /></td><td className="p-2"><Button aria-label={`Remove cost row ${index + 1}`} disabled={rows.length <= 2} onClick={() => onChange({ cost_rows: rows.filter((_, current) => current !== index) })} type="button" variant="ghost">Remove</Button></td></tr>)}</tbody></table></div><Button onClick={() => onChange({ cost_rows: [...rows, { size: 0, capital_cost_aud: 0, replacement_cost_aud: 0, annual_om_cost_aud: 0 }] })} type="button" variant="outline">Add cost point</Button></section>;
}

function sizeMetricLabel(value: CiPriceItem["size_metric"]) {
  return value === "pv_kwp_dc" ? "PV kWp DC" : value === "pv_inverter_kw_ac" ? "PV inverter kW AC" : value === "battery_kw_discharge" ? "Battery kW discharge" : "Battery kWh";
}

function SolutionChart({ format, heading, higherIsBetter = false, onView, solutions, value, viewedId }: { format: (value: number) => string; heading: string; higherIsBetter?: boolean; onView: (id: string) => void; solutions: CiFinancialSolution[]; value: (item: CiFinancialSolution) => number; viewedId: string | null }) {
  const ranked = useMemo(() => [...solutions].sort((a, b) => higherIsBetter ? value(b) - value(a) : value(a) - value(b)), [higherIsBetter, solutions, value]);
  const maximum = Math.max(...ranked.map((item) => Math.abs(value(item))), 1);
  return <Card><CardHeader><CardTitle as="h3">{heading}</CardTitle><CardDescription>{higherIsBetter ? "Highest to lowest" : "Shortest to longest"} · click a bar to view</CardDescription></CardHeader><CardContent className="space-y-3">{ranked.map((solution, index) => {
    const viewed = solution.solution_id === viewedId;
    const metricValue = value(solution);
    return <button aria-label={`View ${solution.label}`} className="grid w-full grid-cols-[2rem_1fr_auto] items-center gap-2 text-left text-sm" key={solution.solution_id} onClick={() => onView(solution.solution_id)} type="button"><span className="text-muted-foreground">#{index + 1}</span><span><span className="mb-1 flex items-center justify-between gap-2"><span className="truncate">{solution.starred ? "★ " : ""}{solution.label}</span></span><span className="block h-6 rounded-sm bg-muted"><span className={`block h-6 rounded-sm ${solution.starred ? "bg-fuchsia-500" : viewed ? "bg-slate-900" : metricValue < 0 ? "bg-rose-400" : "bg-blue-400"}`} style={{ width: `${Math.max(4, Math.abs(metricValue) / maximum * 100)}%` }} /></span></span><strong className="tabular-nums">{format(metricValue)}</strong></button>;
  })}</CardContent></Card>;
}

function SolutionCard({ onStar, onView, solution, viewed }: { onStar: () => void; onView: () => void; solution: CiFinancialSolution; viewed: boolean }) {
  return <Card className={viewed ? "border-slate-900" : undefined}><CardHeader><div className="flex items-start justify-between gap-2"><div><CardTitle as="h3">{solution.label}</CardTitle><CardDescription>{viewed ? "Viewed solution" : "Saved solution"}</CardDescription></div><Button aria-label={solution.starred ? "Remove star" : "Star solution"} onClick={onStar} type="button" variant="outline">{solution.starred ? "★ Starred" : "☆ Star"}</Button></div></CardHeader><CardContent className="space-y-3 text-sm"><dl className="grid grid-cols-2 gap-2"><div><dt className="text-muted-foreground">NPV</dt><dd className="font-semibold">{new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(solution.metrics.net_present_value_aud)}</dd></div><div><dt className="text-muted-foreground">Payback</dt><dd className="font-semibold">{solution.metrics.payback_period_years === null ? "Beyond term" : `${solution.metrics.payback_period_years.toFixed(2)} yr`}</dd></div><div><dt className="text-muted-foreground">IRR</dt><dd className="font-semibold">{solution.metrics.internal_rate_of_return === null ? "—" : `${(solution.metrics.internal_rate_of_return * 100).toFixed(1)}%`}</dd></div><div><dt className="text-muted-foreground">Upfront</dt><dd className="font-semibold">${solution.assumptions.upfront_cost_aud.toLocaleString("en-AU")}</dd></div></dl><Button onClick={onView} type="button" variant={viewed ? "secondary" : "outline"}>{viewed ? "Currently viewed" : "View solution"}</Button></CardContent></Card>;
}

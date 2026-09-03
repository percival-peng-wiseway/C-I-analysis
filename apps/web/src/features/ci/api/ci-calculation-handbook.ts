import type { QueryClient } from "@tanstack/react-query";

import type { CiWorkspaceStage } from "@/features/ci/ci-workspace-context";

export type CiHandbookValue = string | number | boolean | null | CiHandbookValue[];

export interface CiHandbookParameter {
  parameter_id: string;
  label: string;
  value: CiHandbookValue;
  unit: string | null;
  source_kind: string;
  source_label: string;
  source_path: string;
  editable: boolean;
  edit_stage: CiWorkspaceStage | null;
  active_in_current_model: boolean;
}

export interface CiHandbookCalculation {
  calculation_id: string;
  label: string;
  formula: string;
  description: string;
  inputs: string[];
  source_reference: string;
  current_example: null | {
    substitution: string;
    result: CiHandbookValue;
    unit: string | null;
  };
}

export interface CiHandbookModel {
  model_id: string;
  label: string;
  method: string;
  objective: string;
  constraints: string[];
  source_reference: string;
}

export interface CiHandbookResultSet {
  result_set_id: string;
  label: string;
  columns: Array<{ key: string; label: string; unit: string | null }>;
  rows: Array<{
    result_id: string;
    label: string;
    values: Record<string, CiHandbookValue>;
  }>;
}

export interface CiHandbookModule {
  module_id: "evidence" | "solution_generator" | "scenario_analysis" | "finance_analysis";
  label: string;
  description: string;
  status: "ready" | "input_required" | "not_saved" | "stale";
  saved_at: string | null;
  parameters: CiHandbookParameter[];
  calculations: CiHandbookCalculation[];
  models: CiHandbookModel[];
  result_sets: CiHandbookResultSet[];
  boundaries: string[];
}

export interface CiCalculationHandbook {
  contract_version: "ci_project_handbook_v1";
  project: {
    project_id: string;
    display_name: string;
    snapshot_at: string;
  };
  authority: {
    calculation_authority: "python";
    presentation_authority: "handbook_projection_only";
    mutation_policy: "controlled_existing_module_inputs";
    statement: string;
  };
  parameter_management: {
    mode: "edit_at_source";
    stable_parameter_ids: true;
    supports_generic_formula_mutation: false;
    statement: string;
  };
  modules: CiHandbookModule[];
  summary: {
    module_count: number;
    parameter_count: number;
    calculation_count: number;
    model_count: number;
    result_row_count: number;
  };
}

export const ciCalculationHandbookRootQueryKey = ["ci-calculation-handbook"] as const;

export const ciCalculationHandbookQueryKey = (projectId: string) =>
  [...ciCalculationHandbookRootQueryKey, projectId] as const;

export function invalidateCiCalculationHandbook(queryClient: QueryClient, projectId: string) {
  return queryClient.invalidateQueries({
    exact: true,
    queryKey: ciCalculationHandbookQueryKey(projectId),
  });
}

export function invalidateAllCiCalculationHandbooks(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ciCalculationHandbookRootQueryKey });
}

export async function fetchCiCalculationHandbook(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CiCalculationHandbook> {
  const response = await fetcher(
    `/api/commercial-industrial/projects/${encodeURIComponent(projectId)}/calculation-handbook`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null;
    throw new Error(payload?.detail?.message ?? `Handbook could not be loaded (${response.status}).`);
  }
  return assertCiCalculationHandbook(await response.json(), projectId);
}

export function assertCiCalculationHandbook(value: unknown, projectId: string): CiCalculationHandbook {
  const payload = value as CiCalculationHandbook;
  const moduleIds = payload?.modules?.map((module) => module.module_id) ?? [];
  const parameters = payload?.modules?.flatMap((module) => module.parameters ?? []) ?? [];
  const calculations = payload?.modules?.flatMap((module) => module.calculations ?? []) ?? [];
  const models = payload?.modules?.flatMap((module) => module.models ?? []) ?? [];
  const resultRows = payload?.modules?.flatMap((module) => module.result_sets?.flatMap((set) => set.rows ?? []) ?? []) ?? [];
  if (
    payload?.contract_version !== "ci_project_handbook_v1" ||
    payload.project?.project_id !== projectId ||
    !safeText(payload.project?.display_name) ||
    !safeDate(payload.project?.snapshot_at) ||
    payload.authority?.calculation_authority !== "python" ||
    payload.authority?.presentation_authority !== "handbook_projection_only" ||
    payload.authority?.mutation_policy !== "controlled_existing_module_inputs" ||
    !safeText(payload.authority?.statement) ||
    payload.parameter_management?.mode !== "edit_at_source" ||
    payload.parameter_management?.stable_parameter_ids !== true ||
    payload.parameter_management?.supports_generic_formula_mutation !== false ||
    !safeText(payload.parameter_management?.statement) ||
    !Array.isArray(payload.modules) ||
    payload.modules.length !== 4 ||
    new Set(moduleIds).size !== 4 ||
    !["evidence", "solution_generator", "scenario_analysis", "finance_analysis"].every((id) => moduleIds.includes(id as CiHandbookModule["module_id"])) ||
    payload.modules.some((module) => !validModule(module)) ||
    duplicate(parameters.map((item) => item.parameter_id)) ||
    duplicate(calculations.map((item) => item.calculation_id)) ||
    duplicate(models.map((item) => item.model_id)) ||
    !validCount(payload.summary?.module_count, payload.modules.length) ||
    !validCount(payload.summary?.parameter_count, parameters.length) ||
    !validCount(payload.summary?.calculation_count, calculations.length) ||
    !validCount(payload.summary?.model_count, models.length) ||
    !validCount(payload.summary?.result_row_count, resultRows.length)
  ) throw new Error("Handbook returned an unsafe or incomplete contract.");
  return payload;
}

function validModule(module: CiHandbookModule) {
  return safeText(module.label) && safeText(module.description) &&
    ["ready", "input_required", "not_saved", "stale"].includes(module.status) &&
    (module.saved_at === null || safeDate(module.saved_at)) &&
    Array.isArray(module.parameters) && module.parameters.every(validParameter) &&
    Array.isArray(module.calculations) && module.calculations.every(validCalculation) &&
    Array.isArray(module.models) && module.models.every(validModel) &&
    Array.isArray(module.result_sets) && module.result_sets.every(validResultSet) &&
    Array.isArray(module.boundaries) && module.boundaries.every(safeText);
}

function validParameter(value: CiHandbookParameter) {
  return safeId(value.parameter_id) && safeText(value.label) && safeValue(value.value) &&
    (value.unit === null || safeText(value.unit)) && safeText(value.source_kind) &&
    safeText(value.source_label) && safeText(value.source_path) &&
    typeof value.editable === "boolean" && typeof value.active_in_current_model === "boolean" &&
    (value.edit_stage === null || ["evidence", "physical_feasibility", "dispatch", "tariff_replay"].includes(value.edit_stage));
}

function validCalculation(value: CiHandbookCalculation) {
  return safeId(value.calculation_id) && safeText(value.label) && safeText(value.formula) &&
    safeText(value.description) && Array.isArray(value.inputs) && value.inputs.every(safeText) &&
    safeText(value.source_reference) && (value.current_example === null || (
      safeText(value.current_example.substitution) && safeValue(value.current_example.result) &&
      (value.current_example.unit === null || safeText(value.current_example.unit))
    ));
}

function validModel(value: CiHandbookModel) {
  return safeId(value.model_id) && safeText(value.label) && safeText(value.method) &&
    safeText(value.objective) && Array.isArray(value.constraints) && value.constraints.every(safeText) &&
    safeText(value.source_reference);
}

function validResultSet(value: CiHandbookResultSet) {
  const keys = value.columns?.map((column) => column.key) ?? [];
  const rowIds = value.rows?.map((row) => row.result_id) ?? [];
  return safeId(value.result_set_id) && safeText(value.label) && Array.isArray(value.columns) &&
    value.columns.length > 0 && !duplicate(keys) && value.columns.every((column) =>
      safeId(column.key) && safeText(column.label) && (column.unit === null || safeText(column.unit))) &&
    Array.isArray(value.rows) && !duplicate(rowIds) && value.rows.every((row) =>
      safeText(row.result_id) && safeText(row.label) && row.values && typeof row.values === "object" &&
      !Array.isArray(row.values) && Object.keys(row.values).every((key) => keys.includes(key)) &&
      Object.values(row.values).every(safeValue));
}

function safeValue(value: unknown): value is CiHandbookValue {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(safeValue));
}

function safeId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value);
}

function safeText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_000;
}

function safeDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function duplicate(values: string[]) {
  return new Set(values).size !== values.length;
}

function validCount(value: unknown, expected: number) {
  return Number.isInteger(value) && value === expected;
}

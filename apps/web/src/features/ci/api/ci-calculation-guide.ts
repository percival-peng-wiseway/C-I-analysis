export interface GuideStep {
  title: string;
  formula: string;
  substitution: string;
  result: string;
  explanation: string;
  source_reference: string;
}
export interface CalculationGuide {
  contract_version: "ci_calculation_guide_v1";
  title: string;
  disclosure: string;
  example: { label: string; inputs: [string, string][] };
  chapters: { id: string; title: string; summary: string; steps: GuideStep[] }[];
  glossary: [string, string][];
}
export async function fetchCalculationGuide(): Promise<CalculationGuide> {
  const response = await fetch("/api/commercial-industrial/calculation-guide", { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("The calculation guide could not be loaded. Please retry.");
  return assertCalculationGuide(await response.json());
}
export function assertCalculationGuide(value: unknown): CalculationGuide {
  const data = value as CalculationGuide;
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const pairs = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(p => Array.isArray(p) && p.length === 2 && p.every(text));
  if (data?.contract_version !== "ci_calculation_guide_v1" || !text(data.title) || !text(data.disclosure) ||
      !text(data.example?.label) || !pairs(data.example?.inputs) || !pairs(data.glossary) ||
      !Array.isArray(data.chapters) || data.chapters.length !== 5 ||
      new Set(data.chapters.map(c => c?.id)).size !== 5 ||
      data.chapters.some(c => !c || !["evidence", "solution_generator", "scenario_analysis", "finance_analysis", "stc"].includes(c.id) ||
        !text(c.title) || !text(c.summary) || !Array.isArray(c.steps) || !c.steps.length || c.steps.some(s => !s ||
          ![s.title, s.formula, s.substitution, s.result, s.explanation, s.source_reference].every(text)))) {
    throw new Error("The calculation guide returned incomplete content.");
  }
  return data;
}

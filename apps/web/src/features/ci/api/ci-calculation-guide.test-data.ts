import type { CalculationGuide } from "./ci-calculation-guide";

export function guideFixture(): CalculationGuide {
  return {
    contract_version: "ci_calculation_guide_v1", title: "How this system calculates",
    disclosure: "Synthetic teaching example only. Not a customer quotation.",
    example: { label: "Example solution · 200 kWp PV + 210 kWh battery + 125 kW PCS", inputs: [["PV capacity", "200 kWp DC"]] },
    chapters: ["evidence", "solution_generator", "scenario_analysis", "finance_analysis", "stc"].map((id, i) => ({
      id, title: `${i + 1}. ${id} · Explanation`, summary: "Read-only teaching content.",
      steps: [{ title: id === "stc" ? "Battery STC worksheet" : "Energy is not power", formula: id === "stc" ? "STC count × price" : "kWh / hours",
        substitution: id === "stc" ? "174 × $39" : "50 / 0.25", result: id === "stc" ? "$6,786.00 worksheet estimate" : "200 kW average demand",
        explanation: "Not a saved project result.", source_reference: "solar_battery/ci_stc_calculator.py" }],
    })),
    glossary: [["kWh", "Energy"]],
  };
}

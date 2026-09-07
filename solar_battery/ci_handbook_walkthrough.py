"""Small, Python-owned numerical explanations of one saved solution at a time.

This is a read-only projection, not a dispatch or finance recalculation. Derived
equipment arithmetic is labelled separately from authoritative saved outputs.
"""
from math import isfinite


def solution_walkthroughs(modules, *, price_ready, replay_ready):
    by_module = {m["module_id"]: m for m in modules}
    sets = {s["result_set_id"]: s for m in modules for s in m["result_sets"]}
    parameters = {p["parameter_id"]: p["value"] for m in modules for p in m["parameters"]}

    def values(set_id, scenario_id):
        return next((r["values"] for r in sets.get(set_id, {}).get("rows", [])
                     if r["result_id"] == scenario_id), {})

    def number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)

    def fmt(value):
        return f"{value:,.6f}".rstrip("0").rstrip(".") if number(value) else "not saved"

    result = []
    for candidate in sets.get("solution.solutions", {}).get("rows", []):
        scenario_id = candidate["result_id"]
        c = candidate["values"]
        steps = []

        def add(key, title, formula, operands, operation, unit, explanation, missing="Required saved inputs are missing."):
            available = all(number(x) for x in operands)
            example = operation(*operands) if available else None
            if example is not None and not number(example[1]):
                example = None
            steps.append({"calculation_id": key, "label": title, "formula": formula,
                          "description": explanation if example else missing,
                          "inputs": [], "source_reference": "Python saved solution projection",
                          "current_example": {"substitution": example[0], "result": example[1], "unit": unit} if example else None})

        add("pv.yield", "Effective solar yield", "Effective yield = authored yield × derating",
            [c.get("specific_yield"), c.get("derating")],
            lambda y, d: (f"{fmt(y)} × {fmt(d)}", y * d), "kWh/kWp/year",
            "Uses this generated solution's saved yield and loss factor, not today's location settings.")
        add("pv.annual", "Annual PV energy before clipping", "PV energy = PV capacity × authored yield × derating",
            [c.get("pv_capacity"), c.get("specific_yield"), c.get("derating")],
            lambda p, y, d: (f"{fmt(p)} × {fmt(y)} × {fmt(d)}", p * y * d), "kWh/year",
            "Design-year energy before inverter/connection clipping. This is not the delivered replay total or a bill saving.")
        add("battery.usable", "Battery operating energy", "Operating energy = nominal capacity × (maximum SOC − minimum SOC)",
            [c.get("battery_capacity"), c.get("soc_max"), c.get("soc_min")],
            lambda cap, hi, lo: (f"{fmt(cap)} × ({fmt(hi)} − {fmt(lo)})", cap * (hi - lo)), "kWh",
            "Energy between the saved SOC limits, before discharge losses.")
        add("battery.duration", "Full-power discharge duration", "Duration = operating energy × discharge efficiency ÷ discharge power",
            [c.get("battery_capacity"), c.get("soc_max"), c.get("soc_min"), c.get("discharge_efficiency"), c.get("battery_power")],
            lambda cap, hi, lo, eta, p: (f"{fmt(cap)} × ({fmt(hi)} − {fmt(lo)}) × {fmt(eta)} ÷ {fmt(p)}", cap * (hi - lo) * eta / p) if p > 0 else None,
            "hours", "Upper-bound duration from maximum to minimum SOC at the discharge limit, with no charging. Dispatch can be further constrained by the AC port and reactive support.")
        add("battery.rte", "Effective round-trip efficiency", "RTE = charge efficiency × discharge efficiency × 100",
            [c.get("charge_efficiency"), c.get("discharge_efficiency")],
            lambda a, b: (f"{fmt(a)} × {fmt(b)} × 100", a * b * 100), "%",
            "These saved one-way efficiencies already include the selected RTE basis. Do not apply conversion losses again.")
        costs = [c.get(k) for k in ("pv_capex", "battery_capex", "inverter_capex", "installation_misc", "gross_capex")]
        add("investment", "Equipment and installation investment", "CAPEX = PV + battery + inverter + installation & miscellaneous",
            costs if price_ready else [None],
            lambda pv, bat, inv, inst, total: (f"{fmt(pv)} + {fmt(bat)} + {fmt(inv)} + {fmt(inst)}", total), "AUD ex GST",
            "Saved model-price preview, including installation once. STC is not deducted. Finance may instead use a saved final manual quote.",
            "Current equipment-price preview is unavailable. Refresh solution pricing to show this substitution.")

        replay = values("scenario.tariff_replay", scenario_id) if replay_ready else {}
        add("bill.saving", "Annual electricity-bill saving", "Annual saving = baseline annual bill − solution annual bill",
            [replay.get("baseline_cost"), replay.get("annual_cost"), replay.get("first_year_value")],
            lambda before, after, saving: (f"{fmt(before)} − {fmt(after)}", saving), "AUD ex GST/year",
            "Stored approved-tariff replay for this solution. Not the optimizer objective, which also includes a discharge shadow cost.",
            "A current approved-tariff replay for this solution is required. Current results are withheld; run Analysis first.")
        finance_ready = by_module["finance_analysis"]["status"] == "ready" and replay_ready
        f = values("finance.solutions", scenario_id) if finance_ready else {}
        om_rate = parameters.get("finance.assumption.annual_om_fraction_of_capex")
        add("finance.om", "Annual operating cost", "Annual O&M = finance gross upfront × O&M fraction",
            [f.get("gross_upfront"), om_rate, f.get("annual_om")],
            lambda cap, rate, om: (f"{fmt(cap)} × {fmt(rate)}", om), "AUD/year",
            "Saved finance investment basis, which may be a manual quote including installation.",
            "Current finance results are withheld. Complete tariff replay and Finance Analysis for this solution.")
        cashflows = f.get("annual_cashflows")
        cashflows = cashflows if isinstance(cashflows, list) and cashflows and all(number(x) for x in cashflows) else []
        add("finance.year1", "Year-one net cashflow", "Year-one cashflow = annual bill saving − annual O&M",
            [f.get("first_year_value"), f.get("annual_om"), cashflows[0] if cashflows else None],
            lambda saving, om, cf: (f"{fmt(saving)} − {fmt(om)}", cf), "AUD",
            "The current comparison has no replacement events. Escalation and degradation start after year one.",
            "A current saved finance cashflow is required.")
        discount = parameters.get("finance.assumption.discount_rate")
        add("finance.npv", "Net present value (NPV)", "NPV = −initial investment + Σ cashflow[t] / (1 + discount rate)^t",
            [f.get("net_capex"), discount, f.get("npv")] if cashflows else [None],
            lambda cap, rate, npv: (f"−{fmt(cap)} + " + " + ".join(f"{fmt(cf)} / (1 + {fmt(rate)})^{i}" for i, cf in enumerate(cashflows, 1)), npv), "AUD",
            "Every term uses this solution's saved annual cashflow. The result is the saved Python NPV, not a browser recalculation.",
            "Current finance investment, cashflows, discount rate and NPV are required.")
        result.append({"scenario_id": scenario_id, "steps": steps})
    return result

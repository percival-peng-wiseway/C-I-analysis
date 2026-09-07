"""Versioned teaching material, not project evidence or a calculation endpoint.

The numeric example is synthetic and fixed. Regression tests verify its arithmetic
against Python's production helpers; reading it never runs a project simulation.
"""
from copy import deepcopy


def _step(title, formula, substitution, result, explanation, source):
    return dict(title=title, formula=formula, substitution=substitution,
                result=result, explanation=explanation, source_reference=source)


_GUIDE = {
    "contract_version": "ci_calculation_guide_v1",
    "title": "How this system calculates",
    "disclosure": "Synthetic teaching example only. Not this customer's solution, approved tariff, forecast or quotation. Saved solution results are available separately in Project ledger. Opening Handbook does not generate solutions or run dispatch/finance.",
    "example": {
        "label": "Example solution · 200 kWp PV + 210 kWh battery + 125 kW PCS",
        "inputs": [
            ["PV capacity", "200 kWp DC"], ["Battery capacity / profile power", "210 kWh / 100 kW"],
            ["DC/AC ratio / site headroom", "1.6 / 350 kW"],
            ["Authored annual yield / derating", "1,500 kWh/kWp/year / 90%"],
            ["Battery RTE basis", "Whole-system AC, 90.25% (one-way 95%)"],
            ["SOC limits", "10% to 100% of nominal capacity; initial SOC 100%"],
            ["Finance", "10 years, 8% discount, 1% O&M, 0% escalation/degradation"],
            ["Tax and incentives", "AUD ex GST; STC excluded from investment and cashflow"],
        ],
    },
    "chapters": [
        {
            "id": "evidence", "title": "1. Evidence · establish the measured baseline",
            "summary": "Bill extraction describes what was invoiced. NEM12 describes when energy flowed. Neither an address nor a detected tariff code proves a complete approved tariff.",
            "steps": [
                _step("Energy is not power", "P (kW) = interval energy (kWh) / interval hours",
                      "50 kWh / (15 / 60 hours)", "200 kW average demand",
                      "Sum source interval energy when aggregating to 15 minutes; do not sum kW. E1 is active import, B1 active export, Q1/K1 reactive streams. Preserve the saved time basis and align streams before apparent-demand analysis.",
                      "solar_battery/ci_evidence_intake.py; solar_battery/ci_design_feasibility.py"),
                _step("Apparent demand", "S (kVA) = sqrt(P² + Q²); PF = P / S",
                      "sqrt(200² + 60²)", "208.81 kVA; power factor 0.958",
                      "Here 60 kvar is a synthetic aligned reactive-demand reading. A kVA demand tariff charges apparent demand, not just kW; a kW reduction does not imply the same kVA reduction.",
                      "solar_battery/ci_scenario_analysis.py"),
                _step("Invoice-period reconciliation", "difference % = 100 × (interval import − billed import) / billed import",
                      "100 × (80,000 − 80,000) / 80,000", "0% difference",
                      "Only compare the invoice's own start/end dates, not the annual reference window. The internal tolerance is 2%; agreement validates quantities, not contractual tariff rules.",
                      "solar_battery/ci_evidence_intake.py::_bill_period_import_reconciliation"),
                _step("Indicative annual bill, not tariff replay", "energy-like category × annual import / billed import; daily-recurring category × 365 / invoice days",
                      "Energy: $8,000 × 1,000,000 / 80,000; metering: $93 × 365 / 31",
                      "$100,000 energy category; $1,095 metering category",
                      "Use the latest complete 365-day import window. Current invoice annualisation scales energy, regulated and environmental totals by kWh; metering and network totals by days. This is a screening assumption, not reconstructed demand charges. Unverified recurring adjustments are excluded. Finance uses approved tariff replay instead.",
                      "solar_battery/ci_evidence_intake.py"),
            ],
        },
        {
            "id": "solution_generator", "title": "2. Solution Generator · size equipment and PV output",
            "summary": "Combine chosen PV and battery targets with saved hardware profiles and site assumptions. Generation saves a snapshot; later edits do not silently overwrite existing solutions.",
            "steps": [
                _step("Address, PVGIS and fallback", "effective yield = authored specific yield × availability × product(1 − site loss)",
                      "1,500 × 1.00 × (1 − 0.10)", "1,350 kWh/kWp/year",
                      "Bill address → Geoapify coordinates → PVGIS annual/monthly resource. Without a successful result, the fallback is 1,000, not a measured value. Apply PVGIS to replace 1,000, never multiply by it. Refresh & apply PVGIS after tilt/azimuth changes, then regenerate. Do not deduct losses already included in the resource response twice. This example uses an authored gross yield and one synthetic 10% loss.",
                      "solar_battery/ci_solar_resource.py; solar_battery/ci_solution_generator.py::_effective_derating"),
                _step("Annual PV energy and interval timing", "PV annual energy = PV kWp × effective yield; interval energy = normalized shape × annual energy",
                      "200 × 1,350", "270,000 kWh/year before dispatch clipping",
                      "PVGIS annual/monthly resource is not a measured 15-minute generation series. Legacy timing uses a generic daylight shape; geometry timing uses confirmed coordinates, tilt and azimuth. The selected timing model allocates energy over time. Inverter clipping, shared-port limits and curtailment can reduce delivered output.",
                      "solar_battery/ci_pv_timing.py; solar_battery/ci_design_feasibility.py::_scenario_energy_series"),
                _step("Candidate matrix", "range count = floor((maximum − minimum) / step) + 1; combinations = PV count × battery count",
                      "PV 180, 200, 220 kWp × battery 126, 168, 210 kWh", "9 requested combinations before feasibility checks",
                      "This guide follows only the 200 kWp / 210 kWh combination. Size targets are continuous, not automatically rounded to purchase quantities.",
                      "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
                _step("Battery power and duration", "battery kW = target kWh × profile kW / profile kWh; nominal duration = kWh / kW",
                      "210 × 100 / 210 = 100; 210 / 100 = 2.1", "100 kW; 2.1 hours nominal duration",
                      "Duration is not a guarantee of discharge at that power. SOC limits, efficiency and shared inverter limits reduce deliverable energy/power. Here the 10–100% SOC operating band stores 189 kWh of usable swing.",
                      "solar_battery/ci_solution_generator.py::_screening_battery_power"),
                _step("PCS sizing and connection gate", "PCS requirement = max(PV kWp / DC:AC ratio, battery kW) ≤ site AC headroom",
                      "max(200 / 1.6, 100) = 125 ≤ 350", "125 kW PCS passes the connection gate",
                      "With multiple batteries in one PV row, the generator uses the maximum requirement of the headroom-feasible batteries in that row. The largest battery in this example is 210 kWh / 100 kW, so every 200 kWp-row option receives 125 kW PCS. P² + Q² capability also limits simultaneous active/reactive support.",
                      "solar_battery/ci_solution_generator.py::generate_ci_solutions"),
            ],
        },
        {
            "id": "scenario_analysis", "title": "3. Scenario Analysis · follow energy interval by interval",
            "summary": "Technical screening asks how much peak could be shaved. Tariff-aware dispatch asks which feasible schedule improves the approved bill. These are different results; Finance consumes the saved tariff-aware result.",
            "steps": [
                _step("PV-only and PV + battery", "PV-to-load = min(load, PV); post-import = load − PV-to-load − discharge + grid charging",
                      "Load 200 kW, PV 80 kW: PV-only = 120 kW; battery discharge 40 kW: post-import = 80 kW",
                      "200 → 120 → 80 kW in this illustrative interval",
                      "The 15-minute energies are 50, 20 and 10 kWh. The PV-only curve can overlap the PV + battery curve when the battery is idle; overlap does not mean PV starts generating later. If reactive demand stays at 60 kvar, post-system demand is sqrt(80² + 60²) = 100 kVA.",
                      "solar_battery/ci_design_feasibility.py::_scenario_energy_series; solar_battery/ci_scenario_analysis.py"),
                _step("Charging and discharging SOC", "SOC_next = SOC + charge kW × hours × η_charge − discharge kW × hours / η_discharge",
                      "η = sqrt(0.9025) = 0.95; discharge: 100 − 40 × 0.25 / 0.95; separate charge interval: 100 + 20 × 0.25 × 0.95",
                      "89.4737 kWh after discharge; 104.75 kWh after the separate charging example",
                      "For 210 kWh at 10–100%, enforce 21 ≤ SOC ≤ 210 kWh. These are separate mid-day examples starting at 100 kWh, not the annual initial SOC. Generated scenarios start full; annual tariff replay also enforces its terminal SOC basis. Pack-plus-conversion uses sqrt(pack RTE) × conversion efficiency; whole-system AC must not multiply losses again. Charging consumes energy and must obey saved permissions.",
                      "solar_battery/ci_peak_shaving_optimizer.py::_build_model; solar_battery/ci_solution_generator.py"),
                _step("Why a peak may remain", "min energy cost + priced demand cost + 0.05 AUD/kWh × battery discharge",
                      "40 kW × 0.25 h × $0.05", "$0.50 discharge shadow cost in this interval",
                      "This optimization penalty is not an extra Finance cash expense. A peak may remain because SOC is low, battery/PCS power is limited, energy is reserved for later, or the peak has no priced tariff benefit. Zero-rate demand is not an economic shaving objective. Current export credit is zero; reactive support matters financially only under a priced kVA demand component.",
                      "solar_battery/ci_peak_shaving_optimizer.py"),
                _step("Saved dispatch, not a chart-derived saving", "annual value = approved baseline replay − matching optimized scenario replay",
                      "Scenario ID + interval/design/tariff hashes + calculation revision must match", "Reuse only current validated results",
                      "The rolling optimizer uses a 48-hour planning horizon with a 24-hour commit horizon, followed by exact tariff/kVA checks. Charts display saved results; a single peak day is not enough to establish annual savings. Stale or missing approved inputs must block customer-dollar conclusions.",
                      "solar_battery/ci_project_tariff_replay.py; solar_battery/ci_peak_shaving_optimizer.py"),
            ],
        },
        {
            "id": "finance_analysis", "title": "4. Finance Analysis · convert a saved replay into cashflow",
            "summary": "Reprice the baseline and the same scenario with approved tariffs, then apply the selected investment and financial assumptions. Do not substitute Evidence's scaled bill estimate for tariff-derived savings.",
            "steps": [
                _step("Tariff charge lines", "retail = kWh × cents/kWh / 100 × MLF × DLF; network energy = kWh × network rate / 100",
                      "1,000 kWh × 20 c/kWh / 100 × 1.00 × 1.05", "$210 retail energy charge",
                      "Use the applicable saved local-time windows. Regulated/environmental lines have their own DLF/fraction rules; fixed charges use inclusive days. Demand uses approved kW/kVA windows, ratchets/minima and monthly quantities, not a generic unit energy rate. Line amounts are rounded to cents before totals.",
                      "solar_battery/ci_tariff_analysis.py::calculate_ci_tariff_charges"),
                _step("Demand and representative-year savings", "rolling quantity = max(window peak kVA, minimum kVA) × 12; incentive quantity = sum(eligible monthly maxima)",
                      "200 kVA × 12 × $10/kVA/month", "$24,000 illustrative rolling demand charge",
                      "This demand example is separate from the simplified flat-rate cashflow example below. It illustrates why shaving the wrong time window, or below a minimum, may not reduce billed demand. Current annual replay excludes bill-only adjustments and has zero export credit.",
                      "solar_battery/ci_scenario_analysis.py::_annual_tariff_quantities"),
                _step("Gross investment, including Plan A", "CAPEX = PV cost + battery curve cost + inverter cost + installation/miscellaneous",
                      "200 × $530 + $77,578 + $10,000 + $70,000", "$263,578 ex GST",
                      "This synthetic price snapshot uses a 210 kWh battery curve point and one 125 kW PCS. Battery curve cost is proportional below the first point, interpolated between points and extrapolated above the last. Installation is added once per solution, not once per component. Manual final quotations already include installation, so it is not added again. STC is not deducted.",
                      "solar_battery/ci_annual_financial_comparison.py::_profile_capex_breakdown"),
                _step("Annual savings and O&M", "value_1 = baseline bill − post-dispatch bill; O&M = investment × annual O&M fraction",
                      "Assumed flat-rate teaching totals: 1,000,000 × $0.20 − 750,000 × $0.20 = $50,000; $263,578 × 1% = $2,635.78",
                      "$47,364.22 year-one net cashflow",
                      "The 750,000 kWh post-import is a stipulated teaching input, NOT an optimizer result inferred from 270,000 kWh PV. Both quantities and the flat $0.20 tariff are fictional. Real Finance must obtain baseline/post totals from the matching approved saved replay, including demand and all other charge lines.",
                      "solar_battery/ci_annual_financial_comparison.py::_financial_solution"),
                _step("NPV, payback and IRR", "CF_y = value_1 × (1+escalation)^(y−1) × (1−degradation)^(y−1) − O&M − replacements_y; NPV = −CAPEX + Σ CF_y/(1+r)^y",
                      "−263,578 + Σ(years 1..10) 47,364.22 / 1.08^year",
                      "NPV $54,239.77; simple payback 5.565 years; IRR 12.3733%",
                      "These are Python-verified results for the synthetic assumptions, not a recommendation. NPV discounts future money; payback uses undiscounted cumulative cashflow and interpolates the crossing year. IRR solves NPV=0 and can be undefined. Future years project one representative dispatch year's value; the current workflow does not re-optimize ageing hardware each year. Current comparison provides no replacement events.",
                      "solar_battery/ci_financial_solutions.py::calculate_metrics"),
            ],
        },
        {
            "id": "stc", "title": "5. STC worksheet · separate arithmetic only",
            "summary": "This worksheet is not eligibility approval and is deliberately excluded from Solutions, Net CAPEX, annual cashflow, NPV and payback.",
            "steps": [
                _step("Solar STC worksheet", "(2030 − installation year + 1) × zone factor × entered PV kWp × price",
                      "Year 2025, Zone 4, 200 kWp, $39: 6 × 1.185 × 200 × 39", "$55,458.00 worksheet estimate",
                      "Zone 3 is 1.382; Zone 4 is 1.185. These are manual worksheet operands; the worksheet does not apply certificate-flooring or eligibility caps. Do not treat a 200 kWp illustration as proof of entitlement.",
                      "solar_battery/ci_stc_calculator.py::calculate_stc_estimate"),
                _step("Battery STC worksheet", "entered STC count × price per certificate",
                      "174 × $39", "$6,786.00 worksheet estimate",
                      "No installation-period coefficient, battery capacity multiplier or tiering is applied. The certificate count is supplied by the analyst. Solar + battery worksheet total here is $62,244.00, but Finance deduction remains $0.",
                      "solar_battery/ci_stc_calculator.py::calculate_stc_estimate"),
            ],
        },
    ],
    "glossary": [
        ["kW / kWp", "Instantaneous/interval-average active power / PV nameplate DC capacity."],
        ["kWh", "Energy. kW × hours = kWh."],
        ["kvar / kVA", "Reactive power / apparent power; kVA = sqrt(kW² + kvar²)."],
        ["kWh/kWp/year", "Annual specific PV yield, not a capacity or a tariff."],
        ["SOC / RTE", "Stored energy or its capacity percentage / round-trip efficiency."],
        ["MLF / DLF", "Loss factors applied only to the charge lines specified by the tariff model."],
        ["CAPEX / O&M", "Upfront investment / annual operating and maintenance cost."],
        ["NPV / IRR", "Discounted net value / discount rate at which NPV is zero."],
    ],
}


def calculation_guide():
    return deepcopy(_GUIDE)

# C&I reference-model validation

## Purpose and current status

Cross-model agreement is not real-world accuracy. No claim of "80% Orkestra
accuracy" has been established. The inspected reference configuration differed
in capacities, input series, interval resolution, efficiency, control and
financial assumptions. Existing customer configurations were not changed and
no paid Orkestra simulation was started.

The first engineering target is **at most 20% relative difference in annual
savings, NPV and payback on reviewed, identical-input cases**, with tighter
baseline and physical checks. This is a proposed acceptance policy, not an
industry standard or a guarantee from Orkestra.

## What the official reference documents establish

- Orkestra describes a MILP cost-to-serve optimiser with configurable value
  streams, operational limits and perfect foresight inside time chunks. Its
  arbitrage hurdle is in AUD/MWh, split across charge and discharge. This is
  not equivalent to our fixed discharge-only AUD 0.05/kWh shadow cost.
  [Dispatch documentation](https://app.orkestra.energy/app/docs/how-orkestra-performs-solar-and-battery-dispatch).
- Quick mode repeats first-year simulation data; Precision simulates the
  full analysis period, including physical degradation and changing rates.
  [Mode documentation](https://app.orkestra.energy/app/docs/quick-and-precision-analysis-modes).
- Its documented baseline reactive load comes from one site power factor;
  solar and batteries change active power, not reactive power. That does not
  validate our active inverter reactive-support model.
  [Power-factor documentation](https://app.orkestra.energy/app/docs/power-factor-calculation-in-orkestra).

These observable/documented behaviours do not reveal the private solver source
or every heuristic. Do not describe our implementation as an Orkestra replica.

## Changes in this iteration

1. One-click finance now explicitly sends current saved financial assumptions,
   or configured workspace defaults if no current saved result exists. Missing
   inputs stop the run before dispatch. Changing workspace defaults does not
   silently overwrite saved project assumptions.
2. Finance Intervals now defaults to the saved tariff-aware dispatch. It shows
   kW/kVA, battery charge/discharge and stored energy from the same Python
   projection; pre-tariff screening is secondary. Viewing does not calculate.
3. Removed an unused project-name-triggered hardcoded financial report. Missing
   persisted results now remain missing rather than showing a canned report.
4. Handbook now distinguishes the economically material throughput shadow cost
   from the secondary tie-break, describes active efficiency conventions, and
   records physical-model limits.

## Remaining fidelity priorities

| Priority | Gap | Required validation before changing mathematics |
| --- | --- | --- |
| 1 | Legacy PV timing is generic; opt-in coordinate/orientation geometry is still only screening | Approved measured or weather-derived interval PV, source provenance, time-zone and resolution alignment |
| 1 | Explicit separate-AC and shared-hybrid modes now have independent port tests | Confirm actual project topology and inverter sizing before regeneration; hardware labels do not select a topology |
| 1 | Explicit pack-only or whole-system AC RTE now avoids double conversion | Confirm supplier efficiency measurement boundary before selecting a basis |
| 2 | Representative-year financial extrapolation is not future-year physical simulation | Annual ageing/replacement and tariff forecasts, independently validated cashflows |
| 2 | Perfect foresight can overstate operational value | Forecast-error/backtest cases and an explicit, separately disclosed realisation policy |
| 2 | Fixed discharge shadow cost rather than configurable control strategy | Explicit objective controls, units and provenance; no unexplained coefficients fitted to a desired answer |

Legacy/pack-plus-conversion mode calculates effective RTE as pack_RTE times
conversion_efficiency squared. A 95% pack RTE and 95% one-way conversion means
85.7375% effective RTE; whole-system AC mode uses the supplied RTE directly.
Inverter European efficiency, standby loss and battery
ageing must not be claimed as active simply because stored profile fields exist.

The optional `solar_geometry_screening_v1` uses confirmed coordinates and
orientation with [NOAA solar geometry](https://gml.noaa.gov/grad/solcalc/solareqns.PDF).
It samples interval midpoints and normalises over each full calendar year
(including leap years). The authored annual yield is conserved; tilt changes
timing, not that yield. It is not a meteorological production forecast.

Finance now records per-year escalation, aggregate value retention, savings,
O&M, replacements, net/discounted/cumulative cashflows. This is explicitly
representative-year projection, not annual battery-ageing redispatch. Ambiguous
IRR cashflows are not presented as a single definite investment return.

Separate-AC automatic CAPEX prices the PV inverter and battery PCS separately
using the saved inverter cost curve as an explicitly disclosed screening proxy.
Manual net quotes remain authoritative and are not changed by that proxy.

Do not weaken evidence checks or solver validation to obtain similar numbers.
Do not automatically change customer parameters to match a reference example.

## Offline Python comparison

Run with Python 3.12+:

```powershell
.venv/Scripts/python.exe -m solar_battery.ci_reference_benchmark .local/reference.json .local/candidate.json
```

The CLI only reads those local JSON files and prints a report. Exit code 0 means
all targets were met for that case; 2 means outside targets, not comparable, or
invalid input. It does not contact Orkestra or mutate project results. Keep all
customer exports and normalised case files in ignored `.local/` or `.tmp/`.

Each input has `contract_version: "ci_reference_benchmark_v1"`,
`basis_reviewed: true`, `basis: {...}` and `metrics: {...}`. The review flag is an
analyst attestation, not an automated certification. The full required basis
list is `REQUIRED_BASIS` in `solar_battery/ci_reference_benchmark.py`; all fields
must be known and identical, including any additional supplied fields.

Normalisation rules:

- Use SHA-256 of the same canonical, aligned active-load, PV and reactive
  series, and the same canonical tariff (rates, windows, lookback, floors,
  loss factors and export credits). Independently verify their contents; never
  copy hashes solely to make a test pass. Do not use raw-file hashes for
  different exports of equivalent series.
- Use kW, kWh, kvar and kVA consistently; money is AUD ex GST; fractional
  efficiencies/rates use 0-1. Start/end dates, time zone and interval minutes
  must match. Specify whether load is gross site load or net measured import.
- Explicitly state topology, initial/terminal SOC, dispatch horizon, wear/hurdle
  cost convention, reactive control and demand-savings realisation policy.
  Unimplemented/unknown reference settings prevent a like-for-like test.
- Declare nominal/real pricing, discount/escalation/degradation definitions,
  O&M, net capital and rebate basis. `replacement_schedule: []` means explicitly
  no replacements; `null` means unknown. Use the string `"unlimited"` for
  reviewed unbounded import/export limits, never `null` or infinity.
- Numeric basis fields must be finite numbers, not numeric strings or booleans.
  Capacities, limits, O&M and capital costs are non-negative; efficiencies are
  greater than zero and at most one. Other fractions are between zero and one.
  Interval minutes and analysis years are positive integers; interval minutes
  cannot exceed one day. Dates use `YYYY-MM-DD`, and end cannot precede start.
  Usable battery capacity cannot exceed nominal capacity. Use `currency: "AUD"`
  and `tax_basis: "ex_GST"`. Other descriptive policy fields are nonempty known
  strings; an equal label alone does not establish implementation equivalence.
  Nonempty replacement schedules contain objects with positive integer `year`
  within the analysis term and non-negative `cost_aud`. Empty lists are not
  accepted as known values for other assumptions.
- Metrics must be finite numbers. `payback_years: null` means no cost recovery
  during the matched term; omission is not the same thing. Annual savings is
  baseline minus post-dispatch bill before O&M, not an ambiguously named
  external "earnings" field. NPV must use identical cashflow conventions.
  Each case must internally reconcile annual savings with baseline minus
  post-dispatch bill (at most AUD 0.02 rounding difference), and metric Net CAPEX
  with the declared basis (at most AUD 0.01). A numeric payback cannot exceed the
  analysis term; use `null` when there is no recovery within that term.

| Metric key | Relative target | Near-zero absolute tolerance |
| --- | --- | --- |
| `baseline_bill_aud` | 2% | AUD 1 |
| `post_dispatch_bill_aud` | 5% | AUD 1 |
| `annual_savings_aud` | 20% | AUD 1 |
| `post_dispatch_peak_kva` | 10% | 0.1 kVA |
| `net_capex_aud` | 1% | AUD 1 |
| `npv_aud` | 20% | AUD 1 |
| `payback_years` | 20% | 0.1 year |

Allowed difference is `max(absolute_tolerance, abs(reference) * relative_target)`.
Near-zero references show no misleading relative percentage. Missing or
mismatched inputs produce `not_comparable`, even when all displayed numbers
coincide. `within_targets` means agreement on that one reviewed case only;
customer-facing and recommendation permissions remain false.

Before a product-wide claim, test several independently reviewed sites and
cases: PV-only; storage with/without grid charging; TOU and flat rates; kVA and
kW demand; demand floors; zero export; clipping; replacement/no replacement;
reactive off, plus independent measured-Q tests for reactive on. Report case
count, failures, exclusions and metric errors separately. Never average away a
failed baseline reconstruction or substitute a branded reference for measured
bills and physical validation.

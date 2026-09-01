# C&I invoice charge groups and annual bill estimates

## Product boundary

The evidence intake may present verified invoice category totals under three
headings: `Fixed`, `Other usage`, and `Energy (Import)`. A network tariff code
does not prove the customer's full retail contract. Derived daily or c/kWh
figures are review equivalents, not detected contractual rates.

Customer-dollar and demand-charge claims remain fail-closed unless explicit,
reviewed site evidence is present. Evidence intake may publish an internal,
evidence-limited annual estimate from the uploaded invoice and NEM12 only when
all of the following are true:

- the bill and interval source identify the same site;
- the bill represents a plausible complete 20–45 day billing cycle;
- a standard NEM12 E1 series contains every bill-period day;
- bill-period interval import reconciles to billed consumption within 2%;
- invoice arithmetic and bill review checks pass;
- the bill contains verified category totals, billing days and import kWh; and
- the interval source contains 365 consecutive complete days of active import.

The estimate is not a contractual tariff replay and remains ineligible for a
customer-facing recommendation. A formal tariff claim still requires an
approved, effective-dated tariff profile and interval replay.

## Bill-derived interval-scaled calculation

The Python intake selects the most recent complete rolling 365-day standard
NEM12 E1 period and returns its recorded import kWh as the annual quantity
reference. It then derives review-equivalent rates from the verified invoice:

- energy, regulated and environmental categories use the invoice amount divided
  by billed import kWh, then multiply that rate by the recorded annual NEM12 kWh;
- metering and aggregate network charges use the invoice amount divided by
  billing days, then multiply that daily equivalent by 365;
- additional charges, credits and adjustments retain their observed source
  amount but are excluded from the estimate unless recurrence is separately
  established; and
- the ex-GST estimate is the sum of the resulting category amounts.

The network category deliberately stays on an observed daily-equivalent basis
because a category total does not reveal the split between energy, rolling
demand, seasonal demand and other network components. The result is labelled
`bill_derived_interval_scaled_v1` and `evidence_limited`.

A formal result must additionally:

- replay each evidenced line item and reconcile the bill-period dollar result;
- match the correct current retail and network tariff versions and effective dates;
- classify each interval into evidenced time and demand windows;
- calculate monthly kW/kVA maxima, ratchets, minimums and seasonal rules; and
- apply DLF, MLF, GST, discounts or credits only when their treatment is evidenced.

## Better future methods

1. Complete NEM12 plus an approved, effective-dated tariff profile: classify
   every interval into the tariff's time windows and calculate energy, monthly
   kW/kVA demand, ratchets, fixed charges and evidenced factors. This is the
   authoritative target method.
2. Partial customer interval data: use a public regional profile only for shape
   and seasonality. Anchor its scale to the customer's own overlapping kWh:
   `scale = customer kWh in overlap / public-profile kWh in overlap`. Produce a
   range from multiple reference years. Demand dollars remain unavailable unless
   all required demand periods and rules are covered.
3. Public data only: show a clearly named regional or small-business benchmark,
   never a site annual bill.

## Official reference sources

- AER Energy Product Reference Data provides public small-customer plan data.
  It is not a source for negotiated large-C&I retail contracts:
  <https://www.aer.gov.au/energy-product-reference-data>
- AER annual network pricing proposals and approved schedules are the source for
  DNSP tariff components and effective dates:
  <https://www.aer.gov.au/industry/networks/pricing-proposals-tariff-variations>
- AEMO operational demand supplies regional/load-forecast-area aggregate shape,
  not customer scale:
  <https://www.aemo.com.au/energy-systems/electricity/national-electricity-market-nem/data-nem/operational-demand-data>
- AEMO NSLP/CLP data may support low-confidence time-of-use allocation for the
  applicable profile area, not C&I demand reconstruction:
  <https://www.aemo.com.au/energy-systems/electricity/national-electricity-market-nem/data-nem/metering-data/load-profiles>
- DNSP zone-substation data can support local seasonality and peak-timing context
  after an address-to-zone mapping is verified. It aggregates many customers and
  cannot set the site's consumption scale. Example:
  <https://www.ausgrid.com.au/about-us/about-ausgrid/research-data-sets/distribution-zone-substation-data>
- BOM observations may later support weather normalisation:
  <https://www.bom.gov.au/climate/data/>

## Future reference-data persistence

Raw official snapshots belong in private object storage, not Git. PostgreSQL
metadata should be immutable and include publisher, source URL, licence,
retrieval time, effective dates, geography/customer class, schema version and
SHA-256. Estimates must retain the exact snapshot/profile identifiers used so a
new release can mark an old result stale rather than silently rewriting it.

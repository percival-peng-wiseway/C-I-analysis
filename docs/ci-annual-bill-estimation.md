# C&I invoice charge groups and annual bill readiness

## Product boundary

The evidence intake may present verified invoice category totals under three
headings: `Fixed`, `Other usage`, and `Energy (Import)`. A network tariff code
does not prove the customer's full retail contract. Derived daily or c/kWh
figures are review equivalents, not detected contractual rates.

Customer-dollar and demand-charge claims remain fail-closed. Evidence intake
does not publish an annual amount from invoice-category extrapolation. It can
only establish annual-usage readiness when all of the following are true:

- the bill and interval source identify the same site;
- the interval source covers the bill period;
- invoice arithmetic and bill review checks pass;
- the bill contains verified category totals, billing days and import kWh; and
- the interval source contains 365 consecutive complete days of active import.

Even after those checks pass, the annual dollar result remains `unavailable`
until an approved, effective-dated tariff profile and interval replay pass.

## Version 1 readiness calculation

The Python intake selects the most recent complete rolling 365-day E1 or
reported-kW period and returns its recorded import kWh as the annual quantity
reference. It does not apply invoice-category rates or publish a dollar total.

The result uses `approved_tariff_replay_required` when the annual interval
quantity is ready. A formal result must additionally:

- reconcile bill-period E1 import to billed consumption;
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

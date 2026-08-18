# E3 C&I Analyzer architecture

## Current local runtime

```text
Browser :15173
    |
    | /api (Vite development proxy adds the loopback credential)
    v
FastAPI :18080
    |-- Python C&I calculation authority
    |-- SQLite .local/e3_ci_analyzer.sqlite3
    `-- private filesystem object store .local/object_store
```

The local runtime intentionally uses two processes and no containers. Vite
owns frontend hot reload; FastAPI owns every calculation, persisted result and
private file operation. SQLite is appropriate for one local analyst and keeps
the project portable.

## Persistence boundary

Only six application tables are migrated:

- `ci_projects`
- `ci_project_evidence`
- `ci_project_feasibility_results`
- `ci_pricing_catalog_versions`
- `ci_financial_solutions`
- `ci_internal_report_artifacts`

Uploaded bytes are stored outside the database. Database rows retain scoped
object keys, sizes and SHA-256 digests. A feasibility result is restored only
while its design and interval-evidence digests still match; otherwise it is
reported as stale.

## Calculation boundary

Python remains authoritative for parsing, interval normalization, physical
dispatch, scenario validation, optimizer execution, pricing projections and
report contracts. React validates response versions and presents results but
does not infer tariff windows, demand charges, savings, eligibility or
recommendations.

The neutral `solar_profile.py` module contains the migrated deterministic PV
shape used by C&I calculations. Residential calculation, UI, database and
migration modules are not included.

## Future hosted runtime

Keep the same logical separation:

```text
Static frontend hosting
    |
    | authenticated HTTPS API
    v
Python API / calculation service
    |-- managed PostgreSQL
    `-- private object storage
```

Do not embed the local bearer token in a public frontend bundle. A hosted
version needs real user identity, server-side authorization and private file
access controls before customer evidence is uploaded.

The frontend `pnpm frontend:build` output is static. The Python API uses
packages such as HiGHS and PDF rendering that must be validated against the
selected hosted runtime separately. Cloud deployment is intentionally not
enabled by this local migration.

## Scale triggers

Retain SQLite and synchronous API execution while there is one local analyst.
Move to PostgreSQL when multiple writers, hosted durability or managed backups
are required. Add a durable job queue/worker when long analyses need retry,
progress reporting or concurrent execution. These are scale decisions, not
requirements for the current local product.

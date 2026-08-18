# Repository instructions

- This repository is the standalone E3 C&I Analyzer. Do not add Residential
  UI, routes, migrations or project models.
- Keep Python authoritative for calculation, tariff, dispatch, finance and
  persisted-result meaning.
- Never commit customer PDFs, NEM12/interval files, tariff evidence, generated
  customer artifacts, `.local/` data, secrets or identifiers.
- C&I customer-dollar, demand-charge and recommendation claims must fail
  closed unless explicit approved evidence is present.
- Use Python 3.12 or newer. Run `./scripts/test.sh` and
  `pnpm frontend:build` for executable changes.
- Local development defaults to SQLite and the filesystem object store. Keep
  the persistence interfaces compatible with a future PostgreSQL and private
  object-storage deployment.

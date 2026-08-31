# E3 C&I Analyzer

Standalone local workspace for commercial and industrial solar, battery and
inverter feasibility analysis.

The project contains only the C&I product surface and its calculation
dependencies. It does not include the Residential cockpit, Residential
migrations, Docker services, customer source files or data copied from the
original repository.

## Included workflow

- Project overview and project-scoped persistence
- Electricity-bill PDF and NEM12/interval-data intake
- Input checks, bill breakdown and annual demand heatmaps
- Solar PV, inverter and battery design ranges
- Physical feasibility and interval-activity visualisation
- Saved feasibility results that survive navigation and restart
- Annual financial scenario workspace, pricing catalog and internal reports

Customer-facing recommendations and claims remain disabled. Tariff analysis
continues to fail closed when its required local evidence profile is absent or
does not match the uploaded evidence.

## Local requirements

- macOS or Linux
- Python 3.12 or newer
- Node.js with `pnpm` or `corepack`

Docker and PostgreSQL are not required for local use. The default database is
SQLite and all runtime data is stored under the ignored `.local/` directory.

## First start

```bash
cd "/Users/pperciva1/Desktop/E3_files/C&I_analysis/E3_C&I_analyzer"
./scripts/setup_local.sh
./scripts/dev.sh
```

Then open [http://127.0.0.1:15173](http://127.0.0.1:15173).

The API is available at [http://127.0.0.1:18080](http://127.0.0.1:18080), and
its health check is `/api/health`.

`./scripts/dev.sh` performs pending database migrations before starting the
API and frontend. Press `Ctrl+C` once to stop both processes.

## Local data

The default local files are:

```text
.local/e3_ci_analyzer.sqlite3   project records and saved results
.local/object_store/            uploaded bills, interval files and reports
.local/ci/active-tariff-profile.json  optional evidence-bound tariff profile
```

The complete `.local/` directory is ignored by Git. Do not move customer PDFs,
NEM12 files, tariff evidence or generated customer artifacts into source or
test directories.

To reset only a disposable local development instance, stop the application
and move `.local/` to a backup location. Do not delete it when it contains
project evidence that has not been backed up.

## Tests

```bash
./scripts/test.sh
pnpm frontend:build
```

The Python tests and migrations use synthetic, private-data-free fixtures.

## Configuration

Copy `.env.example` for a list of supported variables. The local scripts set
safe loopback defaults without reading a `.env` file. Export an environment
variable before starting to override a default.

The default ports are `E3_API_PORT=18080` and `E3_WEB_PORT=15173`. Override
either variable when another local application already uses a port.

For PostgreSQL later, install the optional driver and set `DATABASE_URL`:

```bash
.venv/bin/pip install -e '.[postgres]'
export DATABASE_URL='postgresql+psycopg://...'
./scripts/dev.sh
```

## Cloudflare deployment

The production Worker serves the built React assets and routes `/api/*` to a
single Cloudflare Container running the Python/FastAPI/HiGHS API. Customer
artifacts use a private R2 binding; no R2 credential is exposed to the browser
or container. PostgreSQL remains mandatory because Cloudflare Container disks
are ephemeral and therefore cannot safely hold the application database.

The Worker must be protected by Cloudflare Access before customer evidence is
uploaded. Backend credentials and Access configuration are Worker secrets and
must never be committed. See `docs/CLOUDFLARE_DEPLOYMENT.md` for the required
resources, secrets, build command and verification steps.

## Provenance

The internal Python namespace remains `solar_battery` so the migrated C&I
calculation contracts and historical test provenance stay traceable. The
standalone product and package are named `E3 C&I Analyzer`; no Residential UI
or database tables are present.

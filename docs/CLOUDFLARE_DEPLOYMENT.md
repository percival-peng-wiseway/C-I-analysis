# Cloudflare production deployment

The deployment uses one Worker for the React frontend and API routing, one
Cloudflare Container for FastAPI/HiGHS/PDF rendering, private R2 for uploaded
and generated objects, and durable PostgreSQL for relational data.

## Required resources

- A Workers Paid plan with Cloudflare Containers enabled.
- The private R2 bucket `e3-ci-private-objects`.
- A PostgreSQL database reachable from Cloudflare Containers with TLS enabled.
- A Cloudflare Zero Trust Access application protecting the `e3-ci-web`
  Worker, with an explicit allow policy for approved internal users.
- Docker for a local deployment, or a connected Workers Builds repository for
  a Cloudflare-hosted image build.

Cloudflare Containers have ephemeral disk. Do not configure a SQLite URL or a
filesystem object store in production.

## Worker secrets

Configure these as encrypted Worker secrets, never plaintext `vars`:

- `DATABASE_URL`: the PostgreSQL SQLAlchemy URL.
- `DURABLE_API_BEARER_TOKEN`: a randomly generated internal credential used
  only between the Worker and FastAPI.
- `ACCESS_TEAM_DOMAIN`: the Access team hostname, for example
  `team-name.cloudflareaccess.com`.
- `ACCESS_AUD`: the Access application's audience tag.

The non-secret workspace identifiers are declared in `wrangler.jsonc`.

## Deploy

For a connected Git repository, set the production deploy command in Workers
Builds to:

```text
pnpm cloudflare:deploy
```

For a local deployment with Docker running:

```text
pnpm cloudflare:deploy
```

Wrangler builds the frontend, bundles the Worker, builds the linux/amd64
container image and rolls out the container. Initial provisioning can take a
few minutes.

Do not start a production analysis while a deployment is still propagating.
A Worker code update can restart its Durable Object, so every long calculation
must persist resumable checkpoints rather than depend on one uninterrupted
proxy request. Physical feasibility and tariff replay both use small,
idempotent scenario batches for this reason. A failed batch can be resumed
from PostgreSQL without re-running completed scenarios or accumulating a
rebate or financial value twice.

The production container configuration keeps capacity for rollout overlap and
uses an active rollout grace period. These settings reduce cold-start and
container-replacement failures, but they do not replace application-level
checkpoints: Durable Objects can also restart because of platform or Worker
updates.

Scenario execution uses the `standard-4` container size with at most two
isolated battery-scenario processes. Each process keeps HiGHS single-threaded;
this avoids solver oversubscription while using two cores concurrently and
leaving memory headroom for the API, interval evidence and result persistence.
`CI_SCENARIO_PROCESS_TIMEOUT_SECONDS` is a wall-clock watchdog for the complete
process batch (600 seconds in production), whereas the optimizer's 120-second
limit applies separately to each HiGHS solve. A watchdog expiry terminates the
child processes and fails closed so a later request cannot wait forever behind
an abandoned calculation lock.

The production Worker starts the API container in the background on an HTML
navigation and keeps the single instance available for two hours after its
last activity. This reduces repeated project-list cold starts during a working
session, while increasing the container runtime compared with the platform's
ten-minute default. Review Container duration and cold-start logs when tuning
this value.

## Verification

1. Confirm `/api/health` returns `{"status":"healthy"}` after the container
   has provisioned.
2. Confirm an unauthenticated non-health API request is rejected.
3. Sign in through Cloudflare Access and create a synthetic project.
4. Upload only synthetic evidence, restart the container, and confirm the
   project and object remain available from PostgreSQL and R2.
5. Inspect Worker and Container logs without recording customer payloads.

Do not upload customer evidence until Access, PostgreSQL durability, R2 and
the restart test have all passed.

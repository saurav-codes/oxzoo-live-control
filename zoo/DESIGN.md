# oxzoo-live design

This file is the contract every project follows. If code and this file disagree,
fix the code or change this file on purpose, never drift silently.

## Servers and domains

| Server | Droplet | Size | Wildcard record | Projects |
|--------|---------|------|-----------------|----------|
| s1 | zoo-1 (tag `ox-zoo`) | Ubuntu 26.04, 2 vCPU, 4 GB | `*.s1.zoo.sorv.dev` A, DNS only | zoo-control, celery-hub, rails-queue, phoenix-live, sveltekit-ssr, nest-bullmq |
| s2 | zoo-2 | same | `*.s2.zoo.sorv.dev` | catalog-api, search-svc, laravel-jobs, remix-router, cron-ledger, hono-files |
| s3 | zoo-3 | same | `*.s3.zoo.sorv.dev` | event-bus, next-prisma, deno-fresh, rabbit-relay, mesh-shop, symfony-notes |
| s4 | zoo-4 | same | `*.s4.zoo.sorv.dev`, `*.pv.zoo.sorv.dev` | pipeline-py, axum-cache, nuxt-chat, astro-api, angular-static, release-lab |

Domain of a project: `<project>.s<N>.zoo.sorv.dev`. Extra hostnames:
`release-lab-staging.s4.zoo.sorv.dev` and at most two previews under
`*.pv.zoo.sorv.dev` (the account preview domain). Total 27 certificates. Domains are
attached at deploy time (`ox domains`), not written in `ox.toml`, so zero-config
projects stay zero-config.

Every service binds 127.0.0.1. Cross-server calls go over public HTTPS to the peer's
domain and are signed (below). The server name shown in health is derived from
`PUBLIC_HOST` (the `sN` label), never configured by hand.

## Contract

### `GET /_zoo/health`

Cheap, no dependencies touched, always 200 while the process is up.

```json
{
  "name": "catalog-api",
  "stack": "FastAPI + SQLAlchemy 2 + Alembic",
  "server": "s2",
  "release": "3f9c2a1",
  "env": "production",
  "uptime_s": 1234,
  "started_at": "2026-10-09T10:00:00Z",
  "build": { "tag": "zoo-1", "built_at": "2026-10-09T09:58:00Z", "runtime": "python 3.13.5" }
}
```

- `release`: `OX_RELEASE` (first 12 chars), else `"unknown"`.
- `env`: `OX_ENV`, else `"local"`.
- `server`: the label matching `^s[0-9]+$` in `PUBLIC_HOST` (`catalog-api.s2.zoo.sorv.dev` gives `s2`), else `"local"`.
- `build.tag` is a build-time label when the project has one (`VITE_BUILD_TAG`, `PUBLIC_BUILD_TAG`), else omitted.
- Static sites (zoo-control, angular-static) serve `/_zoo/health.json` written at build: `started_at` is the build time and `uptime_s` is omitted.
- `build.built_at` is written at build time when the stack has a build step (a generated file or a compile-time constant), else omitted.

### `GET /_zoo/probe`

Runs real round trips against every service and dependency, then reports.

```json
{
  "name": "catalog-api", "stack": "...", "server": "s2", "release": "3f9c2a1", "env": "production",
  "ok": true, "ms": 41, "at": "2026-10-09T10:20:00Z",
  "checks": [
    { "id": "postgres", "label": "Postgres write, read, delete", "ok": true, "ms": 6,
      "detail": "zoo_probe row round trip, server 18.1", "env": ["DATABASE_URL"], "hops": ["catalog-api@s2"] },
    { "id": "redis", "label": "Redis SET/GET/DEL with TTL", "ok": true, "ms": 1, "env": ["REDIS_URL"], "hops": ["catalog-api@s2"] },
    { "id": "peer:axum-cache", "label": "Signed call to axum-cache", "ok": false, "ms": 8000,
      "error": "timeout after 8000 ms", "env": ["AXUM_URL", "INTERNAL_TOKEN"], "hops": ["sveltekit-ssr@s1", "axum-cache@s4"] }
  ],
  "vars": [
    { "name": "INTERNAL_TOKEN", "fp": "915a", "role": "verifies" },
    { "name": "CATALOG_URL", "value": "https://catalog-api.s2.zoo.sorv.dev", "role": "url", "peer": "catalog-api" },
    { "name": "CELERY_BROKER_URL", "fp": "1c2d", "role": "reference", "peer": "REDIS_URL" }
  ]
}
```

Rules:

- Each check is a real operation: write, read back, compare, delete. A TCP connect or a ping alone is not a check (a ping is fine as an extra check next to a real one).
- `env` lists the exact variable NAMES the check used. Never a value of a secret or of a service URL (service URLs carry passwords).
- `vars`: every variable the project reads that matters to the zoo.
  - `fp` is the last 4 hex characters of `sha256(value)`; it is the only thing ever shown for a secret or a service URL.
  - `value` is shown only for public peer URLs (role `url`) and plain non-secret config (role `plain`).
  - roles: `signs` (this project signs with the key), `verifies` (it checks signatures with it), `reference` (an ox `${...}` reference, `peer` names the referenced key; the panel checks both fps match), `service` (a service key provided by ox, fp only, the target of a reference), `secret` (a framework secret such as `SECRET_KEY_BASE`, `APP_KEY`, `APP_SECRET`, fp only), `url`, `plain`.
  - A missing variable is `{ "name": "...", "missing": true, "role": "..." }` and makes the checks that need it fail with `error: "VAR_NAME is not set"`.
- Peer checks call the peer's `GET /_zoo/verify` signed (see below) and pass only when: status 200, `name` equals the expected peer, `key_fp` equals our own fp of the key, and the peer's `public_url` equals our URL variable (so the variable value is proven too).
- Limits: one probe at a time per process; a second waits up to 5 s, then 429 `{"error":"probe busy"}`. Each local check times out at 5 s, each cross-server check at 8 s, the whole probe at 20 s. Probe writes are cleaned up in the same probe.
- Overall `ok` is true only when every check passed. Status code is 200 either way (the body says what failed); 429 and 500 only for the probe itself failing.

### `GET /_zoo/verify` (verifiers only)

Requires a valid signature. Returns
`{"ok": true, "name": "catalog-api", "public_url": "https://catalog-api.s2.zoo.sorv.dev", "verified_by": "INTERNAL_TOKEN", "key_fp": "915a", "caller": "mesh-shop", "server": "s2", "release": "..."}`.
Bad or missing signature: 401 `{"ok": false, "error": "<reason>"}` with reason one of
`missing signature`, `bad format`, `expired`, `unknown caller`, `bad signature`.

### Signing: zoo-sig v1

Header: `X-Zoo-Signature: t=<unix seconds>,caller=<project name>,sig=<hex>`

`sig = hex(HMAC-SHA256(key, "<t>.<METHOD>.<path with query>.<hex sha256 of raw body>"))`

- The path is exactly what goes on the request line (`/api/items?x=1`), METHOD uppercase. Empty body hashes to `e3b0c442...b855`.
- Verifier: `|now - t| <= 300`, caller in the verifier's hardcoded allowlist, constant-time compare, body read with a 64 KB cap before hashing.
- Optional `X-Zoo-Trace: <uuid>`: a verifier that receives a valid signed request with this header records a hop under that trace.

Test vectors (every implementation's unit tests must pass these):

```
key  = "zoo-test-key-0123456789abcdef"
t    = 1760000000
POST /api/items?x=1  body {"sku":"ZOO-1"}
  body sha256 = cc2860a77ea231854ea58f9cb05f3217059f80a8e95d7b69a204293ae4f3a444
  sig         = 50c22839fe6a06cb51a9fd25167d9e457eb0b5ee63ce696f4c5428a6b9271da1
GET /_zoo/verify  empty body
  sig         = 9a404bebaa32497c5ed39ef8990e8466428f8023d6aa9f5acc94f16fb7670ecb
fp(key)       = 915a
```

### Shared secrets

| Key | Verifiers (allowlist of callers) | Signers |
|-----|----------------------------------|---------|
| `INTERNAL_TOKEN` | catalog-api (mesh-shop, sveltekit-ssr), axum-cache (sveltekit-ssr) | mesh-shop, sveltekit-ssr |
| `EVENTS_KEY` | event-bus (celery-hub, pipeline-py) | celery-hub, pipeline-py |
| `SEARCH_INGEST_KEY` | search-svc (event-bus) | event-bus (Python consumer) |
| `WEBHOOK_SECRET` | rails-queue (mesh-shop, laravel-jobs), laravel-jobs `/api/acks` (rails-queue) | mesh-shop fulfiller, laravel-jobs, rails-queue |

Values are generated once in the deploy phase into `~/.config/oxzoo/shared.env`
(never committed) and set with `ox vars set <project> --from-file`. In `.env.example`
these keys have empty values.

### CORS

The panel calls every `/_zoo/*` endpoint from the browser.

- `ZOO_PANEL_ORIGIN`: comma list of allowed origins (production value `https://zoo-control.s1.zoo.sorv.dev`; local tests add `http://localhost:5173`).
- For `/_zoo/health`, `/_zoo/probe`, `/_zoo/trace/*`, `/_zoo/chain/*`: when `Origin` is in the list, answer `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`; never `*`, never credentials. `OPTIONS` preflight: 204 with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 600`. Origin not listed: no CORS headers (the browser blocks).
- App APIs called from angular-static use `CORS_ORIGINS` with the same rules (catalog-api, search-svc). Production value: `https://angular-static.s4.zoo.sorv.dev,https://zoo-control.s1.zoo.sorv.dev`. The `/_zoo/health` of those two also allows `CORS_ORIGINS` origins (angular-static's selftest reads it).
- Response shapes the browser relies on: catalog-api `GET /api/items` is `{"items":[{"sku","name","price_cents"}]}`, `GET /api/items/<sku>` is one item; search-svc `GET /api/search?q=` is `{"hits":[...],"query":"...","ms":n}`.
- angular-static selftest messages: parent sends `{"type":"zoo-probe"}`, child replies `{"type":"zoo-probe-result","probe":{...}}`.
- `GET /_zoo/trace/<malformed>` answers 400.

### Chains

`POST /_zoo/chain/<chain>` with `{"trace": "<uuid>"}` starts a chain on its starter
project. Trace ids match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
Rate limit 10 starts per minute per process (429 after). Returns 202
`{"trace": "...", "started": true}`.

`GET /_zoo/trace/<id>` on every project in a chain returns
`{"trace": "...", "found": true, "hops": [{"at": "...", "step": "queued", "detail": "..."}]}`
(`found: false, hops: []` when unknown). Hops live in the project's own store (its
database, or a 200-entry in-memory ring with 1 h TTL for stateless projects). The panel
polls each project listed in the chain until every expected step appears or 60 s pass.

| Chain | Starter | Projects and expected steps |
|-------|---------|-----------------------------|
| `event-river` | celery-hub | celery-hub: `queued`, `worker-ledger`, `sent`; event-bus: `ingested`, `go-consumer`, `py-forwarded`; search-svc: `received`, `indexed`; pipeline-py: `clickhouse`, `qdrant`, `meili` |
| `shop-order` | mesh-shop | mesh-shop: `order-created`, `catalog-ok`, `stock-reserved`, `fulfilled`, `webhook-sent`; catalog-api: `signed-lookup`; rails-queue: `webhook-received`, `job-done` |
| `ping-pong` | laravel-jobs | laravel-jobs: `queued`, `webhook-sent`, `ack-received`; rails-queue: `webhook-received`, `job-done`, `ack-sent` |
| `ssr-fanout` | sveltekit-ssr | sveltekit-ssr: `catalog`, `search`, `axum`; catalog-api: `signed-lookup`; axum-cache: `signed-lookup` |
| `rabbit-relay` | rabbit-relay | rabbit-relay: `published`, `consumed`, `stored` |

C6 (zero downtime) is panel-only: it polls release-lab `/_zoo/health` every 500 ms
and counts failed requests and release id changes while the owner deploys.

Details per chain:

- event-river: celery-hub enqueues a Celery task (broker `CELERY_BROKER_URL = ${REDIS_URL}`), the worker writes a row in the private `ledger` database, then POSTs signed (`EVENTS_KEY`) to `${EVENTS_URL}/api/events` `{"trace","kind":"zoo.chain","text"}`. event-bus stores the event in PG and publishes to JetStream subject `zoo.events` (stream `ZOO`). Its Go consumer (durable `ledger`) writes a ledger row; its Python consumer (durable `forward`) POSTs signed (`SEARCH_INGEST_KEY`) to `${SEARCH_URL}/api/ingest`. search-svc stores it in a PG queue table; its Go indexer worker indexes into Meilisearch index `events`. pipeline-py's puller worker calls `GET ${EVENTS_URL}/api/events?after=<id>` signed (`EVENTS_KEY`) every 5 s, inserts into ClickHouse `zoo.events`, upserts a deterministic 64-dim hash vector into Qdrant collection `events`, and indexes into its own Meilisearch.
- shop-order: mesh-shop gateway proxies to the `orders` port worker; orders calls `GET ${CATALOG_URL}/api/items/<sku>` signed (`INTERNAL_TOKEN`, with `X-Zoo-Trace`), asks the `stock` port worker to reserve, stores the order in PG, pushes to a Redis list; the fulfiller worker pops it, marks it fulfilled, and POSTs signed (`WEBHOOK_SECRET`) to `${RAILS_URL}/webhooks/zoo` `{"trace","source":"mesh-shop","event":"order.fulfilled"}`. rails-queue verifies, records, enqueues a Solid Queue job that records `job-done`.
- ping-pong: laravel-jobs dispatches a queued job (Redis queue) that POSTs signed to `${RAILS_URL}/webhooks/zoo` with `"source":"laravel-jobs"`. rails-queue's job, for source `laravel-jobs` only, POSTs a signed ack to `${LARAVEL_URL}/api/acks` `{"trace"}`. The ack target always comes from rails-queue's own variable, never from the payload.
- ssr-fanout: sveltekit-ssr calls, server-side and in parallel, catalog-api `/api/items` (signed), search-svc `/api/search?q=zoo` (public read), axum-cache `/api/cache/zoo` (signed). The secret never reaches the browser.
- rabbit-relay: publish to queue `zoo.relay` (durable, persistent message), the consumer worker acks after writing PG.

## Variables per project

Provided by ox (never set by hand): `PORT`, `HOST`, `OX_ENV`, `OX_PROJECT`,
`OX_RELEASE`, `OX_DATA_DIR`, `PUBLIC_URL`, `PUBLIC_HOST`, `<WORKER>_URL`, service keys.
Every HTTP project also reads `ZOO_PANEL_ORIGIN` (plain).

| Project | Service keys (provided) | Yours: secrets | Yours: plain and references |
|---------|-------------------------|----------------|-----------------------------|
| zoo-control | none | none | none (reads `projects.json`) |
| celery-hub | `DATABASE_URL`, `LEDGER_DATABASE_URL`, `REDIS_URL`, `CACHE_REDIS_URL` | `DJANGO_SECRET_KEY`, `EVENTS_KEY` | `CELERY_BROKER_URL=${REDIS_URL}`, `EVENTS_URL` |
| rails-queue | `DATABASE_URL` | `SECRET_KEY_BASE`, `WEBHOOK_SECRET` | `LARAVEL_URL` |
| phoenix-live | `DATABASE_URL` | `SECRET_KEY_BASE` | none |
| sveltekit-ssr | none | `INTERNAL_TOKEN` | `ORIGIN=${PUBLIC_URL}`, `CATALOG_URL`, `SEARCH_URL`, `AXUM_URL` |
| nest-bullmq | `DATABASE_URL`, `REDIS_URL` | none | none |
| catalog-api | `DATABASE_URL`, `REDIS_URL` | `INTERNAL_TOKEN` | `CORS_ORIGINS` |
| search-svc | `DATABASE_URL`, `MEILI_URL`, `MEILI_MASTER_KEY` | `SEARCH_INGEST_KEY` | `CORS_ORIGINS` |
| laravel-jobs | `MYSQL_URL`, `REDIS_URL` | `APP_KEY`, `WEBHOOK_SECRET` | `RAILS_URL` |
| remix-router | none | `SESSION_SECRET` | `VITE_BUILD_TAG` (build time) |
| cron-ledger | `DATABASE_URL` | none | none |
| hono-files | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | none | none |
| event-bus | `DATABASE_URL`, `NATS_URL` | `EVENTS_KEY`, `SEARCH_INGEST_KEY` | `SEARCH_URL` |
| next-prisma | `DATABASE_URL` | none | none |
| deno-fresh | none | none | none |
| rabbit-relay | `DATABASE_URL`, `AMQP_URL` | none | none |
| mesh-shop | `DATABASE_URL`, `REDIS_URL`, `ORDERS_URL`, `STOCK_URL` | `INTERNAL_TOKEN`, `WEBHOOK_SECRET` | `CATALOG_URL`, `RAILS_URL` |
| symfony-notes | `MYSQL_URL` | `APP_SECRET` | none |
| pipeline-py | `CLICKHOUSE_URL`, `CLICKHOUSE_PASSWORD`, `MEILI_URL`, `MEILI_MASTER_KEY`, `QDRANT_URL` | `EVENTS_KEY` | `EVENTS_URL` |
| axum-cache | `DATABASE_URL`, `REDIS_URL` | `INTERNAL_TOKEN` | none |
| nuxt-chat | `REDIS_URL` | none | none |
| astro-api | none | none | `PUBLIC_BUILD_TAG` (build time) |
| angular-static | none | none | `CATALOG_URL`, `SEARCH_URL` (build time) |
| release-lab | none | none | `RELEASE_LABEL` (differs on staging) |

Peer URL values: `CATALOG_URL=https://catalog-api.s2.zoo.sorv.dev`,
`SEARCH_URL=https://search-svc.s2.zoo.sorv.dev`, `AXUM_URL=https://axum-cache.s4.zoo.sorv.dev`,
`EVENTS_URL=https://event-bus.s3.zoo.sorv.dev`, `RAILS_URL=https://rails-queue.s1.zoo.sorv.dev`,
`LARAVEL_URL=https://laravel-jobs.s2.zoo.sorv.dev`.

Framework settings are derived, not new variables: Django `ALLOWED_HOSTS` and
`CSRF_TRUSTED_ORIGINS` from `PUBLIC_HOST`/`PUBLIC_URL`, Phoenix host from `PUBLIC_HOST`,
Laravel `APP_URL` from `PUBLIC_URL`, Doctrine and Laravel read `MYSQL_URL` directly.

## Static projects

ox serves `[static]` files through Caddy with no custom headers, so a static site
cannot answer cross-origin requests. Two static projects handle it:

- zoo-control is the panel itself (same origin for `projects.json`).
- angular-static writes `/_zoo/health.json` at build time and ships `/selftest`, a page
  the panel loads in a hidden iframe. It runs the browser CORS calls to catalog-api and
  search-svc and `postMessage`s the result (same probe JSON shape) only to an origin in
  its build-time allowlist.

## Proof levels

P1 health answers. P2 every local service check passes. P3 a cross-server signed
call passes with matching fingerprints and URL value. P4 the project's chain passes.
`projects.json` declares the maximum each project can reach; the panel shows the
level actually reached.

## projects.json

Lives in `zoo-control/public/projects.json`, the single registry. One entry per project:

```json
{
  "name": "catalog-api", "server": "s2", "url": "https://catalog-api.s2.zoo.sorv.dev",
  "stack": "FastAPI + SQLAlchemy 2 + Alembic", "kind": "api",
  "services": ["postgres", "redis"], "processes": ["app"],
  "proof": "P3", "ox_features": ["zero-config", "migrate"],
  "links": [{"label": "Items", "path": "/api/items"}],
  "vars": { "signs": [], "verifies": ["INTERNAL_TOKEN"], "urls": {} },
  "chains": ["shop-order", "ssr-fanout"],
  "probe": "server"
}
```

`probe` is `server` (fetch `/_zoo/probe`), `iframe` (angular-static `/selftest`), or
`self` (zoo-control checks itself). Chains are listed in `chains` at the top level
with their starter and expected steps (the table above).

## Code rules for every project

- 200 to 800 lines of real code (excluding lockfiles and generated files).
- No default passwords, no debug mode in production, validated input (size caps, regexes on ids), timeouts on every outbound call, logs to stdout or stderr.
- `ox.toml` only when detection cannot express the project; when present it is minimal and commented only where a reason is not obvious.
- `.env.example` lists every key of yours, with empty values for secrets.
- Unit tests run locally (pytest, go test, node:test, bun test, deno test, cargo test, minitest, phpunit, mix test), including the signing test vectors for every signer or verifier.
- README: what it proves, ox features exercised, exact variables, recorded `ox check` output.
- No em-dashes anywhere.

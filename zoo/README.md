# oxzoo-live

A live zoo of 24 real example projects spread over 4 servers, built to stress-test
ox end to end: stack detection, built-in and custom services, workers, cron, storage,
zero-downtime deploys, staging, previews, promote, rollback, variables, secrets and
cross-server calls over public HTTPS. One control panel (`zoo-control`) probes all of
them live from the browser.

Each subfolder is one project and later becomes its own GitHub repo
(`github.com/saurav-codes/oxzoo-live-<name>`, the panel is `oxzoo-live-control`). The full contract and every chain are in
[DESIGN.md](DESIGN.md).

Skipped on purpose: Spring Boot and ASP.NET (only plan-verified in ox, no new Java
work, no local dotnet), Typesense (no install path in ox), MinIO (no binaries;
SeaweedFS covers S3), MongoDB (not supported).

## Topology

```
                         browser (zoo-control SPA, s1)
                 |  CORS probes to every /_zoo/probe and /_zoo/health
   +-------------+--------------+------------------+-------------------+
   |                            |                  |                   |
 s1 (zoo-1)                 s2 (zoo-2)          s3 (zoo-3)          s4 (zoo-4)
 zoo-control                catalog-api         event-bus           pipeline-py
 celery-hub   --signed-->   search-svc   <----  (NATS JetStream)  <-- pulls events
 rails-queue  <--webhook--  laravel-jobs        next-prisma         axum-cache
 phoenix-live               remix-router        deno-fresh          nuxt-chat
 sveltekit-ssr --SSR-->     cron-ledger         rabbit-relay        astro-api
 nest-bullmq                hono-files          mesh-shop --------> angular-static
                                                symfony-notes       release-lab
                                                                    (+ staging, previews)

 Every service binds 127.0.0.1, so every cross-server call is HTTPS to a public
 domain, signed with a shared secret that ox stores as a project variable.
```

Domains: `<project>.s<N>.zoo.sorv.dev`, served by a wildcard A record
`*.s<N>.zoo.sorv.dev` per server (Cloudflare, DNS only, grey cloud, so Caddy gets
Let's Encrypt certificates). Previews use `*.pv.zoo.sorv.dev` pointing at s4.
Planned hostnames: 24 apps + 1 staging + at most 2 previews = 27 certificates,
well under the 50 per week limit for `sorv.dev`.

## Projects

| # | Project | Server | Stack | Services and processes | Proof |
|---|---------|--------|-------|------------------------|-------|
| 1 | zoo-control | s1 | Vite + React + TS static | none (static) | P1 |
| 2 | celery-hub | s1 | Django 5 + Celery + beat | postgres (shared), postgres `ledger` (private), redis (private broker), redis `cache` (shared), worker, beat | P4 |
| 3 | rails-queue | s1 | Rails 8 + Puma + Solid Queue | postgres, `bin/jobs` worker | P4 |
| 4 | phoenix-live | s1 | Phoenix 1.8 LiveView | postgres | P2 |
| 5 | sveltekit-ssr | s1 | SvelteKit adapter-node | none, SSR fan-out to 3 servers | P3 |
| 6 | nest-bullmq | s1 | NestJS + BullMQ | postgres, redis, worker | P2 |
| 7 | catalog-api | s2 | FastAPI + SQLAlchemy 2 + Alembic | postgres, redis cache | P3 |
| 8 | search-svc | s2 | Go chi + Meilisearch | custom `search` (Meilisearch), postgres queue, indexer worker | P3 |
| 9 | laravel-jobs | s2 | Laravel 12 | mysql, redis queue, queue worker, scheduler cron, `[storage] keep` | P4 |
| 10 | remix-router | s2 | React Router 7 SSR | none, build-time `VITE_` var + run-time secret | P2 |
| 11 | cron-ledger | s2 | Flask + gunicorn | postgres, 4 cron jobs with run history | P2 |
| 12 | hono-files | s2 | Bun + Hono + SQLite | custom `s3` (SeaweedFS), `[storage] keep` for SQLite + uploads | P2 |
| 13 | event-bus | s3 | Go chi + NATS JetStream | custom `nats` (nats-server), postgres, Go consumer, Python consumer | P4 |
| 14 | next-prisma | s3 | Next.js 15 SSR + Prisma | postgres | P2 |
| 15 | deno-fresh | s3 | Deno Fresh 2 | none | P1 |
| 16 | rabbit-relay | s3 | Fastify + RabbitMQ | custom `rabbit` (rabbitmq-server), postgres, consumer worker | P4 |
| 17 | mesh-shop | s3 | Monorepo: Go gateway + Bun orders + Python stock + Node fulfiller + static web | postgres, redis, 3 port workers, 1 worker | P4 |
| 18 | symfony-notes | s3 | Symfony 7 + Doctrine | mysql | P2 |
| 19 | pipeline-py | s4 | Python workers + cron + Starlette | custom `clickhouse`, custom `search` (Meilisearch), qdrant, 2 workers, cron | P4 |
| 20 | axum-cache | s4 | Rust Axum + sqlx | postgres, redis | P3 |
| 21 | nuxt-chat | s4 | Nuxt 4 SSR + SSE chat | redis pub/sub | P2 |
| 22 | astro-api | s4 | Astro static + Hono API | `[static] api` routes to a Node app | P2 |
| 23 | angular-static | s4 | Angular 20 static | none, browser CORS calls to s2 | P3 |
| 24 | release-lab | s4 | Go stdlib | none, staging, previews, promote, rollback | P2 |

Proof levels: P1 up and healthy, P2 local services pass real round trips, P3 a
cross-server call with a verified shared secret passes, P4 an end-to-end chain passes.

## Chains

| Chain | Path | What it proves |
|-------|------|----------------|
| C1 Event river | panel -> celery-hub (s1) -> Celery via Redis -> signed POST event-bus (s3) -> JetStream -> Go consumer (PG ledger) + Python consumer -> signed POST search-svc (s2) -> Meilisearch; pipeline-py (s4) pulls events -> ClickHouse + Qdrant + Meilisearch | workers, private vs shared services, custom services, 4-server HTTPS with 2 shared secrets |
| C2 Shop order | panel -> mesh-shop gateway (s3) -> orders -> signed GET catalog-api (s2) -> PG + Redis -> fulfiller -> signed webhook rails-queue (s1) -> Solid Queue job | port workers, `<NAME>_URL` wiring, secrets shared across 3 projects |
| C3 Webhook ping-pong | panel -> laravel-jobs (s2) queue -> signed webhook rails-queue (s1) -> job -> signed ack back to laravel-jobs | HMAC both directions, two queue systems |
| C4 SSR fan-out | sveltekit-ssr (s1) server-side -> catalog-api (s2), search-svc (s2), axum-cache (s4); angular-static (s4) browser -> catalog-api, search-svc via CORS | server-side secrets stay server-side, CORS allowlists right |
| C5 Rabbit relay | panel -> rabbit-relay (s3) publish -> RabbitMQ -> consumer -> PG | custom service from apt with its own daemon |
| C6 Zero downtime | panel polls release-lab health every 500 ms while a deploy runs, counts errors and release id changes | two-side switch, rollback, promote |

## Layout of each project

- source, lockfile, tests runnable locally
- `ox.toml` only when zero-config detection cannot express it
- `.env.example` listing every variable ox must ask for (secret values empty)
- `README.md`: what it proves, ox features, exact variables, recorded `ox check` output
- `GET /_zoo/health` and `GET /_zoo/probe` per [DESIGN.md](DESIGN.md#contract)

## Deploy phase (not done yet)

Needs from the owner: create the `oxzoo-*` GitHub repos (or allow the agent to),
install the ox GitHub App on them, sign in to the plane, create 4 droplets tagged
`ox-zoo` and the Cloudflare records. Then `deploy/` scripts generate the shared
secrets into `~/.config/oxzoo/shared.env` (never committed) and set them with
`ox vars set <project> --from-file`.

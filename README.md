# zoo-control

> **Role in the zoo:** project `zoo-control` of [oxzoo-live](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/README.md#projects), deployed with ox on server s1 at https://zoo-control.s1.zoo.sorv.dev. The contract it follows is [DESIGN.md](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/DESIGN.md).

The oxzoo-live control panel: a Vite + React + TypeScript static SPA on s1
(`https://zoo-control.s1.zoo.sorv.dev`) that probes all 24 zoo projects live from
the browser. Proof max: P1.

## What it proves

- ox deploys a plain Vite SPA with **zero config**: no `ox.toml`, detection gives
  `[static] dir = "dist"`, `spa = true`, `npm ci`, `npm run build`, node 24 from `engines`.
- Build-time provided variables reach the build: `scripts/write-health.mjs` (the
  `prebuild` script) stamps `/_zoo/health.json` with `OX_RELEASE` (first 12 chars),
  `OX_ENV` and the `sN` label of `PUBLIC_HOST`.
- Every other project's CORS allowlist (`ZOO_PANEL_ORIGIN`) is right, because the
  panel calls their `/_zoo/*` endpoints cross-origin from this domain.

## ox features exercised

zero-config detection, static SPA served by Caddy, build-time provided variables.

## Variables

| Kind | Keys |
|------|------|
| Provided by ox, read at build | `OX_RELEASE`, `OX_ENV`, `PUBLIC_HOST` |
| Yours | none |

`.env.example` has no keys. No secret is ever in the front end: the panel only sees
fingerprints (`fp`, last 4 hex of sha256) that the projects report.

## Views

- **Overview**: per-server status strip, tiles grouped by server (name, stack,
  domain, proof reached/max, release id, status dot, health latency, probe sparkline).
  A tile opens a drawer that runs the probe live: each check with label, ok, ms,
  env var names as chips, hops as `a@s1 -> b@s2`, the reported variables, app links.
- **Run everything**: every probe in parallel, at most 8 at a time; `n passed / n failed`,
  failing checks expanded.
- **Variable flow**: per shared key, signers and verifiers with their fps and each real
  caller pair (signer with a URL variable to a verifier of that key, which is exactly the
  DESIGN.md allowlists) marked match or mismatch; references show both fps; URL
  variables show the value vs the peer's public URL.
- **Chains**: starts a chain with a `crypto.randomUUID()` trace, polls every member's
  `/_zoo/trace/<id>` every 1 s up to 60 s, ticks off expected steps with timings.
  A passed chain is remembered (localStorage) and lifts its members to P4.
- **Zero downtime**: polls release-lab `/_zoo/health` every 500 ms, counts requests,
  errors and release changes. Start/stop.
- Probe history: last 50 runs per project in localStorage, sparkline of ms with failures marked.

Proof level reached (capped at the max in `projects.json`): P1 health answers;
P2 every non-`peer:` check passes; P3 additionally every `peer:` check passes, no fp
or URL mismatch on the project's own pairs, and at least one cross-server proof
(a peer check or a matching pair); P4 additionally one of its chains passed.

Probe modes: `server` fetches `<url>/_zoo/probe`; `iframe` (angular-static) loads
`<url>/selftest` hidden, posts `{"type":"zoo-probe"}` to that exact origin (again every
second until it answers), accepts a reply only from that origin and that frame, either
`{"type":"zoo-probe-result","probe":{...}}` or the probe JSON itself, 10 s timeout;
`self` (zoo-control) checks the registry, its own `/_zoo/health.json`, and a
localStorage round trip. Health is `/_zoo/health` for `server` and `/_zoo/health.json`
for `iframe` and `self`. Network and CORS errors show per tile (a browser cannot tell
them apart, so they read "network or CORS error").

## projects.json

`public/projects.json` is the single registry: `servers` (s1..s4), `chains` (id, title,
starter, steps per project, from the DESIGN.md chain table) and 24 `projects` in the
DESIGN.md shape. `vars.urls` maps a URL variable to the peer project. The panel
validates it on load and refuses an invalid registry with the list of problems.

## Run locally

```bash
npm ci
npm test                 # vitest: proof levels, fp matching, chain progress, registry
npm run build            # writes public/_zoo/health.json, typechecks, builds dist/
```

Against a fake zoo (two terminals):

```bash
node scripts/stub-server.mjs          # registry on 127.0.0.1:4400, projects on 4402..4424
npm run dev                           # then open http://localhost:5173/?registry=local
# or, after npm run build:
npx vite preview --port 4173          # then open http://localhost:4173/?registry=local
```

`?registry=local` loads `http://127.0.0.1:4400/projects.json`, the same registry with
every URL pointing at the stub. The stub answers `/_zoo/health`, `/_zoo/probe`,
`/_zoo/verify`, `/_zoo/trace/*`, `/_zoo/chain/*` (CORS for localhost:5173 and :4173) and
a `/selftest` page for angular-static, with deliberate failures: next-prisma is down,
symfony-notes sends no CORS headers, laravel-jobs fails its redis check, cron-ledger's
probe answers 500, axum-cache holds a stale `INTERNAL_TOKEN` (fp mismatch with
sveltekit-ssr), pipeline-py misses `EVENTS_URL`, ping-pong never records `ack-sent`
(times out at 60 s), and release-lab changes release every 20 s and drops 1 request in 40.

## Recorded output

`npm test`:

```
 Test Files  2 passed (2)
      Tests  18 passed (18)
```

`npm run build`:

```
> zoo-control@1.0.0 prebuild
> node scripts/write-health.mjs
wrote public/_zoo/health.json (release unknown, server local)
> zoo-control@1.0.0 build
> tsc --noEmit && vite build
vite v8.3.4 building client environment for production...
✓ 27 modules transformed.
dist/index.html                   0.61 kB │ gzip:  0.39 kB
dist/assets/index-Amk703a0.css    6.98 kB │ gzip:  2.07 kB
dist/assets/index-Cr54WNSj.js   246.06 kB │ gzip: 76.47 kB
✓ built in 674ms
```

`/tmp/oxz/ox check .`:

```
ox check . (manifest: none)

  static.dir                 dist                                                 detected:package.json
  build.install              npm ci                                               detected:package-lock.json
  build.commands[0]          npm run build                                        detected:package.json
  tools.node                 24                                                   detected:package.json

  Provided by ox: PORT, HOST, OX_ENV, OX_PROJECT, OX_RELEASE, OX_DATA_DIR, PUBLIC_URL, PUBLIC_HOST

Ready to deploy.
```

(`ox check --json` shows `"SPA": true`; the text plan has no `static.spa` row.)

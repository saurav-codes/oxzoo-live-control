// Local stand-in for the whole zoo: one fake /_zoo/* server per project on
// localhost:4401.., plus the rewritten registry on localhost:4400/projects.json.
// Open the panel with ?registry=local. Deliberate failures, so the error states show:
//   next-prisma is down, symfony-notes sends no CORS headers, laravel-jobs has a
//   failing redis check, cron-ledger's probe answers 500, axum-cache holds a stale
//   INTERNAL_TOKEN (fp mismatch), pipeline-py misses EVENTS_URL, and ping-pong
//   never records ack-sent. release-lab changes release every 20 s and drops 1 in 40.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const BASE = 4400;
const ORIGINS = ["http://localhost:5173", "http://localhost:4173", "http://127.0.0.1:5173", "http://127.0.0.1:4173"];
const TRACE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE_ENV = {
  postgres: "DATABASE_URL", ledger: "LEDGER_DATABASE_URL", redis: "REDIS_URL", cache: "CACHE_REDIS_URL",
  mysql: "MYSQL_URL", search: "MEILI_URL", nats: "NATS_URL", rabbit: "AMQP_URL", s3: "S3_ENDPOINT",
  clickhouse: "CLICKHOUSE_URL", qdrant: "QDRANT_URL",
};

const reg = JSON.parse(readFileSync(new URL("../public/projects.json", import.meta.url), "utf8"));
const port = (name) => BASE + 1 + reg.projects.findIndex((p) => p.name === name);
const local = {
  ...reg,
  projects: reg.projects.map((p) => ({ ...p, url: p.probe === "self" ? p.url : `http://127.0.0.1:${port(p.name)}` })),
};
const byName = new Map(local.projects.map((p) => [p.name, p]));
const fp = (v) => createHash("sha256").update(v).digest("hex").slice(-4);
const keyValue = (project, key) => (project === "axum-cache" && key === "INTERNAL_TOKEN" ? `stub-${key}-stale` : `stub-${key}`);
const ms = () => 1 + Math.floor(Math.random() * 9);
const started = Date.now();
const traces = new Map(); // trace -> { chain, at }
const starts = [];

function send(req, res, status, body, cors = true) {
  const origin = req.headers.origin;
  if (cors && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (status === 204) {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.writeHead(204).end();
  }
  const isHtml = typeof body === "string";
  res.writeHead(status, { "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json" });
  res.end(isHtml ? body : JSON.stringify(body));
}

function release(p) {
  const epoch = p.name === "release-lab" ? Math.floor((Date.now() - started) / 20000) : 0;
  return createHash("sha256").update(p.name + epoch).digest("hex").slice(0, 7);
}

function health(p) {
  return { name: p.name, stack: p.stack, server: p.server, release: release(p), env: "local", uptime_s: Math.round((Date.now() - started) / 1000) };
}

function probe(p) {
  const hop = `${p.name}@${p.server}`;
  const checks = p.services.map((s) => ({
    id: s, label: `${s} write, read, delete`, ok: !(p.name === "laravel-jobs" && s === "redis"), ms: ms(),
    ...(p.name === "laravel-jobs" && s === "redis" ? { error: "NOAUTH Authentication required" } : { detail: "stub round trip" }),
    env: [SERVICE_ENV[s] ?? `${s.toUpperCase()}_URL`], hops: [hop],
  }));
  const vars = [];
  for (const role of ["signs", "verifies"]) for (const k of p.vars[role]) vars.push({ name: k, fp: fp(keyValue(p.name, k)), role });
  for (const [name, peerName] of Object.entries(p.vars.urls)) {
    const peer = byName.get(peerName);
    if (p.name === "pipeline-py") {
      vars.push({ name, missing: true, role: "url" });
      checks.push({ id: `peer:${peerName}`, label: `Signed call to ${peerName}`, ok: false, ms: 0, error: `${name} is not set`, env: [name], hops: [hop] });
      continue;
    }
    vars.push({ name, value: peer.url, role: "url", peer: peerName });
    const key = p.vars.signs.find((k) => peer.vars.verifies.includes(k));
    if (!key) continue;
    const match = fp(keyValue(p.name, key)) === fp(keyValue(peerName, key));
    checks.push({
      id: `peer:${peerName}`, label: `Signed call to ${peerName}`, ok: match, ms: 20 + ms() * 5,
      ...(match ? { detail: `key_fp ${fp(keyValue(peerName, key))}, public_url matches` } : { error: "key_fp mismatch" }),
      env: [name, key], hops: [hop, `${peerName}@${peer.server}`],
    });
  }
  if (p.name === "celery-hub") {
    vars.push({ name: "CELERY_BROKER_URL", fp: fp("redis://stub"), role: "reference", peer: "REDIS_URL" }, { name: "REDIS_URL", fp: fp("redis://stub"), role: "service" });
  }
  if (p.name === "sveltekit-ssr") {
    vars.push({ name: "ORIGIN", fp: fp(p.url), role: "reference", peer: "PUBLIC_URL" }, { name: "PUBLIC_URL", value: p.url, fp: fp(p.url), role: "plain" });
  }
  const total = checks.reduce((a, c) => a + c.ms, 0);
  return { ...health(p), ok: checks.every((c) => c.ok), ms: total, at: new Date().toISOString(), checks, vars };
}

function hopsFor(p, trace) {
  const t = traces.get(trace);
  if (!t) return [];
  const chain = reg.chains.find((c) => c.id === t.chain);
  const all = Object.entries(chain.steps).flatMap(([proj, steps]) => steps.map((step) => ({ proj, step })));
  return all
    .map((s, i) => ({ ...s, at: t.at + (i + 1) * 600 }))
    .filter((s) => s.proj === p.name && s.at <= Date.now() && s.step !== "ack-sent")
    .map((s) => ({ at: new Date(s.at).toISOString(), step: s.step, detail: "stub" }));
}

const selftest = (p) => `<!doctype html><title>selftest</title><script>
const allowed = ${JSON.stringify(ORIGINS)};
const report = ${JSON.stringify({ ...health(p), ok: true, ms: 64, vars: [] })};
report.checks = [
  { id: "peer:catalog-api", label: "Browser CORS call to catalog-api", ok: true, ms: 31, env: ["CATALOG_URL"], hops: ["angular-static@s4", "catalog-api@s2"] },
  { id: "peer:search-svc", label: "Browser CORS call to search-svc", ok: true, ms: 33, env: ["SEARCH_URL"], hops: ["angular-static@s4", "search-svc@s2"] },
];
report.vars = [
  { name: "CATALOG_URL", value: ${JSON.stringify(byName.get("catalog-api").url)}, role: "url", peer: "catalog-api" },
  { name: "SEARCH_URL", value: ${JSON.stringify(byName.get("search-svc").url)}, role: "url", peer: "search-svc" },
];
addEventListener("message", (e) => {
  if (!allowed.includes(e.origin) || e.data?.type !== "zoo-probe") return;
  e.source.postMessage({ type: "zoo-probe-result", probe: { ...report, at: new Date().toISOString() } }, e.origin);
});
</script>`;

function handle(p, req, res) {
  const url = new URL(req.url, "http://localhost");
  const cors = p.name !== "symfony-notes";
  if (req.method === "OPTIONS") return send(req, res, cors ? 204 : 404, {}, cors);
  const path = url.pathname;
  if (p.name === "release-lab" && Math.random() < 1 / 40) return send(req, res, 503, { error: "stub drop" }, cors);
  if (path === "/_zoo/health" || path === "/_zoo/health.json") return send(req, res, 200, health(p), cors);
  if (path === "/selftest" && p.probe === "iframe") return send(req, res, 200, selftest(p), false);
  if (path === "/_zoo/probe") {
    if (p.name === "cron-ledger") return send(req, res, 500, { error: "stub probe crashed" }, cors);
    return setTimeout(() => send(req, res, 200, probe(p), cors), 150 + Math.random() * 600);
  }
  if (path === "/_zoo/verify" && p.vars.verifies.length) {
    return send(req, res, 200, { ok: true, name: p.name, public_url: p.url, verified_by: p.vars.verifies[0], key_fp: fp(keyValue(p.name, p.vars.verifies[0])), caller: "stub", server: p.server, release: release(p) });
  }
  const trace = path.match(/^\/_zoo\/trace\/([^/]+)$/);
  if (trace && req.method === "GET") {
    if (!TRACE_RE.test(trace[1])) return send(req, res, 400, { error: "bad trace id" }, cors);
    const hops = hopsFor(p, trace[1]);
    return send(req, res, 200, { trace: trace[1], found: hops.length > 0, hops }, cors);
  }
  const chain = path.match(/^\/_zoo\/chain\/([a-z-]+)$/);
  if (chain && req.method === "POST" && reg.chains.some((c) => c.id === chain[1] && c.starter === p.name)) {
    let body = "";
    req.on("data", (d) => (body += d).length > 4096 && req.destroy());
    return req.on("end", () => {
      const now = Date.now();
      while (starts.length && starts[0] < now - 60000) starts.shift();
      if (starts.length >= 10) return send(req, res, 429, { error: "rate limited" }, cors);
      let t;
      try { t = JSON.parse(body).trace; } catch { t = null; }
      if (typeof t !== "string" || !TRACE_RE.test(t)) return send(req, res, 400, { error: "bad trace id" }, cors);
      starts.push(now);
      traces.set(t, { chain: chain[1], at: now });
      send(req, res, 202, { trace: t, started: true }, cors);
    });
  }
  send(req, res, 404, { error: "not found" }, cors);
}

createServer((req, res) => {
  if (req.method === "OPTIONS") return send(req, res, 204, {});
  if (req.url === "/projects.json") return send(req, res, 200, local);
  send(req, res, 404, { error: "not found" });
}).listen(BASE, "127.0.0.1");

for (const p of local.projects) {
  if (p.probe === "self" || p.name === "next-prisma") continue;
  createServer((req, res) => handle(p, req, res)).listen(port(p.name), "127.0.0.1");
}
console.log(`stub zoo: registry http://127.0.0.1:${BASE}/projects.json, projects on ${BASE + 2}..${BASE + reg.projects.length}`);
console.log("open http://localhost:5173/?registry=local (dev) or http://localhost:4173/?registry=local (preview)");

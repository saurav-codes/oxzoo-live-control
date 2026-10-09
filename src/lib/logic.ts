import type { Chain, Project, Registry } from "./registry";

export interface Health {
  name: string;
  stack?: string;
  server?: string;
  release?: string;
  env?: string;
  uptime_s?: number;
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
  env?: string[];
  hops?: string[];
}

export interface ZooVar {
  name: string;
  role: "signs" | "verifies" | "reference" | "url" | "plain" | "service";
  fp?: string;
  value?: string;
  peer?: string;
  missing?: boolean;
}

export interface Probe {
  name: string;
  ok: boolean;
  ms: number;
  at?: string;
  release?: string;
  checks: Check[];
  vars: ZooVar[];
}

export interface Hop {
  at: string;
  step: string;
  detail?: string;
}

export type Match = "match" | "mismatch" | "unknown";

export const TRACE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LEVELS = ["P1", "P2", "P3", "P4"];
export const levelNum = (p: string) => LEVELS.indexOf(p) + 1;

// Proof level actually reached (0 = health failed), capped at the declared max.
// P2: every local check passed. P3: peer checks passed and the shared keys and URL
// values this project takes part in match its peers. P4: one of its chains passed.
export function proofLevel(max: string, s: { healthOk: boolean; probe?: Probe; cross: Match; chainPassed: boolean }): number {
  const cap = levelNum(max);
  if (!s.healthOk) return 0;
  let lvl = 1;
  const local = s.probe?.checks.filter((c) => !c.id.startsWith("peer:")) ?? [];
  const peers = s.probe?.checks.filter((c) => c.id.startsWith("peer:")) ?? [];
  if (s.probe && local.every((c) => c.ok)) lvl = 2;
  if (lvl === 2 && peers.every((c) => c.ok) && s.cross !== "mismatch" && (peers.length > 0 || s.cross === "match")) lvl = 3;
  if (lvl === 3 && s.chainPassed) lvl = 4;
  return Math.min(lvl, cap);
}

export interface KeyEntry {
  project: string;
  role: "signs" | "verifies";
  fp?: string;
  missing?: boolean;
}

export interface KeyFlow {
  key: string;
  entries: KeyEntry[];
  status: Match;
}

// For each shared secret: who signs, who verifies, and whether the fps agree.
export function keyFlows(reg: Registry, probes: Record<string, Probe | undefined>): KeyFlow[] {
  const keys = new Map<string, KeyEntry[]>();
  for (const p of reg.projects) {
    for (const role of ["signs", "verifies"] as const) {
      for (const key of p.vars[role]) {
        const v = probes[p.name]?.vars?.find((x) => x.name === key);
        const list = keys.get(key) ?? [];
        list.push({ project: p.name, role, fp: v?.fp, missing: v?.missing });
        keys.set(key, list);
      }
    }
  }
  return [...keys].map(([key, entries]) => ({ key, entries, status: fpStatus(entries) }));
}

export function fpStatus(entries: { fp?: string; missing?: boolean }[]): Match {
  if (entries.some((e) => e.missing)) return "mismatch";
  const fps = entries.map((e) => e.fp).filter((f): f is string => !!f);
  if (new Set(fps).size > 1) return "mismatch";
  return fps.length >= 2 ? "match" : "unknown";
}

export interface UrlFlow {
  project: string;
  name: string;
  peer: string;
  expected: string;
  value?: string;
  status: Match;
}

// URL variables: the value a project reports vs the peer's public URL.
export function urlFlows(reg: Registry, probes: Record<string, Probe | undefined>): UrlFlow[] {
  const urls = new Map(reg.projects.map((p) => [p.name, p.url]));
  const out: UrlFlow[] = [];
  for (const p of reg.projects) {
    for (const [name, peer] of Object.entries(p.vars.urls)) {
      const v = probes[p.name]?.vars?.find((x) => x.name === name);
      const expected = urls.get(peer) ?? "";
      const status: Match = v?.missing ? "mismatch" : v?.value === undefined ? "unknown" : v.value.replace(/\/$/, "") === expected ? "match" : "mismatch";
      out.push({ project: p.name, name, peer, expected, value: v?.value, status });
    }
  }
  return out;
}

export interface RefFlow {
  project: string;
  name: string;
  peer: string;
  fp?: string;
  peerFp?: string;
  status: Match;
}

// ox references like CELERY_BROKER_URL=${REDIS_URL}: both fps must be equal.
export function refFlows(probes: Record<string, Probe | undefined>): RefFlow[] {
  const out: RefFlow[] = [];
  for (const [project, probe] of Object.entries(probes)) {
    for (const v of probe?.vars ?? []) {
      if (v.role !== "reference" || !v.peer) continue;
      const peerFp = probe!.vars.find((x) => x.name === v.peer)?.fp;
      const status: Match = v.missing ? "mismatch" : !v.fp || !peerFp ? "unknown" : v.fp === peerFp ? "match" : "mismatch";
      out.push({ project, name: v.name, peer: v.peer, fp: v.fp, peerFp, status });
    }
  }
  return out;
}

export interface KeyPair {
  key: string;
  signer: string;
  verifier: string;
  status: Match;
}

// Who actually calls whom: a signer with a URL variable pointing at a project that
// verifies one of its keys. These are exactly the DESIGN.md allowlists.
export function keyPairs(reg: Registry, keys: KeyFlow[]): KeyPair[] {
  const out: KeyPair[] = [];
  for (const p of reg.projects) {
    for (const peer of Object.values(p.vars.urls)) {
      const v = reg.projects.find((x) => x.name === peer);
      for (const key of p.vars.signs.filter((k) => v?.vars.verifies.includes(k))) {
        const entries = keys.find((k) => k.key === key)?.entries ?? [];
        const pick = (name: string, role: string) => entries.filter((e) => e.project === name && e.role === role);
        out.push({ key, signer: p.name, verifier: peer, status: fpStatus([...pick(p.name, "signs"), ...pick(peer, "verifies")]) });
      }
    }
  }
  return out;
}

// Cross-server status of one project over its own key pairs and URL values:
// any mismatch wins, then any match.
export function projectCross(name: string, pairs: KeyPair[], urls: UrlFlow[]): Match {
  const mine: Match[] = [
    ...pairs.filter((k) => k.signer === name || k.verifier === name).map((k) => k.status),
    ...urls.filter((u) => u.project === name).map((u) => u.status),
  ];
  if (mine.includes("mismatch")) return "mismatch";
  return mine.includes("match") ? "match" : "unknown";
}

export interface StepState {
  project: string;
  step: string;
  done: boolean;
  ms?: number;
}

export function chainProgress(chain: Chain, hops: Record<string, Hop[] | undefined>, startedAt: number) {
  const steps: StepState[] = [];
  for (const [project, names] of Object.entries(chain.steps)) {
    for (const step of names) {
      const hop = hops[project]?.find((h) => h.step === step);
      const t = hop ? Date.parse(hop.at) : NaN;
      steps.push({ project, step, done: !!hop, ms: hop && !Number.isNaN(t) ? Math.max(0, t - startedAt) : undefined });
    }
  }
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}

// Projects whose probe needs the static health file instead of a live endpoint.
export function healthPath(p: Project): string {
  return p.probe === "server" ? "/_zoo/health" : "/_zoo/health.json";
}

export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

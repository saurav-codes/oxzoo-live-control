export type ProofLevel = "P1" | "P2" | "P3" | "P4";
export type ProbeMode = "server" | "iframe" | "self";

export interface Project {
  name: string;
  server: string;
  url: string;
  stack: string;
  kind: string;
  services: string[];
  processes: string[];
  proof: ProofLevel;
  ox_features: string[];
  links: { label: string; path: string }[];
  vars: { signs: string[]; verifies: string[]; urls: Record<string, string> };
  chains: string[];
  probe: ProbeMode;
}

export interface Chain {
  id: string;
  title: string;
  starter: string;
  steps: Record<string, string[]>;
}

export interface Server {
  id: string;
  droplet: string;
  domain: string;
}

export interface Registry {
  version: number;
  servers: Server[];
  chains: Chain[];
  projects: Project[];
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const VAR = /^[A-Z][A-Z0-9_]{0,63}$/;
const URL_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;
const PROOFS = ["P1", "P2", "P3", "P4"];
const MODES = ["server", "iframe", "self"];

// Returns every problem at once; an empty list means the registry is usable.
export function validateRegistry(reg: Registry): string[] {
  const errs: string[] = [];
  if (!reg || !Array.isArray(reg.projects) || !Array.isArray(reg.chains) || !Array.isArray(reg.servers)) {
    return ["registry needs servers, chains and projects arrays"];
  }
  const servers = new Set(reg.servers.map((s) => s.id));
  const names = new Set<string>();
  const chainIds = new Set(reg.chains.map((c) => c.id));
  for (const p of reg.projects) {
    const at = `project ${p.name}`;
    if (!NAME.test(p.name)) errs.push(`${at}: bad name`);
    if (names.has(p.name)) errs.push(`${at}: duplicate`);
    names.add(p.name);
    if (!servers.has(p.server)) errs.push(`${at}: unknown server ${p.server}`);
    if (!URL_RE.test(p.url)) errs.push(`${at}: bad url ${p.url}`);
    if (!PROOFS.includes(p.proof)) errs.push(`${at}: bad proof ${p.proof}`);
    if (!MODES.includes(p.probe)) errs.push(`${at}: bad probe mode ${p.probe}`);
    for (const k of [...p.vars.signs, ...p.vars.verifies, ...Object.keys(p.vars.urls)]) {
      if (!VAR.test(k)) errs.push(`${at}: bad variable name ${k}`);
    }
    for (const l of p.links) {
      if (!l.path.startsWith("/") && !l.path.startsWith("https://")) errs.push(`${at}: bad link ${l.path}`);
    }
    for (const c of p.chains) if (!chainIds.has(c)) errs.push(`${at}: unknown chain ${c}`);
  }
  for (const p of reg.projects) {
    for (const [k, peer] of Object.entries(p.vars.urls)) {
      if (!names.has(peer)) errs.push(`project ${p.name}: ${k} points at unknown project ${peer}`);
    }
  }
  for (const c of reg.chains) {
    if (!names.has(c.starter)) errs.push(`chain ${c.id}: unknown starter ${c.starter}`);
    for (const member of Object.keys(c.steps)) {
      if (!names.has(member)) errs.push(`chain ${c.id}: unknown member ${member}`);
      const p = reg.projects.find((x) => x.name === member);
      if (p && !p.chains.includes(c.id)) errs.push(`chain ${c.id}: ${member} does not list it`);
    }
  }
  return errs;
}

// `?registry=local` loads the registry served by scripts/stub-server.mjs.
export function registryUrl(search: string): string {
  return new URLSearchParams(search).get("registry") === "local"
    ? "http://127.0.0.1:4400/projects.json"
    : "/projects.json";
}

export async function loadRegistry(search: string): Promise<Registry> {
  const res = await fetch(registryUrl(search), { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
  const reg = (await res.json()) as Registry;
  const errs = validateRegistry(reg);
  if (errs.length) throw new Error(`registry invalid: ${errs.join("; ")}`);
  return reg;
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

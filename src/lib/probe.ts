import type { Health, Hop, Probe } from "./logic";
import { healthPath } from "./logic";
import type { Project, Registry } from "./registry";
import { validateRegistry } from "./registry";

export class FetchError extends Error {}

// Every outbound call has a timeout; network and CORS failures read the same in a
// browser (an opaque TypeError), so both are reported together.
export async function fetchJSON<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error).name;
    throw new FetchError(name === "TimeoutError" || name === "AbortError" ? `timeout after ${timeoutMs} ms` : "network or CORS error");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 202) throw new FetchError(body?.error ? `HTTP ${res.status}: ${body.error}` : `HTTP ${res.status}`);
  if (body === null) throw new FetchError("response is not JSON");
  return body as T;
}

function base(p: Project): string {
  return p.probe === "self" ? location.origin : p.url;
}

export async function getHealth(p: Project): Promise<{ health: Health; ms: number }> {
  const t = performance.now();
  const health = await fetchJSON<Health>(base(p) + healthPath(p), 8000);
  return { health, ms: Math.round(performance.now() - t) };
}

export function getProbe(p: Project, reg: Registry): Promise<Probe> {
  if (p.probe === "self") return selfProbe(reg);
  if (p.probe === "iframe") return iframeProbe(p.url);
  return fetchJSON<Probe>(p.url + "/_zoo/probe", 25000);
}

async function timed(id: string, label: string, fn: () => Promise<string>) {
  const t = performance.now();
  try {
    const detail = await fn();
    return { id, label, ok: true, ms: Math.round(performance.now() - t), detail, env: [], hops: ["zoo-control@s1"] };
  } catch (e) {
    return { id, label, ok: false, ms: Math.round(performance.now() - t), error: (e as Error).message, env: [], hops: ["zoo-control@s1"] };
  }
}

// zoo-control has no server, so it proves what it can from the browser.
async function selfProbe(reg: Registry): Promise<Probe> {
  const t = performance.now();
  const checks = await Promise.all([
    timed("registry", "Registry loads and validates", async () => {
      const errs = validateRegistry(reg);
      if (errs.length) throw new Error(errs[0]);
      return `${reg.projects.length} projects, ${reg.chains.length} chains`;
    }),
    timed("health-file", "Build-time health file", async () => {
      const h = await fetchJSON<Health>("/_zoo/health.json", 5000);
      if (h.name !== "zoo-control") throw new Error(`name is ${h.name}`);
      return `release ${h.release}`;
    }),
    timed("storage", "localStorage write, read, delete", async () => {
      const k = "zoo-control:probe", v = crypto.randomUUID();
      localStorage.setItem(k, v);
      const back = localStorage.getItem(k);
      localStorage.removeItem(k);
      if (back !== v) throw new Error("read back differs");
      return "round trip";
    }),
  ]);
  return { name: "zoo-control", ok: checks.every((c) => c.ok), ms: Math.round(performance.now() - t), at: new Date().toISOString(), checks, vars: [] };
}

// angular-static is static, so its browser-side probe runs in a hidden iframe and
// answers by postMessage. Only a reply from that exact origin and window counts.
export function iframeProbe(url: string, timeoutMs = 10000): Promise<Probe> {
  const origin = new URL(url).origin;
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = url + "/selftest";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  return new Promise<Probe>((resolve, reject) => {
    let retry: number | undefined;
    const done = () => {
      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener("message", onMessage);
      frame.remove();
    };
    const timer = window.setTimeout(() => {
      done();
      reject(new FetchError(`no reply from ${origin}/selftest within ${timeoutMs} ms`));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== origin || ev.source !== frame.contentWindow) return;
      const d = ev.data;
      const probe = d?.type === "zoo-probe-result" ? d.probe : d;
      if (!probe || !Array.isArray(probe.checks)) return;
      done();
      resolve({ ...probe, vars: Array.isArray(probe.vars) ? probe.vars : [] });
    };
    window.addEventListener("message", onMessage);
    // The selftest app may register its listener after the load event, so ask again until it answers.
    const ask = () => frame.contentWindow?.postMessage({ type: "zoo-probe" }, origin);
    frame.addEventListener("load", () => {
      ask();
      retry = window.setInterval(ask, 1000);
    });
    document.body.appendChild(frame);
  });
}

export function startChain(starter: Project, chain: string, trace: string) {
  return fetchJSON<{ trace: string; started: boolean }>(`${starter.url}/_zoo/chain/${chain}`, 8000, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trace }),
  });
}

export function getTrace(p: Project, trace: string) {
  return fetchJSON<{ trace: string; found: boolean; hops: Hop[] }>(`${p.url}/_zoo/trace/${trace}`, 5000);
}

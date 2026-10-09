import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Health, Probe } from "./lib/logic";
import { keyFlows, keyPairs, pool, projectCross, proofLevel, urlFlows } from "./lib/logic";
import type { Project, Registry } from "./lib/registry";
import { loadRegistry } from "./lib/registry";
import { appendHistory, loadChainPasses, loadHistory, saveHistory } from "./lib/history";
import { getHealth, getProbe } from "./lib/probe";
import { Overview } from "./views/Overview";
import { Drawer } from "./views/Drawer";
import { RunAll } from "./views/RunAll";
import { Flow } from "./views/Flow";
import { Chains } from "./views/Chains";
import { Watch } from "./views/Watch";

export interface Result {
  health?: Health;
  healthMs?: number;
  healthError?: string;
  probe?: Probe;
  probeError?: string;
  busy?: boolean;
}

export type Results = Record<string, Result>;

const TABS = [
  ["overview", "Overview"],
  ["run", "Run everything"],
  ["vars", "Variable flow"],
  ["chains", "Chains"],
  ["watch", "Zero downtime"],
] as const;
type Tab = (typeof TABS)[number][0];

function levels(reg: Registry, results: Results, passes: Record<string, number>): Record<string, number> {
  const probes = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.probe]));
  const pairs = keyPairs(reg, keyFlows(reg, probes));
  const urls = urlFlows(reg, probes);
  return Object.fromEntries(
    reg.projects.map((p) => {
      const r = results[p.name] ?? {};
      const cross = projectCross(p.name, pairs, urls);
      return [p.name, proofLevel(p.proof, { healthOk: !!r.health, probe: r.probe, cross, chainPassed: p.chains.some((c) => passes[c]) })];
    }),
  );
}

const tabFromHash = (): Tab => (TABS.find(([id]) => `#${id}` === location.hash)?.[0] ?? "overview");

export function App() {
  const [reg, setReg] = useState<Registry>();
  const [loadErr, setLoadErr] = useState<string>();
  const [results, setResults] = useState<Results>({});
  const [hist, setHist] = useState(loadHistory);
  const [passes, setPasses] = useState(loadChainPasses);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<Results>({});

  const patch = useCallback((name: string, r: Partial<Result>) => {
    ref.current = { ...ref.current, [name]: { ...ref.current[name], ...r } };
    setResults(ref.current);
  }, []);

  const checkHealth = useCallback(
    async (p: Project) => {
      try {
        const { health, ms } = await getHealth(p);
        patch(p.name, { health, healthMs: ms, healthError: undefined });
        return true;
      } catch (e) {
        patch(p.name, { health: undefined, healthMs: undefined, healthError: (e as Error).message });
        return false;
      }
    },
    [patch],
  );

  const probeOne = useCallback(
    async (p: Project) => {
      if (!reg || ref.current[p.name]?.busy) return;
      patch(p.name, { busy: true });
      if (await checkHealth(p)) {
        try {
          patch(p.name, { probe: await getProbe(p, reg), probeError: undefined });
        } catch (e) {
          patch(p.name, { probe: undefined, probeError: (e as Error).message });
        }
      } else {
        patch(p.name, { probe: undefined, probeError: "skipped: health failed" });
      }
      patch(p.name, { busy: false });
      const r = ref.current[p.name];
      const level = levels(reg, ref.current, loadChainPasses())[p.name];
      setHist((h) => {
        const next = appendHistory(h, p.name, { at: Date.now(), ok: !!r.probe?.ok, ms: r.probe?.ms ?? r.healthMs ?? 0, level });
        saveHistory(next);
        return next;
      });
    },
    [reg, patch, checkHealth],
  );

  useEffect(() => {
    loadRegistry(location.search).then(setReg, (e) => setLoadErr((e as Error).message));
  }, []);

  useEffect(() => {
    if (reg) pool(reg.projects, 8, async (p) => void (await checkHealth(p)));
  }, [reg, checkHealth]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const lv = useMemo(() => (reg ? levels(reg, results, passes) : {}), [reg, results, passes]);

  if (loadErr) return <main className="page"><p className="error">Could not load the registry: {loadErr}</p></main>;
  if (!reg) return <main className="page"><p className="muted">Loading registry...</p></main>;

  const openProject = reg.projects.find((p) => p.name === open);
  return (
    <>
      <header className="top">
        <div className="brand">
          <strong>zoo-control</strong>
          <span className="muted small">{reg.projects.length} projects on {reg.servers.length} servers</span>
        </div>
        <nav className="tabs" aria-label="Views">
          {TABS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className={tab === id ? "tab active" : "tab"} aria-current={tab === id ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main className="page">
        {tab === "overview" && <Overview reg={reg} results={results} levels={lv} hist={hist} onOpen={setOpen} />}
        {tab === "run" && <RunAll reg={reg} results={results} probeOne={probeOne} onOpen={setOpen} />}
        {tab === "vars" && <Flow reg={reg} results={results} />}
        {tab === "chains" && <Chains reg={reg} onPass={() => setPasses(loadChainPasses())} />}
        {tab === "watch" && <Watch project={reg.projects.find((p) => p.name === "release-lab")} />}
      </main>
      {openProject && (
        <Drawer
          project={openProject}
          result={results[openProject.name] ?? {}}
          level={lv[openProject.name] ?? 0}
          hist={hist[openProject.name] ?? []}
          probeOne={probeOne}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

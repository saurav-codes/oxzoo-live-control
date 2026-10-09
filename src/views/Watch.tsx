import { useEffect, useRef, useState } from "react";
import type { Health } from "../lib/logic";
import type { Project } from "../lib/registry";
import { fetchJSON } from "../lib/probe";
import { Dot } from "./ui";

interface Stats {
  sent: number;
  errors: number;
  changes: number;
  release?: string;
  releases: string[];
  lastMs?: number;
  lastError?: string;
  since?: number;
}

const EMPTY: Stats = { sent: 0, errors: 0, changes: 0, releases: [] };
const EVERY_MS = 500;

// C6: poll release-lab health while the owner deploys; any failed request is downtime.
export function Watch({ project }: { project?: Project }) {
  const [on, setOn] = useState(false);
  const [s, setS] = useState<Stats>(EMPTY);
  const busy = useRef(false);

  useEffect(() => {
    if (!on || !project) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      const t = performance.now();
      try {
        const h = await fetchJSON<Health>(project.url + "/_zoo/health", 3000);
        const ms = Math.round(performance.now() - t);
        setS((p) => {
          const changed = p.release !== undefined && h.release !== p.release;
          return {
            ...p, sent: p.sent + 1, lastMs: ms, lastError: undefined, release: h.release,
            changes: p.changes + (changed ? 1 : 0),
            releases: changed || !p.releases.length ? [...p.releases, h.release ?? "?"].slice(-10) : p.releases,
          };
        });
      } catch (e) {
        setS((p) => ({ ...p, sent: p.sent + 1, errors: p.errors + 1, lastError: (e as Error).message }));
      } finally {
        busy.current = false;
      }
    };
    const id = setInterval(tick, EVERY_MS);
    tick();
    return () => clearInterval(id);
  }, [on, project]);

  if (!project) return <p className="error">release-lab is not in the registry.</p>;
  const start = () => {
    setS({ ...EMPTY, since: Date.now() });
    setOn(true);
  };
  return (
    <section>
      <p className="muted small">Polls {project.url}/_zoo/health every {EVERY_MS} ms. Deploy, promote or roll back release-lab while this runs: errors must stay at 0 while the release id changes.</p>
      <div className="row wrap">
        {on ? <button className="btn" onClick={() => setOn(false)}>Stop</button> : <button className="btn primary" onClick={start}>Start watching</button>}
        <Dot tone={!on ? "idle" : s.lastError ? "bad" : "ok"} label={on ? "watching" : "stopped"} />
        {s.since && <span className="muted small">{Math.round((Date.now() - s.since) / 1000)} s</span>}
      </div>
      <div className="stats">
        <div><span className="stat">{s.sent}</span><span className="muted small">requests</span></div>
        <div className={s.errors ? "bad-text" : ""}><span className="stat">{s.errors}</span><span className="muted small">errors</span></div>
        <div><span className="stat">{s.changes}</span><span className="muted small">release changes</span></div>
        <div><span className="stat">{s.lastMs ?? "-"}</span><span className="muted small">last ms</span></div>
      </div>
      {s.lastError && <p className="error">Last error: {s.lastError}</p>}
      {s.releases.length > 0 && <p className="small">Releases seen: {s.releases.map((r, i) => <code key={i} className="chip">{r}</code>)}</p>}
    </section>
  );
}

import { useState } from "react";
import type { Results } from "../App";
import { pool } from "../lib/logic";
import type { Project, Registry } from "../lib/registry";
import { CheckRow, Dot } from "./ui";

interface Props {
  reg: Registry;
  results: Results;
  probeOne: (p: Project) => Promise<void>;
  onOpen: (name: string) => void;
}

export function RunAll({ reg, results, probeOne, onOpen }: Props) {
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<{ at: number; ms: number } | null>(null);

  const run = async () => {
    setRunning(true);
    const t = performance.now();
    await pool(reg.projects, 8, probeOne);
    setRan({ at: Date.now(), ms: Math.round(performance.now() - t) });
    setRunning(false);
  };

  const done = reg.projects.filter((p) => results[p.name]?.probe || results[p.name]?.probeError);
  const failed = done.filter((p) => !results[p.name]?.probe?.ok);
  const passed = done.length - failed.length;
  return (
    <section>
      <div className="row wrap">
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? `Running ${done.length}/${reg.projects.length}...` : "Run everything"}
        </button>
        <span className="summary">
          <span className="ok-text">{passed} passed</span> / <span className="bad-text">{failed.length} failed</span>
          <span className="muted small"> of {reg.projects.length}{ran ? ` · ${(ran.ms / 1000).toFixed(1)} s` : ""}</span>
        </span>
      </div>
      <p className="muted small">Probes every project from this browser, 8 at a time. Failing checks open below.</p>
      {failed.map((p) => {
        const r = results[p.name];
        return (
          <article key={p.name} className="card bad">
            <button className="card-head" onClick={() => onOpen(p.name)}>
              <Dot tone="bad" /> <strong>{p.name}</strong> <span className="muted small">{p.server}</span>
            </button>
            {r.healthError && <p className="error">Health: {r.healthError}</p>}
            {r.probeError && <p className="error">Probe: {r.probeError}</p>}
            <ul className="checks">{r.probe?.checks.filter((c) => !c.ok).map((c) => <CheckRow key={c.id} c={c} />)}</ul>
          </article>
        );
      })}
      <div className="passed-list">
        {done
          .filter((p) => results[p.name]?.probe?.ok)
          .map((p) => (
            <button key={p.name} className="pill" onClick={() => onOpen(p.name)}>
              <Dot tone="ok" /> {p.name} <span className="muted small">{results[p.name].probe!.ms} ms</span>
            </button>
          ))}
      </div>
    </section>
  );
}

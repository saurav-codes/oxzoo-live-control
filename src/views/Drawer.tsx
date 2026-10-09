import { useEffect } from "react";
import type { Result } from "../App";
import type { HistEntry } from "../lib/history";
import type { Project } from "../lib/registry";
import { hostOf } from "../lib/registry";
import { CheckRow, Chips, Sparkline } from "./ui";

interface Props {
  project: Project;
  result: Result;
  level: number;
  hist: HistEntry[];
  probeOne: (p: Project) => Promise<void>;
  onClose: () => void;
}

export function Drawer({ project: p, result: r, level, hist, probeOne, onClose }: Props) {
  useEffect(() => {
    probeOne(p);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Run the probe once per opened project.
  }, [p.name]);

  const link = (path: string) => (path.startsWith("https://") ? path : p.url + path);
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={p.name} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>{p.name}</h2>
            <div className="muted small">{p.stack} · {p.server} · {hostOf(p.url)}</div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="row wrap">
          <span className="level big">P{level}/{p.proof}</span>
          <span className="muted small">release {r.health?.release ?? "?"} · {r.health?.env ?? "?"}</span>
          <button className="btn" disabled={r.busy} onClick={() => probeOne(p)}>{r.busy ? "Probing..." : "Probe again"}</button>
        </div>
        <div className="row wrap">
          {p.links.map((l) => (
            <a key={l.path} className="btn ghost" href={link(l.path)} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
        </div>
        {r.healthError && <p className="error">Health: {r.healthError}</p>}
        {r.probeError && <p className="error">Probe: {r.probeError}</p>}
        {r.probe && (
          <>
            <h3>
              Checks <span className="muted small">{r.probe.checks.filter((c) => c.ok).length}/{r.probe.checks.length} ok · {r.probe.ms} ms</span>
            </h3>
            <ul className="checks">{r.probe.checks.map((c) => <CheckRow key={c.id} c={c} />)}</ul>
            {r.probe.vars.length > 0 && (
              <>
                <h3>Variables</h3>
                <ul className="vars">
                  {r.probe.vars.map((v) => (
                    <li key={v.name} className={v.missing ? "error" : undefined}>
                      <Chips items={[v.name]} /> <span className="muted small">{v.role}</span>{" "}
                      {v.missing ? "missing" : v.fp ? <code>fp {v.fp}</code> : <code className="ellipsis">{v.value}</code>}
                      {v.peer && <span className="muted small"> peer {v.peer}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <h3>History <span className="muted small">{hist.length} runs, this browser</span></h3>
        <Sparkline data={hist} width={280} height={40} />
        <div className="muted small">
          Services: {p.services.join(", ") || "none"} · Processes: {p.processes.join(", ") || "static"} · ox: {p.ox_features.join(", ")}
        </div>
      </aside>
    </div>
  );
}

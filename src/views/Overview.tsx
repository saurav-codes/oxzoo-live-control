import type { Result, Results } from "../App";
import type { History } from "../lib/history";
import { levelNum } from "../lib/logic";
import type { Project, Registry } from "../lib/registry";
import { hostOf } from "../lib/registry";
import type { Tone } from "./ui";
import { Dot, Sparkline } from "./ui";

export function toneOf(r: Result | undefined, level: number, max: number): Tone {
  if (!r || (!r.health && !r.healthError)) return "idle";
  if (!r.health) return "bad";
  if (r.probe && !r.probe.ok) return "warn";
  if (r.probeError) return "warn";
  return level >= max || !r.probe ? "ok" : "warn";
}

interface Props {
  reg: Registry;
  results: Results;
  levels: Record<string, number>;
  hist: History;
  onOpen: (name: string) => void;
}

export function Overview({ reg, results, levels, hist, onOpen }: Props) {
  return (
    <>
      <section className="strip" aria-label="Servers">
        {reg.servers.map((s) => {
          const ps = reg.projects.filter((p) => p.server === s.id);
          const up = ps.filter((p) => results[p.name]?.health).length;
          const down = ps.filter((p) => results[p.name]?.healthError).length;
          return (
            <a key={s.id} className="strip-item" href={`#server-${s.id}`}>
              <Dot tone={down ? "bad" : up === ps.length ? "ok" : "idle"} />
              <strong>{s.id}</strong>
              <span className="muted small">{up}/{ps.length} up</span>
            </a>
          );
        })}
      </section>
      {reg.servers.map((s) => (
        <section key={s.id} id={`server-${s.id}`} className="group">
          <h2>
            {s.id} <span className="muted small">{s.droplet} · *.{s.domain}</span>
          </h2>
          <div className="tiles">
            {reg.projects
              .filter((p) => p.server === s.id)
              .map((p) => (
                <Tile key={p.name} p={p} r={results[p.name]} level={levels[p.name] ?? 0} hist={hist[p.name] ?? []} onOpen={onOpen} />
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Tile({ p, r, level, hist, onOpen }: { p: Project; r?: Result; level: number; hist: History[string]; onOpen: (n: string) => void }) {
  const max = levelNum(p.proof);
  const tone = toneOf(r, level, max);
  return (
    <button className={`tile ${tone}`} onClick={() => onOpen(p.name)} aria-label={`${p.name}, open details`}>
      <div className="tile-head">
        <Dot tone={tone} />
        <strong className="tile-name">{p.name}</strong>
        <span className="level" title="proof level reached / max">
          {level ? `P${level}` : "P0"}/{p.proof}
        </span>
      </div>
      <div className="muted small ellipsis">{p.stack}</div>
      <div className="muted small ellipsis">{hostOf(p.url)}</div>
      <div className="tile-foot small">
        <span className="ellipsis">{r?.health?.release ?? (r?.healthError ? <span className="error">{r.healthError}</span> : "...")}</span>
        <span className="ms">{r?.healthMs !== undefined ? `${r.healthMs} ms` : ""}</span>
      </div>
      <Sparkline data={hist} />
    </button>
  );
}

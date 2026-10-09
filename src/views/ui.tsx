import type { Check, Match } from "../lib/logic";
import type { HistEntry } from "../lib/history";

export type Tone = "ok" | "warn" | "bad" | "idle";

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot ${tone}`} role="img" aria-label={label ?? tone} />;
}

export function MatchBadge({ m }: { m: Match }) {
  const text = { match: "match", mismatch: "mismatch", unknown: "not probed" }[m];
  return <span className={`badge ${m}`}>{text}</span>;
}

export function Chips({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <span className="chips">
      {items.map((v) => (
        <code key={v} className="chip">{v}</code>
      ))}
    </span>
  );
}

export function Hops({ hops }: { hops?: string[] }) {
  if (!hops?.length) return null;
  return <span className="hops">{hops.join(" -> ")}</span>;
}

export function CheckRow({ c }: { c: Check }) {
  return (
    <li className={`check ${c.ok ? "ok" : "bad"}`}>
      <div className="check-head">
        <Dot tone={c.ok ? "ok" : "bad"} />
        <span className="check-label">{c.label}</span>
        <span className="ms">{c.ms} ms</span>
      </div>
      {c.error && <div className="error">{c.error}</div>}
      {c.detail && <div className="muted small">{c.detail}</div>}
      <div className="check-meta">
        <Chips items={c.env} />
        <Hops hops={c.hops} />
      </div>
    </li>
  );
}

// Probe time as a line, failures as red ticks on the baseline.
export function Sparkline({ data, width = 96, height = 22 }: { data: HistEntry[]; width?: number; height?: number }) {
  if (data.length < 2) return <span className="spark-empty muted small">{data.length ? "1 run" : "no runs"}</span>;
  const max = Math.max(...data.map((d) => d.ms), 1);
  const step = width / (data.length - 1);
  const pts = data.map((d, i) => `${(i * step).toFixed(1)},${(height - 3 - (d.ms / max) * (height - 6)).toFixed(1)}`);
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`${data.length} runs`}>
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {data.map((d, i) => !d.ok && <rect key={i} x={i * step - 1} y={height - 3} width="2" height="3" className="spark-bad" />)}
    </svg>
  );
}

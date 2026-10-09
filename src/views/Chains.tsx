import { useEffect, useRef, useState } from "react";
import type { Hop } from "../lib/logic";
import { chainProgress } from "../lib/logic";
import type { Chain, Registry } from "../lib/registry";
import { recordChainPass } from "../lib/history";
import { getTrace, startChain } from "../lib/probe";
import { Dot } from "./ui";

interface Run {
  trace: string;
  startedAt: number;
  hops: Record<string, Hop[] | undefined>;
  errors: Record<string, string | undefined>;
  state: "running" | "passed" | "timeout" | "failed";
  error?: string;
}

const POLL_MS = 1000;
const LIMIT_MS = 60000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Chains({ reg, onPass }: { reg: Registry; onPass: () => void }) {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const set = (id: string, r: Partial<Run>) => setRuns((all) => ({ ...all, [id]: { ...all[id], ...r } }));

  const run = async (c: Chain) => {
    const starter = reg.projects.find((p) => p.name === c.starter)!;
    const members = Object.keys(c.steps).map((n) => reg.projects.find((p) => p.name === n)!);
    const trace = crypto.randomUUID();
    const startedAt = Date.now();
    set(c.id, { trace, startedAt, hops: {}, errors: {}, state: "running", error: undefined });
    try {
      await startChain(starter, c.id, trace);
    } catch (e) {
      return set(c.id, { state: "failed", error: `start: ${(e as Error).message}` });
    }
    while (alive.current && Date.now() - startedAt < LIMIT_MS) {
      await sleep(POLL_MS);
      const got = await Promise.all(
        members.map((m) =>
          getTrace(m, trace).then(
            (t) => [m.name, t.hops, undefined] as const,
            (e: Error) => [m.name, undefined, e.message] as const,
          ),
        ),
      );
      const hops = Object.fromEntries(got.map(([n, h]) => [n, h]));
      set(c.id, { hops, errors: Object.fromEntries(got.map(([n, , e]) => [n, e])) });
      if (chainProgress(c, hops, startedAt).complete) {
        recordChainPass(c.id);
        onPass();
        return set(c.id, { state: "passed" });
      }
    }
    if (alive.current) set(c.id, { state: "timeout" });
  };

  return (
    <section className="flows">
      {reg.chains.map((c) => {
        const r = runs[c.id];
        const prog = chainProgress(c, r?.hops ?? {}, r?.startedAt ?? 0);
        const tone = !r ? "idle" : r.state === "passed" ? "ok" : r.state === "running" ? "warn" : "bad";
        return (
          <article key={c.id} className={`card ${r?.state ?? ""}`}>
            <div className="card-head static">
              <Dot tone={tone} />
              <strong>{c.title}</strong>
              <span className="muted small">from {c.starter}</span>
              <button className="btn" disabled={r?.state === "running"} onClick={() => run(c)}>
                {r?.state === "running" ? `${prog.done}/${prog.total}` : "Start"}
              </button>
            </div>
            {r && (
              <div className="muted small">
                trace <code>{r.trace}</code> · {r.state}
                {r.error && <span className="error"> · {r.error}</span>}
              </div>
            )}
            {Object.entries(c.steps).map(([project, steps]) => (
              <div key={project} className="chain-member">
                <div className="small">
                  <strong>{project}</strong>
                  {r?.errors[project] && <span className="error"> {r.errors[project]}</span>}
                </div>
                <ol className="steps">
                  {steps.map((s) => {
                    const st = prog.steps.find((x) => x.project === project && x.step === s)!;
                    return (
                      <li key={s} className={st.done ? "done" : ""}>
                        <Dot tone={st.done ? "ok" : r?.state === "timeout" ? "bad" : "idle"} /> {s}
                        {st.ms !== undefined && <span className="ms"> +{st.ms} ms</span>}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </article>
        );
      })}
    </section>
  );
}

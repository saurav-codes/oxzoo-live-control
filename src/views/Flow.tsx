import type { Results } from "../App";
import { keyFlows, keyPairs, refFlows, urlFlows } from "../lib/logic";
import type { Registry } from "../lib/registry";
import { MatchBadge } from "./ui";

export function Flow({ reg, results }: { reg: Registry; results: Results }) {
  const probes = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.probe]));
  const keys = keyFlows(reg, probes);
  const pairs = keyPairs(reg, keys);
  const refs = refFlows(probes);
  const urls = urlFlows(reg, probes);
  const fp = (e: { fp?: string; missing?: boolean }) => (e.missing ? "missing" : e.fp ?? "?");
  return (
    <section>
      <p className="muted small">Fingerprints come from the latest probe of each project (Run everything fills them all). Only the last 4 hex of sha256 is ever shown.</p>
      <h2>Shared keys</h2>
      <div className="flows">
        {keys.map((k) => (
          <article key={k.key} className={`card ${k.status}`}>
            <div className="card-head static">
              <code>{k.key}</code> <MatchBadge m={k.status} />
            </div>
            {(["signs", "verifies"] as const).map((role) => (
              <div key={role} className="flow-side">
                <span className="muted small">{role === "signs" ? "Signers" : "Verifiers"}</span>
                {k.entries
                  .filter((e) => e.role === role)
                  .map((e) => (
                    <span key={e.project} className={`fp ${e.fp ? "" : "unknown"}`}>
                      {e.project} <code>{fp(e)}</code>
                    </span>
                  ))}
              </div>
            ))}
            <ul className="pairs">
              {pairs
                .filter((p) => p.key === k.key)
                .map((p) => (
                  <li key={p.signer + p.verifier} className={p.status}>
                    {p.signer} {"->"} {p.verifier} <MatchBadge m={p.status} />
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </div>
      <h2>References</h2>
      {refs.length === 0 && <p className="muted small">No reference reported yet (celery-hub and sveltekit-ssr report theirs when probed).</p>}
      <table className="table">
        <tbody>
          {refs.map((r) => (
            <tr key={r.project + r.name}>
              <td>{r.project}</td>
              <td><code>{r.name}</code> = <code>{"${" + r.peer + "}"}</code></td>
              <td><code>{r.fp ?? "?"}</code> vs <code>{r.peerFp ?? "?"}</code></td>
              <td><MatchBadge m={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Peer URLs</h2>
      <table className="table">
        <tbody>
          {urls.map((u) => (
            <tr key={u.project + u.name}>
              <td>{u.project}</td>
              <td><code>{u.name}</code></td>
              <td className="wrap-any">
                <div>{u.value ?? <span className={u.status === "mismatch" ? "error" : "muted"}>{u.status === "mismatch" ? "missing" : "not probed"}</span>}</div>
                <div className="muted small">{u.peer} is {u.expected}</div>
              </td>
              <td><MatchBadge m={u.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

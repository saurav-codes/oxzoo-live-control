import { describe, expect, it } from "vitest";
import type { Probe } from "../src/lib/logic";
import { chainProgress, fpStatus, keyFlows, keyPairs, pool, projectCross, proofLevel, refFlows, TRACE_RE, urlFlows } from "../src/lib/logic";
import { appendHistory } from "../src/lib/history";
import type { Registry } from "../src/lib/registry";
import reg from "../public/projects.json";

const registry = reg as unknown as Registry;

const probe = (checks: [string, boolean][], vars: Probe["vars"] = []): Probe => ({
  name: "x", ok: checks.every(([, ok]) => ok), ms: 10,
  checks: checks.map(([id, ok]) => ({ id, label: id, ok, ms: 1 })), vars,
});

describe("proofLevel", () => {
  const base = { healthOk: true, cross: "unknown" as const, chainPassed: false };
  it("is 0 when health fails, 1 on health alone", () => {
    expect(proofLevel("P4", { ...base, healthOk: false })).toBe(0);
    expect(proofLevel("P4", base)).toBe(1);
  });
  it("needs every local check for P2", () => {
    expect(proofLevel("P4", { ...base, probe: probe([["postgres", true], ["redis", false]]) })).toBe(1);
    expect(proofLevel("P4", { ...base, probe: probe([["postgres", true], ["peer:catalog-api", false]]) })).toBe(2);
  });
  it("needs passing peers or matching keys for P3, and no mismatch", () => {
    const p = probe([["postgres", true], ["peer:catalog-api", true]]);
    expect(proofLevel("P4", { ...base, probe: p })).toBe(3);
    expect(proofLevel("P4", { ...base, probe: p, cross: "mismatch" })).toBe(2);
    expect(proofLevel("P3", { ...base, probe: probe([["postgres", true]]), cross: "match" })).toBe(3);
    expect(proofLevel("P3", { ...base, probe: probe([["postgres", true]]) })).toBe(2);
  });
  it("reaches P4 on a passed chain and caps at the declared max", () => {
    const p = probe([["peer:x", true]]);
    expect(proofLevel("P4", { ...base, probe: p, chainPassed: true })).toBe(4);
    expect(proofLevel("P2", { ...base, probe: p, chainPassed: true })).toBe(2);
    expect(proofLevel("P1", { ...base, probe: p })).toBe(1);
  });
});

describe("fingerprint matching", () => {
  it("fpStatus", () => {
    expect(fpStatus([{ fp: "915a" }, { fp: "915a" }])).toBe("match");
    expect(fpStatus([{ fp: "915a" }, { fp: "0000" }])).toBe("mismatch");
    expect(fpStatus([{ fp: "915a" }, {}])).toBe("unknown");
    expect(fpStatus([{ fp: "915a" }, { fp: "915a" }, { missing: true }])).toBe("mismatch");
  });
  it("keyFlows groups signers and verifiers per shared key", () => {
    const flows = keyFlows(registry, {
      "mesh-shop": probe([], [{ name: "INTERNAL_TOKEN", fp: "915a", role: "signs" }]),
      "catalog-api": probe([], [{ name: "INTERNAL_TOKEN", fp: "915a", role: "verifies" }]),
      "axum-cache": probe([], [{ name: "INTERNAL_TOKEN", fp: "beef", role: "verifies" }]),
    });
    const tok = flows.find((f) => f.key === "INTERNAL_TOKEN")!;
    expect(tok.entries.map((e) => e.project).sort()).toEqual(["axum-cache", "catalog-api", "mesh-shop", "sveltekit-ssr"]);
    expect(tok.status).toBe("mismatch");
    expect(flows.map((f) => f.key).sort()).toEqual(["EVENTS_KEY", "INTERNAL_TOKEN", "SEARCH_INGEST_KEY", "WEBHOOK_SECRET"]);
    // Only real caller pairs count: axum-cache's stale key does not taint mesh-shop.
    const pairs = keyPairs(registry, flows);
    expect(pairs.filter((p) => p.key === "INTERNAL_TOKEN").map((p) => `${p.signer}>${p.verifier}:${p.status}`)).toEqual([
      "sveltekit-ssr>catalog-api:unknown", "sveltekit-ssr>axum-cache:unknown", "mesh-shop>catalog-api:match",
    ]);
    expect(projectCross("mesh-shop", pairs, [])).toBe("match");
    expect(projectCross("catalog-api", pairs, [])).toBe("match");
    expect(projectCross("phoenix-live", pairs, [])).toBe("unknown");
    const withSvelte = keyFlows(registry, {
      "sveltekit-ssr": probe([], [{ name: "INTERNAL_TOKEN", fp: "915a", role: "signs" }]),
      "axum-cache": probe([], [{ name: "INTERNAL_TOKEN", fp: "beef", role: "verifies" }]),
    });
    expect(projectCross("axum-cache", keyPairs(registry, withSvelte), [])).toBe("mismatch");
    expect(keyPairs(registry, withSvelte)).toHaveLength(9);
  });
  it("urlFlows compares the value with the peer's public url", () => {
    const flows = urlFlows(registry, {
      "mesh-shop": probe([], [
        { name: "CATALOG_URL", value: "https://catalog-api.s2.zoo.sorv.dev/", role: "url", peer: "catalog-api" },
        { name: "RAILS_URL", value: "https://rails-queue.s2.zoo.sorv.dev", role: "url", peer: "rails-queue" },
      ]),
    });
    const mine = flows.filter((f) => f.project === "mesh-shop");
    expect(mine.map((f) => f.status)).toEqual(["match", "mismatch"]);
    expect(flows.find((f) => f.project === "celery-hub")!.status).toBe("unknown");
  });
  it("refFlows checks a reference against its peer key", () => {
    const flows = refFlows({
      "celery-hub": probe([], [
        { name: "CELERY_BROKER_URL", fp: "1c2d", role: "reference", peer: "REDIS_URL" },
        { name: "REDIS_URL", fp: "1c2d", role: "service" },
      ]),
      "sveltekit-ssr": probe([], [{ name: "ORIGIN", fp: "aaaa", role: "reference", peer: "PUBLIC_URL" }]),
    });
    expect(flows.map((f) => f.status)).toEqual(["match", "unknown"]);
  });
});

describe("chainProgress", () => {
  const chain = registry.chains.find((c) => c.id === "shop-order")!;
  const t0 = Date.parse("2026-10-09T10:00:00Z");
  it("ticks off expected steps with timings", () => {
    const p = chainProgress(chain, {
      "mesh-shop": [{ at: "2026-10-09T10:00:00.250Z", step: "order-created" }, { at: "2026-10-09T10:00:01Z", step: "catalog-ok" }],
      "catalog-api": [{ at: "2026-10-09T10:00:00.900Z", step: "signed-lookup" }, { at: "x", step: "unexpected" }],
    }, t0);
    expect(p.total).toBe(8);
    expect(p.done).toBe(3);
    expect(p.complete).toBe(false);
    expect(p.steps.find((s) => s.step === "catalog-ok")!.ms).toBe(1000);
    expect(p.steps.find((s) => s.step === "job-done")!.done).toBe(false);
  });
  it("is complete when every step appeared", () => {
    const hops = Object.fromEntries(Object.entries(chain.steps).map(([k, steps]) => [k, steps.map((step) => ({ at: "2026-10-09T10:00:02Z", step }))]));
    expect(chainProgress(chain, hops, t0).complete).toBe(true);
  });
});

describe("helpers", () => {
  it("trace ids", () => {
    expect(TRACE_RE.test(crypto.randomUUID())).toBe(true);
    expect(TRACE_RE.test("not-a-trace")).toBe(false);
    expect(TRACE_RE.test("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe(false);
  });
  it("history keeps the last 50 runs per project", () => {
    let h = {};
    for (let i = 0; i < 60; i++) h = appendHistory(h, "a", { at: i, ok: true, ms: i, level: 1 });
    expect((h as Record<string, unknown[]>).a).toHaveLength(50);
    expect((h as Record<string, { at: number }[]>).a[0].at).toBe(10);
  });
  it("pool never runs more than the limit at once", async () => {
    let live = 0, peak = 0;
    await pool(Array.from({ length: 30 }, (_, i) => i), 8, async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
    });
    expect(peak).toBe(8);
  });
});

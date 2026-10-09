import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Registry } from "../src/lib/registry";
import { registryUrl, validateRegistry } from "../src/lib/registry";
import reg from "../public/projects.json";

const registry = reg as unknown as Registry;
// The workspace README holds the project table; a standalone checkout of this repo has none.
const readme = new URL("../../README.md", import.meta.url);
const design = new URL("../../DESIGN.md", import.meta.url);

function tableRows(md: string, header: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(header));
  const rows: string[][] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(l.split("|").slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

describe("projects.json", () => {
  it("is valid", () => {
    expect(validateRegistry(registry)).toEqual([]);
    expect(registry.projects).toHaveLength(24);
  });

  it.runIf(existsSync(readme))("has every project of the README table with its server and proof", () => {
    const rows = tableRows(readFileSync(readme, "utf8"), "| # | Project");
    expect(rows).toHaveLength(24);
    for (const [, name, server, stack, , proof] of rows) {
      const p = registry.projects.find((x) => x.name === name);
      expect(p, name).toBeDefined();
      expect([p!.server, p!.stack, p!.proof]).toEqual([server, stack, proof]);
    }
  });

  it.runIf(existsSync(design))("matches the DESIGN.md chain table", () => {
    const rows = tableRows(readFileSync(design, "utf8"), "| Chain | Starter");
    expect(rows.map((r) => r[0].replace(/`/g, ""))).toEqual(registry.chains.map((c) => c.id));
    for (const [id, starter, steps] of rows) {
      const c = registry.chains.find((x) => `\`${x.id}\`` === id)!;
      expect(c.starter).toBe(starter);
      const want = steps.split(";").map((s) => s.trim().replace(/`/g, ""));
      expect(Object.entries(c.steps).map(([k, v]) => `${k}: ${v.join(", ")}`)).toEqual(want);
    }
  });

  it("reports broken entries", () => {
    const bad = structuredClone(registry);
    bad.projects[1].server = "s9";
    bad.projects[2].vars.urls = { RAILS_URL: "nope" };
    bad.projects.push({ ...bad.projects[3] });
    bad.chains[0].starter = "ghost";
    const errs = validateRegistry(bad);
    expect(errs).toContain("project celery-hub: unknown server s9");
    expect(errs).toContain("project rails-queue: RAILS_URL points at unknown project nope");
    expect(errs).toContain("project phoenix-live: duplicate");
    expect(errs).toContain("chain event-river: unknown starter ghost");
  });

  it("loads the stub registry only on ?registry=local", () => {
    expect(registryUrl("")).toBe("/projects.json");
    expect(registryUrl("?registry=other")).toBe("/projects.json");
    expect(registryUrl("?registry=local")).toBe("http://127.0.0.1:4400/projects.json");
  });
});

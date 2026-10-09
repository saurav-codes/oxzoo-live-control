// Writes public/_zoo/health.json at build time: zoo-control is static, so its
// health is a file stamped with the release ox is building.
import { mkdirSync, writeFileSync } from "node:fs";

const env = process.env;
const server = (env.PUBLIC_HOST ?? "").split(".").find((l) => /^s[0-9]+$/.test(l)) ?? "local";
const builtAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const health = {
  name: "zoo-control",
  stack: "Vite + React + TS static",
  server,
  release: env.OX_RELEASE ? env.OX_RELEASE.slice(0, 12) : "unknown",
  env: env.OX_ENV || "local",
  started_at: builtAt,
  build: { built_at: builtAt, runtime: `node ${process.versions.node}` },
};

const dir = new URL("../public/_zoo/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("health.json", dir), JSON.stringify(health, null, 2) + "\n");
console.log(`wrote public/_zoo/health.json (release ${health.release}, server ${server})`);

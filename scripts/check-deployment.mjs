import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve();
const [dockerfile, compose, caddyfile, qualityWorkflow] = await Promise.all([
  readFile(path.join(root, "Dockerfile"), "utf8"),
  readFile(path.join(root, "compose.yaml"), "utf8"),
  readFile(path.join(root, "ops/Caddyfile.example"), "utf8"),
  readFile(path.join(root, ".github/workflows/quality.yml"), "utf8")
]);

const startupSteps = [
  "check-api-production-config.mjs",
  "db-migrate.mjs",
  "db-seed-catalog.mjs",
  "run-catalog-imports.mjs --apply",
  "apps/api/dist/server.js"
];
let previousIndex = -1;
for (const step of startupSteps) {
  const index = dockerfile.indexOf(step);
  assert.ok(index > previousIndex, `Docker startup is missing or misorders ${step}`);
  previousIndex = index;
}

assert.match(dockerfile, /^USER node$/m, "Runtime container must use the node user");
assert.match(compose, /read_only:\s*true/, "API filesystem must be read-only");
assert.match(compose, /no-new-privileges:true/, "API must disable privilege escalation");
assert.match(compose, /127\.0\.0\.1:3000:3000/, "API port must bind to loopback");
assert.match(compose, /healthcheck:[\s\S]*\/ready/, "Compose must probe database readiness");
assert.match(caddyfile, /reverse_proxy\s+127\.0\.0\.1:3000/, "Caddy must proxy to loopback API");
assert.match(qualityWorkflow, /services:[\s\S]*postgres:/, "CI must provide PostgreSQL");
assert.match(qualityWorkflow, /npm run check:db-api/, "CI must exercise the database API lifecycle");
assert.match(qualityWorkflow, /docker run[\s\S]*detective-archives-api:test/, "CI must start the built image");
assert.match(qualityWorkflow, /npm run check:runtime/, "CI must probe the running production image");

console.log("Deployment structure and startup sequence: OK");

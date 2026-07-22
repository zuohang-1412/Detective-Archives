import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

const limit = 45;
let remaining = 2;
let resetAt = Date.now() + 750;
let rateLimitedResponses = 0;

const server = createServer((request, response) => {
  if (Date.now() >= resetAt) {
    remaining = limit;
    resetAt = Date.now() + 60_000;
  }
  const resetSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000));
  response.setHeader("content-type", "application/json");
  response.setHeader("x-ratelimit-limit", String(limit));
  response.setHeader("x-ratelimit-remaining", String(Math.max(0, remaining - 1)));
  response.setHeader("x-ratelimit-reset", String(resetSeconds));
  if (remaining <= 0) {
    rateLimitedResponses += 1;
    response.statusCode = 429;
    response.end(JSON.stringify({ code: "RATE_LIMITED" }));
    return;
  }
  remaining -= 1;
  response.statusCode = 200;
  response.end(JSON.stringify({ items: [], total: 0, path: request.url }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
assert.ok(address && typeof address === "object");
const child = spawn(process.execPath, [path.resolve("scripts/check-runtime-performance.mjs")], {
  cwd: path.resolve(),
  env: {
    ...process.env,
    RUNTIME_BASE_URL: `http://127.0.0.1:${address.port}`,
    PERF_REQUESTS_PER_ROUTE: "10",
    PERF_CONCURRENCY: "4",
    PERF_P95_LIMIT_MS: "10000",
    PERF_MAX_RATE_LIMIT_WAIT_MS: "2500"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

assert.equal(exitCode, 0, stderr || stdout);
const report = JSON.parse(stdout);
assert.equal(report.status, "runtime_performance_ok");
assert.ok(report.rateLimitWaitMs >= 1_000 && report.rateLimitWaitMs <= 2_500);
assert.equal(rateLimitedResponses, 1);
assert.equal(Object.keys(report.routes).length, 4);

console.log(
  `Runtime performance rate-limit budget: OK (${report.rateLimitWaitMs}ms guarded wait, one controlled 429)`
);

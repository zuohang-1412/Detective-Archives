import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const baseUrl = new URL(process.env.RUNTIME_BASE_URL ?? "http://127.0.0.1:3000");
const requestsPerRoute = Number.parseInt(process.env.PERF_REQUESTS_PER_ROUTE ?? "40", 10);
const concurrency = Number.parseInt(process.env.PERF_CONCURRENCY ?? "8", 10);
const p95LimitMs = Number.parseInt(process.env.PERF_P95_LIMIT_MS ?? "750", 10);

for (const [name, value, minimum, maximum] of [
  ["PERF_REQUESTS_PER_ROUTE", requestsPerRoute, 10, 500],
  ["PERF_CONCURRENCY", concurrency, 1, 50],
  ["PERF_P95_LIMIT_MS", p95LimitMs, 50, 10_000]
]) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

const routes = [
  "/api/v1/detectives?pageSize=30",
  "/api/v1/works?pageSize=20",
  "/api/v1/picture-book?pageSize=30",
  "/api/v1/community/reviews?pageSize=20"
];

async function timedRequest(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(pathname, baseUrl), { signal: controller.signal });
    const durationMs = performance.now() - startedAt;
    await response.body?.cancel();
    return { pathname, status: response.status, durationMs };
  } finally {
    clearTimeout(timeout);
  }
}

for (const route of routes) {
  const warmup = await timedRequest(route);
  assert.equal(warmup.status, 200, `${route} warmup returned ${warmup.status}`);
}

const pending = routes.flatMap((route) => (
  Array.from({ length: requestsPerRoute }, () => route)
));
const results = [];
const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
  while (pending.length) {
    const route = pending.shift();
    if (!route) return;
    results.push(await timedRequest(route));
  }
});
await Promise.all(workers);

const summary = {};
for (const route of routes) {
  const routeResults = results.filter((result) => result.pathname === route);
  assert.equal(routeResults.length, requestsPerRoute);
  const failures = routeResults.filter((result) => result.status !== 200);
  assert.equal(failures.length, 0, `${route} returned ${failures.length} failed responses`);
  const durations = routeResults.map((result) => result.durationMs).sort((left, right) => left - right);
  const percentile = (value) => durations[Math.max(0, Math.ceil(durations.length * value) - 1)];
  const p50Ms = percentile(0.5);
  const p95Ms = percentile(0.95);
  const maxMs = durations[durations.length - 1];
  assert.ok(p95Ms <= p95LimitMs, `${route} P95 ${p95Ms.toFixed(1)}ms exceeds ${p95LimitMs}ms`);
  summary[route] = {
    requests: routeResults.length,
    p50Ms: Number(p50Ms.toFixed(1)),
    p95Ms: Number(p95Ms.toFixed(1)),
    maxMs: Number(maxMs.toFixed(1))
  };
}

console.log(JSON.stringify({
  status: "runtime_performance_ok",
  concurrency,
  p95LimitMs,
  routes: summary
}, null, 2));

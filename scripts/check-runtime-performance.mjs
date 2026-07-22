import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";

const baseUrl = new URL(process.env.RUNTIME_BASE_URL ?? "http://127.0.0.1:3000");
const requestsPerRoute = Number.parseInt(process.env.PERF_REQUESTS_PER_ROUTE ?? "40", 10);
const concurrency = Number.parseInt(process.env.PERF_CONCURRENCY ?? "8", 10);
const p95LimitMs = Number.parseInt(process.env.PERF_P95_LIMIT_MS ?? "750", 10);
const maximumRateLimitWaitMs = Number.parseInt(
  process.env.PERF_MAX_RATE_LIMIT_WAIT_MS ?? "65000",
  10
);

for (const [name, value, minimum, maximum] of [
  ["PERF_REQUESTS_PER_ROUTE", requestsPerRoute, 10, 500],
  ["PERF_CONCURRENCY", concurrency, 1, 50],
  ["PERF_P95_LIMIT_MS", p95LimitMs, 50, 10_000]
]) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}
if (!Number.isInteger(maximumRateLimitWaitMs)
  || maximumRateLimitWaitMs < 0
  || maximumRateLimitWaitMs > 300_000) {
  throw new Error("PERF_MAX_RATE_LIMIT_WAIT_MS must be an integer between 0 and 300000");
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
    const rateLimit = Object.fromEntries(
      ["limit", "remaining", "reset"].map((name) => {
        const parsed = Number.parseInt(response.headers.get(`x-ratelimit-${name}`) ?? "", 10);
        return [name, Number.isInteger(parsed) ? parsed : null];
      })
    );
    return { pathname, status: response.status, durationMs, rateLimit };
  } finally {
    clearTimeout(timeout);
  }
}

let rateLimitWaitMs = 0;
async function waitForReset(result, reason) {
  const resetSeconds = result.rateLimit.reset;
  if (!Number.isInteger(resetSeconds) || resetSeconds < 0) {
    throw new Error(`${reason}, and the API did not provide a valid x-ratelimit-reset header`);
  }
  const waitMs = Math.max(1_000, resetSeconds * 1_000 + 250);
  if (rateLimitWaitMs + waitMs > maximumRateLimitWaitMs) {
    throw new Error(
      `${reason}; required rate-limit wait ${rateLimitWaitMs + waitMs}ms exceeds `
        + `PERF_MAX_RATE_LIMIT_WAIT_MS=${maximumRateLimitWaitMs}`
    );
  }
  await wait(waitMs);
  rateLimitWaitMs += waitMs;
}

let latestWarmup;
for (const route of routes) {
  let warmup = await timedRequest(route);
  if (warmup.status === 429) {
    await waitForReset(warmup, `${route} warmup exhausted the runtime rate limit`);
    warmup = await timedRequest(route);
  }
  assert.equal(warmup.status, 200, `${route} warmup returned ${warmup.status}`);
  latestWarmup = warmup;
}

const pending = routes.flatMap((route) => (
  Array.from({ length: requestsPerRoute }, () => route)
));
if (Number.isInteger(latestWarmup?.rateLimit.limit)
  && latestWarmup.rateLimit.limit < pending.length + 1) {
  throw new Error(
    `Runtime rate limit ${latestWarmup.rateLimit.limit} is too low for `
      + `${pending.length} measured requests in one performance sample`
  );
}
if (Number.isInteger(latestWarmup?.rateLimit.remaining)
  && latestWarmup.rateLimit.remaining < pending.length) {
  await waitForReset(
    latestWarmup,
    `Runtime rate-limit budget ${latestWarmup.rateLimit.remaining} is below `
      + `${pending.length} measured requests`
  );
  const budgetProbe = await timedRequest(routes[0]);
  assert.equal(budgetProbe.status, 200, `Rate-limit budget probe returned ${budgetProbe.status}`);
  if (Number.isInteger(budgetProbe.rateLimit.remaining)) {
    assert.ok(
      budgetProbe.rateLimit.remaining >= pending.length,
      `Rate-limit budget remained ${budgetProbe.rateLimit.remaining} after reset; `
        + `${pending.length} measured requests are required`
    );
  }
}
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
  rateLimitWaitMs,
  routes: summary
}, null, 2));

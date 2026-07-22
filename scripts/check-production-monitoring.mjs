import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  evaluateProductionMetrics,
  histogramQuantile,
  parsePrometheusText,
  runProductionMonitoring,
  validatePublicApiOrigin
} from "./lib/production-monitoring.mjs";

function metrics({ requests = 100, failures = 1, fast = 95, slow = 100 } = {}) {
  return `# HELP detective_archives_http_requests_total Total requests
detective_archives_http_requests_total{method="GET",route="/ready",status_code="200"} ${requests - failures}
detective_archives_http_requests_total{method="GET",route="/ready",status_code="500"} ${failures}
detective_archives_http_request_duration_seconds_bucket{method="GET",route="/ready",status_code="200",le="0.1"} ${fast}
detective_archives_http_request_duration_seconds_bucket{method="GET",route="/ready",status_code="200",le="1"} ${slow}
detective_archives_http_request_duration_seconds_bucket{method="GET",route="/ready",status_code="200",le="+Inf"} ${slow}
detective_archives_process_resident_memory_bytes 134217728
detective_archives_nodejs_eventloop_lag_p99_seconds 0.02
`;
}

const parsed = parsePrometheusText(metrics());
assert.ok(parsed.some((sample) => sample.labels.status_code === "500"));
assert.equal(histogramQuantile([
  { upperBound: 0.1, count: 95 },
  { upperBound: 1, count: 100 },
  { upperBound: Number.POSITIVE_INFINITY, count: 100 }
], 0.95), 0.1);
assert.equal(validatePublicApiOrigin("https://api.detective-archives.cn").origin, "https://api.detective-archives.cn");
for (const invalidOrigin of [
  "http://api.detective-archives.cn",
  "https://localhost",
  "https://127.0.0.1",
  "https://[::1]",
  "https://[fc00::1]",
  "https://[2001:4860:4860::8888]",
  "https://api.example",
  "https://api.detective-archives.cn/path"
]) {
  assert.throws(() => validatePublicApiOrigin(invalidOrigin));
}

const healthy = evaluateProductionMetrics(
  metrics({ requests: 100, failures: 1, fast: 95, slow: 100 }),
  metrics({ requests: 200, failures: 2, fast: 190, slow: 200 })
);
assert.equal(healthy.requests, 100);
assert.equal(healthy.serverErrors, 1);
assert.equal(healthy.serverErrorRatio, 0.01);
assert.equal(healthy.p95Seconds, 0.1);
assert.deepEqual(healthy.violations, []);

const unhealthy = evaluateProductionMetrics(
  metrics({ requests: 100, failures: 1, fast: 95, slow: 100 }),
  metrics({ requests: 200, failures: 10, fast: 180, slow: 200 })
);
assert.ok(unhealthy.violations.some((violation) => violation.startsWith("5xx ratio")));

const resourceAndLatencyViolations = evaluateProductionMetrics(
  metrics({ requests: 100, failures: 1, fast: 95, slow: 100 }),
  metrics({ requests: 200, failures: 2, fast: 185, slow: 200 }),
  {
    ...DEFAULT_THRESHOLDS,
    maxP95Seconds: 0.5,
    maxResidentMemoryBytes: 100 * 1024 * 1024,
    maxEventLoopLagSeconds: 0.01
  }
);
for (const prefix of ["P95", "resident memory", "event loop P99"]) {
  assert.ok(
    resourceAndLatencyViolations.violations.some((violation) => violation.startsWith(prefix)),
    `${prefix} threshold must be enforced`
  );
}
assert.throws(
  () => evaluateProductionMetrics(metrics(), metrics().replace(
    "detective_archives_nodejs_eventloop_lag_p99_seconds 0.02\n",
    ""
  )),
  /Required production metric is missing/
);

const reset = evaluateProductionMetrics(
  metrics({ requests: 1_000, failures: 50, fast: 900, slow: 1_000 }),
  metrics({ requests: 10, failures: 0, fast: 10, slow: 10 })
);
assert.equal(reset.requests, 10);
assert.equal(reset.serverErrors, 0);

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers
  });
}

function requestSequence(metricsStatus = 401) {
  const queue = [
    response(
      { status: "ready", service: "detective-archives-api", database: "connected" },
      200,
      { "cache-control": "no-store", "content-type": "application/json" }
    ),
    response({ code: "METRICS_AUTH_REQUIRED" }, metricsStatus, { "content-type": "application/json" }),
    response(metrics({ requests: 100, failures: 1 }), 200, { "content-type": "text/plain; version=0.0.4" }),
    response(metrics({ requests: 200, failures: 2, fast: 190, slow: 200 }), 200, {
      "content-type": "text/plain; version=0.0.4"
    })
  ];
  return async (_url, options) => {
    assert.ok(options.signal, "every production request must have a timeout signal");
    const next = queue.shift();
    if (!next) throw new Error("Unexpected monitoring request");
    return next;
  };
}

const report = await runProductionMonitoring({
  publicApiOrigin: "https://api.detective-archives.cn",
  metricsToken: "monitoring-token-with-24-chars",
  sampleIntervalMs: 0,
  requestTimeoutMs: 1_000,
  request: requestSequence(),
  sleep: async () => {},
  now: () => new Date("2026-07-22T00:00:00.000Z")
});
assert.equal(report.status, "production_monitoring_ok");
assert.equal(report.checkedAt, "2026-07-22T00:00:00.000Z");
assert.equal(report.metricsProtection, "bearer_required");

await assert.rejects(
  runProductionMonitoring({
    publicApiOrigin: "https://api.detective-archives.cn",
    metricsToken: "monitoring-token-with-24-chars",
    sampleIntervalMs: 0,
    requestTimeoutMs: 1_000,
    request: requestSequence(200),
    sleep: async () => {}
  }),
  /must reject requests/
);

await assert.rejects(
  runProductionMonitoring({
    publicApiOrigin: "https://api.detective-archives.cn",
    metricsToken: "short",
    sampleIntervalMs: 0,
    requestTimeoutMs: 1_000,
    request: requestSequence(),
    sleep: async () => {}
  }),
  /at least 24 characters/
);

const secretToken = "monitoring-token-that-must-not-leak";
await assert.rejects(
  runProductionMonitoring({
    publicApiOrigin: "https://api.detective-archives.cn",
    metricsToken: secretToken,
    sampleIntervalMs: 0,
    requestTimeoutMs: 5,
    request: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }),
    sleep: async () => {}
  }),
  (error) => {
    assert.match(error.message, /request timed out/);
    assert.doesNotMatch(error.message, new RegExp(secretToken));
    return true;
  }
);

assert.deepEqual(DEFAULT_THRESHOLDS, {
  max5xxRatio: 0.02,
  maxP95Seconds: 1,
  maxResidentMemoryBytes: 805306368,
  maxEventLoopLagSeconds: 0.25
});

console.log("Production monitoring probe and threshold evaluation: OK");

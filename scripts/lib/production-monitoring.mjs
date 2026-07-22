import { isIP } from "node:net";

const REQUEST_COUNTER = "detective_archives_http_requests_total";
const REQUEST_DURATION_BUCKET = "detective_archives_http_request_duration_seconds_bucket";
const RESIDENT_MEMORY = "detective_archives_process_resident_memory_bytes";
const EVENT_LOOP_LAG_P99 = "detective_archives_nodejs_eventloop_lag_p99_seconds";

const DEFAULT_THRESHOLDS = Object.freeze({
  max5xxRatio: 0.02,
  maxP95Seconds: 1,
  maxResidentMemoryBytes: 768 * 1024 * 1024,
  maxEventLoopLagSeconds: 0.25
});

function decodeLabelValue(value) {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\");
}

function parseLabels(source) {
  const labels = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (source.slice(cursor, match.index).trim().replace(/^,|,$/g, "")) {
      throw new Error("Prometheus label set is malformed");
    }
    labels[match[1]] = decodeLabelValue(match[2]);
    cursor = pattern.lastIndex;
  }
  if (source.slice(cursor).trim().replace(/^,|,$/g, "")) {
    throw new Error("Prometheus label set is malformed");
  }
  return labels;
}

function parseMetricValue(source) {
  if (source === "+Inf" || source === "Inf") return Number.POSITIVE_INFINITY;
  if (source === "-Inf") return Number.NEGATIVE_INFINITY;
  const value = Number(source);
  return Number.isFinite(value) ? value : null;
}

export function parsePrometheusText(source) {
  if (typeof source !== "string") throw new Error("Prometheus payload must be text");
  const samples = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/
    );
    if (!match) throw new Error("Prometheus payload contains an unsupported sample");
    const value = parseMetricValue(match[3]);
    if (value === null) continue;
    samples.push({
      name: match[1],
      labels: match[2] ? parseLabels(match[2]) : {},
      value
    });
  }
  return samples;
}

function samplesNamed(samples, name) {
  return samples.filter((sample) => sample.name === name);
}

function resetSafeDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return after >= before ? after - before : after;
}

function aggregateBy(samples, name, keyOf) {
  const values = new Map();
  for (const sample of samplesNamed(samples, name)) {
    const key = keyOf(sample);
    values.set(key, (values.get(key) ?? 0) + sample.value);
  }
  return values;
}

function deltaBy(before, after) {
  const result = new Map();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    result.set(key, resetSafeDelta(before.get(key) ?? 0, after.get(key) ?? 0));
  }
  return result;
}

function requestWindow(beforeSamples, afterSamples) {
  const byStatusBefore = aggregateBy(beforeSamples, REQUEST_COUNTER, (sample) => (
    sample.labels.status_code ?? "unknown"
  ));
  const byStatusAfter = aggregateBy(afterSamples, REQUEST_COUNTER, (sample) => (
    sample.labels.status_code ?? "unknown"
  ));
  const byStatus = deltaBy(byStatusBefore, byStatusAfter);
  const total = [...byStatus.values()].reduce((value, count) => value + count, 0);
  const serverErrors = [...byStatus.entries()]
    .filter(([status]) => /^5\d\d$/.test(status))
    .reduce((value, [, count]) => value + count, 0);
  return {
    requests: total,
    serverErrors,
    serverErrorRatio: total > 0 ? serverErrors / total : 0
  };
}

function histogramWindow(beforeSamples, afterSamples) {
  const before = aggregateBy(beforeSamples, REQUEST_DURATION_BUCKET, (sample) => sample.labels.le);
  const after = aggregateBy(afterSamples, REQUEST_DURATION_BUCKET, (sample) => sample.labels.le);
  return [...deltaBy(before, after).entries()]
    .map(([upperBound, count]) => ({
      upperBound: upperBound === "+Inf" ? Number.POSITIVE_INFINITY : Number(upperBound),
      count
    }))
    .filter((bucket) => !Number.isNaN(bucket.upperBound))
    .sort((left, right) => left.upperBound - right.upperBound);
}

export function histogramQuantile(buckets, quantile) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  if (!(quantile > 0 && quantile <= 1)) throw new Error("Histogram quantile must be in (0, 1]");
  const infinity = buckets.find((bucket) => bucket.upperBound === Number.POSITIVE_INFINITY);
  const total = infinity?.count ?? buckets[buckets.length - 1].count;
  if (!(total > 0)) return 0;
  const target = total * quantile;
  let priorCount = 0;
  for (const bucket of buckets) {
    const cumulativeCount = Math.max(priorCount, bucket.count);
    if (cumulativeCount >= target) return bucket.upperBound;
    priorCount = cumulativeCount;
  }
  return Number.POSITIVE_INFINITY;
}

function requireGauge(samples, name) {
  const values = samplesNamed(samples, name);
  if (values.length === 0) throw new Error(`Required production metric is missing: ${name}`);
  return Math.max(...values.map((sample) => sample.value));
}

export function evaluateProductionMetrics(beforeText, afterText, thresholds = DEFAULT_THRESHOLDS) {
  const before = parsePrometheusText(beforeText);
  const after = parsePrometheusText(afterText);
  if (samplesNamed(before, REQUEST_COUNTER).length === 0
      || samplesNamed(after, REQUEST_COUNTER).length === 0) {
    throw new Error(`Required production metric is missing: ${REQUEST_COUNTER}`);
  }
  if (samplesNamed(before, REQUEST_DURATION_BUCKET).length === 0
      || samplesNamed(after, REQUEST_DURATION_BUCKET).length === 0) {
    throw new Error(`Required production metric is missing: ${REQUEST_DURATION_BUCKET}`);
  }

  const window = requestWindow(before, after);
  const p95Seconds = histogramQuantile(histogramWindow(before, after), 0.95);
  const residentMemoryBytes = requireGauge(after, RESIDENT_MEMORY);
  const eventLoopLagP99Seconds = requireGauge(after, EVENT_LOOP_LAG_P99);
  const violations = [];

  if (window.serverErrorRatio > thresholds.max5xxRatio) {
    violations.push(
      `5xx ratio ${(window.serverErrorRatio * 100).toFixed(2)}% exceeds ${(thresholds.max5xxRatio * 100).toFixed(2)}%`
    );
  }
  if (p95Seconds === null || p95Seconds > thresholds.maxP95Seconds) {
    violations.push(`P95 ${p95Seconds ?? "missing"}s exceeds ${thresholds.maxP95Seconds}s`);
  }
  if (residentMemoryBytes > thresholds.maxResidentMemoryBytes) {
    violations.push(
      `resident memory ${residentMemoryBytes} bytes exceeds ${thresholds.maxResidentMemoryBytes} bytes`
    );
  }
  if (eventLoopLagP99Seconds > thresholds.maxEventLoopLagSeconds) {
    violations.push(
      `event loop P99 ${eventLoopLagP99Seconds}s exceeds ${thresholds.maxEventLoopLagSeconds}s`
    );
  }

  return {
    requests: window.requests,
    serverErrors: window.serverErrors,
    serverErrorRatio: Number(window.serverErrorRatio.toFixed(6)),
    p95Seconds,
    residentMemoryBytes,
    eventLoopLagP99Seconds,
    violations
  };
}

export function validatePublicApiOrigin(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("PUBLIC_API_BASE_URL is required");
  }
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("PUBLIC_API_BASE_URL must be a valid URL");
  }
  const rawHostname = origin.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const rejectedHostname = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".example")
    || hostname.endsWith(".test")
    || isIP(hostname) !== 0;
  if (origin.protocol !== "https:"
      || origin.origin !== value
      || origin.username
      || origin.password
      || rejectedHostname) {
    throw new Error("PUBLIC_API_BASE_URL must be an exact public HTTPS origin");
  }
  return origin;
}

async function fetchText(request, url, options, timeoutMs, maximumLength) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, { ...options, signal: controller.signal });
    const body = await response.text();
    if (body.length > maximumLength) throw new Error(`${url.pathname} response is too large`);
    return { response, body };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${url.pathname} request timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readMetrics(request, origin, metricsToken, timeoutMs) {
  const url = new URL("/metrics", origin);
  const { response, body } = await fetchText(
    request,
    url,
    { headers: { authorization: `Bearer ${metricsToken}` } },
    timeoutMs,
    5 * 1024 * 1024
  );
  if (response.status !== 200 || !/^text\/plain/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error(`/metrics authenticated probe returned ${response.status} or an invalid content type`);
  }
  return body;
}

export async function runProductionMonitoring({
  publicApiOrigin,
  metricsToken,
  sampleIntervalMs = 15_000,
  requestTimeoutMs = 10_000,
  thresholds = DEFAULT_THRESHOLDS,
  request = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date()
}) {
  const origin = validatePublicApiOrigin(publicApiOrigin);
  if (typeof metricsToken !== "string" || metricsToken.length < 24) {
    throw new Error("METRICS_AUTH_TOKEN must contain at least 24 characters");
  }

  const readyUrl = new URL("/ready", origin);
  const readyResult = await fetchText(request, readyUrl, {}, requestTimeoutMs, 4 * 1024);
  if (readyResult.response.status !== 200
      || !/(?:^|,)\s*no-store(?:\s*(?:,|$))/i.test(
        readyResult.response.headers.get("cache-control") ?? ""
      )) {
    throw new Error(`/ready probe returned ${readyResult.response.status} or a cacheable response`);
  }
  let readiness;
  try {
    readiness = JSON.parse(readyResult.body);
  } catch {
    throw new Error("/ready response is not valid JSON");
  }
  if (readiness?.status !== "ready"
      || readiness?.service !== "detective-archives-api"
      || readiness?.database !== "connected") {
    throw new Error("/ready response does not prove API and database readiness");
  }

  const unprotected = await fetchText(
    request,
    new URL("/metrics", origin),
    {},
    requestTimeoutMs,
    4 * 1024
  );
  if (unprotected.response.status !== 401) {
    throw new Error("/metrics must reject requests without the monitoring token");
  }

  const before = await readMetrics(request, origin, metricsToken, requestTimeoutMs);
  await sleep(sampleIntervalMs);
  const after = await readMetrics(request, origin, metricsToken, requestTimeoutMs);
  const metrics = evaluateProductionMetrics(before, after, thresholds);
  if (metrics.violations.length > 0) {
    throw new Error(`Production thresholds failed: ${metrics.violations.join("; ")}`);
  }

  return {
    status: "production_monitoring_ok",
    checkedAt: now().toISOString(),
    origin: origin.origin,
    sampleIntervalMs,
    readiness: "api_and_database_ready",
    metricsProtection: "bearer_required",
    metrics
  };
}

export { DEFAULT_THRESHOLDS };

import {
  DEFAULT_THRESHOLDS,
  runProductionMonitoring
} from "./lib/production-monitoring.mjs";

function numberFromEnvironment(name, fallback, { minimum, maximum }) {
  const source = process.env[name];
  const value = source === undefined ? fallback : Number(source);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

const sampleIntervalMs = numberFromEnvironment("MONITOR_SAMPLE_INTERVAL_MS", 15_000, {
  minimum: 1_000,
  maximum: 60_000
});
const requestTimeoutMs = numberFromEnvironment("MONITOR_REQUEST_TIMEOUT_MS", 10_000, {
  minimum: 1_000,
  maximum: 30_000
});
const thresholds = {
  max5xxRatio: numberFromEnvironment("MONITOR_MAX_5XX_RATIO", DEFAULT_THRESHOLDS.max5xxRatio, {
    minimum: 0,
    maximum: 1
  }),
  maxP95Seconds: numberFromEnvironment(
    "MONITOR_MAX_P95_SECONDS",
    DEFAULT_THRESHOLDS.maxP95Seconds,
    { minimum: 0.05, maximum: 30 }
  ),
  maxResidentMemoryBytes: numberFromEnvironment(
    "MONITOR_MAX_RSS_BYTES",
    DEFAULT_THRESHOLDS.maxResidentMemoryBytes,
    { minimum: 64 * 1024 * 1024, maximum: 16 * 1024 * 1024 * 1024 }
  ),
  maxEventLoopLagSeconds: numberFromEnvironment(
    "MONITOR_MAX_EVENT_LOOP_LAG_SECONDS",
    DEFAULT_THRESHOLDS.maxEventLoopLagSeconds,
    { minimum: 0.01, maximum: 10 }
  )
};

const report = await runProductionMonitoring({
  publicApiOrigin: process.env.PUBLIC_API_BASE_URL,
  metricsToken: process.env.METRICS_AUTH_TOKEN,
  sampleIntervalMs,
  requestTimeoutMs,
  thresholds
});

console.log(JSON.stringify(report, null, 2));

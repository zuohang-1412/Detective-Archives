import { loadRuntimeConfig } from "../apps/api/dist/runtime-config.js";

const config = loadRuntimeConfig({ ...process.env, NODE_ENV: "production" });
console.log(JSON.stringify({
  status: "api_production_config_ready",
  host: config.host,
  port: config.port,
  corsOriginCount: Array.isArray(config.corsOrigin) ? config.corsOrigin.length : 1,
  trustProxy: config.trustProxy,
  metricsProtected: Boolean(config.metricsAuthToken)
}));

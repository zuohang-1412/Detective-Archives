import { buildApp } from "./app.js";
import { createAdminCredentialValidatorFromEnv } from "./auth/admin.js";
import { createWechatCodeExchangeFromEnv } from "./auth/wechat.js";
import { createWechatContentSafetyCheckFromEnv } from "./auth/wechat-content-safety.js";
import { createDatabasePoolFromEnv } from "./db/pool.js";
import { loadRuntimeConfig } from "./runtime-config.js";

const config = loadRuntimeConfig();
const database = createDatabasePoolFromEnv();
const wechatCodeExchange = createWechatCodeExchangeFromEnv();
const contentSafetyCheck = createWechatContentSafetyCheckFromEnv();
const adminCredentialValidator = createAdminCredentialValidatorFromEnv();
const app = await buildApp({
  logger: {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authorization",
        "request.headers.cookie",
        "body.code",
        "body.password",
        "password",
        "token"
      ],
      censor: "[REDACTED]"
    }
  },
  corsOrigin: config.corsOrigin,
  trustProxy: config.trustProxy,
  rateLimitMax: config.rateLimitMax,
  rateLimitWindowMs: config.rateLimitWindowMs,
  ...(config.metricsAuthToken ? { metricsAuthToken: config.metricsAuthToken } : {}),
  ...(database ? { database } : {}),
  ...(wechatCodeExchange ? { wechatCodeExchange } : {}),
  ...(contentSafetyCheck ? { contentSafetyCheck } : {}),
  ...(adminCredentialValidator ? { adminCredentialValidator } : {}),
  sessionTtlSeconds: config.sessionTtlSeconds
});

database?.on("error", (error) => {
  app.log.error({ err: error }, "unexpected idle database client error");
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "graceful shutdown started");
  const forcedExit = setTimeout(() => {
    app.log.error("graceful shutdown timed out");
    process.exit(1);
  }, 10_000).unref();
  try {
    await app.close();
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "graceful shutdown failed");
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

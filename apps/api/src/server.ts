import { buildApp } from "./app.js";
import { createAdminCredentialValidatorFromEnv } from "./auth/admin.js";
import { createWechatCodeExchangeFromEnv } from "./auth/wechat.js";
import { createDatabasePoolFromEnv } from "./db/pool.js";

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = process.env.API_HOST ?? "127.0.0.1";
const database = createDatabasePoolFromEnv();
const wechatCodeExchange = createWechatCodeExchangeFromEnv();
const adminCredentialValidator = createAdminCredentialValidatorFromEnv();
const app = await buildApp({
  logger: true,
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  ...(database ? { database } : {}),
  ...(wechatCodeExchange ? { wechatCodeExchange } : {}),
  ...(adminCredentialValidator ? { adminCredentialValidator } : {}),
  sessionTtlSeconds: positiveInteger(
    process.env.SESSION_TTL_SECONDS,
    2_592_000,
    "SESSION_TTL_SECONDS"
  )
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}

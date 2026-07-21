import { buildApp } from "./app.js";
import { createDatabasePoolFromEnv } from "./db/pool.js";

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = process.env.API_HOST ?? "127.0.0.1";
const database = createDatabasePoolFromEnv();
const app = await buildApp({
  logger: true,
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  ...(database ? { database } : {})
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}

import { Pool, type PoolConfig } from "pg";

function databaseSsl(env: NodeJS.ProcessEnv): PoolConfig["ssl"] {
  const mode = env.PGSSLMODE?.toLowerCase();
  if (!mode) {
    return undefined;
  }
  if (mode === "disable" || mode === "allow" || mode === "prefer") {
    return false;
  }
  if (mode === "require" || mode === "no-verify") {
    return { rejectUnauthorized: false };
  }
  if (mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: true };
  }
  throw new Error("Unsupported PGSSLMODE");
}

function parseInteger(value: string | undefined, fallback: number, name: string) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function createDatabasePoolFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const pgKeys = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
  const hasPgConfig = pgKeys.some((key) => Boolean(env[key]));
  if (!env.DATABASE_URL && !hasPgConfig) {
    return undefined;
  }

  const ssl = databaseSsl(env);
  const poolConfig: PoolConfig = env.DATABASE_URL
    ? {
        connectionString: env.DATABASE_URL,
        ...(ssl === undefined ? {} : { ssl })
      }
    : {
        host: env.PGHOST,
        port: parseInteger(env.PGPORT, 5432, "PGPORT"),
        database: env.PGDATABASE,
        user: env.PGUSER,
        password: env.PGPASSWORD,
        ...(ssl === undefined ? {} : { ssl })
      };

  if (!env.DATABASE_URL) {
    const missing = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"].filter(
      (key) => !env[key]
    );
    if (missing.length > 0) {
      throw new Error(`Incomplete PostgreSQL configuration: ${missing.join(", ")}`);
    }
  }

  return new Pool({
    ...poolConfig,
    application_name: "detective-archives-api",
    max: parseInteger(env.DB_POOL_MAX, 10, "DB_POOL_MAX"),
    connectionTimeoutMillis: parseInteger(
      env.DB_CONNECTION_TIMEOUT_MS,
      5000,
      "DB_CONNECTION_TIMEOUT_MS"
    ),
    idleTimeoutMillis: parseInteger(env.DB_IDLE_TIMEOUT_MS, 30000, "DB_IDLE_TIMEOUT_MS")
  });
}

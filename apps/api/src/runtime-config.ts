export interface RuntimeConfig {
  host: string;
  port: number;
  corsOrigin: string | string[];
  trustProxy: boolean;
  logLevel: string;
  sessionTtlSeconds: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  metricsAuthToken?: string;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function hasDatabaseConfiguration(env: NodeJS.ProcessEnv) {
  return Boolean(env.DATABASE_URL)
    || ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"].every((key) => Boolean(env[key]));
}

function configuredSecret(value: string | undefined, name: string, minimumLength: number) {
  const normalized = value?.trim();
  if (!normalized || /^(replace|change-me|your-|example)/i.test(normalized)) {
    throw new Error(`${name} must be configured for production`);
  }
  if (normalized.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} characters in production`);
  }
  return normalized;
}

function corsOrigins(value: string | undefined, production: boolean) {
  const normalized = value?.trim() || "*";
  if (production && normalized === "*") {
    throw new Error("CORS_ORIGIN cannot be * in production");
  }
  if (normalized === "*") return normalized;

  const origins = normalized.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    throw new Error("CORS_ORIGIN must contain at least one origin");
  }
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGIN contains an invalid origin: ${origin}`);
    }
    if (url.origin !== origin || (production && url.protocol !== "https:")) {
      throw new Error(`CORS_ORIGIN must contain exact${production ? " HTTPS" : ""} origins`);
    }
  }
  return origins.length === 1 ? origins[0]! : origins;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === "production";
  const logLevel = env.LOG_LEVEL?.trim() || "info";
  if (!["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(logLevel)) {
    throw new Error("LOG_LEVEL must be a supported Pino log level");
  }

  if (production) {
    if (!hasDatabaseConfiguration(env)) {
      throw new Error("PostgreSQL must be configured in production");
    }
    if (env.WECHAT_DEV_LOGIN === "true") {
      throw new Error("WECHAT_DEV_LOGIN cannot be enabled in production");
    }
    const appId = configuredSecret(env.WECHAT_APP_ID, "WECHAT_APP_ID", 6);
    if (!/^wx[a-zA-Z0-9]{6,}$/.test(appId)) {
      throw new Error("WECHAT_APP_ID is not a valid Mini Program AppID");
    }
    configuredSecret(env.WECHAT_APP_SECRET, "WECHAT_APP_SECRET", 16);
    configuredSecret(env.ADMIN_LOGIN_ID, "ADMIN_LOGIN_ID", 3);
    configuredSecret(env.ADMIN_LOGIN_PASSWORD, "ADMIN_LOGIN_PASSWORD", 16);
    configuredSecret(env.METRICS_AUTH_TOKEN, "METRICS_AUTH_TOKEN", 24);
  }

  return {
    host: env.API_HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port: positiveInteger(env.API_PORT, 3000, "API_PORT", 65_535),
    corsOrigin: corsOrigins(env.CORS_ORIGIN, production),
    trustProxy: booleanValue(env.TRUST_PROXY, production, "TRUST_PROXY"),
    logLevel,
    sessionTtlSeconds: positiveInteger(
      env.SESSION_TTL_SECONDS,
      2_592_000,
      "SESSION_TTL_SECONDS"
    ),
    rateLimitMax: positiveInteger(env.RATE_LIMIT_MAX, 300, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: positiveInteger(
      env.RATE_LIMIT_WINDOW_MS,
      60_000,
      "RATE_LIMIT_WINDOW_MS"
    ),
    ...(env.METRICS_AUTH_TOKEN ? { metricsAuthToken: env.METRICS_AUTH_TOKEN } : {})
  };
}

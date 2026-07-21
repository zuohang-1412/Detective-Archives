import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const productionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://service:secret@database:5432/detective_archives",
  CORS_ORIGIN: "https://admin.detective.example",
  WECHAT_APP_ID: "wx1234567890",
  WECHAT_APP_SECRET: "wechat-secret-for-tests",
  ADMIN_LOGIN_ID: "operations",
  ADMIN_LOGIN_PASSWORD: "admin-password-for-tests",
  METRICS_AUTH_TOKEN: "metrics-auth-token-for-tests"
};

describe("runtime configuration", () => {
  it("uses safe local defaults outside production", () => {
    const config = loadRuntimeConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.corsOrigin, "*");
    assert.equal(config.trustProxy, false);
  });

  it("loads a complete production environment", () => {
    const config = loadRuntimeConfig(productionEnvironment);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.corsOrigin, "https://admin.detective.example");
    assert.equal(config.trustProxy, true);
    assert.equal(config.metricsAuthToken, "metrics-auth-token-for-tests");
  });

  it("supports an explicit production origin allowlist", () => {
    const config = loadRuntimeConfig({
      ...productionEnvironment,
      CORS_ORIGIN: "https://one.example,https://two.example"
    });
    assert.deepEqual(config.corsOrigin, ["https://one.example", "https://two.example"]);
  });

  it("rejects incomplete and permissive production environments", () => {
    assert.throws(
      () => loadRuntimeConfig({ NODE_ENV: "production" }),
      /PostgreSQL must be configured/
    );
    assert.throws(
      () => loadRuntimeConfig({ ...productionEnvironment, CORS_ORIGIN: "*" }),
      /cannot be \*/
    );
    assert.throws(
      () => loadRuntimeConfig({ ...productionEnvironment, CORS_ORIGIN: "http://admin.example" }),
      /exact HTTPS origins/
    );
    assert.throws(
      () => loadRuntimeConfig({ ...productionEnvironment, METRICS_AUTH_TOKEN: "short" }),
      /at least 24 characters/
    );
    assert.throws(
      () => loadRuntimeConfig({ ...productionEnvironment, LOG_LEVEL: "verbose" }),
      /supported Pino log level/
    );
    assert.throws(
      () => loadRuntimeConfig({ ...productionEnvironment, WECHAT_APP_ID: "not-wechat" }),
      /not a valid Mini Program AppID/
    );
  });
});

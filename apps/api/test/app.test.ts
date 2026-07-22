import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { buildApp } from "../src/app.js";
import { createLoggerOptions } from "../src/logging.js";

describe("detective archives API", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
  });

  after(async () => {
    await app.close();
  });

  it("returns health status", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ok",
      service: "detective-archives-api"
    });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(typeof response.headers["x-request-id"], "string");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(response.headers["content-security-policy"] ?? "", /default-src 'self'/);
  });

  it("protects metrics when a monitoring token is configured", async () => {
    const metricsApp = await buildApp({ metricsAuthToken: "monitoring-token-for-tests" });
    const unauthorized = await metricsApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(unauthorized.statusCode, 401);

    const response = await metricsApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer monitoring-token-for-tests" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/plain/);
    assert.match(response.body, /detective_archives_http_requests_total/);
    await metricsApp.close();
  });

  it("redacts authentication and database credentials from production logs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const logger = pino(createLoggerOptions("info"), destination);
    const loggingApp = await buildApp({ loggerInstance: logger });
    const secrets = {
      authorization: "Bearer secret-session-token",
      cookie: "session=secret-cookie",
      code: "secret-wechat-code",
      password: "secret-admin-password",
      token: "secret-response-token",
      appSecret: "secret-wechat-app-secret",
      databasePassword: "secret-database-password"
    };
    loggingApp.log.info({
      req: {
        headers: {
          authorization: secrets.authorization,
          cookie: secrets.cookie
        },
        body: { code: secrets.code, password: secrets.password }
      },
      body: {
        code: secrets.code,
        password: secrets.password,
        token: secrets.token
      },
      credentials: {
        appSecret: secrets.appSecret,
        password: secrets.password
      },
      session: {
        token: secrets.token,
        refreshToken: secrets.token
      },
      err: {
        config: { password: secrets.databasePassword }
      },
      token: secrets.token,
      password: secrets.password,
      appSecret: secrets.appSecret
    }, "redaction verification");
    await loggingApp.close();
    assert.match(output, /redaction verification/);
    assert.match(output, /\[REDACTED\]/);
    Object.values(secrets).forEach((secret) => assert.equal(output.includes(secret), false));
  });

  it("allows configured origins to issue PUT requests", async () => {
    const corsApp = await buildApp({ corsOrigin: "https://console.example.com" });
    const response = await corsApp.inject({
      method: "OPTIONS",
      url: "/api/v1/me/shelf/example",
      headers: {
        origin: "https://console.example.com",
        "access-control-request-method": "PUT"
      }
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], "https://console.example.com");
    assert.match(response.headers["access-control-allow-methods"] ?? "", /PUT/);
    await corsApp.close();
  });

  it("rate limits non-operational endpoints", async () => {
    const limitedApp = await buildApp({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await limitedApp.inject({ method: "GET", url: "/api/v1/detectives" });
      assert.equal(response.statusCode, 200);
    }
    const limited = await limitedApp.inject({ method: "GET", url: "/api/v1/detectives" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMITED");
    await limitedApp.close();
  });

  it("rejects oversized bodies without exposing internals", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "x".repeat(1024 * 1024), agreements: {} }
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json(), { code: "PAYLOAD_TOO_LARGE", message: "请求内容过大" });
  });

  it("serves the built-in operations console", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/html/);
    assert.equal(response.body.includes("运营后台"), true);
  });

  it("reports not ready when the database is not configured", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: "not_ready",
      service: "detective-archives-api",
      database: "not_configured"
    });
  });

  it("reports ready when the database responds", async () => {
    let ended = false;
    const readyApp = await buildApp({
      database: {
        async query(sql) {
          assert.equal(sql, "SELECT 1");
          return { rows: [{ value: 1 }] };
        },
        async end() {
          ended = true;
        }
      }
    });

    const response = await readyApp.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ready",
      service: "detective-archives-api",
      database: "connected"
    });
    await readyApp.close();
    assert.equal(ended, true);
  });

  it("reports unavailable without leaking a database error", async () => {
    const unavailableApp = await buildApp({
      database: {
        async query() {
          throw new Error("internal connection detail");
        },
        async end() {}
      }
    });

    const response = await unavailableApp.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: "not_ready",
      service: "detective-archives-api",
      database: "unavailable"
    });
    assert.equal(response.body.includes("internal connection detail"), false);
    await unavailableApp.close();
  });

  it("returns a stable 500 response without leaking repository errors", async () => {
    const failingApp = await buildApp({
      database: {
        async query() {
          throw new Error("private database host and SQL detail");
        },
        async end() {}
      }
    });
    const response = await failingApp.inject({ method: "GET", url: "/api/v1/detectives" });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_SERVER_ERROR",
      message: "服务暂时不可用，请稍后再试"
    });
    assert.equal(response.body.includes("private database"), false);
    await failingApp.close();
  });

  it("keeps login and shelf writes unavailable without server configuration", async () => {
    const consentResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: { code: "temporary-code" }
    });
    assert.equal(consentResponse.statusCode, 400);
    assert.equal(consentResponse.json().code, "INVALID_LOGIN_REQUEST");

    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat",
      payload: {
        code: "temporary-code",
        agreements: { termsAccepted: true, privacyAccepted: true }
      }
    });
    assert.equal(loginResponse.statusCode, 503);
    assert.equal(loginResponse.json().code, "AUTH_NOT_CONFIGURED");

    const shelfResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me/shelf"
    });
    assert.equal(shelfResponse.statusCode, 503);
    assert.equal(shelfResponse.json().code, "DATABASE_REQUIRED");

    const exportResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me/data-export"
    });
    assert.equal(exportResponse.statusCode, 503);
    assert.equal(exportResponse.json().code, "DATABASE_REQUIRED");

    const adminLoginResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/admin",
      payload: { loginId: "admin", password: "not-configured" }
    });
    assert.equal(adminLoginResponse.statusCode, 503);
    assert.equal(adminLoginResponse.json().code, "AUTH_NOT_CONFIGURED");

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { authorization: "Bearer da_token-long-enough-for-validation" }
    });
    assert.equal(refreshResponse.statusCode, 503);
    assert.equal(refreshResponse.json().code, "DATABASE_REQUIRED");
  });

  it("validates community content before database writes", async () => {
    const communityResponse = await app.inject({
      method: "GET",
      url: "/api/v1/community/reviews"
    });
    assert.equal(communityResponse.statusCode, 503);
    assert.equal(communityResponse.json().code, "DATABASE_REQUIRED");

    const invalidCommunityResponse = await app.inject({
      method: "GET",
      url: "/api/v1/community/reviews?reviewType=UNKNOWN"
    });
    assert.equal(invalidCommunityResponse.statusCode, 400);
    assert.equal(invalidCommunityResponse.json().code, "INVALID_COMMUNITY_QUERY");

    const reviewsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/works/00000000-0000-4000-8000-000000000001/reviews"
    });
    assert.equal(reviewsResponse.statusCode, 503);
    assert.equal(reviewsResponse.json().code, "DATABASE_REQUIRED");

    const invalidLongReview = await app.inject({
      method: "POST",
      url: "/api/v1/works/00000000-0000-4000-8000-000000000001/reviews",
      payload: {
        reviewType: "LONG",
        body: "长评缺少标题",
        containsSpoiler: false
      }
    });
    assert.equal(invalidLongReview.statusCode, 400);
    assert.equal(invalidLongReview.json().code, "INVALID_REVIEW");
  });

  it("validates link feedback and catalog operations before database writes", async () => {
    const invalidFeedback = await app.inject({
      method: "POST",
      url: "/api/v1/work-links/00000000-0000-4000-8000-000000000001/feedback",
      payload: { reasonCode: "UNKNOWN" }
    });
    assert.equal(invalidFeedback.statusCode, 400);
    assert.equal(invalidFeedback.json().code, "INVALID_LINK_FEEDBACK");

    const clickWithoutDatabase = await app.inject({
      method: "POST",
      url: "/api/v1/work-links/00000000-0000-4000-8000-000000000001/click"
    });
    assert.equal(clickWithoutDatabase.statusCode, 503);
    assert.equal(clickWithoutDatabase.json().code, "DATABASE_REQUIRED");

    const invalidDetective = await app.inject({
      method: "POST",
      url: "/api/v1/admin/detectives",
      payload: { slug: "INVALID", nameZh: "测试" }
    });
    assert.equal(invalidDetective.statusCode, 400);
    assert.equal(invalidDetective.json().code, "INVALID_DETECTIVE");
  });

  it("validates content appeals before database writes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/appeals",
      payload: {
        targetType: "REVIEW",
        targetId: "00000000-0000-4000-8000-000000000001",
        reason: "短"
      }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "INVALID_APPEAL");
  });

  it("lists detectives with pagination", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives?pageSize=2" });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.total, 3);
    assert.equal(body.pagination.totalPages, 2);
    assert.deepEqual(body.facets.countries, ["比利时", "日本", "英国"].sort());
    assert.deepEqual(body.facets.subjectKinds, ["FICTIONAL"]);
    assert.ok(body.facets.tags.includes("古典推理"));
  });

  it("filters detectives by keyword", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives?q=%E6%B3%A2%E6%B4%9B" });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].slug, "hercule-poirot");
  });

  it("returns one detective by slug", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives/sherlock-holmes" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.nameZh, "夏洛克·福尔摩斯");
  });

  it("returns a stable error for a missing detective", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives/not-exist" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "DETECTIVE_NOT_FOUND");
  });

  it("rejects invalid pagination", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives?page=0" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "INVALID_QUERY");
  });

  it("lists and filters published works", async () => {
    const listResponse = await app.inject({ method: "GET", url: "/api/v1/works?pageSize=10" });
    const listBody = listResponse.json();
    assert.equal(listResponse.statusCode, 200);
    assert.equal(listBody.data.length, 5);
    assert.equal(listBody.pagination.total, 5);

    const filterResponse = await app.inject({
      method: "GET",
      url: "/api/v1/works?q=%E6%B1%9F%E6%88%B7%E5%B7%9D%E4%B9%B1%E6%AD%A5"
    });
    assert.equal(filterResponse.statusCode, 200);
    assert.equal(filterResponse.json().data[0].slug, "d-slope-murder-case");
  });

  it("returns a work with its official links and related detective", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/works/murder-on-the-orient-express"
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.titleZh, "东方快车谋杀案");
    assert.equal(body.data.detectives[0].slug, "hercule-poirot");
    assert.equal(body.data.links[0].providerName, "Agatha Christie Official");
    assert.match(body.data.links[0].url, /^https:\/\//);
  });

  it("returns stable errors for invalid or missing works", async () => {
    const invalidResponse = await app.inject({ method: "GET", url: "/api/v1/works/INVALID" });
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(invalidResponse.json().code, "INVALID_SLUG");

    const missingResponse = await app.inject({ method: "GET", url: "/api/v1/works/not-exist" });
    assert.equal(missingResponse.statusCode, 404);
    assert.equal(missingResponse.json().code, "WORK_NOT_FOUND");
  });

  it("lists the complete picture-book volume index", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?pageSize=150"
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 109);
    assert.equal(body.coverage.standardVolumeCount, 108);
    assert.equal(body.coverage.latestPublishedVolume, 108);
    assert.equal(body.pagination.total, 109);
    assert.deepEqual(body.data[0].linkedRecommendations, []);
  });

  it("searches picture-book names, aliases and recommended works", async () => {
    const aliasResponse = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?q=%E9%B2%81%E9%82%A6"
    });
    assert.equal(aliasResponse.statusCode, 200);
    assert.equal(aliasResponse.json().data[0].id, "PB-004-STD");

    const workResponse = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?q=%E6%81%90%E6%80%96%E8%B0%B7"
    });
    assert.equal(workResponse.statusCode, 200);
    assert.equal(workResponse.json().data[0].id, "PB-001-STD");
  });

  it("keeps standard and special volume entries distinct", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?fromVolume=105&toVolume=105&pageSize=10"
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.data.map((entry: { id: string }) => entry.id),
      ["PB-105-STD", "PB-105-SP"]
    );
  });

  it("returns one picture-book entry with a case-insensitive id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book/pb-105-sp"
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.names.zh, "工藤新一");
    assert.equal(response.json().data.verification.identity, "PRIMARY_SOURCE_CONFIRMED");
  });

  it("rejects a reversed picture-book volume range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?fromVolume=20&toVolume=10"
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "INVALID_QUERY");
  });

  it("lists archive extensions separately from historical subjects", async () => {
    const extensionsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory?collection=ARCHIVE_EXTENSION&pageSize=50"
    });
    const extensionsBody = extensionsResponse.json();
    assert.equal(extensionsResponse.statusCode, 200);
    assert.equal(extensionsBody.data.length, 26);
    assert.equal(extensionsBody.coverage.extensionCount, 26);
    assert.ok(extensionsBody.data.every((entry: { id: string }) => entry.id.startsWith("EXT-")));

    const historicalResponse = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory?collection=HISTORICAL_CASES&pageSize=50"
    });
    const historicalBody = historicalResponse.json();
    assert.equal(historicalResponse.statusCode, 200);
    assert.equal(historicalBody.data.length, 3);
    assert.ok(historicalBody.data.every((entry: { id: string }) => entry.id.startsWith("HIS-")));
  });

  it("searches archive-directory aliases and representative works", async () => {
    const aliasResponse = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory?q=%E5%8D%97%E5%B8%8C"
    });
    assert.equal(aliasResponse.statusCode, 200);
    assert.equal(aliasResponse.json().data[0].id, "EXT-WL-008");

    const workResponse = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory?q=%E5%BF%83%E7%90%86%E7%BD%AA"
    });
    assert.equal(workResponse.statusCode, 200);
    assert.equal(workResponse.json().data[0].id, "EXT-CN-003");

    const forensicResponse = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory?q=%E6%B3%95%E5%8C%BB%E6%8E%A8%E7%90%86"
    });
    assert.equal(forensicResponse.statusCode, 200);
    assert.equal(forensicResponse.json().data[0].id, "EXT-WL-014");
  });

  it("returns one archive-directory entry and its sources", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory/his-cn-003"
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.names.zh, "宋慈");
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].quality, "PUBLIC_INSTITUTION");

    const extensionResponse = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory/ext-wl-009"
    });
    const extensionBody = extensionResponse.json();
    assert.equal(extensionResponse.statusCode, 200);
    assert.equal(extensionBody.data.names.zh, "姆玛·拉莫茨韦");
    assert.equal(extensionBody.sources[0].quality, "PUBLISHER");
  });

  it("rejects an invalid archive-directory collection", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/archive-directory?collection=UNKNOWN"
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "INVALID_QUERY");
  });
});

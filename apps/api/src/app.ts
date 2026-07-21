import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry
} from "prom-client";
import type { AdminCredentialValidator } from "./auth/admin.js";
import type { WechatCodeExchange } from "./auth/wechat.js";
import type { ContentSafetyCheck } from "./auth/wechat-content-safety.js";
import type { DatabaseClient } from "./db/types.js";
import { archiveDirectoryRoutes } from "./routes/archive-directory.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { communityRoutes } from "./routes/community.js";
import { detectiveRoutes } from "./routes/detectives.js";
import { pictureBookRoutes } from "./routes/picture-book.js";
import { shelfRoutes } from "./routes/shelf.js";
import { workRoutes } from "./routes/works.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  corsOrigin?: string | string[];
  trustProxy?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  metricsAuthToken?: string;
  database?: DatabaseClient;
  wechatCodeExchange?: WechatCodeExchange;
  contentSafetyCheck?: ContentSafetyCheck;
  sessionTtlSeconds?: number;
  adminCredentialValidator?: AdminCredentialValidator;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
    trustProxy: options.trustProxy ?? false
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      app.log.error({ err: error, requestId: request.id }, "unhandled request error");
      return reply.code(500).send({
        code: "INTERNAL_SERVER_ERROR",
        message: "服务暂时不可用，请稍后再试"
      });
    }
    if (statusCode === 429) {
      return reply.code(429).send({ code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" });
    }
    if (statusCode === 413) {
      return reply.code(413).send({ code: "PAYLOAD_TOO_LARGE", message: "请求内容过大" });
    }
    return reply.code(statusCode).send({
      code: error.code ?? "REQUEST_REJECTED",
      message: error.message
    });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  });

  await app.register(cors, {
    origin: options.corsOrigin === "*" ? true : options.corsOrigin ?? false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
  });

  await app.register(rateLimit, {
    global: true,
    max: options.rateLimitMax ?? 300,
    timeWindow: options.rateLimitWindowMs ?? 60_000,
    allowList: (request) => ["/health", "/ready", "/metrics"].includes(request.url)
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (
      request.url.startsWith("/api/")
      || request.url === "/health"
      || request.url === "/ready"
      || request.url === "/metrics"
    ) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics, prefix: "detective_archives_" });
  const requestCounter = new Counter({
    name: "detective_archives_http_requests_total",
    help: "Total number of HTTP responses",
    labelNames: ["method", "route", "status_code"],
    registers: [metrics]
  });
  const requestDuration = new Histogram({
    name: "detective_archives_http_request_duration_seconds",
    help: "HTTP response duration in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metrics]
  });
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status_code: String(reply.statusCode)
    };
    requestCounter.inc(labels);
    requestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../../admin", import.meta.url)),
    prefix: "/admin/",
    index: ["index.html"]
  });
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));

  app.get("/health", async () => ({
    status: "ok",
    service: "detective-archives-api"
  }));

  app.get("/ready", async (_request, reply) => {
    if (!options.database) {
      return reply.code(503).send({
        status: "not_ready",
        service: "detective-archives-api",
        database: "not_configured"
      });
    }

    try {
      await options.database.query("SELECT 1");
      return {
        status: "ready",
        service: "detective-archives-api",
        database: "connected"
      };
    } catch (error) {
      app.log.error({ err: error }, "database readiness check failed");
      return reply.code(503).send({
        status: "not_ready",
        service: "detective-archives-api",
        database: "unavailable"
      });
    }
  });

  app.get("/metrics", async (request, reply) => {
    if (options.metricsAuthToken) {
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
      const actual = Buffer.from(token);
      const expected = Buffer.from(options.metricsAuthToken);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return reply.code(401).send({ code: "METRICS_AUTH_REQUIRED", message: "监控凭证无效" });
      }
    }
    reply.header("content-type", metrics.contentType);
    return reply.send(await metrics.metrics());
  });

  if (options.database) {
    app.addHook("onClose", async () => {
      await options.database?.end();
    });
  }

  const routeOptions = {
    prefix: "/api/v1",
    ...(options.database ? { database: options.database } : {}),
    ...(options.wechatCodeExchange ? { wechatCodeExchange: options.wechatCodeExchange } : {}),
    ...(options.contentSafetyCheck ? { contentSafetyCheck: options.contentSafetyCheck } : {}),
    ...(options.sessionTtlSeconds ? { sessionTtlSeconds: options.sessionTtlSeconds } : {}),
    ...(options.adminCredentialValidator
      ? { adminCredentialValidator: options.adminCredentialValidator }
      : {})
  };
  await app.register(authRoutes, routeOptions);
  await app.register(adminRoutes, routeOptions);
  await app.register(communityRoutes, routeOptions);
  await app.register(detectiveRoutes, routeOptions);
  await app.register(pictureBookRoutes, routeOptions);
  await app.register(archiveDirectoryRoutes, routeOptions);
  await app.register(workRoutes, routeOptions);
  await app.register(shelfRoutes, routeOptions);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ code: "ROUTE_NOT_FOUND", message: "接口不存在" });
  });

  return app;
}

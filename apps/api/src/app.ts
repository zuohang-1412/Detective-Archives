import cors from "@fastify/cors";
import Fastify from "fastify";
import type { DatabaseClient } from "./db/types.js";
import { archiveDirectoryRoutes } from "./routes/archive-directory.js";
import { detectiveRoutes } from "./routes/detectives.js";
import { pictureBookRoutes } from "./routes/picture-book.js";
import { workRoutes } from "./routes/works.js";

export interface BuildAppOptions {
  logger?: boolean;
  corsOrigin?: string;
  database?: DatabaseClient;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id"
  });

  await app.register(cors, {
    origin: options.corsOrigin === "*" ? true : options.corsOrigin ?? false,
    methods: ["GET", "POST", "PATCH", "DELETE"]
  });

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

  if (options.database) {
    app.addHook("onClose", async () => {
      await options.database?.end();
    });
  }

  const routeOptions = {
    prefix: "/api/v1",
    ...(options.database ? { database: options.database } : {})
  };
  await app.register(detectiveRoutes, routeOptions);
  await app.register(pictureBookRoutes, routeOptions);
  await app.register(archiveDirectoryRoutes, routeOptions);
  await app.register(workRoutes, routeOptions);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ code: "ROUTE_NOT_FOUND", message: "接口不存在" });
  });

  return app;
}

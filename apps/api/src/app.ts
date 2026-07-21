import cors from "@fastify/cors";
import Fastify from "fastify";
import { archiveDirectoryRoutes } from "./routes/archive-directory.js";
import { detectiveRoutes } from "./routes/detectives.js";
import { pictureBookRoutes } from "./routes/picture-book.js";

export interface BuildAppOptions {
  logger?: boolean;
  corsOrigin?: string;
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

  await app.register(detectiveRoutes, { prefix: "/api/v1" });
  await app.register(pictureBookRoutes, { prefix: "/api/v1" });
  await app.register(archiveDirectoryRoutes, { prefix: "/api/v1" });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ code: "ROUTE_NOT_FOUND", message: "接口不存在" });
  });

  return app;
}

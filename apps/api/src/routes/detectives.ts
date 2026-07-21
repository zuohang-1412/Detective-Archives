import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { DatabaseClient } from "../db/types.js";
import {
  getDetectiveBySlug,
  listDetectiveFacets,
  listDetectives
} from "../repositories/detectives.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(50).optional(),
  country: z.string().trim().max(30).optional(),
  era: z.string().trim().max(80).optional(),
  category: z.enum([
    "WORLD_LITERATURE",
    "SCREEN_DETECTIVES",
    "JAPANESE_POPULAR",
    "CHINESE_LITERATURE",
    "HISTORICAL_JUSTICE"
  ]).optional(),
  subjectKind: z.enum(["FICTIONAL", "HISTORICAL"]).optional(),
  tag: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

const slugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(80)
});

interface DetectiveRouteOptions {
  database?: DatabaseClient;
}

export const detectiveRoutes: FastifyPluginAsync<DetectiveRouteOptions> = async (app, options) => {
  app.get("/detectives", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_QUERY",
        message: "查询条件不合法",
        details: parsed.error.flatten()
      });
    }

    const { page, pageSize } = parsed.data;
    const [result, facets] = await Promise.all([
      listDetectives(options.database, parsed.data),
      listDetectiveFacets(options.database)
    ]);
    return {
      data: result.data,
      facets,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize)
      }
    };
  });

  app.get("/detectives/:slug", async (request, reply) => {
    const parsed = slugParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_SLUG", message: "侦探标识不合法" });
    }

    const detective = await getDetectiveBySlug(options.database, parsed.data.slug);
    if (!detective) {
      return reply.code(404).send({ code: "DETECTIVE_NOT_FOUND", message: "未找到该侦探档案" });
    }

    return { data: detective };
  });
};

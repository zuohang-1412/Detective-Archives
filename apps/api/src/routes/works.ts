import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { DatabaseClient } from "../db/types.js";
import { getWorkBySlug, listWorks } from "../repositories/works.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  type: z
    .enum(["NOVEL", "SHORT_STORY", "COMIC", "FILM", "SERIES", "ANIMATION", "GAME", "OTHER"])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

const slugParamsSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)
});

interface WorkRouteOptions {
  database?: DatabaseClient;
}

export const workRoutes: FastifyPluginAsync<WorkRouteOptions> = async (app, options) => {
  app.get("/works", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_QUERY",
        message: "作品查询条件不合法",
        details: parsed.error.flatten()
      });
    }

    const result = await listWorks(options.database, parsed.data);
    return {
      data: result.data,
      pagination: {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / parsed.data.pageSize)
      }
    };
  });

  app.get("/works/:slug", async (request, reply) => {
    const parsed = slugParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_SLUG", message: "作品标识不合法" });
    }

    const work = await getWorkBySlug(options.database, parsed.data.slug);
    if (!work) {
      return reply.code(404).send({ code: "WORK_NOT_FOUND", message: "未找到该作品" });
    }
    return { data: work };
  });
};

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { detectives } from "../data/detectives.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(50).optional(),
  country: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

const slugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(80)
});

export const detectiveRoutes: FastifyPluginAsync = async (app) => {
  app.get("/detectives", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_QUERY",
        message: "查询条件不合法",
        details: parsed.error.flatten()
      });
    }

    const { q, country, page, pageSize } = parsed.data;
    const normalizedQuery = q?.toLocaleLowerCase("zh-CN");
    const filtered = detectives.filter((detective) => {
      const matchesCountry = !country || detective.country === country;
      const searchable = [
        detective.nameZh,
        detective.nameOriginal,
        detective.creatorName,
        ...detective.tags
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      return matchesCountry && matchesQuery;
    });

    const start = (page - 1) * pageSize;
    return {
      data: filtered.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / pageSize)
      }
    };
  });

  app.get("/detectives/:slug", async (request, reply) => {
    const parsed = slugParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_SLUG", message: "侦探标识不合法" });
    }

    const detective = detectives.find((item) => item.slug === parsed.data.slug);
    if (!detective) {
      return reply.code(404).send({ code: "DETECTIVE_NOT_FOUND", message: "未找到该侦探档案" });
    }

    return { data: detective };
  });
};

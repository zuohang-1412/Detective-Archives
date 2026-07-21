import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { recordCatalogView, visitorHashFromRequest } from "../analytics/visitor.js";
import { bearerToken, findActiveSession } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { getWorkBySlug, listWorks } from "../repositories/works.js";
import {
  createWorkLinkFeedback,
  trackWorkLinkClick
} from "../repositories/work-link-feedback.js";

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
const linkParamsSchema = z.object({ linkId: z.uuid() });
const linkFeedbackSchema = z.object({
  reasonCode: z.enum([
    "BROKEN",
    "WRONG_DESTINATION",
    "REGION_UNAVAILABLE",
    "COPYRIGHT_CONCERN",
    "OTHER"
  ]),
  description: z.string().trim().min(2).max(500).optional()
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
    await recordCatalogView(options.database, request, "WORK_LIST_VIEW", null);
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
    await recordCatalogView(options.database, request, "WORK_DETAIL_VIEW", work.id);
    return { data: work };
  });

  app.post("/work-links/:linkId/click", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const params = linkParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ code: "INVALID_WORK_LINK", message: "链接标识不合法" });
    }
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const token = bearerToken(request);
    const session = token ? await findActiveSession(options.database, token) : null;
    const tracked = await trackWorkLinkClick(
      options.database,
      params.data.linkId,
      session?.id ?? null,
      visitorHashFromRequest(request),
      request.id
    );
    if (!tracked) {
      return reply.code(404).send({ code: "WORK_LINK_NOT_FOUND", message: "链接已失效或不存在" });
    }
    return { data: tracked };
  });

  app.post("/work-links/:linkId/feedback", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const params = linkParamsSchema.safeParse(request.params);
    const body = linkFeedbackSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_LINK_FEEDBACK", message: "链接反馈不合法" });
    }
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const token = bearerToken(request);
    const session = token ? await findActiveSession(options.database, token) : null;
    try {
      const feedback = await createWorkLinkFeedback(
        options.database,
        params.data.linkId,
        session?.id ?? null,
        body.data.reasonCode,
        body.data.description
      );
      if (!feedback) {
        return reply.code(404).send({ code: "WORK_LINK_NOT_FOUND", message: "链接已失效或不存在" });
      }
      return reply.code(201).send({ data: feedback });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return reply.code(409).send({ code: "LINK_FEEDBACK_EXISTS", message: "该问题已提交，正在处理中" });
      }
      throw error;
    }
  });
};

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { authorizeRoles } from "../auth/authorization.js";
import type { DatabaseClient } from "../db/types.js";
import {
  createAdminWork,
  createAdminWorkLink,
  getAdminDashboard,
  getModerationQueue,
  handleReport,
  listAdminWorks,
  moderateContent,
  setAdminWorkLinkActive,
  setAdminWorkStatus,
  suspendUser,
  updateAdminWork
} from "../repositories/admin.js";

const contentParamsSchema = z.object({
  targetType: z.enum(["REVIEW", "COMMENT"]),
  targetId: z.uuid()
});
const moderationBodySchema = z.object({
  action: z.enum(["PUBLISH", "HIDE", "RESTORE", "REJECT"]),
  reason: z.string().trim().min(2).max(500)
});
const reportParamsSchema = z.object({ reportId: z.uuid() });
const reportBodySchema = z.object({
  status: z.enum(["PROCESSING", "RESOLVED", "REJECTED"]),
  resolutionNote: z.string().trim().min(2).max(500)
});
const userParamsSchema = z.object({ userId: z.uuid() });
const suspensionBodySchema = z.object({
  durationHours: z.number().int().min(1).max(24 * 365),
  reason: z.string().trim().min(2).max(500)
});
const workParamsSchema = z.object({ workId: z.uuid() });
const linkParamsSchema = z.object({ linkId: z.uuid() });
const workQuerySchema = z.object({ q: z.string().trim().max(80).optional() });
const workInputSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  titleZh: z.string().trim().min(1).max(200),
  titleOriginal: z.string().trim().max(240).optional(),
  mediaType: z.enum(["NOVEL", "SHORT_STORY", "COMIC", "FILM", "SERIES", "ANIMATION", "GAME", "OTHER"]),
  releaseYear: z.number().int().min(1000).max(2200).optional(),
  summary: z.string().trim().max(5000).optional(),
  coverUrl: z.url().max(1000).optional(),
  creatorName: z.string().trim().max(120).optional()
});
const workStatusSchema = z.object({
  status: z.enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "HIDDEN", "ARCHIVED"])
});
const workLinkSchema = z.object({
  linkType: z.enum(["PUBLISHER", "BOOKSTORE", "LIBRARY", "STREAMING", "OFFICIAL_SITE", "OTHER"]),
  providerName: z.string().trim().min(1).max(100),
  url: z.url().refine((url) => url.startsWith("https://"), "正版链接必须使用 HTTPS"),
  region: z.string().trim().min(1).max(30).default("CN")
});
const linkStatusSchema = z.object({ isActive: z.boolean() });

interface AdminRouteOptions {
  database?: DatabaseClient;
}

export const adminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, options) => {
  app.get("/admin/dashboard", async (request, reply) => {
    const user = await authorizeRoles(
      options.database,
      request,
      reply,
      ["EDITOR", "MODERATOR", "ADMIN"]
    );
    if (!user || !options.database) return;
    return { data: await getAdminDashboard(options.database) };
  });

  app.get("/admin/moderation", async (request, reply) => {
    const user = await authorizeRoles(options.database, request, reply, ["MODERATOR", "ADMIN"]);
    if (!user || !options.database) return;
    return { data: await getModerationQueue(options.database) };
  });

  app.post("/admin/moderation/:targetType/:targetId", async (request, reply) => {
    const params = contentParamsSchema.safeParse(request.params);
    const body = moderationBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_MODERATION_ACTION", message: "审核操作不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["MODERATOR", "ADMIN"]);
    if (!user || !options.database) return;
    const content = await moderateContent(
      options.database,
      user.id,
      params.data.targetType,
      params.data.targetId,
      body.data.action,
      body.data.reason,
      request.id
    );
    if (!content) {
      return reply.code(404).send({ code: "CONTENT_NOT_FOUND", message: "未找到可审核的内容" });
    }
    return { data: content };
  });

  app.patch("/admin/reports/:reportId", async (request, reply) => {
    const params = reportParamsSchema.safeParse(request.params);
    const body = reportBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_REPORT_ACTION", message: "举报处理信息不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["MODERATOR", "ADMIN"]);
    if (!user || !options.database) return;
    const report = await handleReport(
      options.database,
      user.id,
      params.data.reportId,
      body.data.status,
      body.data.resolutionNote,
      request.id
    );
    if (!report) {
      return reply.code(404).send({ code: "REPORT_NOT_FOUND", message: "未找到待处理举报" });
    }
    return { data: report };
  });

  app.post("/admin/users/:userId/suspend", async (request, reply) => {
    const params = userParamsSchema.safeParse(request.params);
    const body = suspensionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_SUSPENSION", message: "用户处置信息不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["MODERATOR", "ADMIN"]);
    if (!user || !options.database) return;
    if (params.data.userId === user.id) {
      return reply.code(400).send({ code: "CANNOT_SUSPEND_SELF", message: "不能限制自己的账号" });
    }
    const suspended = await suspendUser(
      options.database,
      user.id,
      params.data.userId,
      body.data.durationHours,
      body.data.reason,
      request.id
    );
    if (!suspended) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "未找到可处置的普通用户" });
    }
    return { data: suspended };
  });

  app.get("/admin/works", async (request, reply) => {
    const query = workQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "作品查询条件不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    return { data: await listAdminWorks(options.database, query.data.q) };
  });

  app.post("/admin/works", async (request, reply) => {
    const body = workInputSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        code: "INVALID_WORK",
        message: "作品信息不合法",
        details: body.error.flatten()
      });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    try {
      const work = await createAdminWork(options.database, user.id, body.data, request.id);
      return reply.code(201).send({ data: work });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return reply.code(409).send({ code: "WORK_SLUG_EXISTS", message: "作品标识已经存在" });
      }
      throw error;
    }
  });

  app.patch("/admin/works/:workId", async (request, reply) => {
    const params = workParamsSchema.safeParse(request.params);
    const body = workInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_WORK", message: "作品信息不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    const work = await updateAdminWork(
      options.database,
      user.id,
      params.data.workId,
      body.data,
      request.id,
      user.role === "EDITOR"
    );
    if (!work) {
      return user.role === "EDITOR"
        ? reply.code(409).send({ code: "WORK_NOT_EDITABLE", message: "已发布作品需由管理员维护" })
        : reply.code(404).send({ code: "WORK_NOT_FOUND", message: "未找到该作品" });
    }
    return { data: work };
  });

  app.post("/admin/works/:workId/status", async (request, reply) => {
    const params = workParamsSchema.safeParse(request.params);
    const body = workStatusSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_WORK_STATUS", message: "作品状态不合法" });
    }
    const allowedRoles: Array<"EDITOR" | "ADMIN"> =
      body.success && body.data.status === "PENDING_REVIEW"
        ? ["EDITOR", "ADMIN"]
        : ["ADMIN"];
    const user = await authorizeRoles(options.database, request, reply, allowedRoles);
    if (!user || !options.database) return;
    const work = await setAdminWorkStatus(
      options.database,
      user.id,
      params.data.workId,
      body.data.status,
      request.id
    );
    if (!work) {
      return reply.code(404).send({ code: "WORK_NOT_FOUND", message: "未找到该作品" });
    }
    return { data: work };
  });

  app.post("/admin/works/:workId/links", async (request, reply) => {
    const params = workParamsSchema.safeParse(request.params);
    const body = workLinkSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_WORK_LINK", message: "正版链接信息不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    const link = await createAdminWorkLink(
      options.database,
      user.id,
      params.data.workId,
      body.data,
      request.id,
      user.role === "ADMIN"
    );
    if (!link) {
      return reply.code(404).send({ code: "WORK_NOT_FOUND", message: "未找到该作品" });
    }
    return reply.code(201).send({ data: link });
  });

  app.patch("/admin/work-links/:linkId", async (request, reply) => {
    const params = linkParamsSchema.safeParse(request.params);
    const body = linkStatusSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_WORK_LINK", message: "链接状态不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["ADMIN"]);
    if (!user || !options.database) return;
    const link = await setAdminWorkLinkActive(
      options.database,
      user.id,
      params.data.linkId,
      body.data.isActive,
      request.id
    );
    if (!link) {
      return reply.code(404).send({ code: "WORK_LINK_NOT_FOUND", message: "未找到该链接" });
    }
    return { data: link };
  });
};

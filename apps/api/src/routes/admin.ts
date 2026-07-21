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
import { getProductAnalytics } from "../repositories/analytics.js";
import { handleContentAppeal } from "../repositories/appeals.js";
import {
  createAdminDetective,
  listAdminAuditLogs,
  listAdminDetectives,
  listAdminUsers,
  setAdminDetectiveStatus,
  setAdminUserRole,
  updateAdminDetective
} from "../repositories/admin-catalog.js";
import {
  handleWorkLinkFeedback,
  listAdminWorkLinkFeedback
} from "../repositories/work-link-feedback.js";

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
const appealParamsSchema = z.object({ appealId: z.uuid() });
const appealResolutionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  resolutionNote: z.string().trim().min(2).max(500)
});
const userParamsSchema = z.object({ userId: z.uuid() });
const suspensionBodySchema = z.object({
  durationHours: z.number().int().min(1).max(24 * 365),
  reason: z.string().trim().min(2).max(500)
});
const workParamsSchema = z.object({ workId: z.uuid() });
const linkParamsSchema = z.object({ linkId: z.uuid() });
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50)
});
const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(30).max(365).default(90)
});
const workQuerySchema = listQuerySchema.extend({ q: z.string().trim().max(80).optional() });
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
const detectiveParamsSchema = z.object({ detectiveId: z.uuid() });
const detectiveCategorySchema = z.enum([
  "WORLD_LITERATURE",
  "SCREEN_DETECTIVES",
  "JAPANESE_POPULAR",
  "CHINESE_LITERATURE",
  "HISTORICAL_JUSTICE"
]);
const detectiveMediaTypeSchema = z.enum([
  "NOVEL", "SHORT_STORY", "COMIC", "FILM", "SERIES", "ANIMATION", "GAME", "OTHER"
]);
const verificationSchema = z.enum([
  "MISSING", "SOURCE_CAPTURED", "PRIMARY_SOURCE_CONFIRMED"
]);
const detectiveSourceSchema = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.url().refine((url) => url.startsWith("https://"), "资料来源必须使用 HTTPS"),
  quality: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,29}$/),
  verification: verificationSchema.default("SOURCE_CAPTURED")
});
const detectiveInputSchema = z.object({
  catalogId: z.string().trim().max(20).optional(),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  nameZh: z.string().trim().min(1).max(120),
  nameOriginal: z.string().trim().max(160).optional(),
  nameEn: z.string().trim().max(160).optional(),
  country: z.string().trim().max(60).optional(),
  era: z.string().trim().max(80).optional(),
  subjectKind: z.enum(["FICTIONAL", "HISTORICAL"]).default("FICTIONAL"),
  collection: z.enum(["CORE", "ARCHIVE_EXTENSION", "HISTORICAL_CASES"]).default("CORE"),
  category: detectiveCategorySchema.optional(),
  mediaTypes: z.array(detectiveMediaTypeSchema).max(8).default([]),
  summary: z.string().trim().min(10).max(5000),
  sourceNote: z.string().trim().max(2000).optional(),
  verification: verificationSchema.default("SOURCE_CAPTURED"),
  creatorName: z.string().trim().max(120).optional(),
  aliases: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  featuredCases: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
  sources: z.array(detectiveSourceSchema).max(20).default([])
});
const detectiveStatusSchema = z.object({
  status: z.enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "HIDDEN", "ARCHIVED"])
});
const userQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  role: z.enum(["USER", "EDITOR", "MODERATOR", "ADMIN"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50)
});
const roleBodySchema = z.object({
  role: z.enum(["USER", "EDITOR", "MODERATOR", "ADMIN"])
});
const auditQuerySchema = z.object({
  action: z.string().trim().regex(/^[A-Z0-9_]+$/).max(80).optional(),
  resourceType: z.string().trim().regex(/^[A-Z0-9_]+$/).max(50).optional(),
  actorId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50)
});
const feedbackParamsSchema = z.object({ feedbackId: z.uuid() });
const feedbackResolutionSchema = z.object({
  status: z.enum(["RESOLVED", "REJECTED"]),
  resolutionNote: z.string().trim().min(2).max(500),
  deactivateLink: z.boolean().default(false)
});

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

  app.get("/admin/analytics", async (request, reply) => {
    const query = analyticsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        code: "INVALID_ANALYTICS_PERIOD",
        message: "统计周期必须在 30 到 365 天之间"
      });
    }
    const user = await authorizeRoles(
      options.database,
      request,
      reply,
      ["EDITOR", "MODERATOR", "ADMIN"]
    );
    if (!user || !options.database) return;
    return { data: await getProductAnalytics(options.database, query.data.days) };
  });

  app.get("/admin/moderation", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "审核队列分页条件不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["MODERATOR", "ADMIN"]);
    if (!user || !options.database) return;
    const result = await getModerationQueue(options.database, query.data.page, query.data.pageSize);
    return {
      data: {
        reviews: result.reviews,
        comments: result.comments,
        reports: result.reports,
        appeals: result.appeals
      },
      pagination: {
        page: query.data.page,
        pageSize: query.data.pageSize,
        reviews: {
          total: result.reviewTotal,
          totalPages: Math.ceil(result.reviewTotal / query.data.pageSize)
        },
        comments: {
          total: result.commentTotal,
          totalPages: Math.ceil(result.commentTotal / query.data.pageSize)
        },
        reports: {
          total: result.reportTotal,
          totalPages: Math.ceil(result.reportTotal / query.data.pageSize)
        },
        appeals: {
          total: result.appealTotal,
          totalPages: Math.ceil(result.appealTotal / query.data.pageSize)
        }
      }
    };
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

  app.patch("/admin/appeals/:appealId", async (request, reply) => {
    const params = appealParamsSchema.safeParse(request.params);
    const body = appealResolutionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        code: "INVALID_APPEAL_ACTION",
        message: "申诉处理信息不符合要求"
      });
    }
    const user = await authorizeRoles(options.database, request, reply, ["MODERATOR", "ADMIN"]);
    if (!user || !options.database) return;
    const result = await handleContentAppeal(
      options.database,
      user.id,
      params.data.appealId,
      body.data.status,
      body.data.resolutionNote,
      request.id
    );
    if (result.kind === "NOT_FOUND") {
      return reply.code(404).send({
        code: "APPEAL_NOT_FOUND",
        message: "未找到待处理申诉"
      });
    }
    if (result.kind === "CONTENT_CHANGED") {
      return reply.code(409).send({
        code: "APPEAL_TARGET_CHANGED",
        message: "内容状态已变化，请刷新后重新处理"
      });
    }
    return { data: result.appeal };
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
    const result = await listAdminWorks(options.database, query.data);
    return {
      data: result.data,
      pagination: {
        page: query.data.page,
        pageSize: query.data.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.data.pageSize)
      }
    };
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

  app.get("/admin/detectives", async (request, reply) => {
    const query = workQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "侦探查询条件不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    const result = await listAdminDetectives(options.database, query.data);
    return {
      data: result.data,
      pagination: {
        page: query.data.page,
        pageSize: query.data.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.data.pageSize)
      }
    };
  });

  app.post("/admin/detectives", async (request, reply) => {
    const body = detectiveInputSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        code: "INVALID_DETECTIVE",
        message: "侦探档案信息不合法",
        details: body.error.flatten()
      });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    try {
      const detective = await createAdminDetective(options.database, user.id, body.data, request.id);
      return reply.code(201).send({ data: detective });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "DETECTIVE_SLUG_RESERVED") {
          return reply.code(409).send({ code: error.code, message: "该侦探标识是历史访问地址" });
        }
        if (error.code === "23505") {
          return reply.code(409).send({ code: "DETECTIVE_EXISTS", message: "侦探编号或标识已经存在" });
        }
      }
      throw error;
    }
  });

  app.patch("/admin/detectives/:detectiveId", async (request, reply) => {
    const params = detectiveParamsSchema.safeParse(request.params);
    const body = detectiveInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_DETECTIVE", message: "侦探档案信息不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    try {
      const detective = await updateAdminDetective(
        options.database,
        user.id,
        params.data.detectiveId,
        body.data,
        request.id,
        user.role === "EDITOR"
      );
      if (!detective) {
        return user.role === "EDITOR"
          ? reply.code(409).send({ code: "DETECTIVE_NOT_EDITABLE", message: "已发布档案需由管理员维护" })
          : reply.code(404).send({ code: "DETECTIVE_NOT_FOUND", message: "未找到该侦探档案" });
      }
      return { data: detective };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "DETECTIVE_SLUG_RESERVED") {
          return reply.code(409).send({ code: error.code, message: "该侦探标识属于其他历史访问地址" });
        }
        if (error.code === "23505") {
          return reply.code(409).send({ code: "DETECTIVE_EXISTS", message: "侦探编号或标识已经存在" });
        }
      }
      throw error;
    }
  });

  app.post("/admin/detectives/:detectiveId/status", async (request, reply) => {
    const params = detectiveParamsSchema.safeParse(request.params);
    const body = detectiveStatusSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_DETECTIVE_STATUS", message: "侦探档案状态不合法" });
    }
    const roles: Array<"EDITOR" | "ADMIN"> = body.data.status === "PENDING_REVIEW"
      ? ["EDITOR", "ADMIN"]
      : ["ADMIN"];
    const user = await authorizeRoles(options.database, request, reply, roles);
    if (!user || !options.database) return;
    const detective = await setAdminDetectiveStatus(
      options.database,
      user.id,
      params.data.detectiveId,
      body.data.status,
      request.id
    );
    if (!detective) {
      return reply.code(404).send({ code: "DETECTIVE_NOT_FOUND", message: "未找到可变更状态的侦探档案" });
    }
    return { data: detective };
  });

  app.get("/admin/users", async (request, reply) => {
    const query = userQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "用户查询条件不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["ADMIN"]);
    if (!user || !options.database) return;
    const result = await listAdminUsers(options.database, query.data);
    return {
      data: result.data,
      pagination: {
        page: query.data.page,
        pageSize: query.data.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.data.pageSize)
      }
    };
  });

  app.patch("/admin/users/:userId/role", async (request, reply) => {
    const params = userParamsSchema.safeParse(request.params);
    const body = roleBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_USER_ROLE", message: "用户角色不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["ADMIN"]);
    if (!user || !options.database) return;
    if (params.data.userId === user.id) {
      return reply.code(400).send({ code: "CANNOT_CHANGE_SELF_ROLE", message: "不能修改自己的角色" });
    }
    const result = await setAdminUserRole(
      options.database,
      user.id,
      params.data.userId,
      body.data.role,
      request.id
    );
    if (result.kind === "NOT_FOUND") {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "未找到该用户" });
    }
    if (result.kind === "LAST_ADMIN") {
      return reply.code(409).send({ code: "LAST_ADMIN_REQUIRED", message: "系统至少需要保留一名管理员" });
    }
    return { data: result.user };
  });

  app.get("/admin/audit-logs", async (request, reply) => {
    const query = auditQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "审计查询条件不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["ADMIN"]);
    if (!user || !options.database) return;
    const result = await listAdminAuditLogs(options.database, query.data);
    return {
      data: result.data,
      pagination: {
        page: query.data.page,
        pageSize: query.data.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.data.pageSize)
      }
    };
  });

  app.get("/admin/work-link-feedback", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "链接反馈分页条件不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["EDITOR", "ADMIN"]);
    if (!user || !options.database) return;
    const result = await listAdminWorkLinkFeedback(options.database, query.data.page, query.data.pageSize);
    return {
      data: result.data,
      pagination: {
        page: query.data.page,
        pageSize: query.data.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.data.pageSize)
      }
    };
  });

  app.patch("/admin/work-link-feedback/:feedbackId", async (request, reply) => {
    const params = feedbackParamsSchema.safeParse(request.params);
    const body = feedbackResolutionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_LINK_FEEDBACK_ACTION", message: "链接反馈处理信息不合法" });
    }
    const user = await authorizeRoles(options.database, request, reply, ["ADMIN"]);
    if (!user || !options.database) return;
    const feedback = await handleWorkLinkFeedback(
      options.database,
      user.id,
      params.data.feedbackId,
      body.data.status,
      body.data.resolutionNote,
      body.data.deactivateLink,
      request.id
    );
    if (!feedback) {
      return reply.code(404).send({ code: "LINK_FEEDBACK_NOT_FOUND", message: "未找到待处理的链接反馈" });
    }
    return { data: feedback };
  });
};

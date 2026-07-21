import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, findActiveSession } from "../auth/session.js";
import type { ContentSafetyCheck } from "../auth/wechat-content-safety.js";
import type { DatabaseClient } from "../db/types.js";
import {
  createComment,
  createReport,
  createReview,
  type ContentSafetyAudit,
  getMyReview,
  getPublicReview,
  listMyReviews,
  listPublicComments,
  listPublicReviews,
  setLike,
  softDeleteComment,
  softDeleteReview,
  updateReview
} from "../repositories/community.js";

const uuidParamsSchema = z.object({ workId: z.uuid().optional(), reviewId: z.uuid().optional(), commentId: z.uuid().optional() });
const reviewListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});
const reviewInputSchema = z.object({
  reviewType: z.enum(["SHORT", "LONG"]),
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().min(2).max(10_000),
  rating: z.number().int().min(1).max(5).optional(),
  containsSpoiler: z.boolean().default(false)
}).refine((value) => value.reviewType === "SHORT" || Boolean(value.title), {
  message: "长评必须填写标题",
  path: ["title"]
});
const commentInputSchema = z.object({
  parentId: z.uuid().nullable().optional(),
  body: z.string().trim().min(1).max(1000),
  containsSpoiler: z.boolean().default(false)
});
const reportInputSchema = z.object({
  targetType: z.enum(["REVIEW", "COMMENT"]),
  targetId: z.uuid(),
  reasonCode: z.enum(["SPAM", "ABUSE", "HATE", "SPOILER", "ILLEGAL", "COPYRIGHT", "OTHER"]),
  description: z.string().trim().max(500).optional()
});

interface CommunityRouteOptions {
  database?: DatabaseClient;
  contentSafetyCheck?: ContentSafetyCheck;
}

type ContentSafetyDecision = ContentSafetyAudit | {
  status: "RISKY";
  label?: number | undefined;
  traceId?: string | undefined;
};

async function requireUser(
  database: DatabaseClient | undefined,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!database) {
    await reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    return null;
  }
  const token = bearerToken(request);
  const session = token ? await findActiveSession(database, token) : null;
  if (!session) {
    await reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" });
    return null;
  }
  return session;
}

async function optionalViewer(database: DatabaseClient, request: FastifyRequest) {
  const token = bearerToken(request);
  return token ? await findActiveSession(database, token) : null;
}

function databaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

async function assessContent(
  checker: ContentSafetyCheck | undefined,
  user: { wechatOpenId: string | null },
  content: string,
  request: FastifyRequest
): Promise<ContentSafetyDecision> {
  if (!checker) return { status: "NOT_CONFIGURED" };
  if (!user.wechatOpenId) return { status: "UNAVAILABLE" };
  try {
    const result = await checker({
      openId: user.wechatOpenId,
      content,
      scene: 2
    });
    const details = {
      ...(result.label !== undefined ? { label: result.label } : {}),
      ...(result.traceId ? { traceId: result.traceId } : {})
    };
    if (result.suggestion === "risky") return { status: "RISKY", ...details };
    return {
      status: result.suggestion === "review" ? "REVIEW" : "PASS",
      ...details
    };
  } catch (error) {
    request.log.warn({
      errorName: error instanceof Error ? error.name : "UnknownError",
      requestId: request.id
    }, "content safety service unavailable; content remains pending for manual review");
    return { status: "UNAVAILABLE" };
  }
}

export const communityRoutes: FastifyPluginAsync<CommunityRouteOptions> = async (
  app,
  options
) => {
  app.get("/works/:workId/reviews", async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    const query = reviewListSchema.safeParse(request.query);
    if (!params.success || !params.data.workId || !query.success) {
      return reply.code(400).send({ code: "INVALID_REVIEW_QUERY", message: "评价查询条件不合法" });
    }
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const viewer = await optionalViewer(options.database, request);
    const result = await listPublicReviews(
      options.database,
      params.data.workId,
      viewer?.id ?? null,
      query.data.page,
      query.data.pageSize
    );
    return {
      data: result.data,
      pagination: {
        ...query.data,
        total: result.total,
        totalPages: Math.ceil(result.total / query.data.pageSize)
      }
    };
  });

  app.post("/works/:workId/reviews", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    const body = reviewInputSchema.safeParse(request.body);
    if (!params.success || !params.data.workId || !body.success) {
      return reply.code(400).send({
        code: "INVALID_REVIEW",
        message: "评价内容不合法",
        ...(!body.success ? { details: body.error.flatten() } : {})
      });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    const contentSafety = await assessContent(
      options.contentSafetyCheck,
      user,
      [body.data.title, body.data.body].filter(Boolean).join("\n"),
      request
    );
    if (contentSafety.status === "RISKY") {
      return reply.code(422).send({
        code: "CONTENT_NOT_ALLOWED",
        message: "内容未通过安全检查，请修改后重试"
      });
    }
    try {
      const review = await createReview(
        options.database,
        user.id,
        params.data.workId,
        body.data,
        request.id,
        contentSafety
      );
      if (!review) {
        return reply.code(404).send({ code: "WORK_NOT_FOUND", message: "未找到可评价的作品" });
      }
      return reply.code(201).send({ data: review });
    } catch (error) {
      if (databaseErrorCode(error) === "23505") {
        return reply.code(409).send({
          code: "REVIEW_ALREADY_EXISTS",
          message: "你已经为这部作品写过同类型评价"
        });
      }
      throw error;
    }
  });

  app.get("/reviews/:reviewId", async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.reviewId) {
      return reply.code(400).send({ code: "INVALID_REVIEW_ID", message: "评价编号不合法" });
    }
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const viewer = await optionalViewer(options.database, request);
    const review = await getPublicReview(options.database, params.data.reviewId, viewer?.id ?? null);
    if (!review) {
      return reply.code(404).send({ code: "REVIEW_NOT_FOUND", message: "未找到该评价" });
    }
    const comments = await listPublicComments(
      options.database,
      params.data.reviewId,
      viewer?.id ?? null
    );
    return { data: { ...review, comments } };
  });

  app.get("/me/reviews", async (request, reply) => {
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    return { data: await listMyReviews(options.database, user.id) };
  });

  app.get("/me/reviews/:reviewId", async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.reviewId) {
      return reply.code(400).send({ code: "INVALID_REVIEW_ID", message: "评价编号不合法" });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    const review = await getMyReview(options.database, user.id, params.data.reviewId);
    if (!review) {
      return reply.code(404).send({ code: "REVIEW_NOT_FOUND", message: "未找到你的评价" });
    }
    return { data: review };
  });

  app.patch("/reviews/:reviewId", async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    const body = reviewInputSchema.safeParse(request.body);
    if (!params.success || !params.data.reviewId || !body.success) {
      return reply.code(400).send({ code: "INVALID_REVIEW", message: "评价内容不合法" });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    const contentSafety = await assessContent(
      options.contentSafetyCheck,
      user,
      [body.data.title, body.data.body].filter(Boolean).join("\n"),
      request
    );
    if (contentSafety.status === "RISKY") {
      return reply.code(422).send({
        code: "CONTENT_NOT_ALLOWED",
        message: "内容未通过安全检查，请修改后重试"
      });
    }
    try {
      const review = await updateReview(
        options.database,
        user.id,
        params.data.reviewId,
        body.data,
        request.id,
        contentSafety
      );
      if (!review) {
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND", message: "未找到可修改的评价" });
      }
      return { data: review };
    } catch (error) {
      if (databaseErrorCode(error) === "23505") {
        return reply.code(409).send({
          code: "REVIEW_ALREADY_EXISTS",
          message: "你已经为这部作品写过同类型评价"
        });
      }
      throw error;
    }
  });

  app.delete("/reviews/:reviewId", async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.reviewId) {
      return reply.code(400).send({ code: "INVALID_REVIEW_ID", message: "评价编号不合法" });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    const removed = await softDeleteReview(
      options.database,
      user.id,
      params.data.reviewId,
      request.id
    );
    if (!removed) {
      return reply.code(404).send({ code: "REVIEW_NOT_FOUND", message: "未找到可删除的评价" });
    }
    return reply.code(204).send();
  });

  app.post("/reviews/:reviewId/comments", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    const body = commentInputSchema.safeParse(request.body);
    if (!params.success || !params.data.reviewId || !body.success) {
      return reply.code(400).send({ code: "INVALID_COMMENT", message: "回复内容不合法" });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    const contentSafety = await assessContent(
      options.contentSafetyCheck,
      user,
      body.data.body,
      request
    );
    if (contentSafety.status === "RISKY") {
      return reply.code(422).send({
        code: "CONTENT_NOT_ALLOWED",
        message: "内容未通过安全检查，请修改后重试"
      });
    }
    const comment = await createComment(
      options.database,
      user.id,
      params.data.reviewId,
      body.data.parentId ?? null,
      body.data.body,
      body.data.containsSpoiler,
      request.id,
      contentSafety
    );
    if (!comment) {
      return reply.code(404).send({ code: "REVIEW_NOT_FOUND", message: "未找到可回复的评价" });
    }
    return reply.code(201).send({ data: comment });
  });

  app.delete("/comments/:commentId", async (request, reply) => {
    const params = uuidParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.commentId) {
      return reply.code(400).send({ code: "INVALID_COMMENT_ID", message: "回复编号不合法" });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    const removed = await softDeleteComment(
      options.database,
      user.id,
      params.data.commentId,
      request.id
    );
    if (!removed) {
      return reply.code(404).send({ code: "COMMENT_NOT_FOUND", message: "未找到可删除的回复" });
    }
    return reply.code(204).send();
  });

  for (const targetType of ["REVIEW", "COMMENT"] as const) {
    const path = targetType === "REVIEW" ? "/reviews/:reviewId/like" : "/comments/:commentId/like";
    for (const method of ["PUT", "DELETE"] as const) {
      app.route({
        method,
        url: path,
        handler: async (request, reply) => {
          const params = uuidParamsSchema.safeParse(request.params);
          const targetId = targetType === "REVIEW"
            ? params.data?.reviewId
            : params.data?.commentId;
          if (!params.success || !targetId) {
            return reply.code(400).send({ code: "INVALID_TARGET_ID", message: "内容编号不合法" });
          }
          const user = await requireUser(options.database, request, reply);
          if (!user || !options.database) return;
          const likeCount = await setLike(
            options.database,
            user.id,
            targetType,
            targetId,
            method === "PUT"
          );
          if (likeCount === null) {
            return reply.code(404).send({ code: "CONTENT_NOT_FOUND", message: "未找到可点赞的内容" });
          }
          return { data: { liked: method === "PUT", likeCount } };
        }
      });
    }
  }

  app.post("/reports", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = reportInputSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ code: "INVALID_REPORT", message: "举报信息不合法" });
    }
    const user = await requireUser(options.database, request, reply);
    if (!user || !options.database) return;
    try {
      const report = await createReport(options.database, user.id, body.data, request.id);
      if (!report) {
        return reply.code(404).send({ code: "CONTENT_NOT_FOUND", message: "未找到可举报的内容" });
      }
      return reply.code(201).send({ data: report });
    } catch (error) {
      if (databaseErrorCode(error) === "23505") {
        return reply.code(409).send({
          code: "REPORT_ALREADY_OPEN",
          message: "你已经举报过该内容，我们正在处理"
        });
      }
      throw error;
    }
  });
};

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, findActiveSession } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import {
  getShelfItem,
  listShelfItems,
  removeShelfItem,
  upsertShelfItem
} from "../repositories/shelf.js";

const statusSchema = z.enum(["WISHLIST", "IN_PROGRESS", "COMPLETED", "PAUSED", "DROPPED"]);
const listQuerySchema = z.object({
  status: statusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(50)
});
const workParamsSchema = z.object({ workId: z.uuid() });
const updateSchema = z.object({
  status: statusSchema,
  progressPercent: z.number().int().min(0).max(100).optional()
});

interface ShelfRouteOptions {
  database?: DatabaseClient;
}

async function authenticatedUser(
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

export const shelfRoutes: FastifyPluginAsync<ShelfRouteOptions> = async (app, options) => {
  app.get("/me/shelf", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_QUERY", message: "书架筛选条件不合法" });
    }
    const user = await authenticatedUser(options.database, request, reply);
    if (!user || !options.database) return;
    const result = await listShelfItems(
      options.database,
      user.id,
      query.data.status,
      query.data.page,
      query.data.pageSize
    );
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

  app.get("/me/shelf/:workId", async (request, reply) => {
    const params = workParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ code: "INVALID_WORK_ID", message: "作品编号不合法" });
    }
    const user = await authenticatedUser(options.database, request, reply);
    if (!user || !options.database) return;
    const item = await getShelfItem(options.database, user.id, params.data.workId);
    return { data: item };
  });

  app.put("/me/shelf/:workId", async (request, reply) => {
    const params = workParamsSchema.safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        code: "INVALID_SHELF_ITEM",
        message: "阅读状态或进度不合法"
      });
    }
    const user = await authenticatedUser(options.database, request, reply);
    if (!user || !options.database) return;
    const item = await upsertShelfItem(
      options.database,
      user.id,
      params.data.workId,
      body.data.status,
      body.data.progressPercent
    );
    if (!item) {
      return reply.code(404).send({ code: "WORK_NOT_FOUND", message: "未找到可收藏的作品" });
    }
    return { data: item };
  });

  app.delete("/me/shelf/:workId", async (request, reply) => {
    const params = workParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ code: "INVALID_WORK_ID", message: "作品编号不合法" });
    }
    const user = await authenticatedUser(options.database, request, reply);
    if (!user || !options.database) return;
    await removeShelfItem(options.database, user.id, params.data.workId);
    return reply.code(204).send();
  });
};

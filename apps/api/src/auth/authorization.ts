import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, findActiveSession } from "./session.js";
import type { AuthUser } from "./session.js";
import type { DatabaseClient } from "../db/types.js";

export async function authorizeRoles(
  database: DatabaseClient | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: AuthUser["role"][]
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
  if (!allowedRoles.includes(session.role)) {
    await reply.code(403).send({ code: "FORBIDDEN", message: "你没有执行此操作的权限" });
    return null;
  }
  return session;
}

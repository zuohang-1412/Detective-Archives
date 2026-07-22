import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, findAccountRightsSession, findActiveSession } from "./session.js";
import type { AuthUser } from "./session.js";
import type { DatabaseClient } from "../db/types.js";

export async function requireActiveSession(
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
  if (session) return session;

  const accountRights = token ? await findAccountRightsSession(database, token) : null;
  if (accountRights?.isSuspended) {
    await reply.code(403).send({
      code: "ACCOUNT_SUSPENDED",
      message: "账号当前受限，仅可导出个人数据、退出或注销账号"
    });
    return null;
  }
  if (accountRights && !accountRights.agreementsCurrent) {
    await reply.code(428).send({
      code: "AGREEMENT_RECONSENT_REQUIRED",
      message: "用户协议或隐私政策已更新，请重新阅读并确认"
    });
    return null;
  }
  await reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" });
  return null;
}

export async function authorizeRoles(
  database: DatabaseClient | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: AuthUser["role"][]
) {
  const session = await requireActiveSession(database, request, reply);
  if (!session) return null;
  if (!allowedRoles.includes(session.role)) {
    await reply.code(403).send({ code: "FORBIDDEN", message: "你没有执行此操作的权限" });
    return null;
  }
  return session;
}

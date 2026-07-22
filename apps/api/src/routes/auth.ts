import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdminCredentialValidator } from "../auth/admin.js";
import {
  bearerToken,
  findAccountRightsSession,
  sessionTokenHash
} from "../auth/session.js";
import type { WechatCodeExchange } from "../auth/wechat.js";
import { WechatCodeExchangeError } from "../auth/wechat.js";
import type { DatabaseClient } from "../db/types.js";
import {
  deactivateUserAccount,
  loginAdminUser,
  loginWechatUser,
  refreshUserSession
} from "../repositories/users.js";
import { exportUserData } from "../repositories/user-data-export.js";

const loginSchema = z.object({
  code: z.string().trim().min(1).max(200),
  agreements: z.object({
    termsAccepted: z.literal(true),
    privacyAccepted: z.literal(true)
  }),
  profile: z.object({
    displayName: z.string().trim().min(1).max(60).default("推理读者"),
    avatarUrl: z.url().max(1000).optional()
  }).default({ displayName: "推理读者" })
});
const adminLoginSchema = z.object({
  loginId: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(500)
});
const deactivateSchema = z.object({ confirmation: z.literal("DELETE") });

interface AuthRouteOptions {
  database?: DatabaseClient;
  wechatCodeExchange?: WechatCodeExchange;
  sessionTtlSeconds?: number;
  adminCredentialValidator?: AdminCredentialValidator;
}

async function requireAccountRightsSession(
  database: DatabaseClient | undefined,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!database) {
    await reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    return null;
  }
  const token = bearerToken(request);
  const session = token ? await findAccountRightsSession(database, token) : null;
  if (!session) {
    await reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" });
    return null;
  }
  return session;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  app.post("/auth/admin", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsed = adminLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_LOGIN_REQUEST", message: "登录信息不合法" });
    }
    if (!options.database || !options.adminCredentialValidator) {
      return reply.code(503).send({ code: "AUTH_NOT_CONFIGURED", message: "管理员登录尚未配置" });
    }
    if (!options.adminCredentialValidator(parsed.data.loginId, parsed.data.password)) {
      return reply.code(401).send({ code: "ADMIN_LOGIN_FAILED", message: "账号或密码错误" });
    }
    const result = await loginAdminUser(
      options.database,
      parsed.data.loginId,
      options.sessionTtlSeconds ?? 28_800
    );
    return reply.code(201).send({ data: result });
  });

  app.post("/auth/wechat", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_LOGIN_REQUEST",
        message: "登录信息不合法",
        details: parsed.error.flatten()
      });
    }
    if (!options.database || !options.wechatCodeExchange) {
      return reply.code(503).send({
        code: "AUTH_NOT_CONFIGURED",
        message: "登录服务尚未配置"
      });
    }

    try {
      const identity = await options.wechatCodeExchange(parsed.data.code);
      const result = await loginWechatUser(
        options.database,
        identity,
        parsed.data.profile,
        options.sessionTtlSeconds ?? 2_592_000
      );
      return reply.code(201).send({ data: result });
    } catch (error) {
      if (error instanceof WechatCodeExchangeError) {
        app.log.warn({ err: error }, "wechat code exchange failed");
        return reply.code(401).send({
          code: "WECHAT_LOGIN_FAILED",
          message: "微信登录凭证无效或已过期"
        });
      }
      throw error;
    }
  });

  app.get("/auth/me", async (request, reply) => {
    const session = await requireAccountRightsSession(options.database, request, reply);
    if (!session) return;
    const {
      sessionId: _sessionId,
      wechatOpenId: _wechatOpenId,
      ...user
    } = session;
    return { data: user };
  });

  app.post("/auth/refresh", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const token = bearerToken(request);
    const result = token ? await refreshUserSession(options.database, token) : null;
    if (!result) {
      return reply.code(401).send({ code: "SESSION_REFRESH_FAILED", message: "登录已过期，请重新登录" });
    }
    return { data: result };
  });

  app.post("/auth/logout", async (request, reply) => {
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const token = bearerToken(request);
    if (!token) {
      return reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" });
    }
    await options.database.query(`
      UPDATE user_sessions SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL
    `, [sessionTokenHash(token)]);
    return reply.code(204).send();
  });

  app.get("/me/data-export", {
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const session = await requireAccountRightsSession(options.database, request, reply);
    if (!session || !options.database) return;
    if (session.role !== "USER") {
      return reply.code(403).send({
        code: "DATA_EXPORT_NOT_AVAILABLE",
        message: "运营账号不能使用用户数据导出"
      });
    }
    const exported = await exportUserData(
      options.database,
      session.id,
      session.sessionId,
      request.id
    );
    if (!exported) {
      return reply.code(409).send({
        code: "DATA_EXPORT_UNAVAILABLE",
        message: "当前账号数据暂时无法导出"
      });
    }
    const filenameDate = exported.generatedAt.slice(0, 10);
    reply.header(
      "content-disposition",
      `attachment; filename="detective-archives-data-${filenameDate}.json"`
    );
    reply.type("application/json; charset=utf-8");
    return reply.send(`${JSON.stringify(exported, null, 2)}\n`);
  });

  app.delete("/me/account", async (request, reply) => {
    const body = deactivateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        code: "ACCOUNT_DEACTIVATION_CONFIRMATION_REQUIRED",
        message: "请确认注销账号"
      });
    }
    const session = await requireAccountRightsSession(options.database, request, reply);
    if (!session || !options.database) return;
    const deactivated = await deactivateUserAccount(options.database, session.id, request.id);
    if (!deactivated) {
      return reply.code(409).send({ code: "ACCOUNT_CANNOT_BE_DEACTIVATED", message: "账号无法注销" });
    }
    return reply.code(204).send();
  });
};

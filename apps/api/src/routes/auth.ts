import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AdminCredentialValidator } from "../auth/admin.js";
import { bearerToken, findActiveSession, sessionTokenHash } from "../auth/session.js";
import type { WechatCodeExchange } from "../auth/wechat.js";
import { WechatCodeExchangeError } from "../auth/wechat.js";
import type { DatabaseClient } from "../db/types.js";
import {
  deactivateUserAccount,
  loginAdminUser,
  loginWechatUser
} from "../repositories/users.js";

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
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const token = bearerToken(request);
    const session = token ? await findActiveSession(options.database, token) : null;
    if (!session) {
      return reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" });
    }
    const { sessionId: _sessionId, ...user } = session;
    return { data: user };
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

  app.delete("/me/account", async (request, reply) => {
    const body = deactivateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        code: "ACCOUNT_DEACTIVATION_CONFIRMATION_REQUIRED",
        message: "请确认注销账号"
      });
    }
    if (!options.database) {
      return reply.code(503).send({ code: "DATABASE_REQUIRED", message: "服务暂不可用" });
    }
    const token = bearerToken(request);
    const session = token ? await findActiveSession(options.database, token) : null;
    if (!session) {
      return reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" });
    }
    const deactivated = await deactivateUserAccount(options.database, session.id, request.id);
    if (!deactivated) {
      return reply.code(409).send({ code: "ACCOUNT_CANNOT_BE_DEACTIVATED", message: "账号无法注销" });
    }
    return reply.code(204).send();
  });
};

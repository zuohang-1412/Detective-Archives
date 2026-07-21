import { createHash } from "node:crypto";

export interface WechatIdentity {
  providerSubject: string;
  unionSubject?: string | undefined;
}

export type WechatCodeExchange = (code: string) => Promise<WechatIdentity>;

interface Code2SessionResponse {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

export class WechatCodeExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatCodeExchangeError";
  }
}

export function createWechatCodeExchangeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WechatCodeExchange | undefined {
  if (env.WECHAT_DEV_LOGIN === "true") {
    if (env.NODE_ENV === "production") {
      throw new Error("WECHAT_DEV_LOGIN cannot be enabled in production");
    }
    const subject = env.WECHAT_DEV_SUBJECT ?? "local-user";
    const providerSubject = `dev_${createHash("sha256").update(subject).digest("hex")}`;
    return async () => ({ providerSubject });
  }

  const appId = env.WECHAT_APP_ID;
  const appSecret = env.WECHAT_APP_SECRET;
  if (!appId && !appSecret) return undefined;
  if (!appId || !appSecret) {
    throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET must be configured together");
  }

  return async (code) => {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", appSecret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw new WechatCodeExchangeError("WeChat login service is unavailable");
    }
    if (!response.ok) {
      throw new WechatCodeExchangeError(`WeChat login HTTP ${response.status}`);
    }
    const result = await response.json() as Code2SessionResponse;
    if (result.errcode || !result.openid) {
      throw new WechatCodeExchangeError(
        `WeChat login rejected the code (${result.errcode ?? "missing_openid"})`
      );
    }
    return {
      providerSubject: result.openid,
      ...(result.unionid ? { unionSubject: result.unionid } : {})
    };
  };
}

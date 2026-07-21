export type ContentSafetySuggestion = "pass" | "review" | "risky";

export interface ContentSafetyAssessment {
  suggestion: ContentSafetySuggestion;
  label?: number | undefined;
  traceId?: string | undefined;
}

export interface ContentSafetyInput {
  openId: string;
  content: string;
  scene: 1 | 2 | 3 | 4;
}

export type ContentSafetyCheck = (
  input: ContentSafetyInput
) => Promise<ContentSafetyAssessment>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
}

interface MessageSecurityResponse {
  errcode?: number;
  result?: {
    suggest?: ContentSafetySuggestion;
    label?: number;
  };
  trace_id?: string;
}

export class WechatContentSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatContentSafetyError";
  }
}

function chunks(content: string, maximumCharacters = 1500) {
  const characters = Array.from(content.trim());
  const result: string[] = [];
  for (let offset = 0; offset < characters.length; offset += maximumCharacters) {
    result.push(characters.slice(offset, offset + maximumCharacters).join(""));
  }
  return result;
}

export function createWechatContentSafetyCheckFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchLike = fetch
): ContentSafetyCheck | undefined {
  const appId = env.WECHAT_APP_ID;
  const appSecret = env.WECHAT_APP_SECRET;
  if (!appId && !appSecret) return undefined;
  if (!appId || !appSecret) {
    throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET must be configured together");
  }
  const configuredAppId: string = appId;
  const configuredAppSecret: string = appSecret;

  let cachedToken: { value: string; expiresAt: number } | null = null;
  let pendingToken: Promise<string> | null = null;

  async function requestAccessToken(forceRefresh = false) {
    if (forceRefresh) cachedToken = null;
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    if (pendingToken) return pendingToken;

    pendingToken = (async () => {
      const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
      url.searchParams.set("grant_type", "client_credential");
      url.searchParams.set("appid", configuredAppId);
      url.searchParams.set("secret", configuredAppSecret);
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          signal: AbortSignal.timeout(5000)
        });
      } catch (_error) {
        throw new WechatContentSafetyError("WeChat access token service is unavailable");
      }
      if (!response.ok) {
        throw new WechatContentSafetyError(`WeChat access token HTTP ${response.status}`);
      }
      const result = await response.json() as AccessTokenResponse;
      if (!result.access_token || result.errcode) {
        throw new WechatContentSafetyError(
          `WeChat access token rejected the request (${result.errcode ?? "missing_token"})`
        );
      }
      cachedToken = {
        value: result.access_token,
        expiresAt: Date.now() + Math.max(60, (result.expires_in ?? 7200) - 300) * 1000
      };
      return cachedToken.value;
    })();

    try {
      return await pendingToken;
    } finally {
      pendingToken = null;
    }
  }

  async function checkChunk(input: ContentSafetyInput, content: string, retry = true) {
    const token = await requestAccessToken();
    const url = new URL("https://api.weixin.qq.com/wxa/msg_sec_check");
    url.searchParams.set("access_token", token);
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          version: 2,
          scene: input.scene,
          openid: input.openId
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (_error) {
      throw new WechatContentSafetyError("WeChat content safety service is unavailable");
    }
    if (!response.ok) {
      throw new WechatContentSafetyError(`WeChat content safety HTTP ${response.status}`);
    }
    const result = await response.json() as MessageSecurityResponse;
    if (retry && [40001, 40014, 42001].includes(result.errcode ?? 0)) {
      await requestAccessToken(true);
      return checkChunk(input, content, false);
    }
    const suggestion = result.result?.suggest;
    if (result.errcode || !suggestion || !["pass", "review", "risky"].includes(suggestion)) {
      throw new WechatContentSafetyError(
        `WeChat content safety rejected the request (${result.errcode ?? "missing_result"})`
      );
    }
    return {
      suggestion,
      ...(result.result?.label !== undefined ? { label: result.result.label } : {}),
      ...(result.trace_id ? { traceId: result.trace_id } : {})
    } satisfies ContentSafetyAssessment;
  }

  return async (input) => {
    const parts = chunks(input.content);
    if (parts.length === 0) return { suggestion: "pass" };
    let aggregate: ContentSafetyAssessment = { suggestion: "pass" };
    for (let offset = 0; offset < parts.length; offset += 4) {
      const results = await Promise.all(
        parts.slice(offset, offset + 4).map((content) => checkChunk(input, content))
      );
      for (const result of results) {
        if (result.suggestion === "risky") return result;
        if (result.suggestion === "review") aggregate = result;
      }
    }
    return aggregate;
  };
}

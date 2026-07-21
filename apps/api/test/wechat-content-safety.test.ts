import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWechatContentSafetyCheckFromEnv,
  WechatContentSafetyError
} from "../src/auth/wechat-content-safety.js";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const environment = {
  WECHAT_APP_ID: "wx-content-safety-test",
  WECHAT_APP_SECRET: "content-safety-secret"
};

describe("wechat content safety", () => {
  it("stays disabled without WeChat credentials and rejects incomplete credentials", () => {
    assert.equal(createWechatContentSafetyCheckFromEnv({}), undefined);
    assert.throws(
      () => createWechatContentSafetyCheckFromEnv({ WECHAT_APP_ID: "wx-only" }),
      /must be configured together/
    );
  });

  it("caches access tokens and checks long text in bounded chunks", async () => {
    let tokenRequests = 0;
    const checkedContents: string[] = [];
    const checker = createWechatContentSafetyCheckFromEnv(environment, async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/cgi-bin/token") {
        tokenRequests += 1;
        return jsonResponse({ access_token: "token-one", expires_in: 7200 });
      }
      const body = JSON.parse(String(init?.body));
      checkedContents.push(body.content);
      assert.equal(body.version, 2);
      assert.equal(body.scene, 2);
      assert.equal(body.openid, "openid-one");
      return jsonResponse({ errcode: 0, result: { suggest: "pass", label: 100 } });
    });
    assert.ok(checker);

    const first = await checker({
      openId: "openid-one",
      content: "线".repeat(3100),
      scene: 2
    });
    const second = await checker({ openId: "openid-one", content: "短评", scene: 2 });
    assert.equal(first.suggestion, "pass");
    assert.equal(second.suggestion, "pass");
    assert.equal(tokenRequests, 1);
    assert.deepEqual(checkedContents.map((content) => Array.from(content).length), [1500, 1500, 100, 2]);
  });

  it("returns the strongest review or risky assessment", async () => {
    let checkCount = 0;
    const checker = createWechatContentSafetyCheckFromEnv(environment, async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/cgi-bin/token") {
        return jsonResponse({ access_token: "token-two", expires_in: 7200 });
      }
      checkCount += 1;
      return jsonResponse({
        errcode: 0,
        result: checkCount === 1
          ? { suggest: "review", label: 200 }
          : { suggest: "risky", label: 300 },
        trace_id: `trace-${checkCount}`
      });
    });
    assert.ok(checker);
    const result = await checker({
      openId: "openid-two",
      content: `${"待".repeat(1500)}${"拒".repeat(100)}`,
      scene: 2
    });
    assert.deepEqual(result, { suggestion: "risky", label: 300, traceId: "trace-2" });
  });

  it("refreshes an invalid access token once and surfaces dependency failures safely", async () => {
    let tokenRequests = 0;
    let checkRequests = 0;
    const checker = createWechatContentSafetyCheckFromEnv(environment, async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/cgi-bin/token") {
        tokenRequests += 1;
        return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: 7200 });
      }
      checkRequests += 1;
      return checkRequests === 1
        ? jsonResponse({ errcode: 40001 })
        : jsonResponse({ errcode: 0, result: { suggest: "pass" } });
    });
    assert.ok(checker);
    assert.equal((await checker({ openId: "openid", content: "内容", scene: 2 })).suggestion, "pass");
    assert.equal(tokenRequests, 2);

    const unavailable = createWechatContentSafetyCheckFromEnv(environment, async () => {
      throw new Error("private upstream detail");
    });
    assert.ok(unavailable);
    await assert.rejects(
      () => unavailable({ openId: "openid", content: "内容", scene: 2 }),
      (error: unknown) => error instanceof WechatContentSafetyError
        && error.message === "WeChat access token service is unavailable"
    );
  });
});

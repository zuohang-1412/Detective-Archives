import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWechatCodeExchangeFromEnv } from "../src/auth/wechat.js";

describe("wechat authentication configuration", () => {
  it("stays disabled when no WeChat configuration is present", () => {
    assert.equal(createWechatCodeExchangeFromEnv({}), undefined);
  });

  it("creates a stable, non-plain development identity outside production", async () => {
    const exchange = createWechatCodeExchangeFromEnv({
      NODE_ENV: "development",
      WECHAT_DEV_LOGIN: "true",
      WECHAT_DEV_SUBJECT: "local-test-user"
    });
    assert.ok(exchange);
    const first = await exchange("code-one");
    const second = await exchange("code-two");
    assert.equal(first.providerSubject, second.providerSubject);
    assert.equal(first.providerSubject.includes("local-test-user"), false);
  });

  it("refuses development login in production", () => {
    assert.throws(
      () => createWechatCodeExchangeFromEnv({
        NODE_ENV: "production",
        WECHAT_DEV_LOGIN: "true"
      }),
      /cannot be enabled in production/
    );
  });

  it("requires AppID and AppSecret together", () => {
    assert.throws(
      () => createWechatCodeExchangeFromEnv({ WECHAT_APP_ID: "only-app-id" }),
      /must be configured together/
    );
  });
});

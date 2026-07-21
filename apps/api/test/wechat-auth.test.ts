import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdminCredentialValidatorFromEnv } from "../src/auth/admin.js";
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

describe("admin authentication configuration", () => {
  it("validates configured credentials without storing a browser password", () => {
    const validate = createAdminCredentialValidatorFromEnv({
      NODE_ENV: "development",
      ADMIN_LOGIN_ID: "archive-admin",
      ADMIN_LOGIN_PASSWORD: "local-password"
    });
    assert.ok(validate);
    assert.equal(validate("archive-admin", "local-password"), true);
    assert.equal(validate("archive-admin", "wrong-password"), false);
  });

  it("requires a long production password and paired configuration", () => {
    assert.throws(
      () => createAdminCredentialValidatorFromEnv({ ADMIN_LOGIN_ID: "missing-password" }),
      /must be configured together/
    );
    assert.throws(
      () => createAdminCredentialValidatorFromEnv({
        NODE_ENV: "production",
        ADMIN_LOGIN_ID: "admin",
        ADMIN_LOGIN_PASSWORD: "too-short"
      }),
      /at least 16 characters/
    );
  });
});

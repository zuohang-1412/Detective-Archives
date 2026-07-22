import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const [agreementSource, migration, authRoute, authorization, legalPage, mePage, meTemplate, api] =
  await Promise.all([
    source("apps/api/src/auth/agreements.ts"),
    source("database/migrations/016_versioned_user_agreements.sql"),
    source("apps/api/src/routes/auth.ts"),
    source("apps/api/src/auth/authorization.ts"),
    source("apps/miniprogram/pages/legal/legal.js"),
    source("apps/miniprogram/pages/me/me.js"),
    source("apps/miniprogram/pages/me/me.wxml"),
    source("apps/miniprogram/services/api.js")
  ]);

const termsVersion = agreementSource.match(/termsVersion:\s*"([^"]+)"/)?.[1];
const privacyVersion = agreementSource.match(/privacyVersion:\s*"([^"]+)"/)?.[1];
assert.ok(termsVersion, "current terms version is missing");
assert.ok(privacyVersion, "current privacy version is missing");
assert.equal(
  (legalPage.match(new RegExp(`version: "${termsVersion}"`, "g")) || []).length,
  2,
  "both legal documents must display the API agreement version"
);
assert.match(migration, new RegExp(`terms_version = '${termsVersion}'`));
assert.match(migration, new RegExp(`privacy_version = '${privacyVersion}'`));

for (const evidence of [
  [authRoute, 'app.get("/auth/agreements"'],
  [authRoute, 'app.put("/me/agreements"'],
  [authRoute, "AGREEMENT_VERSION_OUTDATED"],
  [authorization, "AGREEMENT_RECONSENT_REQUIRED"],
  [api, 'request("/api/v1/auth/agreements")'],
  [api, 'request("/api/v1/me/agreements"'],
  [mePage, "agreementReconsentRequired"],
  [mePage, "acceptCurrentAgreements"],
  [meTemplate, "协议与隐私政策已更新"],
  [meTemplate, "导出我的数据"]
]) {
  assert.ok(evidence[0].includes(evidence[1]), `missing agreement evidence: ${evidence[1]}`);
}

console.log(`Agreement versioning check passed: terms=${termsVersion}, privacy=${privacyVersion}`);

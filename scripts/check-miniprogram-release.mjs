import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertReleaseGitStatus,
  buildMiniProgramReleasePlan,
  MINIPROGRAM_CI_VERSION,
  resolveNpmInvocation,
  sanitizeCiEnvironment,
  validCandidateUploadReceipt
} from "./lib/miniprogram-release.mjs";

const projectRoot = path.resolve();
const outsideRoot = path.resolve(projectRoot, "..", "detective-archives-release-secrets");
const environment = {
  MINIPROGRAM_APP_ID: "wxproduction123",
  MINIPROGRAM_PRIVATE_KEY_PATH: path.join(outsideRoot, "private.wxproduction123.key"),
  MINIPROGRAM_VERSION: "0.1.0-rc.1",
  MINIPROGRAM_RELEASE_DESC: "侦探档案馆 0.1.0 候选",
  MINIPROGRAM_CI_ROBOT: "2",
  LAUNCH_READINESS_FILE: "ops/launch-readiness.json"
};
const projectConfig = {
  appid: environment.MINIPROGRAM_APP_ID,
  libVersion: "3.17.0",
  setting: { urlCheck: true }
};
const miniProgramConfig = {
  apiBaseUrl: "https://api.detective-archives.test",
  operatorName: "侦探档案馆测试运营主体",
  privacyContact: "privacy@detective-archives.test"
};

const uploadPlan = buildMiniProgramReleasePlan({
  mode: "upload",
  environment,
  projectConfig,
  miniProgramConfig,
  projectRoot
});
assert.equal(uploadPlan.version, "0.1.0-rc.1");
assert.equal(uploadPlan.robot, 2);
assert.equal(path.basename(uploadPlan.launchManifestPath), "launch-readiness.json");

const previewPlan = buildMiniProgramReleasePlan({
  mode: "preview",
  environment: {
    ...environment,
    MINIPROGRAM_QR_OUTPUT: path.join(outsideRoot, "preview-0.1.0-rc.1.jpg")
  },
  projectConfig,
  miniProgramConfig,
  projectRoot
});
assert.equal(previewPlan.qrcodeOutputPath.endsWith(".jpg"), true);
assert.equal(previewPlan.launchManifestPath, null);

const rejects = (changes, expected) => assert.throws(() => buildMiniProgramReleasePlan({
  mode: changes.mode || "upload",
  environment: { ...environment, ...(changes.environment || {}) },
  projectConfig: { ...projectConfig, ...(changes.projectConfig || {}) },
  miniProgramConfig: { ...miniProgramConfig, ...(changes.miniProgramConfig || {}) },
  projectRoot
}), expected);

rejects({ mode: "release" }, /preview or upload/);
rejects({ environment: { MINIPROGRAM_APP_ID: "touristappid" } }, /real Mini Program AppID/);
rejects({ projectConfig: { appid: "wxdifferent123" } }, /must match/);
rejects({ projectConfig: { setting: { urlCheck: false } } }, /URL-domain checks/);
rejects({ miniProgramConfig: { apiBaseUrl: "http://api.detective-archives.test" } }, /exact HTTPS/);
rejects({ miniProgramConfig: { operatorName: "上线前填写" } }, /production information/);
rejects({ environment: { MINIPROGRAM_PRIVATE_KEY_PATH: "private.key" } }, /must be absolute/);
rejects({
  environment: { MINIPROGRAM_PRIVATE_KEY_PATH: path.join(projectRoot, "private.key") }
}, /outside the repository/);
rejects({ environment: { MINIPROGRAM_VERSION: "bad version" } }, /unsupported characters/);
rejects({ environment: { MINIPROGRAM_RELEASE_DESC: "line one\nline two" } }, /one line/);
rejects({ environment: { MINIPROGRAM_CI_ROBOT: "31" } }, /1 to 30/);
rejects({
  environment: { LAUNCH_READINESS_FILE: "ops/launch-readiness.example.json" }
}, /repository's ops\/launch-readiness\.json/);
rejects({
  environment: {
    LAUNCH_READINESS_FILE: path.join(outsideRoot, "launch-readiness.json")
  }
}, /repository's ops\/launch-readiness\.json/);
rejects({
  mode: "preview",
  environment: { MINIPROGRAM_QR_OUTPUT: path.join(projectRoot, "preview.jpg") }
}, /outside the repository/);

assert.equal(assertReleaseGitStatus(""), 0);
assert.equal(assertReleaseGitStatus(" M project.config.json\n M apps/miniprogram/config.js"), 2);
assert.throws(() => assertReleaseGitStatus(" M README.md"), /unapproved change/);
assert.throws(() => assertReleaseGitStatus("?? private.wxproduction123.key"), /unapproved change/);
assert.throws(() => assertReleaseGitStatus(" D project.config.json"), /unapproved change/);

const sanitized = sanitizeCiEnvironment({
  PATH: "safe-path",
  TEMP: "safe-temp",
  DATABASE_URL: "postgresql://secret",
  WECHAT_APP_SECRET: "wechat-secret",
  ADMIN_LOGIN_PASSWORD: "admin-secret",
  METRICS_AUTH_TOKEN: "metrics-secret",
  NODE_OPTIONS: "--require malicious.js"
});
assert.equal(sanitized.PATH, "safe-path");
assert.equal(sanitized.DATABASE_URL, undefined);
assert.equal(sanitized.WECHAT_APP_SECRET, undefined);
assert.equal(sanitized.ADMIN_LOGIN_PASSWORD, undefined);
assert.equal(sanitized.METRICS_AUTH_TOKEN, undefined);
assert.equal(sanitized.NODE_OPTIONS, undefined);

const npmRuntime = resolveNpmInvocation();
assert.equal(npmRuntime.command, process.execPath);
assert.equal(path.basename(npmRuntime.prefix[0]).toLowerCase(), "npm-cli.js");
assert.deepEqual(
  resolveNpmInvocation({ platform: "linux", npmExecPath: null }),
  { command: "npm", prefix: [] }
);
assert.throws(
  () => resolveNpmInvocation({ platform: "win32", npmExecPath: null }),
  /Run this command through npm/
);

const receipt = {
  schemaVersion: 1,
  action: "upload",
  status: "SUCCEEDED",
  appid: environment.MINIPROGRAM_APP_ID,
  version: environment.MINIPROGRAM_VERSION,
  sourceCommit: "a".repeat(40),
  robot: 2,
  completedAt: new Date().toISOString(),
  ciPackage: `miniprogram-ci@${MINIPROGRAM_CI_VERSION}`,
  projectConfigSha256: "b".repeat(64),
  miniProgramConfigSha256: "c".repeat(64)
};
assert.equal(validCandidateUploadReceipt(receipt, environment.MINIPROGRAM_APP_ID), true);
assert.equal(validCandidateUploadReceipt({ ...receipt, status: "PENDING" }, environment.MINIPROGRAM_APP_ID), false);
assert.equal(validCandidateUploadReceipt({ ...receipt, ciPackage: "miniprogram-ci@latest" }, environment.MINIPROGRAM_APP_ID), false);
assert.equal(validCandidateUploadReceipt({ ...receipt, projectConfigSha256: null }, environment.MINIPROGRAM_APP_ID), false);
assert.equal(validCandidateUploadReceipt({ ...receipt, sourceCommit: "short" }, environment.MINIPROGRAM_APP_ID), false);
assert.equal(validCandidateUploadReceipt(receipt, "wxother123"), false);

const releaseScript = await readFile(path.join(projectRoot, "scripts/release-miniprogram.mjs"), "utf8");
for (const requiredText of [
  `miniprogram-ci@\${MINIPROGRAM_CI_VERSION}`,
  "MINIPROGRAM_CI_REGISTRY",
  'npmRuntime.command, [...npmRuntime.prefix, "run", "release:check"]',
  "sanitizeCiEnvironment(process.env)",
  "candidateUploadReceipt"
]) {
  assert.ok(releaseScript.includes(requiredText), `release script must include ${requiredText}`);
}

console.log(
  `Mini Program release tooling: OK (isolated miniprogram-ci ${MINIPROGRAM_CI_VERSION}, upload evidence enforced)`
);

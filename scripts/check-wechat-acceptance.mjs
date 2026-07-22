import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWechatAcceptanceReceipt,
  recordWechatAcceptance,
  validWechatAcceptanceReceipt,
  WECHAT_CONTENT_SAFETY_SCENARIOS,
  WECHAT_DEVICE_PLATFORMS,
  WECHAT_DEVICE_SCENARIOS,
  WECHAT_PLATFORM_SETTINGS
} from "./lib/wechat-acceptance.mjs";

const now = Date.parse("2026-07-22T03:00:00.000Z");
const sourceCommit = "a".repeat(40);
const appid = "wxproduction123";
const publicApiOrigin = "https://api.detective-archives.cn";
const runbookSource = "# WeChat release acceptance runbook\n".repeat(10);
const runbookSha256 = createHash("sha256").update(runbookSource).digest("hex");
const environment = {
  WECHAT_APP_ID: appid,
  MINIPROGRAM_APP_ID: appid,
  WECHAT_APP_SECRET: "must-never-enter-the-receipt",
  PUBLIC_API_BASE_URL: publicApiOrigin
};
const candidateUploadReceipt = {
  schemaVersion: 1,
  action: "upload",
  status: "SUCCEEDED",
  appid,
  version: "0.1.0-rc.2",
  description: "侦探档案馆候选验收",
  sourceCommit,
  robot: 1,
  completedAt: "2026-07-22T02:00:00.000Z",
  ciPackage: "miniprogram-ci@2.1.31",
  projectConfigSha256: "b".repeat(64),
  miniProgramConfigSha256: "c".repeat(64)
};
const manifest = {
  schemaVersion: 1,
  operator: {
    wechatTester: "微信真机验收负责人甲"
  },
  wechat: {
    candidateUploaded: true,
    candidateUploadReceipt,
    serviceCategoryConfigured: true,
    privacyGuideConfigured: true,
    userAgreementApproved: true,
    requestDomainConfigured: true
  },
  validation: {
    contentSafetyPassed: true,
    iosDevicePassed: true,
    androidDevicePassed: true
  }
};

function evidence(id) {
  return {
    id,
    result: "PASSED",
    evidenceReference: `REL-2026-0722#${id}`
  };
}

const record = {
  schemaVersion: 1,
  status: "PASSED",
  appid,
  candidateVersion: candidateUploadReceipt.version,
  publicApiOrigin,
  tester: manifest.operator.wechatTester,
  completedAt: "2026-07-22T02:55:00.000Z",
  evidenceReference: "REL-2026-0722 微信候选验收工单",
  platformSettings: WECHAT_PLATFORM_SETTINGS.map(evidence),
  contentSafetyScenarios: WECHAT_CONTENT_SAFETY_SCENARIOS.map(evidence),
  deviceRuns: WECHAT_DEVICE_PLATFORMS.map((platform) => ({
    platform,
    deviceModel: platform === "IOS" ? "iPhone 15 Pro" : "Pixel 9 Pro",
    osVersion: platform === "IOS" ? "iOS 18.5" : "Android 16",
    wechatVersion: "8.0.61",
    completedAt: "2026-07-22T02:50:00.000Z",
    evidenceReference: `REL-2026-0722#${platform}`,
    scenarios: WECHAT_DEVICE_SCENARIOS.map(evidence)
  }))
};

const receipt = buildWechatAcceptanceReceipt({
  record,
  manifest,
  environment,
  sourceCommit,
  runbookSource,
  now
});
assert.equal(validWechatAcceptanceReceipt(receipt, {
  now,
  appid,
  sourceCommit,
  publicApiOrigin,
  candidateUploadReceipt,
  tester: manifest.operator.wechatTester,
  runbookSha256
}), true);
assert.equal(JSON.stringify(receipt).includes(environment.WECHAT_APP_SECRET), false);
assert.equal(validWechatAcceptanceReceipt({
  ...receipt,
  accidentalSecret: environment.WECHAT_APP_SECRET
}, {
  now,
  appid,
  sourceCommit,
  publicApiOrigin,
  candidateUploadReceipt,
  tester: manifest.operator.wechatTester,
  runbookSha256
}), false, "Acceptance receipts must reject non-whitelisted fields");
assert.deepEqual(receipt.platformSettings.map(({ id }) => id), WECHAT_PLATFORM_SETTINGS);
assert.deepEqual(receipt.deviceRuns.map(({ platform }) => platform), WECHAT_DEVICE_PLATFORMS);

for (const [label, mutation, expected] of [
  ["missing platform", (value) => value.platformSettings.pop(), /Platform acceptance/],
  ["missing safety", (value) => value.contentSafetyScenarios.pop(), /Content safety acceptance/],
  ["missing device", (value) => value.deviceRuns.pop(), /Device acceptance/],
  ["missing device scenario", (value) => value.deviceRuns[0].scenarios.pop(), /Device acceptance/],
  ["candidate version mismatch", (value) => { value.candidateVersion = "0.1.0-other"; }, /must match/],
  ["appid mismatch", (value) => { value.appid = "wxotherproduction123"; }, /must match/],
  ["unsafe evidence", (value) => {
    value.evidenceReference = "https://evidence.invalid/result?access_token=forbidden";
  }, /bounded non-secret/],
  ["unsafe safety evidence", (value) => {
    value.contentSafetyScenarios[0].evidenceReference =
      "https://evidence.invalid/result?signature=forbidden";
  }, /Content safety acceptance/]
]) {
  const invalidRecord = structuredClone(record);
  mutation(invalidRecord);
  assert.throws(() => buildWechatAcceptanceReceipt({
    record: invalidRecord,
    manifest,
    environment,
    sourceCommit,
    runbookSource,
    now
  }), expected, label);
}

const duplicateScenarioRecord = structuredClone(record);
duplicateScenarioRecord.platformSettings = [
  duplicateScenarioRecord.platformSettings[0],
  duplicateScenarioRecord.platformSettings[0],
  ...duplicateScenarioRecord.platformSettings.slice(1, 3)
];
assert.throws(() => buildWechatAcceptanceReceipt({
  record: duplicateScenarioRecord,
  manifest,
  environment,
  sourceCommit,
  runbookSource,
  now
}), /Platform acceptance/);

const duplicateDeviceRecord = structuredClone(record);
duplicateDeviceRecord.deviceRuns = [
  duplicateDeviceRecord.deviceRuns[0],
  structuredClone(duplicateDeviceRecord.deviceRuns[0])
];
assert.throws(() => buildWechatAcceptanceReceipt({
  record: duplicateDeviceRecord,
  manifest,
  environment,
  sourceCommit,
  runbookSource,
  now
}), /Device acceptance/);

assert.throws(() => buildWechatAcceptanceReceipt({
  record: { ...record, completedAt: "2026-05-01T00:00:00.000Z" },
  manifest,
  environment,
  sourceCommit,
  runbookSource,
  now
}), /Device acceptance|receipt fields/);
assert.throws(() => buildWechatAcceptanceReceipt({
  record,
  manifest: {
    ...manifest,
    wechat: {
      ...manifest.wechat,
      candidateUploadReceipt: { ...candidateUploadReceipt, sourceCommit: "d".repeat(40) }
    }
  },
  environment,
  sourceCommit,
  runbookSource,
  now
}), /candidate upload receipt/);
assert.equal(validWechatAcceptanceReceipt(receipt, {
  now,
  appid,
  sourceCommit,
  publicApiOrigin,
  candidateUploadReceipt: { ...candidateUploadReceipt, projectConfigSha256: "d".repeat(64) },
  tester: manifest.operator.wechatTester,
  runbookSha256
}), false, "Candidate receipt changes must invalidate acceptance evidence");
assert.equal(validWechatAcceptanceReceipt(receipt, {
  now,
  appid,
  sourceCommit,
  publicApiOrigin,
  candidateUploadReceipt,
  tester: manifest.operator.wechatTester,
  runbookSha256: "d".repeat(64)
}), false, "A changed acceptance runbook must invalidate the receipt");
assert.throws(() => buildWechatAcceptanceReceipt({
  record,
  manifest: {
    ...manifest,
    operator: { wechatTester: "另一位微信验收负责人" }
  },
  environment,
  sourceCommit,
  runbookSource,
  now
}), /tester must match/);
const staleReceipt = structuredClone(receipt);
staleReceipt.completedAt = "2026-05-01T00:00:00.000Z";
for (const device of staleReceipt.deviceRuns) {
  device.completedAt = "2026-05-01T00:00:00.000Z";
}
assert.equal(validWechatAcceptanceReceipt(staleReceipt, {
  now,
  appid,
  sourceCommit,
  publicApiOrigin,
  candidateUploadReceipt,
  tester: manifest.operator.wechatTester,
  runbookSha256
}), false, "Acceptance evidence older than 30 days must be rejected");

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "detective-wechat-acceptance-project-"));
const externalRoot = await mkdtemp(path.join(os.tmpdir(), "detective-wechat-acceptance-record-"));
try {
  await mkdir(path.join(projectRoot, "ops"), { recursive: true });
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });
  const manifestPath = path.join(projectRoot, "ops", "launch-readiness.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "docs", "runbook.md"), runbookSource);
  const recordPath = path.join(externalRoot, "wechat-acceptance.json");
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const result = await recordWechatAcceptance({
    projectRoot,
    recordPath,
    environment,
    sourceCommit,
    now
  });
  const updatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(updatedManifest.validation.wechatAcceptanceReceipt, result.receipt);
  for (const legacyField of [
    "contentSafetyPassed",
    "iosDevicePassed",
    "androidDevicePassed"
  ]) {
    assert.equal(legacyField in updatedManifest.validation, false);
  }
  for (const legacyField of [
    "serviceCategoryConfigured",
    "privacyGuideConfigured",
    "userAgreementApproved",
    "requestDomainConfigured"
  ]) {
    assert.equal(legacyField in updatedManifest.wechat, false);
  }
  assert.equal(
    JSON.parse(await readFile(path.join(projectRoot, result.receiptPath), "utf8")).status,
    "PASSED"
  );

  const internalRecordPath = path.join(projectRoot, "wechat-acceptance.json");
  await writeFile(internalRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(recordWechatAcceptance({
    projectRoot,
    recordPath: internalRecordPath,
    environment,
    sourceCommit,
    now
  }), /outside the repository/);
  await assert.rejects(recordWechatAcceptance({
    projectRoot,
    recordPath: "relative-wechat-acceptance.json",
    environment,
    sourceCommit,
    now
  }), /path must be absolute/);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}

console.log("WeChat acceptance evidence: OK (platform, iOS, Android, content safety and candidate bound)");

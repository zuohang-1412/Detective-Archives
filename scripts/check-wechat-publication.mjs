import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWechatAcceptanceReceipt,
  WECHAT_CONTENT_SAFETY_SCENARIOS,
  WECHAT_DEVICE_PLATFORMS,
  WECHAT_DEVICE_SCENARIOS,
  WECHAT_PLATFORM_SETTINGS
} from "./lib/wechat-acceptance.mjs";
import {
  buildWechatPublicationReceipt,
  recordWechatPublication,
  validWechatPublicationReceipt,
  WECHAT_PUBLICATION_EVENTS
} from "./lib/wechat-publication.mjs";

const now = Date.parse("2026-07-22T06:00:00.000Z");
const sourceCommit = "a".repeat(40);
const appid = "wxproduction123";
const publicApiOrigin = "https://api.detective-archives.cn";
const runbookSource = "# WeChat publication lifecycle runbook\n".repeat(10);
const runbookSha256 = createHash("sha256").update(runbookSource).digest("hex");
const environment = {
  WECHAT_APP_ID: appid,
  MINIPROGRAM_APP_ID: appid,
  WECHAT_APP_SECRET: "must-never-enter-publication-receipt",
  PUBLIC_API_BASE_URL: publicApiOrigin
};
const candidateUploadReceipt = {
  schemaVersion: 1,
  action: "upload",
  status: "SUCCEEDED",
  appid,
  version: "0.1.0-rc.3",
  description: "侦探档案馆上线候选",
  sourceCommit,
  robot: 1,
  completedAt: "2026-07-22T02:00:00.000Z",
  ciPackage: "miniprogram-ci@2.1.31",
  projectConfigSha256: "b".repeat(64),
  miniProgramConfigSha256: "c".repeat(64)
};
const tester = "微信真机验收负责人甲";
const publisher = "微信发布负责人甲";
const acceptanceEvidence = (id) => ({
  id,
  result: "PASSED",
  evidenceReference: `WX-ACCEPT-20260722#${id}`
});
const acceptanceManifest = {
  schemaVersion: 1,
  operator: { wechatTester: tester },
  wechat: { candidateUploaded: true, candidateUploadReceipt },
  validation: {}
};
const wechatAcceptanceReceipt = buildWechatAcceptanceReceipt({
  record: {
    schemaVersion: 1,
    status: "PASSED",
    appid,
    candidateVersion: candidateUploadReceipt.version,
    publicApiOrigin,
    tester,
    completedAt: "2026-07-22T03:00:00.000Z",
    evidenceReference: "WX-ACCEPT-20260722 微信候选验收工单",
    platformSettings: WECHAT_PLATFORM_SETTINGS.map(acceptanceEvidence),
    contentSafetyScenarios: WECHAT_CONTENT_SAFETY_SCENARIOS.map(acceptanceEvidence),
    deviceRuns: WECHAT_DEVICE_PLATFORMS.map((platform) => ({
      platform,
      deviceModel: platform === "IOS" ? "iPhone 15 Pro" : "Pixel 9 Pro",
      osVersion: platform === "IOS" ? "iOS 18.5" : "Android 16",
      wechatVersion: "8.0.61",
      completedAt: "2026-07-22T02:55:00.000Z",
      evidenceReference: `WX-ACCEPT-20260722#${platform}`,
      scenarios: WECHAT_DEVICE_SCENARIOS.map(acceptanceEvidence)
    }))
  },
  manifest: acceptanceManifest,
  environment,
  sourceCommit,
  runbookSource,
  now
});
const manifest = {
  schemaVersion: 1,
  operator: { wechatTester: tester, wechatPublisher: publisher },
  wechat: { candidateUploaded: true, candidateUploadReceipt },
  validation: { wechatAcceptanceReceipt }
};

function eventRecord(event, completedAt) {
  return {
    schemaVersion: 1,
    status: "PASSED",
    event,
    appid,
    candidateVersion: candidateUploadReceipt.version,
    publisher,
    completedAt,
    evidenceReference: `WX-PUBLISH-20260722#${event}`
  };
}

function build(record, currentManifest = manifest) {
  return buildWechatPublicationReceipt({
    record,
    manifest: currentManifest,
    environment,
    sourceCommit,
    runbookSource,
    now
  });
}

function validationOptions(targetStage, currentManifest = manifest) {
  return {
    now,
    appid,
    sourceCommit,
    publicApiOrigin,
    candidateUploadReceipt: currentManifest.wechat.candidateUploadReceipt,
    wechatAcceptanceReceipt: currentManifest.validation.wechatAcceptanceReceipt,
    tester,
    publisher,
    runbookSha256,
    targetStage
  };
}

const submittedRecord = eventRecord("REVIEW_SUBMITTED", "2026-07-22T04:00:00.000Z");
const submitted = build(submittedRecord).receipt;
assert.equal(validWechatPublicationReceipt(submitted, validationOptions("SUBMITTED")), true);
assert.equal(validWechatPublicationReceipt(submitted, validationOptions("APPROVED")), false);
assert.equal(JSON.stringify(submitted).includes(environment.WECHAT_APP_SECRET), false);

const submittedManifest = structuredClone(manifest);
submittedManifest.validation.wechatPublicationReceipt = submitted;
const approvedRecord = eventRecord("REVIEW_APPROVED", "2026-07-22T05:00:00.000Z");
const approved = build(approvedRecord, submittedManifest).receipt;
assert.equal(validWechatPublicationReceipt(approved, validationOptions("APPROVED")), true);
assert.equal(validWechatPublicationReceipt(approved, validationOptions("RELEASED")), false);

const approvedManifest = structuredClone(manifest);
approvedManifest.validation.wechatPublicationReceipt = approved;
const releasedRecord = eventRecord("PRODUCTION_RELEASED", "2026-07-22T05:30:00.000Z");
const released = build(releasedRecord, approvedManifest).receipt;
assert.deepEqual(released.events.map(({ id }) => id), WECHAT_PUBLICATION_EVENTS);
assert.equal(validWechatPublicationReceipt(released, validationOptions("RELEASED")), true);
assert.deepEqual(build(releasedRecord, {
  ...approvedManifest,
  validation: { ...approvedManifest.validation, wechatPublicationReceipt: released }
}), { receipt: released, unchanged: true });

assert.throws(() => build(approvedRecord), /Next publication event must be REVIEW_SUBMITTED/);
assert.throws(() => build(releasedRecord), /Next publication event must be REVIEW_SUBMITTED/);
assert.throws(() => build({
  ...submittedRecord,
  completedAt: "2026-07-22T02:30:00.000Z"
}), /chronological order/);
assert.throws(() => build({
  ...submittedRecord,
  completedAt: "2026-07-22T04:00:00Z"
}), /canonical/);
assert.throws(() => build({
  ...submittedRecord,
  evidenceReference: "https://evidence.invalid/result?access_token=forbidden"
}), /non-secret publisher/);
assert.throws(() => build({ ...submittedRecord, extraSecret: "forbidden" }), /unexpected fields/);
assert.throws(() => build({ ...submittedRecord, publisher: "另一位发布人" }), /named non-secret publisher/);
assert.throws(() => build({ ...submittedRecord, appid: "wxotherproduction123" }), /match the candidate/);
assert.throws(() => build({
  ...approvedRecord,
  completedAt: "2026-07-22T05:01:00.000Z"
}, approvedManifest), /cannot be rewritten/);
const tamperedHistoryManifest = structuredClone(submittedManifest);
tamperedHistoryManifest.validation.wechatPublicationReceipt.events[0].id = "PRODUCTION_RELEASED";
assert.throws(
  () => build(submittedRecord, tamperedHistoryManifest),
  /Invalid current publication history cannot be overwritten/
);

const replacementCandidateManifest = structuredClone(manifest);
replacementCandidateManifest.validation.wechatPublicationReceipt = submitted;
replacementCandidateManifest.wechat.candidateUploadReceipt = {
  ...candidateUploadReceipt,
  version: "0.1.0-rc.4",
  completedAt: "2026-07-22T03:10:00.000Z",
  projectConfigSha256: "d".repeat(64)
};
const replacementCandidateAcceptanceManifest = {
  schemaVersion: 1,
  operator: { wechatTester: tester },
  wechat: {
    candidateUploaded: true,
    candidateUploadReceipt: replacementCandidateManifest.wechat.candidateUploadReceipt
  },
  validation: {}
};
replacementCandidateManifest.validation.wechatAcceptanceReceipt = buildWechatAcceptanceReceipt({
  record: {
    schemaVersion: 1,
    status: "PASSED",
    appid,
    candidateVersion: "0.1.0-rc.4",
    publicApiOrigin,
    tester,
    completedAt: "2026-07-22T03:30:00.000Z",
    evidenceReference: "WX-ACCEPT-NEW-CANDIDATE",
    platformSettings: WECHAT_PLATFORM_SETTINGS.map(acceptanceEvidence),
    contentSafetyScenarios: WECHAT_CONTENT_SAFETY_SCENARIOS.map(acceptanceEvidence),
    deviceRuns: WECHAT_DEVICE_PLATFORMS.map((platform) => ({
      platform,
      deviceModel: platform === "IOS" ? "iPhone 15 Pro" : "Pixel 9 Pro",
      osVersion: platform === "IOS" ? "iOS 18.5" : "Android 16",
      wechatVersion: "8.0.61",
      completedAt: "2026-07-22T03:25:00.000Z",
      evidenceReference: `WX-ACCEPT-NEW-CANDIDATE#${platform}`,
      scenarios: WECHAT_DEVICE_SCENARIOS.map(acceptanceEvidence)
    }))
  },
  manifest: replacementCandidateAcceptanceManifest,
  environment,
  sourceCommit,
  runbookSource,
  now
});
const replacementSubmission = build({
  ...submittedRecord,
  candidateVersion: "0.1.0-rc.4",
  completedAt: "2026-07-22T04:30:00.000Z",
  evidenceReference: "WX-PUBLISH-NEW-CANDIDATE#REVIEW_SUBMITTED"
}, replacementCandidateManifest);
assert.equal(replacementSubmission.receipt.stage, "SUBMITTED");
assert.equal(replacementSubmission.receipt.events.length, 1);

for (const [label, changedManifest] of [
  ["candidate", {
    ...submittedManifest,
    wechat: {
      ...submittedManifest.wechat,
      candidateUploadReceipt: {
        ...candidateUploadReceipt,
        projectConfigSha256: "d".repeat(64)
      }
    }
  }],
  ["acceptance", {
    ...submittedManifest,
    validation: {
      ...submittedManifest.validation,
      wechatAcceptanceReceipt: {
        ...wechatAcceptanceReceipt,
        evidenceReference: "WX-ACCEPT-CHANGED"
      }
    }
  }]
]) {
  assert.equal(
    validWechatPublicationReceipt(submitted, validationOptions("SUBMITTED", changedManifest)),
    false,
    `${label} changes must invalidate publication evidence`
  );
}
assert.equal(validWechatPublicationReceipt({ ...released, unexpected: true }, validationOptions("RELEASED")), false);
assert.equal(validWechatPublicationReceipt(released, {
  ...validationOptions("RELEASED"),
  publisher: "另一位微信发布负责人"
}), false);
assert.equal(validWechatPublicationReceipt(released, {
  ...validationOptions("RELEASED"),
  runbookSha256: "f".repeat(64)
}), false);

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "detective-wechat-publication-project-"));
const externalRoot = await mkdtemp(path.join(os.tmpdir(), "detective-wechat-publication-events-"));
try {
  await mkdir(path.join(projectRoot, "ops"), { recursive: true });
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });
  const manifestPath = path.join(projectRoot, "ops", "launch-readiness.json");
  const fileManifest = structuredClone(manifest);
  fileManifest.wechat.reviewSubmitted = false;
  fileManifest.wechat.reviewApproved = false;
  fileManifest.wechat.released = false;
  await writeFile(manifestPath, `${JSON.stringify(fileManifest, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "docs", "runbook.md"), runbookSource);

  let lastResult;
  for (const record of [submittedRecord, approvedRecord, releasedRecord]) {
    const recordPath = path.join(externalRoot, `${record.event}.json`);
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    lastResult = await recordWechatPublication({
      projectRoot,
      recordPath,
      environment,
      sourceCommit,
      now
    });
  }
  const updatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(updatedManifest.validation.wechatPublicationReceipt.stage, "RELEASED");
  assert.equal(lastResult.receipt.stage, "RELEASED");
  for (const legacyField of ["reviewSubmitted", "reviewApproved", "released"]) {
    assert.equal(legacyField in updatedManifest.wechat, false);
  }
  const stateFiles = await readdir(path.join(projectRoot, ".release-state", "wechat-publication"));
  assert.equal(stateFiles.length, 3);
  const replay = await recordWechatPublication({
    projectRoot,
    recordPath: path.join(externalRoot, "PRODUCTION_RELEASED.json"),
    environment,
    sourceCommit,
    now
  });
  assert.equal(replay.unchanged, true);
  assert.equal(replay.receiptPath, null);
  assert.equal((await readdir(path.join(projectRoot, ".release-state", "wechat-publication"))).length, 3);

  const internalRecordPath = path.join(projectRoot, "event.json");
  await writeFile(internalRecordPath, `${JSON.stringify(submittedRecord)}\n`);
  await assert.rejects(recordWechatPublication({
    projectRoot,
    recordPath: internalRecordPath,
    environment,
    sourceCommit,
    now
  }), /outside the repository/);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}

console.log("WeChat publication lifecycle: OK (ordered, immutable and candidate-bound)");

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { isPathInside, validCandidateUploadReceipt } from "./miniprogram-release.mjs";
import { validWechatAcceptanceReceipt } from "./wechat-acceptance.mjs";

export const WECHAT_PUBLICATION_EVENTS = Object.freeze([
  "REVIEW_SUBMITTED",
  "REVIEW_APPROVED",
  "PRODUCTION_RELEASED"
]);

export const WECHAT_PUBLICATION_STAGES = Object.freeze([
  "SUBMITTED",
  "APPROVED",
  "RELEASED"
]);

const eventToStage = Object.freeze({
  REVIEW_SUBMITTED: "SUBMITTED",
  REVIEW_APPROVED: "APPROVED",
  PRODUCTION_RELEASED: "RELEASED"
});
const placeholderPattern = /(?:replace|example|your[-_. ]|change-?me|dummy|test-only|ci-only|上线前|待填写|todo)/i;
const unsafeEvidencePattern = /(?:bearer\s+|[?&](?:access_?token|token|signature|sig|x-amz-signature|x-goog-signature)=|https?:\/\/[^/\s:@]+:[^/\s@]+@)/i;
const sourceCommitPattern = /^[0-9a-f]{40}$/i;
const appIdPattern = /^wx[A-Za-z0-9]{6,}$/;
const maximumRecordBytes = 64 * 1024;
const futureClockToleranceMs = 5 * 60 * 1000;
const recordKeys = Object.freeze([
  "appid",
  "candidateVersion",
  "completedAt",
  "event",
  "evidenceReference",
  "publisher",
  "schemaVersion",
  "status"
]);
const receiptKeys = Object.freeze([
  "action",
  "appid",
  "candidateUploadReceiptSha256",
  "candidateVersion",
  "completedAt",
  "events",
  "publicApiOrigin",
  "publisher",
  "runbookSha256",
  "schemaVersion",
  "sourceCommit",
  "stage",
  "status",
  "wechatAcceptanceReceiptSha256"
]);
const receiptEventKeys = Object.freeze(["actor", "completedAt", "evidenceReference", "id"]);

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...expectedKeys].sort().join("\n");
}

function canonicalTime(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function present(value, minimumLength = 2, maximumLength = 500) {
  return typeof value === "string"
    && value.trim().length >= minimumLength
    && value.trim().length <= maximumLength
    && !/[\r\n\u0000-\u001f]/.test(value)
    && !placeholderPattern.test(value);
}

function safeEvidenceReference(value) {
  return present(value, 3) && !unsafeEvidencePattern.test(value);
}

function exactHttpsOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.origin === value
      && url.username === ""
      && url.password === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptSha256(receipt) {
  return sha256(canonicalJson(receipt));
}

function validDependencies({
  now,
  appid,
  sourceCommit,
  publicApiOrigin,
  candidateUploadReceipt,
  wechatAcceptanceReceipt,
  tester,
  runbookSha256
}) {
  return appIdPattern.test(appid || "")
    && sourceCommitPattern.test(sourceCommit || "")
    && exactHttpsOrigin(publicApiOrigin) === publicApiOrigin
    && /^[0-9a-f]{64}$/i.test(runbookSha256 || "")
    && validCandidateUploadReceipt(candidateUploadReceipt, appid, sourceCommit, now)
    && validWechatAcceptanceReceipt(wechatAcceptanceReceipt, {
      now,
      appid,
      sourceCommit,
      publicApiOrigin,
      candidateUploadReceipt,
      tester,
      runbookSha256
    });
}

export function validWechatPublicationReceipt(receipt, {
  now = Date.now(),
  appid = null,
  sourceCommit = null,
  publicApiOrigin = null,
  candidateUploadReceipt = null,
  wechatAcceptanceReceipt = null,
  tester = null,
  publisher = null,
  runbookSha256 = null,
  targetStage = "RELEASED"
} = {}) {
  const targetIndex = WECHAT_PUBLICATION_STAGES.indexOf(targetStage);
  const completedAt = canonicalTime(receipt?.completedAt);
  const origin = exactHttpsOrigin(receipt?.publicApiOrigin);
  if (targetIndex < 0
    || !hasExactKeys(receipt, receiptKeys)
    || receipt.schemaVersion !== 1
    || receipt.action !== "wechat_publication_lifecycle"
    || receipt.status !== "PASSED"
    || !appIdPattern.test(receipt.appid || "")
    || (appid && receipt.appid !== appid)
    || !sourceCommitPattern.test(receipt.sourceCommit || "")
    || (sourceCommit && receipt.sourceCommit !== sourceCommit)
    || !origin
    || (publicApiOrigin && origin !== publicApiOrigin)
    || !present(receipt.publisher, 2, 100)
    || (publisher && receipt.publisher !== publisher)
    || !/^[0-9a-f]{64}$/i.test(receipt.runbookSha256 || "")
    || (runbookSha256 && receipt.runbookSha256 !== runbookSha256)
    || completedAt === null
    || completedAt > now + futureClockToleranceMs
    || !Array.isArray(receipt.events)
    || receipt.events.length < 1
    || receipt.events.length > WECHAT_PUBLICATION_EVENTS.length
    || receipt.stage !== WECHAT_PUBLICATION_STAGES[receipt.events.length - 1]
    || WECHAT_PUBLICATION_STAGES.indexOf(receipt.stage) < targetIndex) return false;

  if (!candidateUploadReceipt
    || !wechatAcceptanceReceipt
    || !validDependencies({
      now,
      appid: receipt.appid,
      sourceCommit: receipt.sourceCommit,
      publicApiOrigin: receipt.publicApiOrigin,
      candidateUploadReceipt,
      wechatAcceptanceReceipt,
      tester,
      runbookSha256: receipt.runbookSha256
    })
    || receipt.candidateVersion !== candidateUploadReceipt.version
    || receipt.candidateUploadReceiptSha256 !== receiptSha256(candidateUploadReceipt)
    || receipt.wechatAcceptanceReceiptSha256 !== receiptSha256(wechatAcceptanceReceipt)) {
    return false;
  }

  const acceptanceCompletedAt = canonicalTime(wechatAcceptanceReceipt.completedAt);
  let previousTime = acceptanceCompletedAt;
  for (let index = 0; index < receipt.events.length; index += 1) {
    const event = receipt.events[index];
    const eventTime = canonicalTime(event?.completedAt);
    if (!hasExactKeys(event, receiptEventKeys)
      || event.id !== WECHAT_PUBLICATION_EVENTS[index]
      || event.actor !== receipt.publisher
      || !safeEvidenceReference(event.evidenceReference)
      || eventTime === null
      || eventTime > now + futureClockToleranceMs
      || previousTime === null
      || eventTime < previousTime) return false;
    previousTime = eventTime;
  }
  return completedAt === previousTime;
}

export function buildWechatPublicationReceipt({
  record,
  manifest,
  environment,
  sourceCommit,
  runbookSource,
  now = Date.now()
}) {
  if (manifest?.schemaVersion !== 1
    || typeof manifest.wechat !== "object"
    || typeof manifest.operator !== "object"
    || typeof manifest.validation !== "object") {
    throw new Error("Launch readiness manifest must contain WeChat, operator and validation state");
  }
  if (!hasExactKeys(record, recordKeys)
    || record.schemaVersion !== 1
    || record.status !== "PASSED"
    || !WECHAT_PUBLICATION_EVENTS.includes(record.event)) {
    throw new Error("WeChat publication event record has invalid or unexpected fields");
  }
  const appid = environment?.WECHAT_APP_ID?.trim();
  const miniProgramAppid = environment?.MINIPROGRAM_APP_ID?.trim();
  const publicApiOrigin = exactHttpsOrigin(environment?.PUBLIC_API_BASE_URL);
  const candidateUploadReceipt = manifest.wechat.candidateUploadReceipt;
  const wechatAcceptanceReceipt = manifest.validation.wechatAcceptanceReceipt;
  const publisher = manifest.operator.wechatPublisher;
  const tester = manifest.operator.wechatTester;
  if (!appid || appid !== miniProgramAppid || !publicApiOrigin) {
    throw new Error("WeChat AppIDs and PUBLIC_API_BASE_URL must match production configuration");
  }
  if (typeof runbookSource !== "string" || runbookSource.length < 100) {
    throw new Error("Operations runbook is missing or incomplete");
  }
  const runbookSha256 = sha256(runbookSource);
  if (!validDependencies({
    now,
    appid,
    sourceCommit,
    publicApiOrigin,
    candidateUploadReceipt,
    wechatAcceptanceReceipt,
    tester,
    runbookSha256
  })) {
    throw new Error("Current candidate upload and WeChat acceptance evidence are required");
  }
  if (!present(publisher, 2, 100)
    || record.publisher !== publisher
    || record.appid !== appid
    || record.candidateVersion !== candidateUploadReceipt.version
    || !safeEvidenceReference(record.evidenceReference)) {
    throw new Error("Publication event must match the candidate and named non-secret publisher");
  }
  const eventTime = canonicalTime(record.completedAt);
  if (eventTime === null || eventTime > now + futureClockToleranceMs) {
    throw new Error("Publication event completion time must be canonical and not in the future");
  }

  const previousReceipt = manifest.validation.wechatPublicationReceipt;
  const previousValid = validWechatPublicationReceipt(previousReceipt, {
    now,
    appid,
    sourceCommit,
    publicApiOrigin,
    candidateUploadReceipt,
    wechatAcceptanceReceipt,
    tester,
    publisher,
    runbookSha256,
    targetStage: "SUBMITTED"
  });
  if (previousReceipt !== undefined
    && previousReceipt !== null
    && !previousValid) {
    const dependencyChanged = previousReceipt?.appid !== appid
      || previousReceipt?.candidateVersion !== candidateUploadReceipt.version
      || previousReceipt?.candidateUploadReceiptSha256 !== receiptSha256(candidateUploadReceipt)
      || previousReceipt?.wechatAcceptanceReceiptSha256 !== receiptSha256(wechatAcceptanceReceipt)
      || previousReceipt?.sourceCommit !== sourceCommit
      || previousReceipt?.runbookSha256 !== runbookSha256
      || previousReceipt?.publicApiOrigin !== publicApiOrigin;
    if (!dependencyChanged) {
      throw new Error("Invalid current publication history cannot be overwritten");
    }
  }
  const previousEvents = previousValid ? previousReceipt.events : [];
  const lastEvent = previousEvents.at(-1);
  if (lastEvent?.id === record.event) {
    if (lastEvent.completedAt === record.completedAt
      && lastEvent.actor === record.publisher
      && lastEvent.evidenceReference === record.evidenceReference) {
      return { receipt: previousReceipt, unchanged: true };
    }
    throw new Error("A recorded publication event cannot be rewritten");
  }
  const expectedEvent = WECHAT_PUBLICATION_EVENTS[previousEvents.length];
  if (record.event !== expectedEvent) {
    throw new Error(`Next publication event must be ${expectedEvent || "none"}`);
  }
  const previousTime = lastEvent
    ? canonicalTime(lastEvent.completedAt)
    : canonicalTime(wechatAcceptanceReceipt.completedAt);
  if (previousTime === null || eventTime < previousTime) {
    throw new Error("Publication events must follow acceptance in chronological order");
  }
  const events = [...previousEvents, {
    id: record.event,
    completedAt: record.completedAt,
    actor: record.publisher,
    evidenceReference: record.evidenceReference
  }];
  const receipt = {
    schemaVersion: 1,
    action: "wechat_publication_lifecycle",
    status: "PASSED",
    stage: eventToStage[record.event],
    appid,
    candidateVersion: candidateUploadReceipt.version,
    candidateUploadReceiptSha256: receiptSha256(candidateUploadReceipt),
    wechatAcceptanceReceiptSha256: receiptSha256(wechatAcceptanceReceipt),
    sourceCommit,
    runbookSha256,
    publicApiOrigin,
    publisher,
    completedAt: record.completedAt,
    events
  };
  if (!validWechatPublicationReceipt(receipt, {
    now,
    appid,
    sourceCommit,
    publicApiOrigin,
    candidateUploadReceipt,
    wechatAcceptanceReceipt,
    tester,
    publisher,
    runbookSha256,
    targetStage: eventToStage[record.event]
  })) throw new Error("Generated WeChat publication receipt is invalid");
  return { receipt, unchanged: false };
}

export async function recordWechatPublication({
  projectRoot = process.cwd(),
  manifestPath = path.join(projectRoot, "ops", "launch-readiness.json"),
  recordPath,
  environment,
  sourceCommit,
  now = Date.now()
}) {
  const root = path.resolve(projectRoot);
  const expectedManifestPath = path.join(root, "ops", "launch-readiness.json");
  if (path.resolve(manifestPath) !== expectedManifestPath) {
    throw new Error("WeChat publication evidence may only update ops/launch-readiness.json");
  }
  if (!recordPath || !path.isAbsolute(recordPath)) {
    throw new Error("WeChat publication event path must be absolute");
  }
  const recordRealPath = await realpath(path.resolve(recordPath));
  if (isPathInside(root, recordRealPath)) {
    throw new Error("WeChat publication event must be stored outside the repository");
  }
  const recordStats = await stat(recordRealPath);
  if (!recordStats.isFile() || recordStats.size < 2 || recordStats.size > maximumRecordBytes) {
    throw new Error("WeChat publication event must be a bounded JSON file");
  }
  const manifestSource = await readFile(expectedManifestPath, "utf8");
  const recordSource = await readFile(recordRealPath, "utf8");
  const runbookSource = await readFile(path.join(root, "docs", "runbook.md"), "utf8");
  let manifest;
  let record;
  try {
    manifest = JSON.parse(manifestSource);
    record = JSON.parse(recordSource);
  } catch {
    throw new Error("Publication event and launch manifest must contain valid JSON");
  }
  const result = buildWechatPublicationReceipt({
    record,
    manifest,
    environment,
    sourceCommit,
    runbookSource,
    now
  });
  if (result.unchanged) return { ...result, receiptPath: null };

  const stateDirectory = path.join(root, ".release-state", "wechat-publication");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await access(path.dirname(expectedManifestPath), constants.W_OK);
  const safeTimestamp = result.receipt.completedAt.replaceAll(":", "").replaceAll(".", "-");
  const receiptPath = path.join(
    stateDirectory,
    `${result.receipt.stage.toLowerCase()}-${sourceCommit.slice(0, 12)}-${safeTimestamp}.json`
  );
  await writeFile(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  const manifestSourceBeforeUpdate = await readFile(expectedManifestPath, "utf8");
  if (sha256(manifestSourceBeforeUpdate) !== sha256(manifestSource)) {
    throw new Error("Launch manifest changed; immutable publication receipt was preserved");
  }
  manifest.validation.wechatPublicationReceipt = result.receipt;
  delete manifest.wechat.reviewSubmitted;
  delete manifest.wechat.reviewApproved;
  delete manifest.wechat.released;
  const temporaryManifestPath = `${expectedManifestPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryManifestPath, expectedManifestPath);
  return {
    ...result,
    receiptPath: path.relative(root, receiptPath).replaceAll("\\", "/")
  };
}

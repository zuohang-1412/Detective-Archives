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
import {
  isPathInside,
  validCandidateUploadReceipt
} from "./miniprogram-release.mjs";

export const WECHAT_PLATFORM_SETTINGS = Object.freeze([
  "SERVICE_CATEGORY",
  "PRIVACY_GUIDE",
  "USER_AGREEMENT",
  "REQUEST_DOMAIN"
]);

export const WECHAT_CONTENT_SAFETY_SCENARIOS = Object.freeze([
  "SAFE_CONTENT_ACCEPTED",
  "REVIEW_CONTENT_PENDING",
  "RISKY_CONTENT_REJECTED",
  "DEPENDENCY_FAILURE_PENDING"
]);

export const WECHAT_DEVICE_PLATFORMS = Object.freeze(["IOS", "ANDROID"]);

export const WECHAT_DEVICE_SCENARIOS = Object.freeze([
  "PRIVACY_REJECTED",
  "PRIVACY_ACCEPTED",
  "LOGIN",
  "CATALOG_AND_SEARCH",
  "SHELF_AND_PROGRESS",
  "REVIEW_AND_COMMUNITY",
  "REPORT",
  "DATA_EXPORT_AND_SHARE",
  "ACCOUNT_DEACTIVATION"
]);

const placeholderPattern = /(?:replace|example|your[-_. ]|change-?me|dummy|test-only|ci-only|上线前|待填写|todo)/i;
const unsafeEvidencePattern = /(?:bearer\s+|[?&](?:access_?token|token|signature|sig|x-amz-signature|x-goog-signature)=|https?:\/\/[^/\s:@]+:[^/\s@]+@)/i;
const maximumRecordBytes = 128 * 1024;
const maximumReceiptAgeMs = 30 * 24 * 60 * 60 * 1000;
const maximumDeviceRunWindowMs = 7 * 24 * 60 * 60 * 1000;
const maximumCandidateAgeMs = 30 * 24 * 60 * 60 * 1000;
const futureClockToleranceMs = 5 * 60 * 1000;
const sourceCommitPattern = /^[0-9a-f]{40}$/i;
const appIdPattern = /^wx[A-Za-z0-9]{6,}$/;
const receiptKeys = Object.freeze([
  "action",
  "appid",
  "candidateUploadReceiptSha256",
  "candidateVersion",
  "completedAt",
  "contentSafetyScenarios",
  "deviceRuns",
  "evidenceReference",
  "platformSettings",
  "publicApiOrigin",
  "runbookSha256",
  "schemaVersion",
  "sourceCommit",
  "status",
  "tester"
]);
const scenarioKeys = Object.freeze(["evidenceReference", "id", "result"]);
const deviceKeys = Object.freeze([
  "completedAt",
  "deviceModel",
  "evidenceReference",
  "osVersion",
  "platform",
  "scenarios",
  "wechatVersion"
]);

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

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function candidateReceiptSha256(receipt) {
  const canonical = {
    schemaVersion: receipt?.schemaVersion,
    action: receipt?.action,
    status: receipt?.status,
    appid: receipt?.appid,
    version: receipt?.version,
    description: receipt?.description,
    sourceCommit: receipt?.sourceCommit,
    robot: receipt?.robot,
    completedAt: receipt?.completedAt,
    ciPackage: receipt?.ciPackage,
    projectConfigSha256: receipt?.projectConfigSha256,
    miniProgramConfigSha256: receipt?.miniProgramConfigSha256
  };
  return sha256(JSON.stringify(canonical));
}

function validScenarioEvidence(scenarios, expectedIds) {
  if (!Array.isArray(scenarios) || scenarios.length !== expectedIds.length) return false;
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  return scenarioMap.size === expectedIds.length && expectedIds.every((id) => {
    const scenario = scenarioMap.get(id);
    return hasExactKeys(scenario, scenarioKeys)
      && scenario.result === "PASSED"
      && safeEvidenceReference(scenario.evidenceReference);
  });
}

function validDeviceRuns(deviceRuns, completedAt) {
  if (!Array.isArray(deviceRuns) || deviceRuns.length !== WECHAT_DEVICE_PLATFORMS.length) {
    return false;
  }
  const deviceMap = new Map(deviceRuns.map((device) => [device?.platform, device]));
  if (deviceMap.size !== WECHAT_DEVICE_PLATFORMS.length) return false;
  return WECHAT_DEVICE_PLATFORMS.every((platform) => {
    const device = deviceMap.get(platform);
    const deviceCompletedAt = canonicalTime(device?.completedAt);
    return hasExactKeys(device, deviceKeys)
      && present(device.deviceModel, 2, 100)
      && present(device?.osVersion, 1, 50)
      && present(device?.wechatVersion, 1, 50)
      && safeEvidenceReference(device?.evidenceReference)
      && deviceCompletedAt !== null
      && deviceCompletedAt <= completedAt + futureClockToleranceMs
      && deviceCompletedAt >= completedAt - maximumDeviceRunWindowMs
      && validScenarioEvidence(device?.scenarios, WECHAT_DEVICE_SCENARIOS);
  });
}

export function validWechatAcceptanceReceipt(receipt, {
  now = Date.now(),
  appid = null,
  sourceCommit = null,
  publicApiOrigin = null,
  candidateUploadReceipt = null,
  tester = null,
  runbookSha256 = null
} = {}) {
  const completedAt = canonicalTime(receipt?.completedAt);
  const origin = exactHttpsOrigin(receipt?.publicApiOrigin);
  if (!hasExactKeys(receipt, receiptKeys)
    || receipt.schemaVersion !== 1
    || receipt.action !== "wechat_release_acceptance"
    || receipt.status !== "PASSED"
    || !appIdPattern.test(receipt.appid || "")
    || (appid && receipt.appid !== appid)
    || !sourceCommitPattern.test(receipt.sourceCommit || "")
    || (sourceCommit && receipt.sourceCommit !== sourceCommit)
    || !origin
    || (publicApiOrigin && origin !== publicApiOrigin)
    || !present(receipt.tester, 2, 100)
    || (tester && receipt.tester !== tester)
    || !/^[0-9a-f]{64}$/i.test(receipt.runbookSha256 || "")
    || (runbookSha256 && receipt.runbookSha256 !== runbookSha256)
    || !safeEvidenceReference(receipt.evidenceReference)
    || completedAt === null
    || completedAt > now + futureClockToleranceMs
    || completedAt < now - maximumReceiptAgeMs
    || !validScenarioEvidence(receipt.platformSettings, WECHAT_PLATFORM_SETTINGS)
    || !validScenarioEvidence(receipt.contentSafetyScenarios, WECHAT_CONTENT_SAFETY_SCENARIOS)
    || !validDeviceRuns(receipt.deviceRuns, completedAt)) return false;

  if (!candidateUploadReceipt
    || !validCandidateUploadReceipt(
      candidateUploadReceipt,
      receipt.appid,
      receipt.sourceCommit,
      now
    )
    || receipt.candidateVersion !== candidateUploadReceipt.version
    || receipt.candidateUploadReceiptSha256 !== candidateReceiptSha256(candidateUploadReceipt)) {
    return false;
  }
  const candidateCompletedAt = canonicalTime(candidateUploadReceipt.completedAt);
  return candidateCompletedAt !== null
    && candidateCompletedAt <= completedAt + futureClockToleranceMs
    && candidateCompletedAt >= completedAt - maximumCandidateAgeMs;
}

function orderedScenarioEvidence(scenarios, expectedIds) {
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return expectedIds.map((id) => ({
    id,
    result: "PASSED",
    evidenceReference: scenarioMap.get(id).evidenceReference
  }));
}

export function buildWechatAcceptanceReceipt({
  record,
  manifest,
  environment,
  sourceCommit,
  runbookSource,
  now = Date.now()
}) {
  if (manifest?.schemaVersion !== 1
    || typeof manifest.wechat !== "object"
    || typeof manifest.operator !== "object") {
    throw new Error(
      "Launch readiness manifest must use schemaVersion 1 and contain operator and WeChat state"
    );
  }
  if (manifest.validation !== undefined
    && (manifest.validation === null
      || typeof manifest.validation !== "object"
      || Array.isArray(manifest.validation))) {
    throw new Error("Launch readiness manifest validation state must be an object");
  }
  if (record?.schemaVersion !== 1 || record.status !== "PASSED") {
    throw new Error("WeChat acceptance record must use schemaVersion 1 and PASSED status");
  }
  const appid = environment?.WECHAT_APP_ID?.trim();
  const miniProgramAppid = environment?.MINIPROGRAM_APP_ID?.trim();
  const publicApiOrigin = exactHttpsOrigin(environment?.PUBLIC_API_BASE_URL);
  if (!appIdPattern.test(appid || "") || appid !== miniProgramAppid) {
    throw new Error("WeChat API and Mini Program AppIDs must be real and identical");
  }
  if (!publicApiOrigin) throw new Error("PUBLIC_API_BASE_URL must be an exact HTTPS origin");
  if (!sourceCommitPattern.test(sourceCommit || "")) {
    throw new Error("WeChat acceptance must bind to a full source commit");
  }
  const candidateUploadReceipt = manifest.wechat.candidateUploadReceipt;
  if (manifest.wechat.candidateUploaded !== true
    || !validCandidateUploadReceipt(candidateUploadReceipt, appid, sourceCommit, now)) {
    throw new Error("A successful candidate upload receipt for the current AppID and commit is required");
  }
  if (record.appid !== appid
    || record.candidateVersion !== candidateUploadReceipt.version
    || record.publicApiOrigin !== publicApiOrigin) {
    throw new Error("Acceptance record must match the candidate AppID, version and public API origin");
  }
  if (!present(record.tester, 2, 100)
    || record.tester !== manifest.operator.wechatTester
    || !safeEvidenceReference(record.evidenceReference)) {
    throw new Error(
      "Acceptance tester must match the launch manifest and use a bounded non-secret evidence reference"
    );
  }
  if (typeof runbookSource !== "string" || runbookSource.length < 100) {
    throw new Error("Operations runbook is missing or incomplete");
  }
  if (!validScenarioEvidence(record.platformSettings, WECHAT_PLATFORM_SETTINGS)) {
    throw new Error(`Platform acceptance must pass exactly: ${WECHAT_PLATFORM_SETTINGS.join(", ")}`);
  }
  if (!validScenarioEvidence(record.contentSafetyScenarios, WECHAT_CONTENT_SAFETY_SCENARIOS)) {
    throw new Error(
      `Content safety acceptance must pass exactly: ${WECHAT_CONTENT_SAFETY_SCENARIOS.join(", ")}`
    );
  }
  const completedAt = canonicalTime(record.completedAt);
  if (completedAt === null || !validDeviceRuns(record.deviceRuns, completedAt)) {
    throw new Error(
      `Device acceptance must include current iOS and Android runs with exactly: ${WECHAT_DEVICE_SCENARIOS.join(", ")}`
    );
  }

  const deviceMap = new Map(record.deviceRuns.map((device) => [device.platform, device]));
  const receipt = {
    schemaVersion: 1,
    action: "wechat_release_acceptance",
    status: "PASSED",
    appid,
    candidateVersion: candidateUploadReceipt.version,
    candidateUploadReceiptSha256: candidateReceiptSha256(candidateUploadReceipt),
    sourceCommit,
    runbookSha256: sha256(runbookSource),
    publicApiOrigin,
    tester: record.tester,
    completedAt: record.completedAt,
    evidenceReference: record.evidenceReference,
    platformSettings: orderedScenarioEvidence(record.platformSettings, WECHAT_PLATFORM_SETTINGS),
    contentSafetyScenarios: orderedScenarioEvidence(
      record.contentSafetyScenarios,
      WECHAT_CONTENT_SAFETY_SCENARIOS
    ),
    deviceRuns: WECHAT_DEVICE_PLATFORMS.map((platform) => {
      const device = deviceMap.get(platform);
      return {
        platform,
        deviceModel: device.deviceModel,
        osVersion: device.osVersion,
        wechatVersion: device.wechatVersion,
        completedAt: device.completedAt,
        evidenceReference: device.evidenceReference,
        scenarios: orderedScenarioEvidence(device.scenarios, WECHAT_DEVICE_SCENARIOS)
      };
    })
  };
  if (!validWechatAcceptanceReceipt(receipt, {
    now,
    appid,
    sourceCommit,
    publicApiOrigin,
    candidateUploadReceipt,
    tester: manifest.operator.wechatTester,
    runbookSha256: sha256(runbookSource)
  })) {
    throw new Error("WeChat acceptance completion time or receipt fields are invalid");
  }
  return receipt;
}

export async function recordWechatAcceptance({
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
    throw new Error("WeChat acceptance evidence may only update ops/launch-readiness.json");
  }
  if (!recordPath || !path.isAbsolute(recordPath)) {
    throw new Error("WeChat acceptance source record path must be absolute");
  }
  const recordRealPath = await realpath(path.resolve(recordPath));
  if (isPathInside(root, recordRealPath)) {
    throw new Error("WeChat acceptance source record must be stored outside the repository");
  }
  const recordStats = await stat(recordRealPath);
  if (!recordStats.isFile() || recordStats.size < 2 || recordStats.size > maximumRecordBytes) {
    throw new Error("WeChat acceptance source record must be a bounded JSON file");
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
    throw new Error("WeChat acceptance record and launch manifest must contain valid JSON");
  }
  const receipt = buildWechatAcceptanceReceipt({
    record,
    manifest,
    environment,
    sourceCommit,
    runbookSource,
    now
  });

  const stateDirectory = path.join(root, ".release-state", "wechat-acceptance");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await access(path.dirname(expectedManifestPath), constants.W_OK);
  const safeTimestamp = receipt.completedAt.replaceAll(":", "").replaceAll(".", "-");
  const receiptPath = path.join(
    stateDirectory,
    `wechat-acceptance-${sourceCommit.slice(0, 12)}-${safeTimestamp}.json`
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });

  const manifestSourceBeforeUpdate = await readFile(expectedManifestPath, "utf8");
  if (sha256(manifestSourceBeforeUpdate) !== sha256(manifestSource)) {
    throw new Error(
      "Launch readiness manifest changed during acceptance; receipt was preserved without overwriting it"
    );
  }
  manifest.validation ??= {};
  manifest.validation.wechatAcceptanceReceipt = receipt;
  delete manifest.validation.contentSafetyPassed;
  delete manifest.validation.iosDevicePassed;
  delete manifest.validation.androidDevicePassed;
  delete manifest.wechat.serviceCategoryConfigured;
  delete manifest.wechat.privacyGuideConfigured;
  delete manifest.wechat.userAgreementApproved;
  delete manifest.wechat.requestDomainConfigured;
  const temporaryManifestPath = `${expectedManifestPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryManifestPath, expectedManifestPath);

  return {
    receipt,
    receiptPath: path.relative(root, receiptPath).replaceAll("\\", "/")
  };
}

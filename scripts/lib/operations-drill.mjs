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

export const OPERATIONS_DRILL_SCENARIOS = Object.freeze([
  "CONTENT_MODERATION",
  "REPORT_RESOLUTION",
  "USER_RESTRICTION",
  "EMERGENCY_UNPUBLISH"
]);

const placeholderPattern = /(?:replace|example|your[-_. ]|change-?me|dummy|test-only|ci-only|上线前|待填写|todo)/i;
const unsafeEvidencePattern = /(?:bearer\s+|[?&](?:access_?token|token|signature|sig|x-amz-signature|x-goog-signature)=|https?:\/\/[^/\s:@]+:[^/\s@]+@)/i;
const allowedGeneratedFiles = new Set([
  "project.config.json",
  "apps/miniprogram/config.js"
]);
const maximumRecordBytes = 64 * 1024;
const maximumReceiptAgeMs = 90 * 24 * 60 * 60 * 1000;
const futureClockToleranceMs = 5 * 60 * 1000;

function present(value, minimumLength = 2, maximumLength = 500) {
  return typeof value === "string"
    && value.trim().length >= minimumLength
    && value.trim().length <= maximumLength
    && !/[\r\n\u0000-\u001f]/.test(value)
    && !placeholderPattern.test(value);
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function safeEvidenceReference(value) {
  return present(value, 3) && !unsafeEvidencePattern.test(value);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertOperationsDrillGitStatus(statusOutput) {
  if (typeof statusOutput !== "string") {
    throw new Error("Operations drill Git status could not be read");
  }
  const changes = statusOutput.split(/\r?\n/).filter(Boolean);
  for (const line of changes) {
    const status = line.slice(0, 2);
    const filePath = line.slice(3).replaceAll("\\", "/");
    const generatedProductionConfig = allowedGeneratedFiles.has(filePath)
      && /^[ M][ M]$/.test(status)
      && status.includes("M");
    if (!generatedProductionConfig) {
      throw new Error("Operations drill must be recorded from committed source and approved production configuration");
    }
  }
  return true;
}

function validScenarioEvidence(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length !== OPERATIONS_DRILL_SCENARIOS.length) {
    return false;
  }
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  if (scenarioMap.size !== OPERATIONS_DRILL_SCENARIOS.length) return false;
  return OPERATIONS_DRILL_SCENARIOS.every((id) => {
    const scenario = scenarioMap.get(id);
    return scenario?.result === "PASSED" && safeEvidenceReference(scenario.evidenceReference);
  });
}

export function validOperationsDrillReceipt(receipt, {
  now = Date.now(),
  runbookSha256 = null
} = {}) {
  if (!receipt
    || receipt.schemaVersion !== 1
    || receipt.action !== "operations_drill"
    || receipt.status !== "PASSED") return false;
  if (!present(receipt.contentModerator) || !present(receipt.alertResponder)) return false;
  if (!safeEvidenceReference(receipt.evidenceReference)) return false;
  if (!/^[0-9a-f]{40}$/i.test(receipt.sourceCommit || "")) return false;
  if (!/^[0-9a-f]{64}$/i.test(receipt.runbookSha256 || "")) return false;
  if (runbookSha256 && receipt.runbookSha256 !== runbookSha256) return false;
  if (!validScenarioEvidence(receipt.scenarios)) return false;
  const completedAt = Date.parse(receipt.completedAt || "");
  return Number.isFinite(completedAt)
    && new Date(completedAt).toISOString() === receipt.completedAt
    && completedAt <= now + futureClockToleranceMs
    && completedAt >= now - maximumReceiptAgeMs;
}

export function buildOperationsDrillReceipt({
  record,
  manifest,
  sourceCommit,
  runbookSource,
  now = Date.now()
}) {
  if (manifest?.schemaVersion !== 1 || typeof manifest.operator !== "object") {
    throw new Error("Launch readiness manifest must use schemaVersion 1 and contain operator state");
  }
  if (manifest.validation !== undefined
    && (manifest.validation === null
      || typeof manifest.validation !== "object"
      || Array.isArray(manifest.validation))) {
    throw new Error("Launch readiness manifest validation state must be an object");
  }
  if (record?.schemaVersion !== 1 || record.status !== "PASSED") {
    throw new Error("Operations drill record must use schemaVersion 1 and PASSED status");
  }
  if (record.contentModerator !== manifest.operator.contentModerator
    || record.alertResponder !== manifest.operator.alertResponder) {
    throw new Error("Operations drill owners must match the launch readiness manifest");
  }
  if (!present(record.contentModerator) || !present(record.alertResponder)) {
    throw new Error("Operations drill owners must be real non-placeholder names");
  }
  if (!safeEvidenceReference(record.evidenceReference)) {
    throw new Error("Operations drill must include a bounded non-secret evidence reference");
  }
  if (!validScenarioEvidence(record.scenarios)) {
    throw new Error(`Operations drill must pass exactly: ${OPERATIONS_DRILL_SCENARIOS.join(", ")}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit || "")) {
    throw new Error("Operations drill must bind to a full source commit");
  }
  if (typeof runbookSource !== "string" || runbookSource.length < 100) {
    throw new Error("Operations runbook is missing or incomplete");
  }

  const scenarioMap = new Map(record.scenarios.map((scenario) => [scenario.id, scenario]));
  const receipt = {
    schemaVersion: 1,
    action: "operations_drill",
    status: "PASSED",
    contentModerator: record.contentModerator,
    alertResponder: record.alertResponder,
    completedAt: record.completedAt,
    evidenceReference: record.evidenceReference,
    sourceCommit,
    runbookSha256: sha256(runbookSource),
    scenarios: OPERATIONS_DRILL_SCENARIOS.map((id) => ({
      id,
      result: "PASSED",
      evidenceReference: scenarioMap.get(id).evidenceReference
    }))
  };
  if (!validOperationsDrillReceipt(receipt, { now, runbookSha256: receipt.runbookSha256 })) {
    throw new Error("Operations drill completion time or receipt fields are invalid");
  }
  return receipt;
}

export async function recordOperationsDrill({
  projectRoot = process.cwd(),
  manifestPath = path.join(projectRoot, "ops", "launch-readiness.json"),
  recordPath,
  sourceCommit,
  now = Date.now()
}) {
  const root = path.resolve(projectRoot);
  const expectedManifestPath = path.join(root, "ops", "launch-readiness.json");
  if (path.resolve(manifestPath) !== expectedManifestPath) {
    throw new Error("Operations drill evidence may only update ops/launch-readiness.json");
  }
  if (!recordPath) throw new Error("An external operations drill record is required");
  if (!path.isAbsolute(recordPath)) {
    throw new Error("Operations drill source record path must be absolute");
  }
  const recordRealPath = await realpath(path.resolve(recordPath));
  if (isPathInside(root, recordRealPath)) {
    throw new Error("Operations drill source record must be stored outside the repository");
  }
  const recordStats = await stat(recordRealPath);
  if (!recordStats.isFile() || recordStats.size < 2 || recordStats.size > maximumRecordBytes) {
    throw new Error("Operations drill source record must be a bounded JSON file");
  }

  const manifestSource = await readFile(expectedManifestPath, "utf8");
  const runbookSource = await readFile(path.join(root, "docs", "runbook.md"), "utf8");
  const recordSource = await readFile(recordRealPath, "utf8");
  let manifest;
  let record;
  try {
    manifest = JSON.parse(manifestSource);
    record = JSON.parse(recordSource);
  } catch {
    throw new Error("Operations drill record and launch manifest must contain valid JSON");
  }
  const receipt = buildOperationsDrillReceipt({
    record,
    manifest,
    sourceCommit,
    runbookSource,
    now
  });

  const stateDirectory = path.join(root, ".release-state", "operations-drill");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await access(path.dirname(expectedManifestPath), constants.W_OK);
  const safeTimestamp = receipt.completedAt.replaceAll(":", "").replaceAll(".", "-");
  const receiptPath = path.join(
    stateDirectory,
    `operations-drill-${sourceCommit.slice(0, 12)}-${safeTimestamp}.json`
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });

  const manifestSourceBeforeUpdate = await readFile(expectedManifestPath, "utf8");
  if (sha256(manifestSourceBeforeUpdate) !== sha256(manifestSource)) {
    throw new Error("Launch readiness manifest changed during the drill; receipt was preserved without overwriting it");
  }
  manifest.validation ??= {};
  manifest.validation.operationsDrillReceipt = receipt;
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

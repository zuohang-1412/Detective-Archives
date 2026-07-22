import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const MONITORING_DRILL_SCENARIOS = Object.freeze([
  "BASELINE_HEALTHY",
  "INCIDENT_CREATED",
  "INCIDENT_DEDUPLICATED",
  "RECOVERY_CLOSED"
]);

export const OFFSITE_BACKUP_CONTENT_BASELINE = Object.freeze({
  detectives: 150,
  works: 160,
  pictureBookEntries: 109,
  recommendations: 92
});

const maximumRecordBytes = 128 * 1024;
const maximumReceiptAgeMs = 30 * 24 * 60 * 60 * 1000;
const maximumMonitoringDrillDurationMs = 7 * 24 * 60 * 60 * 1000;
const maximumRecoveryPointObjectiveSeconds = 26 * 60 * 60;
const maximumRecoveryTimeObjectiveSeconds = 4 * 60 * 60;
const futureClockToleranceMs = 5 * 60 * 1000;
const sourceCommitPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const decimalIdentifierPattern = /^[1-9][0-9]{0,19}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const placeholderPattern = /(?:replace|example|your[-_. ]|change-?me|dummy|test-only|ci-only|上线前|待填写|todo)/i;
const unsafeEvidencePattern = /(?:bearer\s+|[?&](?:access_?token|token|signature|sig|x-amz-signature|x-goog-signature)=|https?:\/\/[^/\s:@]+:[^/\s@]+@)/i;
const allowedGeneratedFiles = new Set([
  "project.config.json",
  "apps/miniprogram/config.js"
]);

const monitoringRecordKeys = Object.freeze([
  "alertResponder",
  "checks",
  "completedAt",
  "evidenceReference",
  "publicApiOrigin",
  "repository",
  "schemaVersion",
  "sourceCommit",
  "status"
]);
const monitoringReceiptKeys = Object.freeze([
  "action",
  "alertResponder",
  "checks",
  "completedAt",
  "evidenceReference",
  "publicApiOrigin",
  "recordSha256",
  "repository",
  "schemaVersion",
  "sourceCommit",
  "status"
]);
const monitoringCheckKeys = Object.freeze([
  "completedAt",
  "conclusion",
  "evidenceReference",
  "id",
  "issueNumber",
  "issueState",
  "issueUrl",
  "runId",
  "runUrl",
  "sourceCommit"
]);
const backupRecordKeys = Object.freeze([
  "artifact",
  "completedAt",
  "evidenceReference",
  "operator",
  "publicApiOrigin",
  "repository",
  "restore",
  "schemaVersion",
  "sourceCommit",
  "status"
]);
const backupReceiptKeys = Object.freeze([
  "action",
  "artifact",
  "completedAt",
  "evidenceReference",
  "operator",
  "publicApiOrigin",
  "recordSha256",
  "repository",
  "restore",
  "schemaVersion",
  "sourceCommit",
  "status"
]);
const backupArtifactKeys = Object.freeze([
  "archiveFileName",
  "archiveSha256",
  "artifactId",
  "artifactName",
  "artifactUrl",
  "createdAt",
  "downloadedAt",
  "keyId",
  "runAttempt",
  "runId",
  "runUrl",
  "sourceCommit"
]);
const backupRestoreKeys = Object.freeze([
  "apiCheck",
  "completedAt",
  "counts",
  "databaseCheck",
  "decryption",
  "encryptedVerification",
  "evidenceReference",
  "pgRestore",
  "recoveryPointAt",
  "rpoSeconds",
  "rtoSeconds",
  "startedAt"
]);
const backupCountKeys = Object.freeze(Object.keys(OFFSITE_BACKUP_CONTENT_BASELINE));

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...expectedKeys].sort().join("\n");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => (
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    )).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
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

function exactGithubUrl(value, expectedPath) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.username === ""
      && url.password === ""
      && url.pathname === expectedPath
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validRepository(value) {
  return typeof value === "string"
    && repositoryPattern.test(value)
    && !placeholderPattern.test(value);
}

function validMonitoringChecks(checks, receipt, now) {
  if (!Array.isArray(checks) || checks.length !== MONITORING_DRILL_SCENARIOS.length) return false;
  const expectedConclusions = ["success", "failure", "failure", "success"];
  const expectedIssueStates = ["NONE", "OPEN", "OPEN", "CLOSED"];
  const runIds = new Set();
  let priorTime = null;
  let firstTime = null;
  let incidentIdentity = null;

  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const completedAt = canonicalTime(check?.completedAt);
    if (!hasExactKeys(check, monitoringCheckKeys)
      || check.id !== MONITORING_DRILL_SCENARIOS[index]
      || check.conclusion !== expectedConclusions[index]
      || check.issueState !== expectedIssueStates[index]
      || check.sourceCommit !== receipt.sourceCommit
      || !decimalIdentifierPattern.test(check.runId || "")
      || runIds.has(check.runId)
      || !exactGithubUrl(
        check.runUrl,
        "/" + receipt.repository + "/actions/runs/" + check.runId
      )
      || !safeEvidenceReference(check.evidenceReference)
      || completedAt === null
      || completedAt > now + futureClockToleranceMs
      || (priorTime !== null && completedAt < priorTime)) return false;

    if (index === 0) {
      if (check.issueNumber !== null || check.issueUrl !== null) return false;
      firstTime = completedAt;
    } else {
      if (!Number.isSafeInteger(check.issueNumber) || check.issueNumber < 1
        || !exactGithubUrl(
          check.issueUrl,
          "/" + receipt.repository + "/issues/" + check.issueNumber
        )) return false;
      const identity = check.issueNumber + "\n" + check.issueUrl;
      if (incidentIdentity !== null && identity !== incidentIdentity) return false;
      incidentIdentity = identity;
    }
    runIds.add(check.runId);
    priorTime = completedAt;
  }

  return firstTime !== null
    && priorTime === canonicalTime(receipt.completedAt)
    && priorTime - firstTime <= maximumMonitoringDrillDurationMs;
}

export function validMonitoringDrillReceipt(receipt, {
  now = Date.now(),
  repository = null,
  sourceCommit = null,
  publicApiOrigin = null,
  alertResponder = null
} = {}) {
  const completedAt = canonicalTime(receipt?.completedAt);
  const origin = exactHttpsOrigin(receipt?.publicApiOrigin);
  return hasExactKeys(receipt, monitoringReceiptKeys)
    && receipt.schemaVersion === 1
    && receipt.action === "production_monitoring_drill"
    && receipt.status === "PASSED"
    && validRepository(receipt.repository)
    && (!repository || receipt.repository === repository)
    && sourceCommitPattern.test(receipt.sourceCommit || "")
    && (!sourceCommit || receipt.sourceCommit === sourceCommit)
    && origin !== null
    && (!publicApiOrigin || origin === publicApiOrigin)
    && present(receipt.alertResponder, 2, 100)
    && (!alertResponder || receipt.alertResponder === alertResponder)
    && safeEvidenceReference(receipt.evidenceReference)
    && sha256Pattern.test(receipt.recordSha256 || "")
    && completedAt !== null
    && completedAt <= now + futureClockToleranceMs
    && completedAt >= now - maximumReceiptAgeMs
    && validMonitoringChecks(receipt.checks, receipt, now);
}

export function buildMonitoringDrillReceipt({
  record,
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now = Date.now()
}) {
  if (manifest?.schemaVersion !== 1
    || typeof manifest.operator !== "object"
    || manifest.operator === null) {
    throw new Error("Launch readiness manifest must contain operator state");
  }
  if (!hasExactKeys(record, monitoringRecordKeys)
    || record.schemaVersion !== 1
    || record.status !== "PASSED") {
    throw new Error("Monitoring drill record has invalid or unexpected fields");
  }
  if (record.repository !== repository
    || record.sourceCommit !== sourceCommit
    || record.publicApiOrigin !== publicApiOrigin
    || record.alertResponder !== manifest.operator.alertResponder) {
    throw new Error("Monitoring drill must match the repository, source, production origin and named responder");
  }
  const receipt = {
    schemaVersion: 1,
    action: "production_monitoring_drill",
    status: "PASSED",
    repository: record.repository,
    sourceCommit: record.sourceCommit,
    publicApiOrigin: record.publicApiOrigin,
    alertResponder: record.alertResponder,
    completedAt: record.completedAt,
    evidenceReference: record.evidenceReference,
    recordSha256: sha256(canonicalJson(record)),
    checks: structuredClone(record.checks)
  };
  if (!validMonitoringDrillReceipt(receipt, {
    now,
    repository,
    sourceCommit,
    publicApiOrigin,
    alertResponder: manifest.operator.alertResponder
  })) {
    throw new Error("Monitoring drill must prove healthy, incident, deduplication and recovery checks");
  }
  return receipt;
}

function backupTimeFromFileName(fileName) {
  const match = typeof fileName === "string"
    ? fileName.match(/^detective-archives-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.enc$/)
    : null;
  if (!match) return null;
  const value = match[1] + "-" + match[2] + "-" + match[3]
    + "T" + match[4] + ":" + match[5] + ":" + match[6] + ".000Z";
  return canonicalTime(value) === null ? null : value;
}

function validBackupCounts(counts) {
  return hasExactKeys(counts, backupCountKeys)
    && backupCountKeys.every((key) => (
      Number.isSafeInteger(counts[key])
      && counts[key] >= OFFSITE_BACKUP_CONTENT_BASELINE[key]
    ));
}

function validBackupArtifact(artifact, receipt) {
  if (!hasExactKeys(artifact, backupArtifactKeys)
    || !decimalIdentifierPattern.test(artifact.runId || "")
    || !decimalIdentifierPattern.test(artifact.artifactId || "")
    || !Number.isSafeInteger(artifact.runAttempt)
    || artifact.runAttempt < 1
    || artifact.runAttempt > 100
    || artifact.sourceCommit !== receipt.sourceCommit
    || !keyIdPattern.test(artifact.keyId || "")
    || artifact.artifactName !== "detective-archives-backup-" + artifact.keyId
      + "-" + artifact.runId + "-" + artifact.runAttempt
    || backupTimeFromFileName(artifact.archiveFileName) === null
    || !sha256Pattern.test(artifact.archiveSha256 || "")
    || !exactGithubUrl(
      artifact.runUrl,
      "/" + receipt.repository + "/actions/runs/" + artifact.runId
    )
    || !exactGithubUrl(
      artifact.artifactUrl,
      "/" + receipt.repository + "/actions/runs/" + artifact.runId
        + "/artifacts/" + artifact.artifactId
    )) return false;
  const createdAt = canonicalTime(artifact.createdAt);
  const downloadedAt = canonicalTime(artifact.downloadedAt);
  return createdAt !== null && downloadedAt !== null && downloadedAt >= createdAt;
}

function validBackupRestore(restore, artifact, receipt, now) {
  if (!hasExactKeys(restore, backupRestoreKeys)
    || restore.encryptedVerification !== "PASSED"
    || restore.decryption !== "PASSED"
    || restore.pgRestore !== "PASSED"
    || restore.databaseCheck !== "PASSED"
    || restore.apiCheck !== "PASSED"
    || !safeEvidenceReference(restore.evidenceReference)
    || !validBackupCounts(restore.counts)) return false;

  const recoveryPointAt = canonicalTime(restore.recoveryPointAt);
  const artifactCreatedAt = canonicalTime(artifact.createdAt);
  const downloadedAt = canonicalTime(artifact.downloadedAt);
  const startedAt = canonicalTime(restore.startedAt);
  const completedAt = canonicalTime(restore.completedAt);
  const expectedRecoveryPoint = backupTimeFromFileName(artifact.archiveFileName);
  if ([recoveryPointAt, artifactCreatedAt, downloadedAt, startedAt, completedAt].includes(null)
    || restore.recoveryPointAt !== expectedRecoveryPoint
    || recoveryPointAt > artifactCreatedAt
    || artifactCreatedAt > downloadedAt
    || downloadedAt > startedAt
    || startedAt >= completedAt
    || completedAt !== canonicalTime(receipt.completedAt)
    || completedAt > now + futureClockToleranceMs) return false;

  const rpoSeconds = (completedAt - recoveryPointAt) / 1000;
  const rtoSeconds = (completedAt - startedAt) / 1000;
  return Number.isSafeInteger(restore.rpoSeconds)
    && Number.isSafeInteger(restore.rtoSeconds)
    && restore.rpoSeconds === rpoSeconds
    && restore.rtoSeconds === rtoSeconds
    && rpoSeconds >= 0
    && rpoSeconds <= maximumRecoveryPointObjectiveSeconds
    && rtoSeconds > 0
    && rtoSeconds <= maximumRecoveryTimeObjectiveSeconds;
}

export function validOffsiteBackupDrillReceipt(receipt, {
  now = Date.now(),
  repository = null,
  sourceCommit = null,
  publicApiOrigin = null,
  operator = null
} = {}) {
  const completedAt = canonicalTime(receipt?.completedAt);
  const origin = exactHttpsOrigin(receipt?.publicApiOrigin);
  return hasExactKeys(receipt, backupReceiptKeys)
    && receipt.schemaVersion === 1
    && receipt.action === "offsite_backup_restore_drill"
    && receipt.status === "PASSED"
    && validRepository(receipt.repository)
    && (!repository || receipt.repository === repository)
    && sourceCommitPattern.test(receipt.sourceCommit || "")
    && (!sourceCommit || receipt.sourceCommit === sourceCommit)
    && origin !== null
    && (!publicApiOrigin || origin === publicApiOrigin)
    && present(receipt.operator, 2, 100)
    && (!operator || receipt.operator === operator)
    && safeEvidenceReference(receipt.evidenceReference)
    && sha256Pattern.test(receipt.recordSha256 || "")
    && completedAt !== null
    && completedAt <= now + futureClockToleranceMs
    && completedAt >= now - maximumReceiptAgeMs
    && validBackupArtifact(receipt.artifact, receipt)
    && validBackupRestore(receipt.restore, receipt.artifact, receipt, now);
}

export function buildOffsiteBackupDrillReceipt({
  record,
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now = Date.now()
}) {
  if (manifest?.schemaVersion !== 1
    || typeof manifest.operator !== "object"
    || manifest.operator === null) {
    throw new Error("Launch readiness manifest must contain operator state");
  }
  if (!hasExactKeys(record, backupRecordKeys)
    || record.schemaVersion !== 1
    || record.status !== "PASSED") {
    throw new Error("Offsite backup drill record has invalid or unexpected fields");
  }
  if (record.repository !== repository
    || record.sourceCommit !== sourceCommit
    || record.publicApiOrigin !== publicApiOrigin
    || record.operator !== manifest.operator.alertResponder) {
    throw new Error("Offsite backup drill must match the repository, source, production origin and named operator");
  }
  const receipt = {
    schemaVersion: 1,
    action: "offsite_backup_restore_drill",
    status: "PASSED",
    repository: record.repository,
    sourceCommit: record.sourceCommit,
    publicApiOrigin: record.publicApiOrigin,
    operator: record.operator,
    completedAt: record.completedAt,
    evidenceReference: record.evidenceReference,
    recordSha256: sha256(canonicalJson(record)),
    artifact: structuredClone(record.artifact),
    restore: structuredClone(record.restore)
  };
  if (!validOffsiteBackupDrillReceipt(receipt, {
    now,
    repository,
    sourceCommit,
    publicApiOrigin,
    operator: manifest.operator.alertResponder
  })) {
    throw new Error("Offsite backup drill must prove an authenticated artifact and bounded isolated restore");
  }
  return receipt;
}

export function assertInfrastructureDrillGitStatus(statusOutput) {
  if (typeof statusOutput !== "string") {
    throw new Error("Infrastructure drill Git status could not be read");
  }
  const changes = statusOutput.split(/\r?\n/).filter(Boolean);
  for (const line of changes) {
    const status = line.slice(0, 2);
    const filePath = line.slice(3).replaceAll("\\", "/");
    const generatedProductionConfig = allowedGeneratedFiles.has(filePath)
      && /^[ M][ M]$/.test(status)
      && status.includes("M");
    if (!generatedProductionConfig) {
      throw new Error("Infrastructure drills must be recorded from committed source and approved production configuration");
    }
  }
  return true;
}

export function parseGithubRepository(remoteUrl) {
  if (typeof remoteUrl !== "string") throw new Error("GitHub remote URL is missing");
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  let repository = null;
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh) repository = ssh[1];
  if (!repository) {
    try {
      const url = new URL(trimmed);
      if (url.protocol === "https:" && url.hostname === "github.com") {
        repository = url.pathname.replace(/^\//, "");
      }
    } catch {
      repository = null;
    }
  }
  if (!validRepository(repository)) throw new Error("origin must be a canonical GitHub repository URL");
  return repository;
}

async function recordInfrastructureDrill({
  projectRoot,
  manifestPath,
  recordPath,
  receiptProperty,
  stateDirectoryName,
  filePrefix,
  buildReceipt,
  buildOptions
}) {
  const root = path.resolve(projectRoot);
  const expectedManifestPath = path.join(root, "ops", "launch-readiness.json");
  if (path.resolve(manifestPath) !== expectedManifestPath) {
    throw new Error("Infrastructure drill evidence may only update ops/launch-readiness.json");
  }
  if (!recordPath || !path.isAbsolute(recordPath)) {
    throw new Error("Infrastructure drill record path must be absolute");
  }
  const resolvedRecordPath = path.resolve(recordPath);
  if (isPathInside(root, resolvedRecordPath)) {
    throw new Error("Infrastructure drill record must be stored outside the repository");
  }
  const recordLinkStats = await lstat(resolvedRecordPath);
  if (recordLinkStats.isSymbolicLink()) {
    throw new Error("Infrastructure drill record must not be a symbolic link");
  }
  const recordRealPath = await realpath(resolvedRecordPath);
  if (isPathInside(root, recordRealPath)) {
    throw new Error("Infrastructure drill record must be stored outside the repository");
  }
  const recordStats = await stat(recordRealPath);
  if (!recordStats.isFile() || recordStats.size < 2 || recordStats.size > maximumRecordBytes) {
    throw new Error("Infrastructure drill record must be a bounded JSON file");
  }

  const manifestSource = await readFile(expectedManifestPath, "utf8");
  const recordSource = await readFile(recordRealPath, "utf8");
  let manifest;
  let record;
  try {
    manifest = JSON.parse(manifestSource);
    record = JSON.parse(recordSource);
  } catch {
    throw new Error("Infrastructure drill record and launch manifest must contain valid JSON");
  }
  if (manifest.validation !== undefined
    && (manifest.validation === null
      || typeof manifest.validation !== "object"
      || Array.isArray(manifest.validation))) {
    throw new Error("Launch readiness manifest validation state must be an object");
  }
  const receipt = buildReceipt({ record, manifest, ...buildOptions });
  if (JSON.stringify(manifest.validation?.[receiptProperty]) === JSON.stringify(receipt)) {
    return { receipt, receiptPath: null, unchanged: true };
  }

  const stateDirectory = path.join(root, ".release-state", stateDirectoryName);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await access(path.dirname(expectedManifestPath), constants.W_OK);
  const safeTimestamp = receipt.completedAt.replaceAll(":", "").replaceAll(".", "-");
  const receiptPath = path.join(
    stateDirectory,
    filePrefix + "-" + receipt.sourceCommit.slice(0, 12) + "-" + safeTimestamp + ".json"
  );
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600
  });

  const manifestSourceBeforeUpdate = await readFile(expectedManifestPath, "utf8");
  if (sha256(manifestSourceBeforeUpdate) !== sha256(manifestSource)) {
    throw new Error("Launch readiness manifest changed; immutable infrastructure receipt was preserved");
  }
  manifest.validation ??= {};
  manifest.validation[receiptProperty] = receipt;
  if (manifest.infrastructure && typeof manifest.infrastructure === "object") {
    delete manifest.infrastructure.monitoringReady;
    delete manifest.infrastructure.offsiteBackupReady;
  }
  const temporaryManifestPath = expectedManifestPath + "." + process.pid + "." + randomUUID() + ".tmp";
  await writeFile(temporaryManifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryManifestPath, expectedManifestPath);
  return {
    receipt,
    receiptPath: path.relative(root, receiptPath).replaceAll("\\", "/"),
    unchanged: false
  };
}

export async function recordMonitoringDrill({
  projectRoot = process.cwd(),
  manifestPath = path.join(projectRoot, "ops", "launch-readiness.json"),
  recordPath,
  repository,
  sourceCommit,
  publicApiOrigin,
  now = Date.now()
}) {
  return recordInfrastructureDrill({
    projectRoot,
    manifestPath,
    recordPath,
    receiptProperty: "monitoringDrillReceipt",
    stateDirectoryName: "monitoring-drill",
    filePrefix: "monitoring-drill",
    buildReceipt: buildMonitoringDrillReceipt,
    buildOptions: { repository, sourceCommit, publicApiOrigin, now }
  });
}

export async function recordOffsiteBackupDrill({
  projectRoot = process.cwd(),
  manifestPath = path.join(projectRoot, "ops", "launch-readiness.json"),
  recordPath,
  repository,
  sourceCommit,
  publicApiOrigin,
  now = Date.now()
}) {
  return recordInfrastructureDrill({
    projectRoot,
    manifestPath,
    recordPath,
    receiptProperty: "offsiteBackupDrillReceipt",
    stateDirectoryName: "offsite-backup-drill",
    filePrefix: "offsite-backup-drill",
    buildReceipt: buildOffsiteBackupDrillReceipt,
    buildOptions: { repository, sourceCommit, publicApiOrigin, now }
  });
}

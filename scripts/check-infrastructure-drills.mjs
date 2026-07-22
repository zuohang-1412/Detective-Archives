import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertInfrastructureDrillGitStatus,
  buildMonitoringDrillReceipt,
  buildOffsiteBackupDrillReceipt,
  MONITORING_DRILL_SCENARIOS,
  OFFSITE_BACKUP_CONTENT_BASELINE,
  parseGithubRepository,
  recordMonitoringDrill,
  recordOffsiteBackupDrill,
  validMonitoringDrillReceipt,
  validOffsiteBackupDrillReceipt
} from "./lib/infrastructure-drills.mjs";

assert.equal(assertInfrastructureDrillGitStatus(""), true);
assert.equal(assertInfrastructureDrillGitStatus(
  " M project.config.json\n M apps/miniprogram/config.js\n"
), true);
assert.throws(
  () => assertInfrastructureDrillGitStatus(" M docs/runbook.md\n"),
  /committed source/
);
assert.equal(
  parseGithubRepository("https://github.com/zuohang-1412/Detective-Archives.git"),
  "zuohang-1412/Detective-Archives"
);
assert.equal(
  parseGithubRepository("git@github.com:zuohang-1412/Detective-Archives.git"),
  "zuohang-1412/Detective-Archives"
);
assert.throws(() => parseGithubRepository("https://gitlab.com/example/repo.git"));

const now = Date.parse("2026-07-22T06:00:00.000Z");
const repository = "zuohang-1412/Detective-Archives";
const sourceCommit = "a".repeat(40);
const publicApiOrigin = "https://api.detective-archives.cn";
const manifest = {
  schemaVersion: 1,
  operator: {
    alertResponder: "生产告警与灾备负责人"
  },
  infrastructure: {
    monitoringReady: true,
    offsiteBackupReady: true
  },
  validation: {}
};

const issueNumber = 42;
const issueUrl = "https://github.com/" + repository + "/issues/" + issueNumber;
const monitoringTimes = [
  "2026-07-22T04:00:00.000Z",
  "2026-07-22T04:15:00.000Z",
  "2026-07-22T04:30:00.000Z",
  "2026-07-22T05:00:00.000Z"
];
const monitoringRecord = {
  schemaVersion: 1,
  status: "PASSED",
  repository,
  sourceCommit,
  publicApiOrigin,
  alertResponder: manifest.operator.alertResponder,
  completedAt: monitoringTimes.at(-1),
  evidenceReference: "MON-2026-0722 生产告警闭环工单",
  checks: MONITORING_DRILL_SCENARIOS.map((id, index) => ({
    id,
    conclusion: ["success", "failure", "failure", "success"][index],
    runId: String(1001 + index),
    runUrl: "https://github.com/" + repository + "/actions/runs/" + (1001 + index),
    sourceCommit,
    completedAt: monitoringTimes[index],
    evidenceReference: "MON-2026-0722#" + id,
    issueNumber: index === 0 ? null : issueNumber,
    issueUrl: index === 0 ? null : issueUrl,
    issueState: ["NONE", "OPEN", "OPEN", "CLOSED"][index]
  }))
};

const monitoringReceipt = buildMonitoringDrillReceipt({
  record: monitoringRecord,
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
});
assert.equal(validMonitoringDrillReceipt(monitoringReceipt, {
  now,
  repository,
  sourceCommit,
  publicApiOrigin,
  alertResponder: manifest.operator.alertResponder
}), true);
assert.equal(
  validMonitoringDrillReceipt({
    ...monitoringReceipt,
    completedAt: "2026-05-01T00:00:00.000Z"
  }, { now }),
  false,
  "Stale monitoring evidence must be rejected"
);
assert.equal(
  validMonitoringDrillReceipt({ ...monitoringReceipt, sourceCommit: "b".repeat(40) }, {
    now,
    sourceCommit
  }),
  false,
  "Monitoring evidence from another source commit must be rejected"
);
assert.throws(() => buildMonitoringDrillReceipt({
  record: { ...monitoringRecord, checks: monitoringRecord.checks.slice(1) },
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
}), /must prove/);
const duplicateIncidentRecord = structuredClone(monitoringRecord);
duplicateIncidentRecord.checks[2].issueNumber = 43;
duplicateIncidentRecord.checks[2].issueUrl = "https://github.com/" + repository + "/issues/43";
assert.throws(() => buildMonitoringDrillReceipt({
  record: duplicateIncidentRecord,
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
}), /must prove/);
assert.throws(() => buildMonitoringDrillReceipt({
  record: {
    ...monitoringRecord,
    evidenceReference: "https://evidence.invalid/result?access_token=secret"
  },
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
}), /must prove/);
assert.throws(() => buildMonitoringDrillReceipt({
  record: { ...monitoringRecord, alertResponder: "另一位负责人" },
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
}), /must match/);

const backupCompletedAt = "2026-07-22T03:35:00.000Z";
const offsiteBackupRecord = {
  schemaVersion: 1,
  status: "PASSED",
  repository,
  sourceCommit,
  publicApiOrigin,
  operator: manifest.operator.alertResponder,
  completedAt: backupCompletedAt,
  evidenceReference: "BKP-2026-0722 离站恢复演练工单",
  artifact: {
    runId: "2001",
    runAttempt: 1,
    runUrl: "https://github.com/" + repository + "/actions/runs/2001",
    sourceCommit,
    artifactId: "3001",
    artifactUrl: "https://github.com/" + repository + "/actions/runs/2001/artifacts/3001",
    artifactName: "detective-archives-backup-primary-2001-1",
    keyId: "primary",
    archiveFileName: "detective-archives-20260722T020000Z.dump.enc",
    archiveSha256: "c".repeat(64),
    createdAt: "2026-07-22T02:15:00.000Z",
    downloadedAt: "2026-07-22T03:00:00.000Z"
  },
  restore: {
    recoveryPointAt: "2026-07-22T02:00:00.000Z",
    startedAt: "2026-07-22T03:05:00.000Z",
    completedAt: backupCompletedAt,
    rpoSeconds: 5700,
    rtoSeconds: 1800,
    encryptedVerification: "PASSED",
    decryption: "PASSED",
    pgRestore: "PASSED",
    databaseCheck: "PASSED",
    apiCheck: "PASSED",
    counts: { ...OFFSITE_BACKUP_CONTENT_BASELINE },
    evidenceReference: "BKP-2026-0722#ISOLATED_RESTORE"
  }
};

const backupReceipt = buildOffsiteBackupDrillReceipt({
  record: offsiteBackupRecord,
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
});
assert.equal(validOffsiteBackupDrillReceipt(backupReceipt, {
  now,
  repository,
  sourceCommit,
  publicApiOrigin,
  operator: manifest.operator.alertResponder
}), true);
assert.equal(
  validOffsiteBackupDrillReceipt({
    ...backupReceipt,
    artifact: { ...backupReceipt.artifact, archiveSha256: "not-a-checksum" }
  }, { now }),
  false,
  "Offsite evidence must require the encrypted archive checksum"
);
assert.equal(
  validOffsiteBackupDrillReceipt({
    ...backupReceipt,
    restore: {
      ...backupReceipt.restore,
      counts: { ...backupReceipt.restore.counts, detectives: 149 }
    }
  }, { now }),
  false,
  "A restore below the current content baseline must be rejected"
);
assert.throws(() => buildOffsiteBackupDrillReceipt({
  record: {
    ...offsiteBackupRecord,
    restore: { ...offsiteBackupRecord.restore, rpoSeconds: 1 }
  },
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
}), /bounded isolated restore/);
assert.throws(() => buildOffsiteBackupDrillReceipt({
  record: { ...offsiteBackupRecord, extra: "unexpected" },
  manifest,
  repository,
  sourceCommit,
  publicApiOrigin,
  now
}), /unexpected fields/);

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "detective-infrastructure-project-"));
const externalRoot = await mkdtemp(path.join(os.tmpdir(), "detective-infrastructure-record-"));
try {
  await mkdir(path.join(projectRoot, "ops"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "ops", "launch-readiness.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  const monitoringRecordPath = path.join(externalRoot, "monitoring-drill.json");
  const backupRecordPath = path.join(externalRoot, "offsite-backup-drill.json");
  await writeFile(monitoringRecordPath, JSON.stringify(monitoringRecord, null, 2) + "\n");
  await writeFile(backupRecordPath, JSON.stringify(offsiteBackupRecord, null, 2) + "\n");

  const monitoringResult = await recordMonitoringDrill({
    projectRoot,
    recordPath: monitoringRecordPath,
    repository,
    sourceCommit,
    publicApiOrigin,
    now
  });
  assert.equal(monitoringResult.unchanged, false);
  const backupResult = await recordOffsiteBackupDrill({
    projectRoot,
    recordPath: backupRecordPath,
    repository,
    sourceCommit,
    publicApiOrigin,
    now
  });
  assert.equal(backupResult.unchanged, false);

  const updatedManifest = JSON.parse(await readFile(
    path.join(projectRoot, "ops", "launch-readiness.json"),
    "utf8"
  ));
  assert.deepEqual(updatedManifest.validation.monitoringDrillReceipt, monitoringResult.receipt);
  assert.deepEqual(updatedManifest.validation.offsiteBackupDrillReceipt, backupResult.receipt);
  assert.equal("monitoringReady" in updatedManifest.infrastructure, false);
  assert.equal("offsiteBackupReady" in updatedManifest.infrastructure, false);
  assert.equal(
    JSON.parse(await readFile(path.join(projectRoot, monitoringResult.receiptPath), "utf8")).status,
    "PASSED"
  );
  assert.equal(
    JSON.parse(await readFile(path.join(projectRoot, backupResult.receiptPath), "utf8")).status,
    "PASSED"
  );

  const replay = await recordMonitoringDrill({
    projectRoot,
    recordPath: monitoringRecordPath,
    repository,
    sourceCommit,
    publicApiOrigin,
    now
  });
  assert.equal(replay.unchanged, true);
  assert.equal(replay.receiptPath, null);

  const internalRecordPath = path.join(projectRoot, "monitoring-drill.json");
  await writeFile(internalRecordPath, JSON.stringify(monitoringRecord));
  await assert.rejects(recordMonitoringDrill({
    projectRoot,
    recordPath: internalRecordPath,
    repository,
    sourceCommit,
    publicApiOrigin,
    now
  }), /outside the repository/);
  await assert.rejects(recordOffsiteBackupDrill({
    projectRoot,
    recordPath: "relative-backup-drill.json",
    repository,
    sourceCommit,
    publicApiOrigin,
    now
  }), /path must be absolute/);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}

console.log("Infrastructure drill evidence: OK (monitoring incident lifecycle and offsite restore receipt)");

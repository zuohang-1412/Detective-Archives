import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { auditLaunchReadiness, summarizeLaunchReadiness } from "./lib/launch-readiness.mjs";
import { PRODUCTION_PROBE_CHECKS } from "./lib/production-release-drill.mjs";

const operationsRunbookSha256 = createHash("sha256")
  .update(await readFile(new URL("../docs/runbook.md", import.meta.url), "utf8"))
  .digest("hex");
const operationsDrillCompletedAt = new Date().toISOString();
const sourceCommit = "a".repeat(40);
const productionReleaseCompletedAt = new Date().toISOString();
const productionProbe = {
  schemaVersion: 1,
  status: "PASSED",
  publicApiOrigin: "https://api.detective-archives.test",
  checkedAt: productionReleaseCompletedAt,
  httpRedirect: {
    status: 308,
    location: "https://api.detective-archives.test/health"
  },
  tls: {
    authorized: true,
    protocol: "TLSv1.3",
    validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    validTo: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    fingerprint256: Array.from({ length: 32 }, () => "AA").join(":")
  },
  checks: PRODUCTION_PROBE_CHECKS.map((id) => ({ id, status: "PASSED" }))
};
const candidateImage = {
  tag: "release-candidate",
  imageId: `sha256:${"1".repeat(64)}`,
  sourceCommit
};
const previousImage = {
  tag: "release-previous",
  imageId: `sha256:${"2".repeat(64)}`,
  sourceCommit: "b".repeat(40)
};
const productionReleaseReceipt = {
  schemaVersion: 1,
  action: "production_release_drill",
  status: "PASSED",
  sourceCommit,
  publicApiOrigin: productionProbe.publicApiOrigin,
  startedAt: productionReleaseCompletedAt,
  completedAt: productionReleaseCompletedAt,
  durationMs: 0,
  candidate: candidateImage,
  previous: previousImage,
  backup: {
    status: "PASSED",
    fileName: "detective-archives-20260722T080000Z.dump",
    checksumSha256: "c".repeat(64),
    sizeBytes: 1024,
    completedAt: productionReleaseCompletedAt
  },
  phases: [
    {
      id: "CANDIDATE_BEFORE_ROLLBACK",
      currentTag: candidateImage.tag,
      previousTag: previousImage.tag,
      runningTag: candidateImage.tag,
      imageId: candidateImage.imageId,
      probe: structuredClone(productionProbe)
    },
    {
      id: "PREVIOUS_AFTER_ROLLBACK",
      currentTag: previousImage.tag,
      previousTag: candidateImage.tag,
      runningTag: previousImage.tag,
      imageId: previousImage.imageId,
      probe: structuredClone(productionProbe)
    },
    {
      id: "CANDIDATE_RESTORED",
      currentTag: candidateImage.tag,
      previousTag: previousImage.tag,
      runningTag: candidateImage.tag,
      imageId: candidateImage.imageId,
      probe: structuredClone(productionProbe)
    }
  ]
};

const secretValues = {
  database: "database-password-must-never-appear",
  wechat: "wechat-secret-must-never-appear",
  admin: "admin-password-must-never-appear",
  metrics: "metrics-token-must-never-appear"
};

const environment = {
  DATABASE_URL: `postgresql://detective:${secretValues.database}@db.internal:5432/detective_archives`,
  PGSSLMODE: "verify-full",
  WECHAT_APP_ID: "wxproduction123",
  MINIPROGRAM_APP_ID: "wxproduction123",
  WECHAT_APP_SECRET: secretValues.wechat,
  WECHAT_DEV_LOGIN: "false",
  PUBLIC_API_BASE_URL: "https://api.detective-archives.test",
  CORS_ORIGIN: "https://api.detective-archives.test,https://operations.detective-archives.test",
  TRUST_PROXY: "true",
  ADMIN_LOGIN_ID: "operations-admin",
  ADMIN_LOGIN_PASSWORD: secretValues.admin,
  METRICS_AUTH_TOKEN: secretValues.metrics,
  OPERATOR_NAME: "侦探档案馆测试运营主体",
  PRIVACY_CONTACT: "privacy@detective-archives.test"
};

const manifest = {
  schemaVersion: 1,
  operator: {
    legalName: environment.OPERATOR_NAME,
    privacyContact: environment.PRIVACY_CONTACT,
    contentModerator: "内容审核负责人",
    alertResponder: "生产告警负责人"
  },
  wechat: {
    serviceCategoryConfigured: true,
    privacyGuideConfigured: true,
    userAgreementApproved: true,
    requestDomainConfigured: true,
    candidateUploaded: true,
    candidateUploadReceipt: {
      schemaVersion: 1,
      action: "upload",
      status: "SUCCEEDED",
      appid: environment.MINIPROGRAM_APP_ID,
      version: "0.1.0-rc.1",
      sourceCommit,
      robot: 1,
      completedAt: new Date().toISOString(),
      ciPackage: "miniprogram-ci@2.1.31",
      projectConfigSha256: "b".repeat(64),
      miniProgramConfigSha256: "c".repeat(64)
    },
    reviewSubmitted: true,
    reviewApproved: true,
    released: true
  },
  infrastructure: {
    serverProvisioned: true,
    domainFiled: true,
    databasePrivate: true,
    monitoringReady: true,
    offsiteBackupReady: true
  },
  validation: {
    productionReleaseReceipt,
    contentSafetyPassed: true,
    iosDevicePassed: true,
    androidDevicePassed: true,
    operationsDrillReceipt: {
      schemaVersion: 1,
      action: "operations_drill",
      status: "PASSED",
      contentModerator: "内容审核负责人",
      alertResponder: "生产告警负责人",
      completedAt: operationsDrillCompletedAt,
      evidenceReference: "OPS-2026-0722 发布演练工单",
      sourceCommit: "d".repeat(40),
      runbookSha256: operationsRunbookSha256,
      scenarios: [
        "CONTENT_MODERATION",
        "REPORT_RESOLUTION",
        "USER_RESTRICTION",
        "EMERGENCY_UNPUBLISH"
      ].map((id) => ({
        id,
        result: "PASSED",
        evidenceReference: `OPS-2026-0722#${id}`
      }))
    }
  }
};

const readyItems = auditLaunchReadiness({
  environment,
  manifest,
  operationsRunbookSha256,
  sourceCommit
});
const readyReport = summarizeLaunchReadiness(readyItems, "RELEASE");
assert.equal(readyReport.status, "READY");
assert.equal(readyReport.readyThrough, "RELEASE");
assert.equal(readyReport.ready, readyReport.total);

const serializedReport = JSON.stringify(readyReport);
for (const secret of Object.values(secretValues)) {
  assert.equal(serializedReport.includes(secret), false, "launch report must never expose secret values");
}

const beforeDeployment = structuredClone(manifest);
delete beforeDeployment.validation.productionReleaseReceipt;
beforeDeployment.validation.contentSafetyPassed = false;
beforeDeployment.infrastructure.monitoringReady = false;
beforeDeployment.infrastructure.offsiteBackupReady = false;
beforeDeployment.wechat.serviceCategoryConfigured = false;
beforeDeployment.wechat.privacyGuideConfigured = false;
beforeDeployment.wechat.userAgreementApproved = false;
beforeDeployment.wechat.requestDomainConfigured = false;
beforeDeployment.wechat.candidateUploaded = false;
beforeDeployment.wechat.reviewSubmitted = false;
beforeDeployment.wechat.reviewApproved = false;
beforeDeployment.wechat.released = false;
beforeDeployment.validation.iosDevicePassed = false;
beforeDeployment.validation.androidDevicePassed = false;
const phasedItems = auditLaunchReadiness({
  environment,
  manifest: beforeDeployment,
  operationsRunbookSha256,
  sourceCommit
});
assert.equal(summarizeLaunchReadiness(phasedItems, "PRE_DEPLOY").status, "READY");
assert.equal(summarizeLaunchReadiness(phasedItems, "POST_DEPLOY").status, "BLOCKED");
assert.equal(summarizeLaunchReadiness(phasedItems, "RELEASE").readyThrough, "PRE_DEPLOY");

const mismatch = auditLaunchReadiness({
  environment: { ...environment, MINIPROGRAM_APP_ID: "wxdifferent123" },
  manifest,
  operationsRunbookSha256,
  sourceCommit
});
assert.equal(mismatch.find((entry) => entry.id === "wechat_app_identity").status, "MISSING_OR_INVALID");

const candidateAppMismatch = auditLaunchReadiness({
  environment: {
    ...environment,
    WECHAT_APP_ID: "wxotherproduction123",
    MINIPROGRAM_APP_ID: "wxotherproduction123"
  },
  manifest,
  operationsRunbookSha256,
  sourceCommit
});
assert.equal(
  candidateAppMismatch.find((entry) => entry.id === "candidate_uploaded").status,
  "MISSING_OR_INVALID"
);

const missingUploadEvidence = structuredClone(manifest);
delete missingUploadEvidence.wechat.candidateUploadReceipt;
assert.equal(
  auditLaunchReadiness({
    environment,
    manifest: missingUploadEvidence,
    operationsRunbookSha256,
    sourceCommit
  })
    .find((entry) => entry.id === "candidate_uploaded").status,
  "MISSING_OR_INVALID"
);

const staleCommitEvidence = structuredClone(manifest);
staleCommitEvidence.validation.productionReleaseReceipt.sourceCommit = "f".repeat(40);
staleCommitEvidence.validation.productionReleaseReceipt.candidate.sourceCommit = "f".repeat(40);
staleCommitEvidence.wechat.candidateUploadReceipt.sourceCommit = "f".repeat(40);
const staleCommitItems = auditLaunchReadiness({
  environment,
  manifest: staleCommitEvidence,
  operationsRunbookSha256,
  sourceCommit
});
for (const id of [
  "tls_verified",
  "production_release_check",
  "rollback_drill",
  "candidate_uploaded"
]) {
  assert.equal(
    staleCommitItems.find((entry) => entry.id === id).status,
    "MISSING_OR_INVALID",
    `${id} must reject evidence from another source commit`
  );
}

const missingProductionReceipt = structuredClone(manifest);
delete missingProductionReceipt.validation.productionReleaseReceipt;
const missingProductionItems = auditLaunchReadiness({
  environment,
  manifest: missingProductionReceipt,
  operationsRunbookSha256,
  sourceCommit
});
for (const id of ["tls_verified", "production_release_check", "rollback_drill"]) {
  assert.equal(
    missingProductionItems.find((entry) => entry.id === id).status,
    "MISSING_OR_INVALID"
  );
}

const unresolvedSourceItems = auditLaunchReadiness({
  environment,
  manifest,
  operationsRunbookSha256
});
assert.equal(
  unresolvedSourceItems.find((entry) => entry.id === "production_release_check").status,
  "MISSING_OR_INVALID"
);
assert.equal(
  unresolvedSourceItems.find((entry) => entry.id === "candidate_uploaded").status,
  "MISSING_OR_INVALID"
);

const missingOperationsDrill = structuredClone(manifest);
delete missingOperationsDrill.validation.operationsDrillReceipt;
assert.equal(
  auditLaunchReadiness({
    environment,
    manifest: missingOperationsDrill,
    operationsRunbookSha256,
    sourceCommit
  }).find((entry) => entry.id === "operations_drill").status,
  "MISSING_OR_INVALID"
);
assert.equal(
  auditLaunchReadiness({
    environment,
    manifest,
    operationsRunbookSha256: "e".repeat(64),
    sourceCommit
  }).find((entry) => entry.id === "operations_drill").status,
  "MISSING_OR_INVALID"
);
assert.equal(
  auditLaunchReadiness({ environment, manifest, sourceCommit })
    .find((entry) => entry.id === "operations_drill").status,
  "MISSING_OR_INVALID",
  "Operations drill readiness must be bound to the current runbook hash"
);

const placeholders = auditLaunchReadiness({
  environment: {
    ...environment,
    DATABASE_URL: "postgresql://user:strong-password@managed-postgres:5432/detective_archives",
    WECHAT_APP_SECRET: "replace-with-real-appsecret",
    ADMIN_LOGIN_PASSWORD: "replace-with-at-least-16-random-characters"
  },
  manifest,
  operationsRunbookSha256,
  sourceCommit
});
assert.equal(placeholders.find((entry) => entry.id === "database_configuration").status, "MISSING_OR_INVALID");
assert.equal(placeholders.find((entry) => entry.id === "wechat_app_secret").status, "MISSING_OR_INVALID");
assert.equal(placeholders.find((entry) => entry.id === "admin_credentials").status, "MISSING_OR_INVALID");

console.log(`Launch readiness audit: OK (${readyItems.length} non-secret gates across 4 phases)`);

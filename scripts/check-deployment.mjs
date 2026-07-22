import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve();
const [
  dockerfile,
  compose,
  caddyfile,
  qualityWorkflow,
  linkHealthWorkflow,
  backupWorkflow,
  backupScript,
  apiServer,
  deployScript,
  rollbackScript,
  releaseRollbackDrill,
  releaseDrillCompose,
  rootPackage,
  catalogSeedScript,
  operationsDrillScript,
  operationsDrillTemplate,
  operationsRunbook,
  launchReadinessLibrary,
  productionDrillCommand,
  productionDrillLibrary,
  wechatAcceptanceCommand,
  wechatAcceptanceTemplate,
  wechatAcceptanceLibrary,
  acceptanceExecution,
  qaReport
] = await Promise.all([
  readFile(path.join(root, "Dockerfile"), "utf8"),
  readFile(path.join(root, "compose.yaml"), "utf8"),
  readFile(path.join(root, "ops/Caddyfile.example"), "utf8"),
  readFile(path.join(root, ".github/workflows/quality.yml"), "utf8"),
  readFile(path.join(root, ".github/workflows/link-health.yml"), "utf8"),
  readFile(path.join(root, ".github/workflows/database-backup.yml"), "utf8"),
  readFile(path.join(root, "ops/backup-postgres.sh"), "utf8"),
  readFile(path.join(root, "apps/api/src/server.ts"), "utf8"),
  readFile(path.join(root, "ops/deploy-release.sh"), "utf8"),
  readFile(path.join(root, "ops/rollback-release.sh"), "utf8"),
  readFile(path.join(root, "scripts/check-release-rollback.mjs"), "utf8"),
  readFile(path.join(root, "ops/compose.release-drill.yaml"), "utf8"),
  readFile(path.join(root, "package.json"), "utf8"),
  readFile(path.join(root, "scripts/db-seed-catalog.mjs"), "utf8"),
  readFile(path.join(root, "scripts/record-operations-drill.mjs"), "utf8"),
  readFile(path.join(root, "ops/operations-drill-record.example.json"), "utf8"),
  readFile(path.join(root, "docs/runbook.md"), "utf8"),
  readFile(path.join(root, "scripts/lib/launch-readiness.mjs"), "utf8"),
  readFile(path.join(root, "scripts/drill-production-release.mjs"), "utf8"),
  readFile(path.join(root, "scripts/lib/production-release-drill.mjs"), "utf8"),
  readFile(path.join(root, "scripts/record-wechat-acceptance.mjs"), "utf8"),
  readFile(path.join(root, "ops/wechat-acceptance-record.example.json"), "utf8"),
  readFile(path.join(root, "scripts/lib/wechat-acceptance.mjs"), "utf8"),
  readFile(path.join(root, "docs/acceptance-execution.md"), "utf8"),
  readFile(path.join(root, "docs/qa-report-2026-07-22.md"), "utf8")
]);

const startupSteps = [
  "check-api-production-config.mjs",
  "db-migrate.mjs",
  "db-seed-catalog.mjs",
  "run-catalog-imports.mjs --apply",
  "apps/api/dist/server.js"
];
let previousIndex = -1;
for (const step of startupSteps) {
  const index = dockerfile.indexOf(step);
  assert.ok(index > previousIndex, `Docker startup is missing or misorders ${step}`);
  previousIndex = index;
}

assert.match(dockerfile, /^USER node$/m, "Runtime container must use the node user");
assert.match(dockerfile, /org\.opencontainers\.image\.revision/, "Runtime images must carry a source revision label");
assert.match(compose, /read_only:\s*true/, "API filesystem must be read-only");
assert.match(compose, /SOURCE_COMMIT:\s*\$\{SOURCE_COMMIT:-unknown\}/, "Compose builds must accept the source revision");
assert.match(compose, /no-new-privileges:true/, "API must disable privilege escalation");
assert.match(compose, /127\.0\.0\.1:3000:3000/, "API port must bind to loopback");
assert.match(compose, /healthcheck:[\s\S]*\/ready/, "Compose must probe database readiness");
assert.match(caddyfile, /reverse_proxy\s+127\.0\.0\.1:3000/, "Caddy must proxy to loopback API");
assert.match(qualityWorkflow, /services:[\s\S]*postgres:/, "CI must provide PostgreSQL");
assert.match(qualityWorkflow, /npm run check:db-api/, "CI must exercise the database API lifecycle");
assert.match(qualityWorkflow, /docker run[\s\S]*detective-archives-api:test/, "CI must start the built image");
assert.match(qualityWorkflow, /npm run check:runtime/, "CI must probe the running production image");
assert.match(qualityWorkflow, /npm run check:performance/, "CI must measure the production image latency");
assert.match(linkHealthWorkflow, /schedule:[\s\S]*cron:/, "Link checks must support a daily schedule");
assert.match(linkHealthWorkflow, /LINK_HEALTH_ENABLED/, "Scheduled link checks must require explicit enablement");
assert.match(linkHealthWorkflow, /runs-on:\s*\[self-hosted, detective-archives\]/, "Link checks must run inside the private deployment network");
assert.match(linkHealthWorkflow, /--fail-on-broken/, "Scheduled link checks must alert on confirmed failures");
assert.match(backupWorkflow, /schedule:[\s\S]*cron:/, "Database backups must support a daily schedule");
assert.match(backupWorkflow, /DATABASE_BACKUP_ENABLED/, "Scheduled backups must require explicit enablement");
assert.match(backupWorkflow, /runs-on:\s*\[self-hosted, detective-archives\]/, "Backups must run inside the private deployment network");
assert.match(backupWorkflow, /backup-postgres\.sh/, "Scheduled backups must use the verified backup script");
assert.match(backupWorkflow, /verify-backup\.sh/, "Scheduled backups must verify the new archive");
assert.match(backupScript, /BACKUP_DIRECTORY must be an absolute dedicated directory/, "Backup cleanup must require a dedicated absolute directory");
assert.match(backupScript, /client\/server major version mismatch/, "Backups must reject a PostgreSQL client/server major version mismatch");
assert.match(backupScript, /sha256sum/, "Backups must record an integrity checksum");
assert.match(apiServer, /createWechatContentSafetyCheckFromEnv/, "Production API must initialize WeChat content safety");
assert.match(deployScript, /npm run release:check/, "Deployments must run the production release gate");
assert.match(deployScript, /git rev-parse HEAD/, "Deployments must resolve the full source commit");
assert.match(deployScript, /SOURCE_COMMIT="\$source_commit"/, "Deployments must bind the image to the source commit");
const launchAuditIndex = deployScript.indexOf("audit-launch-readiness.mjs");
const miniProgramConfigIndex = deployScript.indexOf("npm run config:miniprogram");
const releaseCheckIndex = deployScript.indexOf("npm run release:check");
assert.ok(launchAuditIndex >= 0, "Deployments must audit verified pre-deployment inputs");
assert.ok(
  launchAuditIndex < miniProgramConfigIndex && miniProgramConfigIndex < releaseCheckIndex,
  "Deployments must audit inputs and generate Mini Program configuration before release checks"
);
assert.match(deployScript, /backup-postgres\.sh/, "Deployments must create a pre-release database backup");
assert.match(deployScript, /npm run check:db/, "Deployments must verify the migrated production database");
assert.match(deployScript, /npm run check:runtime/, "Deployments must run HTTP and metrics smoke checks");
assert.match(deployScript, /Restoring previous application image/, "Failed deployments must automatically restore the previous image");
assert.match(rollbackScript, /docker image inspect/, "Rollback must require an existing local image");
assert.match(rollbackScript, /npm run check:runtime/, "Rollback must verify the restored runtime");
assert.match(rootPackage, /"check:release-rollback"/, "The release rollback drill must have an npm entrypoint");
assert.match(rootPackage, /"operations:drill:record"/, "The operations drill must have an npm entrypoint");
assert.match(rootPackage, /"release:drill:production"/, "The production rollback drill must have an npm entrypoint");
assert.match(rootPackage, /"check:production-release-drill"/, "The production rollback evidence must have an automated check");
assert.match(rootPackage, /"wechat:acceptance:record"/, "WeChat acceptance must have a recording entrypoint");
assert.match(rootPackage, /"check:wechat-acceptance"/, "WeChat acceptance must have an automated check");
assert.match(qualityWorkflow, /npm run check:release-rollback/, "CI must execute the real release rollback drill");
assert.match(qualityWorkflow, /postgres:16/, "CI PostgreSQL must match the explicitly installed backup client major version");
assert.match(qualityWorkflow, /postgresql-client-16/, "CI must install a matching PostgreSQL backup client");
assert.match(releaseDrillCompose, /host\.docker\.internal:host-gateway/, "The isolated Compose drill must reach the host-only CI database");
assert.match(releaseRollbackDrill, /RELEASE_ROLLBACK_TEST/, "The destructive release drill must require an explicit opt-in");
assert.match(releaseRollbackDrill, /npm.*db:create/, "The release drill must create an isolated empty database");
assert.match(releaseRollbackDrill, /DROP DATABASE IF EXISTS/, "The release drill must remove only its isolated database");
assert.match(releaseRollbackDrill, /ops\/deploy-release\.sh/, "The drill must execute the production deployment script");
assert.match(releaseRollbackDrill, /ops\/rollback-release\.sh/, "The drill must execute the production rollback script");
assert.match(releaseRollbackDrill, /Candidate and baseline images must have different IDs/, "The drill must prove that two distinct images are switched");
assert.match(releaseRollbackDrill, /previous-image-tag/, "The drill must verify persisted rollback state");
assert.match(releaseRollbackDrill, /ops\/verify-backup\.sh/, "The drill must verify the mandatory deployment backup");
assert.match(catalogSeedScript, /FROM catalog_import_batches/, "Base seeding must detect immutable content history");
assert.match(catalogSeedScript, /preserved existing catalog/, "Redeployment must preserve batch-owned catalog fields and relations");
assert.match(operationsDrillScript, /recordOperationsDrill/, "The operations drill command must persist validated evidence");
for (const scenario of [
  "CONTENT_MODERATION",
  "REPORT_RESOLUTION",
  "USER_RESTRICTION",
  "EMERGENCY_UNPUBLISH"
]) {
  assert.match(operationsDrillTemplate, new RegExp(scenario), `Operations drill template must include ${scenario}`);
}
assert.match(operationsRunbook, /operations:drill:record/, "The runbook must explain how to record the operations drill");
assert.match(operationsRunbook, /wechat:acceptance:record/, "The runbook must explain how to record WeChat acceptance");
assert.match(launchReadinessLibrary, /item\("operations_drill", "SUBMISSION"/, "Submission must require operations drill evidence");
assert.match(productionDrillCommand, /PRODUCTION_ROLLBACK_DRILL/, "Production rollback must require a one-shot opt-in");
assert.match(productionDrillCommand, /inspectRecentBackup/, "Production rollback must require recent backup evidence");
assert.match(productionDrillCommand, /recordProductionReleaseReceipt/, "Production rollback must persist validated evidence");
assert.match(productionDrillLibrary, /inspectPublicTls/, "Production evidence must inspect the public TLS connection");
assert.match(productionDrillLibrary, /CANDIDATE_RESTORED/, "Production evidence must verify candidate recovery");
assert.match(launchReadinessLibrary, /validProductionReleaseReceipt/, "Post-deployment gates must require a production receipt");
assert.match(wechatAcceptanceCommand, /assertReleaseGitStatus/, "WeChat acceptance must require committed candidate source");
assert.match(wechatAcceptanceCommand, /recordWechatAcceptance/, "WeChat acceptance command must persist validated evidence");
for (const scenario of [
  "SERVICE_CATEGORY",
  "PRIVACY_GUIDE",
  "USER_AGREEMENT",
  "REQUEST_DOMAIN",
  "RISKY_CONTENT_REJECTED",
  "DEPENDENCY_FAILURE_PENDING",
  "DATA_EXPORT_AND_SHARE",
  "ACCOUNT_DEACTIVATION"
]) {
  assert.match(wechatAcceptanceTemplate, new RegExp(scenario), `WeChat acceptance template must include ${scenario}`);
}
assert.match(wechatAcceptanceLibrary, /candidateUploadReceiptSha256/, "WeChat acceptance must bind the exact uploaded candidate");
assert.match(launchReadinessLibrary, /validWechatAcceptanceReceipt/, "Submission gates must require WeChat acceptance evidence");

const acceptanceRows = [...acceptanceExecution.matchAll(
  /^\| (PASS|BLOCKED|FAIL|PENDING) \| (AT-[^| ]+) \|/gm
)];
const acceptanceIds = new Set(acceptanceRows.map((match) => match[2]));
assert.equal(acceptanceIds.size, acceptanceRows.length, "Acceptance execution IDs must be unique");
const acceptanceCounts = { PASS: 0, BLOCKED: 0, FAIL: 0, PENDING: 0 };
for (const match of acceptanceRows) acceptanceCounts[match[1]] += 1;
assert.equal(acceptanceCounts.PENDING, 0, "The published QA summary must not hide pending execution rows");
const passRate = ((acceptanceCounts.PASS / acceptanceRows.length) * 100).toFixed(1);
assert.match(
  qaReport,
  new RegExp(
    `\\| ${acceptanceRows.length} \\| ${acceptanceCounts.PASS} \\| `
      + `${acceptanceCounts.FAIL} \\| ${acceptanceCounts.BLOCKED} \\| ${passRate}% \\|`
  ),
  "QA summary counts must match the acceptance execution table"
);

console.log("Deployment structure and startup sequence: OK");

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
  rollbackScript
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
  readFile(path.join(root, "ops/rollback-release.sh"), "utf8")
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
assert.match(compose, /read_only:\s*true/, "API filesystem must be read-only");
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

console.log("Deployment structure and startup sequence: OK");

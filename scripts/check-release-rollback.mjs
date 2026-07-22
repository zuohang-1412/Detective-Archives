import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.env.RELEASE_ROLLBACK_TEST !== "true") {
  throw new Error("Set RELEASE_ROLLBACK_TEST=true to run the destructive, isolated release drill");
}
if (process.platform !== "linux") {
  throw new Error("The release rollback drill requires a Linux Docker host");
}

const root = path.resolve();
const sourceDatabaseUrl = process.env.DATABASE_URL;
if (!sourceDatabaseUrl) throw new Error("DATABASE_URL is required");

const runId = (process.env.GITHUB_SHA?.slice(0, 8) ?? String(process.pid)).toLowerCase();
const drillDatabaseName = `detective_archives_release_${runId}`;
if (!/^[a-z][a-z0-9_]{0,62}$/.test(drillDatabaseName)) {
  throw new Error("The generated release drill database name is invalid");
}
const sourceDatabase = new URL(sourceDatabaseUrl);
const sourceDatabaseName = decodeURIComponent(sourceDatabase.pathname.slice(1));
if (!/^[a-z][a-z0-9_]{0,62}$/.test(sourceDatabaseName)) {
  throw new Error("DATABASE_URL must select a valid maintenance database");
}
const hostDatabaseUrl = new URL(sourceDatabase);
hostDatabaseUrl.pathname = `/${drillDatabaseName}`;
const containerDatabaseUrl = new URL(hostDatabaseUrl);
containerDatabaseUrl.hostname = process.env.RELEASE_ROLLBACK_DATABASE_HOST ?? "host.docker.internal";

const baselineTag = `drill-baseline-${runId}`;
const candidateTag = `drill-candidate-${runId}`;
const baselineImage = `detective-archives-api:${baselineTag}`;
const candidateImage = `detective-archives-api:${candidateTag}`;
const temporaryRoot = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "detective-release-rollback-"));
const stateDirectory = path.join(temporaryRoot, "state");
const backupDirectory = path.join(temporaryRoot, "backups");
const envFile = path.join(temporaryRoot, "production.env");
const readinessFile = path.join(temporaryRoot, "launch-readiness.json");
const markerFile = path.join(root, "apps", "api", "src", "data", "release-rollback-drill-marker.txt");
const miniProgramConfigPath = path.join(root, "apps", "miniprogram", "config.js");
const projectConfigPath = path.join(root, "project.config.json");
const originalMiniProgramConfig = await readFile(miniProgramConfigPath, "utf8");
const originalProjectConfig = await readFile(projectConfigPath, "utf8");
const appId = `wx${randomBytes(8).toString("hex")}`;
const wechatSecret = `release-${randomBytes(24).toString("hex")}`;
const adminPassword = `release-${randomBytes(24).toString("hex")}`;
const metricsToken = `release-${randomBytes(24).toString("hex")}`;
const composeFiles = [
  path.join(root, "compose.yaml"),
  path.join(root, "ops", "compose.release-drill.yaml")
].join(path.delimiter);

const commonEnvironment = {
  ...process.env,
  API_ENV_FILE: envFile,
  COMPOSE_FILE: composeFiles,
  COMPOSE_PROJECT_NAME: `detective-archives-release-drill-${runId}`,
  DATABASE_URL: hostDatabaseUrl.toString(),
  DETECTIVE_DB_NAME: drillDatabaseName,
  PGDATABASE: drillDatabaseName,
  RELEASE_STATE_DIRECTORY: stateDirectory
};

function run(command, args, environment = commonEnvironment) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function output(command, args, environment = commonEnvironment) {
  return execFileSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8"
  }).trim();
}

function composeEnvironment(imageTag) {
  return { ...commonEnvironment, IMAGE_TAG: imageTag };
}

async function state(name) {
  return (await readFile(path.join(stateDirectory, name), "utf8")).trim();
}

function activeContainer(environment) {
  const containerId = output("docker", ["compose", "ps", "-q", "api"], environment);
  assert.ok(containerId, "Compose must expose an active API container");
  return {
    imageName: output("docker", ["inspect", "--format", "{{.Config.Image}}", containerId], environment),
    imageId: output("docker", ["inspect", "--format", "{{.Image}}", containerId], environment)
  };
}

await mkdir(backupDirectory, { recursive: true });
await writeFile(envFile, [
  "API_HOST=0.0.0.0",
  "API_PORT=3000",
  "CORS_ORIGIN=https://api.detective.invalid",
  "TRUST_PROXY=true",
  "LOG_LEVEL=warn",
  `DATABASE_URL=${containerDatabaseUrl.toString()}`,
  `DETECTIVE_DB_NAME=${drillDatabaseName}`,
  `PGDATABASE=${drillDatabaseName}`,
  "PGSSLMODE=disable",
  "DB_POOL_MAX=10",
  "DB_CONNECTION_TIMEOUT_MS=5000",
  "DB_IDLE_TIMEOUT_MS=30000",
  `BACKUP_DIRECTORY=${backupDirectory}`,
  "BACKUP_RETENTION_DAYS=2",
  "SESSION_TTL_SECONDS=2592000",
  "RATE_LIMIT_MAX=300",
  "RATE_LIMIT_WINDOW_MS=60000",
  `WECHAT_APP_ID=${appId}`,
  `WECHAT_APP_SECRET=${wechatSecret}`,
  "WECHAT_DEV_LOGIN=false",
  `MINIPROGRAM_APP_ID=${appId}`,
  "PUBLIC_API_BASE_URL=https://api.detective.invalid",
  "OPERATOR_NAME=DetectiveArchivesVerification",
  "PRIVACY_CONTACT=release-validation@detective.invalid",
  "ADMIN_LOGIN_ID=release-operator",
  `ADMIN_LOGIN_PASSWORD=${adminPassword}`,
  `METRICS_AUTH_TOKEN=${metricsToken}`
].join("\n") + "\n", { mode: 0o600 });
await writeFile(readinessFile, JSON.stringify({
  schemaVersion: 1,
  operator: {
    legalName: "DetectiveArchivesVerification",
    privacyContact: "release-validation@detective.invalid",
    contentModerator: "Release Verification Moderator",
    alertResponder: "Release Verification Responder",
    wechatTester: "Release Verification WeChat Tester"
  },
  wechat: {
    candidateUploaded: false,
    reviewSubmitted: false,
    reviewApproved: false,
    released: false
  },
  infrastructure: {
    serverProvisioned: true,
    domainFiled: true,
    databasePrivate: true,
    monitoringReady: false,
    offsiteBackupReady: false
  },
  validation: {
    productionReleaseReceipt: null,
    wechatAcceptanceReceipt: null
  }
}, null, 2) + "\n", { mode: 0o600 });

let baselineImageId;
let candidateImageId;
let rollbackDurationMs;
try {
  run("npm", ["run", "db:create"], {
    ...commonEnvironment,
    DATABASE_URL: sourceDatabaseUrl,
    DETECTIVE_DB_NAME: drillDatabaseName,
    PGDATABASE: sourceDatabaseName
  });
  const baselineEnvironment = composeEnvironment(baselineTag);
  run("docker", ["compose", "build", "api"], baselineEnvironment);
  baselineImageId = output("docker", ["image", "inspect", "--format", "{{.Id}}", baselineImage]);
  run("docker", ["compose", "up", "-d", "--no-build", "api"], baselineEnvironment);
  run("node", ["scripts/check-runtime-smoke.mjs"], {
    ...baselineEnvironment,
    RUNTIME_BASE_URL: "http://127.0.0.1:3000",
    METRICS_AUTH_TOKEN: metricsToken
  });
  assert.deepEqual(activeContainer(baselineEnvironment), {
    imageName: baselineImage,
    imageId: baselineImageId
  });

  await writeFile(markerFile, `candidate ${runId}\n`, { flag: "wx" });
  run("sh", ["ops/deploy-release.sh", candidateTag, envFile, readinessFile]);

  candidateImageId = output("docker", ["image", "inspect", "--format", "{{.Id}}", candidateImage]);
  assert.notEqual(candidateImageId, baselineImageId, "Candidate and baseline images must have different IDs");
  assert.deepEqual(activeContainer(composeEnvironment(candidateTag)), {
    imageName: candidateImage,
    imageId: candidateImageId
  });
  assert.equal(await state("current-image-tag"), candidateTag);
  assert.equal(await state("previous-image-tag"), baselineTag);

  const backups = (await readdir(backupDirectory)).filter((name) => name.endsWith(".dump"));
  assert.equal(backups.length, 1, "Deployment must create exactly one pre-release backup");
  run("sh", ["ops/verify-backup.sh", path.join(backupDirectory, backups[0])]);

  const rollbackStartedAt = performance.now();
  run("sh", ["ops/rollback-release.sh", "", envFile]);
  rollbackDurationMs = Math.round(performance.now() - rollbackStartedAt);

  assert.deepEqual(activeContainer(composeEnvironment(baselineTag)), {
    imageName: baselineImage,
    imageId: baselineImageId
  });
  assert.equal(await state("current-image-tag"), baselineTag);
  assert.equal(await state("previous-image-tag"), candidateTag);
  run("npm", ["run", "check:db"]);

  console.log(JSON.stringify({
    status: "release_rollback_drill_ok",
    baselineTag,
    candidateTag,
    distinctImageIds: true,
    isolatedDatabase: true,
    backupVerified: true,
    rollbackDurationMs,
    restoredImageTag: baselineTag
  }, null, 2));
} finally {
  spawnSync("docker", ["compose", "down", "--remove-orphans"], {
    cwd: root,
    env: commonEnvironment,
    stdio: "inherit"
  });
  for (const imageName of [candidateImage, baselineImage]) {
    spawnSync("docker", ["image", "rm", "--force", imageName], {
      cwd: root,
      env: commonEnvironment,
      stdio: "ignore"
    });
  }
  const databaseDrop = spawnSync("psql", [
    "--dbname", sourceDatabaseUrl,
    "--set", "ON_ERROR_STOP=1",
    "--command", `DROP DATABASE IF EXISTS "${drillDatabaseName}" WITH (FORCE)`
  ], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  await rm(markerFile, { force: true });
  await writeFile(miniProgramConfigPath, originalMiniProgramConfig, "utf8");
  await writeFile(projectConfigPath, originalProjectConfig, "utf8");
  await rm(temporaryRoot, { recursive: true, force: true });
  if (databaseDrop.error) throw databaseDrop.error;
  if (databaseDrop.status !== 0) {
    throw new Error(`Could not remove the isolated release drill database (exit ${databaseDrop.status})`);
  }
}

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  assertInfrastructureDrillGitStatus,
  parseGithubRepository,
  recordMonitoringDrill,
  recordOffsiteBackupDrill
} from "./lib/infrastructure-drills.mjs";

const [drillType, ...argumentsList] = process.argv.slice(2);
if (!["monitoring", "offsite-backup"].includes(drillType)) {
  throw new Error("First argument must be monitoring or offsite-backup");
}

const options = {
  envFile: null,
  manifestPath: "ops/launch-readiness.json",
  recordPath: null
};

for (const argument of argumentsList) {
  if (argument.startsWith("--record=")) options.recordPath = argument.slice("--record=".length);
  else if (argument.startsWith("--manifest=")) {
    options.manifestPath = argument.slice("--manifest=".length);
  } else if (argument.startsWith("--env-file=")) {
    options.envFile = argument.slice("--env-file=".length);
  } else {
    throw new Error("Unknown infrastructure drill option: " + argument);
  }
}

if (!options.recordPath || !path.isAbsolute(options.recordPath)) {
  throw new Error("--record must be an absolute path outside the repository");
}

let environment = { ...process.env };
if (options.envFile) {
  const source = await readFile(path.resolve(options.envFile), "utf8");
  environment = { ...environment, ...parseEnv(source) };
}
const publicApiOrigin = environment.PUBLIC_API_BASE_URL?.trim();
if (!publicApiOrigin) throw new Error("PUBLIC_API_BASE_URL is required");

function git(argumentsArray, failureMessage) {
  const result = spawnSync("git", argumentsArray, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(failureMessage);
  return result.stdout.trim();
}

assertInfrastructureDrillGitStatus(git(["status", "--porcelain"], "Unable to read Git status"));
const sourceCommit = git(["rev-parse", "HEAD"], "Unable to resolve the current source commit");
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
  throw new Error("Current source commit must be a full Git SHA");
}
const repository = parseGithubRepository(git(
  ["remote", "get-url", "origin"],
  "Unable to resolve the origin repository"
));

const commonOptions = {
  projectRoot: process.cwd(),
  manifestPath: path.resolve(options.manifestPath),
  recordPath: path.resolve(options.recordPath),
  repository,
  sourceCommit,
  publicApiOrigin
};
const result = drillType === "monitoring"
  ? await recordMonitoringDrill(commonOptions)
  : await recordOffsiteBackupDrill(commonOptions);

console.log(JSON.stringify({
  status: "SUCCEEDED",
  action: drillType === "monitoring"
    ? "production_monitoring_drill"
    : "offsite_backup_restore_drill",
  repository,
  sourceCommit,
  receipt: result.receiptPath,
  unchanged: result.unchanged,
  launchManifestUpdated: !result.unchanged
}));

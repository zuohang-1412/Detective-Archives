import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { assertReleaseGitStatus } from "./lib/miniprogram-release.mjs";
import {
  inspectRecentBackup,
  performProductionReleaseDrill,
  probePublicProduction,
  recordProductionReleaseReceipt
} from "./lib/production-release-drill.mjs";

function parseOptions(args) {
  const options = {
    envFile: ".env.production",
    manifest: "ops/launch-readiness.json",
    stateDirectory: null
  };
  for (const argument of args) {
    if (argument.startsWith("--env-file=")) options.envFile = argument.slice("--env-file=".length);
    else if (argument.startsWith("--manifest=")) options.manifest = argument.slice("--manifest=".length);
    else if (argument.startsWith("--state-directory=")) {
      options.stateDirectory = argument.slice("--state-directory=".length);
    } else throw new Error(`Unknown production drill option: ${argument}`);
  }
  return options;
}

function run(command, args, {
  cwd = process.cwd(),
  environment = process.env,
  capture = false,
  label = command
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? String(result.stderr || "").trim().slice(0, 500) : "";
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return capture ? String(result.stdout || "").trim() : "";
}

function readDockerJson(command, args, environment, label) {
  const output = run(command, args, { environment, capture: true, label });
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(`${label} returned an unexpected result`);
  }
  return result[0];
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform !== "linux") {
    throw new Error("The production release drill must run on the Linux deployment host");
  }
  if (process.env.PRODUCTION_ROLLBACK_DRILL !== "true") {
    throw new Error("Set PRODUCTION_ROLLBACK_DRILL=true for this one production drill invocation");
  }

  const projectRoot = path.resolve();
  const envFile = path.resolve(options.envFile);
  const manifestPath = path.resolve(options.manifest);
  if (manifestPath !== path.join(projectRoot, "ops", "launch-readiness.json")) {
    throw new Error("Production evidence may only update ops/launch-readiness.json");
  }
  const fileEnvironment = parseEnv(await readFile(envFile, "utf8"));
  const environment = { ...fileEnvironment, ...process.env };
  const publicApiOrigin = String(environment.PUBLIC_API_BASE_URL || "").trim();
  const metricsToken = String(environment.METRICS_AUTH_TOKEN || "");
  const backupDirectory = String(
    environment.BACKUP_DIRECTORY || "/var/backups/detective-archives"
  );
  const stateDirectory = path.resolve(
    options.stateDirectory || environment.RELEASE_STATE_DIRECTORY || ".release-state"
  );
  const commandEnvironment = {
    ...process.env,
    API_ENV_FILE: envFile,
    RELEASE_STATE_DIRECTORY: stateDirectory
  };

  assertReleaseGitStatus(run("git", ["status", "--porcelain"], {
    capture: true,
    label: "Git status"
  }));
  const sourceCommit = run("git", ["rev-parse", "HEAD"], {
    capture: true,
    label: "Git commit lookup"
  });
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error("Unable to resolve the full release source commit");
  }

  async function stateTag(fileName) {
    return (await readFile(path.join(stateDirectory, fileName), "utf8")).trim();
  }

  async function getState() {
    const currentTag = await stateTag("current-image-tag");
    const previousTag = await stateTag("previous-image-tag");
    const composeEnvironment = { ...commandEnvironment, IMAGE_TAG: currentTag };
    const containerId = run("docker", ["compose", "ps", "-q", "api"], {
      environment: composeEnvironment,
      capture: true,
      label: "Docker Compose application lookup"
    });
    if (!containerId || /\r|\n/.test(containerId)) {
      throw new Error("Exactly one running application container is required");
    }
    const container = readDockerJson(
      "docker",
      ["inspect", containerId],
      composeEnvironment,
      "Application container inspection"
    );
    const prefix = "detective-archives-api:";
    const runningImage = container?.Config?.Image;
    if (typeof runningImage !== "string" || !runningImage.startsWith(prefix)) {
      throw new Error("The running application does not use a release-tagged image");
    }
    return {
      currentTag,
      previousTag,
      runningTag: runningImage.slice(prefix.length),
      runningImageId: container.Image
    };
  }

  async function inspectImage(tag) {
    const image = readDockerJson(
      "docker",
      ["image", "inspect", `detective-archives-api:${tag}`],
      commandEnvironment,
      `Release image inspection (${tag})`
    );
    return {
      imageId: image.Id,
      sourceCommit: image?.Config?.Labels?.["org.opencontainers.image.revision"]
    };
  }

  async function rollback(tag) {
    run("sh", ["ops/rollback-release.sh", tag, envFile], {
      environment: commandEnvironment,
      label: `Rollback to ${tag}`
    });
  }

  const backup = await inspectRecentBackup(backupDirectory);
  const receipt = await performProductionReleaseDrill({
    sourceCommit,
    publicApiOrigin,
    backup,
    getState,
    inspectImage,
    rollback,
    probe: () => probePublicProduction({
      publicApiOrigin,
      metricsToken,
      tlsRejectUnauthorized: environment.NODE_TLS_REJECT_UNAUTHORIZED
    })
  });
  const recorded = await recordProductionReleaseReceipt({
    projectRoot,
    manifestPath,
    stateDirectory,
    receipt
  });

  console.log(JSON.stringify({
    status: receipt.status,
    sourceCommit: receipt.sourceCommit,
    candidateTag: receipt.candidate.tag,
    previousTag: receipt.previous.tag,
    publicApiOrigin: receipt.publicApiOrigin,
    receipt: recorded.receiptFileName,
    launchManifestUpdated: true
  }));
}

await main().catch((error) => {
  const detail = String(error?.message || "unknown error")
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .slice(0, 600);
  console.error(`Production release drill blocked: ${detail}`);
  process.exitCode = 1;
});

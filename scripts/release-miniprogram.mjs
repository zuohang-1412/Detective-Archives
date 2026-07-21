import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import {
  assertReleaseGitStatus,
  buildMiniProgramReleasePlan,
  MINIPROGRAM_CI_REGISTRY,
  MINIPROGRAM_CI_VERSION,
  isPathInside,
  resolveNpmInvocation,
  sanitizeCiEnvironment
} from "./lib/miniprogram-release.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: options.capture ? "utf8" : undefined,
    env: options.environment || process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || "").trim() : "";
    throw new Error(`${options.label || command} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function loadCommonJsConfig(source, filename) {
  const moduleContext = { exports: {} };
  vm.runInNewContext(source, { module: moduleContext, exports: moduleContext.exports }, { filename });
  return moduleContext.exports;
}

async function main() {
const mode = process.argv[2];
if (process.argv.length !== 3) {
  throw new Error("Usage: node scripts/release-miniprogram.mjs <preview|upload>");
}

const projectRoot = path.resolve();
const projectConfigPath = path.join(projectRoot, "project.config.json");
const miniProgramConfigPath = path.join(projectRoot, "apps/miniprogram/config.js");
const projectConfigSource = await readFile(projectConfigPath, "utf8");
const miniProgramConfigSource = await readFile(miniProgramConfigPath, "utf8");
const projectConfig = JSON.parse(projectConfigSource);
const miniProgramConfig = loadCommonJsConfig(miniProgramConfigSource, miniProgramConfigPath);
const plan = buildMiniProgramReleasePlan({
  mode,
  environment: process.env,
  projectConfig,
  miniProgramConfig,
  projectRoot
});

const privateKeyRealPath = await realpath(plan.privateKeyPath);
if (isPathInside(projectRoot, privateKeyRealPath)) {
  throw new Error("Mini Program upload key resolves inside the repository");
}
const privateKeyStats = await stat(privateKeyRealPath);
if (!privateKeyStats.isFile() || privateKeyStats.size < 100 || privateKeyStats.size > 64 * 1024) {
  throw new Error("Mini Program upload key is not a valid bounded file");
}
if (process.platform !== "win32" && (privateKeyStats.mode & 0o077) !== 0) {
  throw new Error("Mini Program upload key permissions must be owner-only (chmod 600)");
}

if (plan.qrcodeOutputPath) {
  try {
    await stat(plan.qrcodeOutputPath);
    throw new Error("MINIPROGRAM_QR_OUTPUT already exists; choose a new path to avoid overwriting it");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const qrcodeParentRealPath = await realpath(path.dirname(plan.qrcodeOutputPath));
  if (isPathInside(projectRoot, qrcodeParentRealPath)) {
    throw new Error("Preview QR code parent resolves inside the repository");
  }
  await access(qrcodeParentRealPath, constants.W_OK);
}

let launchManifest = null;
let launchManifestSource = null;
if (plan.launchManifestPath) {
  const launchManifestRealPath = await realpath(plan.launchManifestPath);
  if (!isPathInside(projectRoot, launchManifestRealPath)) {
    throw new Error("Launch readiness manifest resolves outside the repository");
  }
  launchManifestSource = await readFile(plan.launchManifestPath, "utf8");
  launchManifest = JSON.parse(launchManifestSource);
  if (launchManifest.schemaVersion !== 1 || typeof launchManifest.wechat !== "object") {
    throw new Error("Launch readiness manifest must use schemaVersion 1 and contain wechat state");
  }
  await access(path.dirname(plan.launchManifestPath), constants.W_OK);
}

const initialStatus = run("git", ["status", "--porcelain"], {
  capture: true,
  label: "Git status"
});
assertReleaseGitStatus(initialStatus);

console.log(JSON.stringify({
  status: "release_gate_started",
  action: plan.mode,
  version: plan.version,
  ciPackage: `miniprogram-ci@${MINIPROGRAM_CI_VERSION}`
}));
const npmRuntime = resolveNpmInvocation();
run(npmRuntime.command, [...npmRuntime.prefix, "run", "release:check"], {
  label: "Production release gate"
});
assertReleaseGitStatus(run("git", ["status", "--porcelain"], {
  capture: true,
  label: "Git status after release gate"
}));
const projectConfigSourceAfterGate = await readFile(projectConfigPath, "utf8");
const miniProgramConfigSourceAfterGate = await readFile(miniProgramConfigPath, "utf8");
if (sha256(projectConfigSourceAfterGate) !== sha256(projectConfigSource)
  || sha256(miniProgramConfigSourceAfterGate) !== sha256(miniProgramConfigSource)) {
  throw new Error("Production Mini Program configuration changed during the release gate");
}

const sourceCommit = run("git", ["rev-parse", "HEAD"], {
  capture: true,
  label: "Git commit lookup"
});
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new Error("Unable to resolve a full source commit");

const releaseStateDirectory = path.join(projectRoot, ".release-state", "miniprogram");
await mkdir(releaseStateDirectory, { recursive: true, mode: 0o700 });
await access(releaseStateDirectory, constants.W_OK);

const ciArgs = [
  "exec",
  "--yes",
  `--package=miniprogram-ci@${MINIPROGRAM_CI_VERSION}`,
  `--registry=${MINIPROGRAM_CI_REGISTRY}`,
  "--",
  "miniprogram-ci",
  plan.mode,
  `--appid=${plan.appid}`,
  `--project-path=${plan.projectRoot}`,
  `--private-key-path=${privateKeyRealPath}`,
  "--project-type=miniProgram",
  "--use-project-config",
  `--upload-description=${plan.description}`,
  `--robot=${plan.robot}`,
  "--locales=zh",
  "--verbose=false"
];
if (plan.mode === "upload") ciArgs.push(`--upload-version=${plan.version}`);
else ciArgs.push(
  "--enable-qrcode",
  "--qrcode-format=image",
  `--qrcode-output-dest=${plan.qrcodeOutputPath}`
);

run(npmRuntime.command, [...npmRuntime.prefix, ...ciArgs], {
  environment: sanitizeCiEnvironment(process.env),
  label: `WeChat Mini Program ${plan.mode}`
});

const completedAt = new Date().toISOString();
const receipt = {
  schemaVersion: 1,
  action: plan.mode,
  status: "SUCCEEDED",
  appid: plan.appid,
  version: plan.version,
  description: plan.description,
  sourceCommit,
  robot: plan.robot,
  completedAt,
  ciPackage: `miniprogram-ci@${MINIPROGRAM_CI_VERSION}`,
  projectConfigSha256: sha256(projectConfigSourceAfterGate),
  miniProgramConfigSha256: sha256(miniProgramConfigSourceAfterGate)
};
if (plan.qrcodeOutputPath) {
  receipt.qrcodeSha256 = sha256(await readFile(plan.qrcodeOutputPath));
}

const safeTimestamp = completedAt.replaceAll(":", "").replaceAll(".", "-");
const receiptPath = path.join(
  releaseStateDirectory,
  `${plan.mode}-${plan.version}-${sourceCommit.slice(0, 12)}-${safeTimestamp}.json`
);
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });

if (launchManifest) {
  const launchManifestSourceAfterUpload = await readFile(plan.launchManifestPath, "utf8");
  if (sha256(launchManifestSourceAfterUpload) !== sha256(launchManifestSource)) {
    throw new Error("Launch readiness manifest changed during the upload; successful receipt was preserved without overwriting it");
  }
  launchManifest.wechat.candidateUploaded = true;
  launchManifest.wechat.candidateUploadReceipt = receipt;
  const temporaryManifestPath = `${plan.launchManifestPath}.${process.pid}.tmp`;
  await writeFile(temporaryManifestPath, `${JSON.stringify(launchManifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryManifestPath, plan.launchManifestPath);
}

console.log(JSON.stringify({
  status: "SUCCEEDED",
  action: plan.mode,
  version: plan.version,
  sourceCommit,
  receipt: path.relative(projectRoot, receiptPath).replaceAll("\\", "/"),
  launchManifestUpdated: Boolean(launchManifest)
}));
}

await main().catch((error) => {
  console.error(`Mini Program release blocked: ${error?.message || "unknown error"}`);
  process.exitCode = 1;
});

import path from "node:path";

export const MINIPROGRAM_CI_VERSION = "2.1.31";
export const MINIPROGRAM_CI_REGISTRY = "https://registry.npmjs.org/";

const placeholderPattern = /(?:replace|example|your[-_. ]|change-?me|dummy|test-only|ci-only|上线前|待填写|todo)/i;
const allowedGeneratedFiles = new Set([
  "project.config.json",
  "apps/miniprogram/config.js"
]);

function required(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function exactHttpsOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.origin === value
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

export function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertReleaseGitStatus(statusOutput) {
  const lines = statusOutput.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const status = line.slice(0, 2);
    const filePath = line.slice(3).replaceAll("\\", "/");
    const generatedModification = allowedGeneratedFiles.has(filePath)
      && /^[ M][ M]$/.test(status)
      && status.includes("M");
    if (!generatedModification) {
      throw new Error(`Release tree contains an unapproved change: ${filePath || "unknown"}`);
    }
  }
  return lines.length;
}

export function sanitizeCiEnvironment(environment) {
  const allowed = new Set([
    "APPDATA",
    "CI",
    "COMSPEC",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LOCALAPPDATA",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE"
  ]);
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (allowed.has(key.toUpperCase()) && typeof value === "string") sanitized[key] = value;
  }
  sanitized.NO_UPDATE_NOTIFIER = "1";
  sanitized.npm_config_audit = "false";
  sanitized.npm_config_fund = "false";
  return sanitized;
}

export function resolveNpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath
} = {}) {
  if (typeof npmExecPath === "string"
    && path.isAbsolute(npmExecPath)
    && path.basename(npmExecPath).toLowerCase() === "npm-cli.js") {
    return { command: execPath, prefix: [npmExecPath] };
  }
  if (platform === "win32") {
    throw new Error("Run this command through npm so its cross-platform executable can be resolved");
  }
  return { command: "npm", prefix: [] };
}

export function buildMiniProgramReleasePlan({
  mode,
  environment = {},
  projectConfig = {},
  miniProgramConfig = {},
  projectRoot = process.cwd()
}) {
  if (!new Set(["preview", "upload"]).has(mode)) {
    throw new Error("Release mode must be preview or upload");
  }

  const appid = required(environment.MINIPROGRAM_APP_ID, "MINIPROGRAM_APP_ID");
  if (!/^wx[A-Za-z0-9]{6,}$/.test(appid) || appid === "touristappid") {
    throw new Error("MINIPROGRAM_APP_ID must be a real Mini Program AppID");
  }
  if (projectConfig.appid !== appid) {
    throw new Error("MINIPROGRAM_APP_ID must match project.config.json");
  }
  if (projectConfig.setting?.urlCheck !== true) {
    throw new Error("Mini Program URL-domain checks must be enabled");
  }
  if (!/^\d+\.\d+\.\d+$/.test(projectConfig.libVersion || "")) {
    throw new Error("Mini Program base-library version must be pinned");
  }
  if (!exactHttpsOrigin(miniProgramConfig.apiBaseUrl)) {
    throw new Error("Mini Program API origin must be an exact HTTPS origin");
  }
  for (const [name, value] of Object.entries({
    operatorName: miniProgramConfig.operatorName,
    privacyContact: miniProgramConfig.privacyContact
  })) {
    if (typeof value !== "string" || value.trim().length < 3 || placeholderPattern.test(value)) {
      throw new Error(`Mini Program ${name} must contain production information`);
    }
  }

  const privateKeyPath = required(
    environment.MINIPROGRAM_PRIVATE_KEY_PATH,
    "MINIPROGRAM_PRIVATE_KEY_PATH"
  );
  if (!path.isAbsolute(privateKeyPath)) {
    throw new Error("MINIPROGRAM_PRIVATE_KEY_PATH must be absolute");
  }
  if (isPathInside(projectRoot, privateKeyPath)) {
    throw new Error("Mini Program upload key must be stored outside the repository");
  }

  const version = required(environment.MINIPROGRAM_VERSION, "MINIPROGRAM_VERSION");
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) {
    throw new Error("MINIPROGRAM_VERSION contains unsupported characters");
  }
  const description = (environment.MINIPROGRAM_RELEASE_DESC || `侦探档案馆 ${version}`).trim();
  if (!description || description.length > 128 || /[\r\n\u0000-\u001f]/.test(description)) {
    throw new Error("MINIPROGRAM_RELEASE_DESC must be one line with at most 128 characters");
  }
  const robot = Number(environment.MINIPROGRAM_CI_ROBOT || "1");
  if (!Number.isInteger(robot) || robot < 1 || robot > 30) {
    throw new Error("MINIPROGRAM_CI_ROBOT must be an integer from 1 to 30");
  }

  let qrcodeOutputPath = null;
  if (mode === "preview") {
    qrcodeOutputPath = required(environment.MINIPROGRAM_QR_OUTPUT, "MINIPROGRAM_QR_OUTPUT");
    if (!path.isAbsolute(qrcodeOutputPath)) {
      throw new Error("MINIPROGRAM_QR_OUTPUT must be absolute");
    }
    if (isPathInside(projectRoot, qrcodeOutputPath)) {
      throw new Error("Preview QR code must be written outside the repository");
    }
  }

  let launchManifestPath = null;
  if (mode === "upload") {
    launchManifestPath = path.resolve(required(
      environment.LAUNCH_READINESS_FILE,
      "LAUNCH_READINESS_FILE"
    ));
    const expectedManifestPath = path.join(path.resolve(projectRoot), "ops", "launch-readiness.json");
    if (path.relative(expectedManifestPath, launchManifestPath) !== "") {
      throw new Error("Upload evidence may only update the repository's ops/launch-readiness.json");
    }
  }

  return Object.freeze({
    mode,
    appid,
    projectRoot: path.resolve(projectRoot),
    privateKeyPath: path.resolve(privateKeyPath),
    version,
    description,
    robot,
    qrcodeOutputPath: qrcodeOutputPath ? path.resolve(qrcodeOutputPath) : null,
    launchManifestPath
  });
}

export function validCandidateUploadReceipt(receipt, appid, sourceCommit = null) {
  if (!receipt
    || receipt.schemaVersion !== 1
    || receipt.action !== "upload"
    || receipt.status !== "SUCCEEDED"
    || receipt.ciPackage !== `miniprogram-ci@${MINIPROGRAM_CI_VERSION}`) return false;
  if (receipt.appid !== appid || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(receipt.version || "")) {
    return false;
  }
  if (!/^[0-9a-f]{40}$/i.test(receipt.sourceCommit || "")) return false;
  if (sourceCommit && receipt.sourceCommit !== sourceCommit) return false;
  if (!/^[0-9a-f]{64}$/i.test(receipt.projectConfigSha256 || "")
    || !/^[0-9a-f]{64}$/i.test(receipt.miniProgramConfigSha256 || "")) return false;
  if (!Number.isInteger(receipt.robot) || receipt.robot < 1 || receipt.robot > 30) return false;
  const completedAt = Date.parse(receipt.completedAt || "");
  return Number.isFinite(completedAt) && completedAt <= Date.now() + 5 * 60 * 1000;
}

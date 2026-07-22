import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { assertReleaseGitStatus } from "./lib/miniprogram-release.mjs";
import { recordWechatAcceptance } from "./lib/wechat-acceptance.mjs";

function parseOptions(args) {
  const options = {
    envFile: ".env.production",
    manifestPath: "ops/launch-readiness.json",
    recordPath: null
  };
  for (const argument of args) {
    if (argument.startsWith("--record=")) options.recordPath = argument.slice("--record=".length);
    else if (argument.startsWith("--env-file=")) {
      options.envFile = argument.slice("--env-file=".length);
    } else if (argument.startsWith("--manifest=")) {
      options.manifestPath = argument.slice("--manifest=".length);
    } else throw new Error(`Unknown WeChat acceptance option: ${argument}`);
  }
  return options;
}

function runGit(args, label) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result.stdout.trim();
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!options.recordPath) {
    throw new Error(
      "Usage: node scripts/record-wechat-acceptance.mjs --record=/absolute/path/wechat-acceptance.json"
    );
  }
  if (!path.isAbsolute(options.recordPath)) {
    throw new Error("--record must be an absolute path outside the repository");
  }
  const environment = {
    ...parseEnv(await readFile(path.resolve(options.envFile), "utf8")),
    ...process.env
  };
  assertReleaseGitStatus(runGit(["status", "--porcelain"], "Git status"));
  const sourceCommit = runGit(["rev-parse", "HEAD"], "Git commit lookup");
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error("Unable to resolve the current source commit");
  }

  const result = await recordWechatAcceptance({
    projectRoot: process.cwd(),
    manifestPath: path.resolve(options.manifestPath),
    recordPath: path.resolve(options.recordPath),
    environment,
    sourceCommit
  });
  console.log(JSON.stringify({
    status: "SUCCEEDED",
    action: "wechat_release_acceptance",
    sourceCommit,
    candidateVersion: result.receipt.candidateVersion,
    receipt: result.receiptPath,
    launchManifestUpdated: true
  }));
}

await main().catch((error) => {
  const detail = String(error?.message || "unknown error")
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .slice(0, 600);
  console.error(`WeChat acceptance blocked: ${detail}`);
  process.exitCode = 1;
});

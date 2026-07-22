import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { assertReleaseGitStatus } from "./lib/miniprogram-release.mjs";
import { recordWechatPublication } from "./lib/wechat-publication.mjs";

function parseOptions(args) {
  const options = {
    envFile: ".env.production",
    manifestPath: "ops/launch-readiness.json",
    recordPath: null
  };
  for (const argument of args) {
    if (argument.startsWith("--record=")) options.recordPath = argument.slice(9);
    else if (argument.startsWith("--env-file=")) options.envFile = argument.slice(11);
    else if (argument.startsWith("--manifest=")) options.manifestPath = argument.slice(11);
    else throw new Error(`Unknown WeChat publication option: ${argument}`);
  }
  return options;
}

function git(args, label) {
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
  if (!options.recordPath || !path.isAbsolute(options.recordPath)) {
    throw new Error("Usage: npm run wechat:publication:record -- --record=/absolute/path/event.json");
  }
  const environment = {
    ...parseEnv(await readFile(path.resolve(options.envFile), "utf8")),
    ...process.env
  };
  assertReleaseGitStatus(git(["status", "--porcelain"], "Git status"));
  const sourceCommit = git(["rev-parse", "HEAD"], "Git commit lookup");
  const result = await recordWechatPublication({
    projectRoot: process.cwd(),
    manifestPath: path.resolve(options.manifestPath),
    recordPath: options.recordPath,
    environment,
    sourceCommit
  });
  console.log(JSON.stringify({
    status: "SUCCEEDED",
    action: "wechat_publication_lifecycle",
    sourceCommit,
    stage: result.receipt.stage,
    unchanged: result.unchanged,
    receipt: result.receiptPath,
    launchManifestUpdated: !result.unchanged
  }));
}

await main().catch((error) => {
  const detail = String(error?.message || "unknown error")
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .slice(0, 600);
  console.error(`WeChat publication blocked: ${detail}`);
  process.exitCode = 1;
});

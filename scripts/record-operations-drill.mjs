import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  assertOperationsDrillGitStatus,
  recordOperationsDrill
} from "./lib/operations-drill.mjs";

const options = {
  manifestPath: "ops/launch-readiness.json",
  recordPath: null
};

for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--record=")) options.recordPath = argument.slice("--record=".length);
  else if (argument.startsWith("--manifest=")) {
    options.manifestPath = argument.slice("--manifest=".length);
  } else {
    throw new Error(`Unknown operations drill option: ${argument}`);
  }
}

if (!options.recordPath) {
  throw new Error(
    "Usage: node scripts/record-operations-drill.mjs --record=/absolute/path/operations-drill.json"
  );
}
if (!path.isAbsolute(options.recordPath)) {
  throw new Error("--record must be an absolute path outside the repository");
}

const statusResult = spawnSync("git", ["status", "--porcelain"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});
if (statusResult.error) throw statusResult.error;
if (statusResult.status !== 0) throw new Error("Unable to read the current Git status");
assertOperationsDrillGitStatus(statusResult.stdout);

const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});
if (commitResult.error) throw commitResult.error;
const sourceCommit = commitResult.stdout.trim();
if (commitResult.status !== 0 || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
  throw new Error("Unable to resolve the current source commit");
}

const result = await recordOperationsDrill({
  projectRoot: process.cwd(),
  manifestPath: path.resolve(options.manifestPath),
  recordPath: path.resolve(options.recordPath),
  sourceCommit
});

console.log(JSON.stringify({
  status: "SUCCEEDED",
  action: "operations_drill",
  sourceCommit,
  receipt: result.receiptPath,
  launchManifestUpdated: true
}));

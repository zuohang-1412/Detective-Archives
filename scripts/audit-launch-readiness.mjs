import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { auditLaunchReadiness, PHASES, summarizeLaunchReadiness } from "./lib/launch-readiness.mjs";

const options = {
  envFile: null,
  manifest: "ops/launch-readiness.json",
  phase: "RELEASE",
  json: false,
  reportOnly: false
};

for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--env-file=")) options.envFile = argument.slice("--env-file=".length);
  else if (argument.startsWith("--manifest=")) options.manifest = argument.slice("--manifest=".length);
  else if (argument.startsWith("--phase=")) options.phase = argument.slice("--phase=".length).toUpperCase();
  else if (argument === "--json") options.json = true;
  else if (argument === "--report-only") options.reportOnly = true;
  else throw new Error(`Unknown launch audit option: ${argument}`);
}

if (!PHASES.includes(options.phase)) {
  throw new Error(`--phase must be one of ${PHASES.join(", ")}`);
}

let environment = { ...process.env };
if (options.envFile) {
  const source = await readFile(path.resolve(options.envFile), "utf8");
  environment = { ...environment, ...parseEnv(source) };
}

let manifest;
try {
  manifest = JSON.parse(await readFile(path.resolve(options.manifest), "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(
      `Launch manifest not found: ${options.manifest}. Copy ops/launch-readiness.example.json and fill only verified facts.`
    );
  }
  throw error;
}
if (manifest.schemaVersion !== 1) throw new Error("Launch manifest schemaVersion must be 1");

const report = summarizeLaunchReadiness(
  auditLaunchReadiness({ environment, manifest }),
  options.phase
);

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Launch readiness: ${report.status} (${report.ready}/${report.total}, target ${report.targetPhase}, ready through ${report.readyThrough ?? "NONE"})`
  );
  for (const blocker of report.blockers) {
    console.log(`[${blocker.phase}] ${blocker.id} · ${blocker.owner} · ${blocker.detail}`);
  }
}

if (!options.reportOnly && report.status !== "READY") process.exitCode = 1;

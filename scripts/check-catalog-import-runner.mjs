import assert from "node:assert/strict";
import { runCatalogImports } from "./lib/catalog-import-runner.mjs";

const batches = [
  {
    filename: "catalog-expansion-one.json",
    filePath: "C:/catalog/catalog-expansion-one.json",
    input: { rollbackOf: null }
  },
  {
    filename: "catalog-expansion-two.json",
    filePath: "C:/catalog/catalog-expansion-two.json",
    input: { rollbackOf: "catalog-expansion-one" }
  }
];

const calls = [];
const sleeps = [];
const output = [];
let firstBatchAttempts = 0;
await runCatalogImports({
  batches,
  importer: "C:/catalog/importer.mjs",
  apply: true,
  retryDelayMs: 100,
  runner(command, argumentsList) {
    calls.push({ command, argumentsList });
    if (argumentsList[1].includes("one") && firstBatchAttempts++ === 0) {
      return { status: 1, stdout: "", stderr: "Error: read ECONNRESET" };
    }
    return { status: 0, stdout: "batch ok\n", stderr: "" };
  },
  sleep: async (milliseconds) => sleeps.push(milliseconds),
  stdout: (value) => output.push(value),
  stderr: (value) => output.push(value)
});
assert.equal(calls.length, 3);
assert.deepEqual(sleeps, [100]);
assert.equal(calls[1].argumentsList.includes("--apply"), true);
assert.equal(calls[2].argumentsList.includes("--rollback"), true);
assert.match(output.join(""), /transient database failure/);

let deterministicAttempts = 0;
await assert.rejects(runCatalogImports({
  batches: [batches[0]],
  importer: "C:/catalog/importer.mjs",
  runner() {
    deterministicAttempts += 1;
    return { status: 1, stdout: "", stderr: "duplicate key violates unique constraint" };
  },
  sleep: async () => assert.fail("deterministic failures must not sleep or retry"),
  stdout: () => {},
  stderr: () => {}
}), /Catalog import failed/);
assert.equal(deterministicAttempts, 1);

let transientAttempts = 0;
await assert.rejects(runCatalogImports({
  batches: [batches[0]],
  importer: "C:/catalog/importer.mjs",
  maxTransientRetries: 2,
  retryDelayMs: 0,
  runner() {
    transientAttempts += 1;
    return { status: 1, stdout: "", stderr: "SQLSTATE 08006" };
  },
  sleep: async () => {},
  stdout: () => {},
  stderr: () => {}
}), /Catalog import failed/);
assert.equal(transientAttempts, 3);

await assert.rejects(runCatalogImports({
  batches,
  importer: "C:/catalog/importer.mjs",
  maxTransientRetries: 6
}), /between 0 and 5/);

console.log("Catalog import retry runner: OK (transient retry, rollback args and fail-fast errors)");

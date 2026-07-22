import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const transientDatabaseErrorPattern = /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|connection terminated unexpectedly|server closed the connection unexpectedly|SQLSTATE\s+(?:08001|08003|08006|57P01))/i;

function boundedText(value, maximumLength = 2 * 1024 * 1024) {
  return typeof value === "string" ? value.slice(0, maximumLength) : "";
}

function resultText(result) {
  return `${boundedText(result?.stdout)}\n${boundedText(result?.stderr)}\n${result?.error?.message || ""}`;
}

export function isTransientCatalogImportFailure(result) {
  return transientDatabaseErrorPattern.test(resultText(result));
}

export async function runCatalogImports({
  batches,
  importer,
  apply = false,
  cwd = process.cwd(),
  environment = process.env,
  maxTransientRetries = 2,
  retryDelayMs = 250,
  runner = spawnSync,
  sleep = delay,
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value)
}) {
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new Error("Catalog import runner requires at least one batch");
  }
  if (!Number.isInteger(maxTransientRetries)
    || maxTransientRetries < 0
    || maxTransientRetries > 5) {
    throw new Error("Catalog transient retries must be between 0 and 5");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error("Catalog retry delay must be between 0 and 30000 milliseconds");
  }

  for (const batch of batches) {
    const argumentsList = [importer, `--file=${batch.filePath}`];
    if (batch.input.rollbackOf) argumentsList.push("--rollback");
    if (apply) argumentsList.push("--apply");

    for (let attempt = 0; ; attempt += 1) {
      const result = runner(process.execPath, argumentsList, {
        cwd,
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      });
      if (result.status === 0 && !result.error) {
        if (result.stdout) stdout(result.stdout);
        if (result.stderr) stderr(result.stderr);
        break;
      }
      const transient = isTransientCatalogImportFailure(result);
      if (!transient || attempt >= maxTransientRetries) {
        if (result.stdout) stdout(boundedText(result.stdout));
        if (result.stderr) stderr(boundedText(result.stderr));
        if (result.error) throw result.error;
        throw new Error(
          `Catalog import failed for ${batch.filename} with exit code ${result.status}`
        );
      }
      const waitMs = retryDelayMs * (attempt + 1);
      stderr(
        `Catalog import ${batch.filename}: transient database failure; `
        + `retry ${attempt + 1}/${maxTransientRetries} after ${waitMs}ms\n`
      );
      await sleep(waitMs);
    }
  }
}

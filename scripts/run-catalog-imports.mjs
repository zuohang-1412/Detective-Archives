import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadCatalogBatches } from "./lib/catalog-batches.mjs";

const apply = process.argv.includes("--apply");
const { batches } = await loadCatalogBatches();
const importer = path.resolve("scripts/catalog-import.mjs");

for (const batch of batches) {
  const argumentsList = [importer, `--file=${batch.filePath}`];
  if (batch.input.rollbackOf) argumentsList.push("--rollback");
  if (apply) argumentsList.push("--apply");
  const result = spawnSync(process.execPath, argumentsList, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Catalog import failed for ${batch.filename} with exit code ${result.status}`);
  }
}

console.log(`Catalog imports: ${apply ? "applied" : "preflight passed"} (${batches.length} batches)`);

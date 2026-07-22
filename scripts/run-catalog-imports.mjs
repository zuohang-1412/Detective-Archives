import path from "node:path";
import { loadCatalogBatches } from "./lib/catalog-batches.mjs";
import { runCatalogImports } from "./lib/catalog-import-runner.mjs";

const apply = process.argv.includes("--apply");
const retriesArgument = process.argv.find((argument) => argument.startsWith("--transient-retries="));
const maxTransientRetries = retriesArgument
  ? Number.parseInt(retriesArgument.slice("--transient-retries=".length), 10)
  : 2;
const { batches } = await loadCatalogBatches();
const importer = path.resolve("scripts/catalog-import.mjs");

await runCatalogImports({ batches, importer, apply, maxTransientRetries });

console.log(`Catalog imports: ${apply ? "applied" : "preflight passed"} (${batches.length} batches)`);

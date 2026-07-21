import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

if (process.env.CATALOG_ROLLBACK_TEST !== "true") {
  throw new Error("Refusing to create rollback fixtures without CATALOG_ROLLBACK_TEST=true");
}

const { Client } = pg;
const importer = path.resolve("scripts/catalog-import.mjs");
const forward = path.resolve("scripts/fixtures/catalog-rollback-forward.json");
const compensation = path.resolve("scripts/fixtures/catalog-rollback-compensation.json");

function run(file, rollback = false) {
  const args = [importer, `--file=${file}`, ...(rollback ? ["--rollback"] : []), "--apply"];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Catalog rollback fixture failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

run(forward);
run(compensation, true);
run(forward);
run(compensation, true);

const client = new Client(postgresConfig(targetDatabaseName()));
await client.connect();
try {
  const batches = await client.query(`
    SELECT batch_key AS "batchKey", status, change_summary AS "changeSummary"
    FROM catalog_import_batches
    WHERE batch_key IN ('catalog-rollback-test-forward', 'catalog-rollback-test-compensation')
    ORDER BY batch_key
  `);
  assert.equal(batches.rows.length, 2);
  const byKey = new Map(batches.rows.map((row) => [row.batchKey, row]));
  assert.equal(byKey.get("catalog-rollback-test-forward")?.status, "ROLLED_BACK");
  assert.equal(
    byKey.get("catalog-rollback-test-forward")?.changeSummary?.rolledBackBy,
    "catalog-rollback-test-compensation"
  );
  assert.equal(byKey.get("catalog-rollback-test-compensation")?.status, "APPLIED");
  assert.equal(
    byKey.get("catalog-rollback-test-compensation")?.changeSummary?.rollbackOf,
    "catalog-rollback-test-forward"
  );

  const content = await client.query(`
    SELECT
      detective.status::text AS "detectiveStatus",
      work.status::text AS "workStatus",
      BOOL_OR(link.is_active) AS "hasActiveLink"
    FROM detectives detective
    JOIN detective_works relation ON relation.detective_id = detective.id
    JOIN works work ON work.id = relation.work_id
    JOIN work_links link ON link.work_id = work.id
    WHERE detective.slug = 'catalog-rollback-test-detective'
      AND work.slug = 'catalog-rollback-test-work'
    GROUP BY detective.status, work.status
  `);
  assert.equal(content.rows[0]?.detectiveStatus, "ARCHIVED");
  assert.equal(content.rows[0]?.workStatus, "ARCHIVED");
  assert.equal(content.rows[0]?.hasActiveLink, false);
  const recommendation = await client.query(`
    SELECT work_id AS "workId"
    FROM picture_book_recommendations
    WHERE entry_id = 'PB-001-STD' AND source_label = '恐怖谷'
  `);
  assert.equal(recommendation.rows[0]?.workId, null);
} finally {
  await client.end();
}

console.log("Catalog rollback compensation: OK (latest-only, archived content, unmapped recommendation, inactive links, immutable audit)");

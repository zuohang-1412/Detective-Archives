import { readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

const { Client } = pg;
const client = new Client(postgresConfig(targetDatabaseName()));
const failures = [];
const migrationFiles = (await readdir(path.resolve("database/migrations")))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file));
const expectedMigrationCount = 1 + migrationFiles.length;

function expect(actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, received ${actual}`);
  }
}

try {
  await client.connect();
  const migrationCount = await client.query("SELECT COUNT(*)::int AS count FROM schema_migrations");
  const detectiveCounts = await client.query(`
    SELECT catalog_collection::text AS collection, COUNT(*)::int AS count
    FROM detectives
    GROUP BY catalog_collection
  `);
  const pictureBookCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM picture_book_entries"
  );
  const recommendationCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM picture_book_recommendations"
  );
  const sourceCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM detective_sources"
  );
  const workCount = await client.query("SELECT COUNT(*)::int AS count FROM works");
  const workLinkCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM work_links WHERE is_active = TRUE"
  );
  const detailedWorkCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM works WHERE status = 'PUBLISHED' AND summary IS NOT NULL"
  );
  const categorizedDirectoryCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM detectives
    WHERE catalog_collection IN ('ARCHIVE_EXTENSION', 'HISTORICAL_CASES')
      AND catalog_category IS NOT NULL
  `);
  const orphanCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM detective_sources source
    LEFT JOIN detectives detective ON detective.id = source.detective_id
    WHERE detective.id IS NULL
  `);

  const counts = new Map(
    detectiveCounts.rows.map((row) => [row.collection, row.count])
  );
  expect(migrationCount.rows[0].count, expectedMigrationCount, "migration count");
  expect(counts.get("CORE") ?? 0, 3, "core detective count");
  expect(counts.get("ARCHIVE_EXTENSION") ?? 0, 20, "archive extension count");
  expect(counts.get("HISTORICAL_CASES") ?? 0, 3, "historical subject count");
  expect(pictureBookCount.rows[0].count, 109, "picture-book entry count");
  expect(recommendationCount.rows[0].count, 73, "picture-book recommendation count");
  expect(sourceCount.rows[0].count, 23, "directory source relation count");
  expect(workCount.rows[0].count, 5, "core work count");
  expect(workLinkCount.rows[0].count, 6, "active official work link count");
  expect(detailedWorkCount.rows[0].count, 5, "detailed published work count");
  expect(categorizedDirectoryCount.rows[0].count, 23, "categorized directory count");
  expect(orphanCount.rows[0].count, 0, "orphan source count");

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }

  console.log("Database integrity: OK (26 detectives, 5 works, 109 picture-book entries)");
} finally {
  await client.end();
}

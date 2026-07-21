import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  catalogSlugify,
  loadCatalogBatches,
  uniqueImportedWorks
} from "./lib/catalog-batches.mjs";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

const { Client } = pg;
const client = new Client(postgresConfig(targetDatabaseName()));
const failures = [];
const migrationFiles = (await readdir(path.resolve("database/migrations")))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file));
const expectedMigrationCount = 1 + migrationFiles.length;
const coreDetectives = JSON.parse(await readFile(
  path.resolve("apps/api/src/data/core-detectives.json"), "utf8"
));
const coreWorkDetails = JSON.parse(await readFile(
  path.resolve("apps/api/src/data/core-work-details.json"), "utf8"
));
const archiveDirectory = JSON.parse(await readFile(
  path.resolve("apps/api/src/data/archive-directory-index.json"), "utf8"
));
const pictureBookCatalog = JSON.parse(await readFile(
  path.resolve("apps/api/src/data/picture-book-index.json"), "utf8"
));
const { batches } = await loadCatalogBatches();
const importedWorks = uniqueImportedWorks(batches);
const expectedWorkCount = new Set([
  ...coreWorkDetails.map((work) => work.slug),
  ...importedWorks.keys()
]).size;
const expectedActiveLinkCount = coreWorkDetails.reduce(
  (count, work) => count + work.links.length,
  importedWorks.size
);
const detectiveCollections = new Map([
  ...coreDetectives.map((detective) => [detective.slug, "CORE"]),
  ...archiveDirectory.entries.map((detective) => [catalogSlugify(detective.names.en), detective.collection])
]);
const detectiveSourceCounts = new Map([
  ...coreDetectives.map((detective) => [detective.slug, 0]),
  ...archiveDirectory.entries.map((detective) => [catalogSlugify(detective.names.en), detective.sourceIds.length])
]);
for (const { input } of batches) {
  for (const detective of input.detectives) {
    detectiveCollections.set(detective.slug, detective.collection);
    detectiveSourceCounts.set(detective.slug, detective.sourceIds.length);
  }
}
const expectedDetectiveCounts = new Map();
for (const collection of detectiveCollections.values()) {
  expectedDetectiveCounts.set(collection, (expectedDetectiveCounts.get(collection) ?? 0) + 1);
}
const expectedDetectiveCount = detectiveCollections.size;
const expectedSourceCount = [...detectiveSourceCounts.values()].reduce((sum, count) => sum + count, 0);
const expectedDirectoryCount = archiveDirectory.entries.length;
const expectedPictureBookLinkCount = new Set([
  ...pictureBookCatalog.entries
    .filter((entry) => entry.detectiveSlug)
    .map((entry) => entry.id),
  ...batches.flatMap(({ input }) => input.detectives)
    .flatMap((detective) => detective.pictureBookEntryIds ?? [])
]).size;

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
  const linkedPictureBookCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM picture_book_entries WHERE detective_id IS NOT NULL"
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
  const appliedImportBatchCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM catalog_import_batches WHERE status = 'APPLIED'"
  );

  const counts = new Map(
    detectiveCounts.rows.map((row) => [row.collection, row.count])
  );
  expect(migrationCount.rows[0].count, expectedMigrationCount, "migration count");
  for (const [collection, count] of expectedDetectiveCounts) {
    expect(counts.get(collection) ?? 0, count, `${collection} detective count`);
  }
  expect(pictureBookCount.rows[0].count, pictureBookCatalog.coverage.entryCount, "picture-book entry count");
  expect(linkedPictureBookCount.rows[0].count, expectedPictureBookLinkCount, "linked picture-book entry count");
  expect(recommendationCount.rows[0].count, pictureBookCatalog.coverage.entriesWithRecommendedWorks, "picture-book recommendation count");
  expect(sourceCount.rows[0].count, expectedSourceCount, "directory source relation count");
  expect(workCount.rows[0].count, expectedWorkCount, "published work count");
  expect(workLinkCount.rows[0].count, expectedActiveLinkCount, "active official work link count");
  expect(detailedWorkCount.rows[0].count, expectedWorkCount, "detailed published work count");
  expect(categorizedDirectoryCount.rows[0].count, expectedDirectoryCount, "categorized directory count");
  expect(orphanCount.rows[0].count, 0, "orphan source count");
  expect(appliedImportBatchCount.rows[0].count, batches.length, "applied catalog import batch count");

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }

  console.log(`Database integrity: OK (${expectedDetectiveCount} detectives, ${expectedWorkCount} works, ${pictureBookCatalog.coverage.entryCount} picture-book entries)`);
} finally {
  await client.end();
}

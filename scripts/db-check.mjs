import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  catalogSlugify,
  linkedPictureBookRecommendations,
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
const expectedRecommendationMappings = linkedPictureBookRecommendations(batches);
const allImportedWorks = new Map(
  batches.flatMap(({ input }) => input.detectives)
    .flatMap((detective) => detective.works)
    .map((work) => [work.slug, work])
);
const expectedWorkCount = new Set([
  ...coreWorkDetails.map((work) => work.slug),
  ...allImportedWorks.keys()
]).size;
const expectedPublishedWorkCount = new Set([
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
const pictureBookAssignments = new Map(
  pictureBookCatalog.entries
    .filter((entry) => entry.detectiveSlug)
    .map((entry) => [entry.id, entry.detectiveSlug])
);
for (const { input } of batches) {
  for (const detective of input.detectives) {
    for (const entryId of detective.pictureBookEntryIds ?? []) {
      pictureBookAssignments.set(entryId, detective.slug);
    }
  }
  const archived = new Set(input.archiveDetectiveSlugs ?? []);
  for (const [entryId, detectiveSlug] of pictureBookAssignments) {
    if (archived.has(detectiveSlug)) pictureBookAssignments.delete(entryId);
  }
}
const expectedPictureBookLinkCount = pictureBookAssignments.size;
const expectedBatchStatuses = new Map(batches.map(({ input }) => [input.batchKey, "APPLIED"]));
for (const { input } of batches) {
  if (input.rollbackOf) expectedBatchStatuses.set(input.rollbackOf, "ROLLED_BACK");
}

function expect(actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, received ${actual}`);
  }
}

try {
  await client.connect();
  const migrationCount = await client.query("SELECT COUNT(*)::int AS count FROM schema_migrations");
  const analyticsSchema = await client.query(`
    SELECT
      to_regclass('public.catalog_view_events') IS NOT NULL AS catalog_views,
      to_regclass('public.user_activity_days') IS NOT NULL AS activity_days,
      to_regclass('public.content_appeals') IS NOT NULL AS content_appeals,
      to_regclass('public.shelf_engagement_facts') IS NOT NULL AS shelf_engagement,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'work_link_click_events'
          AND column_name = 'visitor_hash'
      ) AS click_visitor_hash
  `);
  const linkReviewSchema = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE column_name IN (
        'manual_review_status',
        'manual_review_note',
        'manual_review_evidence',
        'manual_reviewed_at',
        'manual_reviewer_id'
      ))::int AS column_count,
      to_regclass('public.idx_work_links_manual_review_queue') IS NOT NULL AS queue_index
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_links'
  `);
  const moderationSpoilerActions = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM pg_enum enum_value
    JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'moderation_action'
      AND enum_value.enumlabel IN ('MARK_SPOILER', 'UNMARK_SPOILER')
  `);
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
  const mappedRecommendationCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM picture_book_recommendations
    WHERE work_id IS NOT NULL
  `);
  const verifiedCoreSeedCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM detectives detective
    WHERE detective.catalog_id = ANY($1)
      AND detective.verification = 'PRIMARY_SOURCE_CONFIRMED'
      AND EXISTS (
        SELECT 1 FROM detective_sources source
        WHERE source.detective_id = detective.id
      )
      AND EXISTS (
        SELECT 1 FROM detective_featured_works featured
        WHERE featured.detective_id = detective.id
      )
  `, [["PB-001-STD", "PB-002-STD", "PB-003-STD"]]);
  const sourceCapturedDetectiveCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM detectives
    WHERE status = 'PUBLISHED' AND verification = 'SOURCE_CAPTURED'
  `);
  const invalidMappedRecommendationCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM picture_book_recommendations recommendation
    JOIN works work ON work.id = recommendation.work_id
    WHERE work.status <> 'PUBLISHED'
      OR NOT EXISTS (
        SELECT 1 FROM work_links link
        WHERE link.work_id = work.id AND link.is_active = TRUE
      )
  `);
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
  const importBatchStatuses = await client.query(`
    SELECT batch_key AS "batchKey", status
    FROM catalog_import_batches
    WHERE batch_key = ANY($1)
  `, [[...expectedBatchStatuses.keys()]]);

  const counts = new Map(
    detectiveCounts.rows.map((row) => [row.collection, row.count])
  );
  expect(migrationCount.rows[0].count, expectedMigrationCount, "migration count");
  expect(analyticsSchema.rows[0].catalog_views, true, "catalog analytics table");
  expect(analyticsSchema.rows[0].activity_days, true, "daily activity table");
  expect(analyticsSchema.rows[0].content_appeals, true, "content appeals table");
  expect(analyticsSchema.rows[0].shelf_engagement, true, "shelf engagement facts table");
  expect(analyticsSchema.rows[0].click_visitor_hash, true, "link click visitor hash column");
  expect(linkReviewSchema.rows[0].column_count, 5, "work link manual review column count");
  expect(linkReviewSchema.rows[0].queue_index, true, "work link manual review queue index");
  expect(moderationSpoilerActions.rows[0].count, 2, "moderator spoiler action count");
  for (const [collection, count] of expectedDetectiveCounts) {
    expect(counts.get(collection) ?? 0, count, `${collection} detective count`);
  }
  expect(pictureBookCount.rows[0].count, pictureBookCatalog.coverage.entryCount, "picture-book entry count");
  expect(linkedPictureBookCount.rows[0].count, expectedPictureBookLinkCount, "linked picture-book entry count");
  expect(recommendationCount.rows[0].count, pictureBookCatalog.coverage.entriesWithRecommendedWorks, "picture-book recommendation count");
  expect(
    mappedRecommendationCount.rows[0].count,
    expectedRecommendationMappings.size,
    "mapped picture-book recommendation count"
  );
  expect(invalidMappedRecommendationCount.rows[0].count, 0, "unavailable mapped recommendation count");
  expect(verifiedCoreSeedCount.rows[0].count, 3, "verified volumes 1 to 3 detective count");
  expect(sourceCapturedDetectiveCount.rows[0].count, 0, "published source-captured detective count");
  expect(sourceCount.rows[0].count, expectedSourceCount, "directory source relation count");
  expect(workCount.rows[0].count, expectedWorkCount, "published work count");
  expect(workLinkCount.rows[0].count, expectedActiveLinkCount, "active official work link count");
  expect(detailedWorkCount.rows[0].count, expectedPublishedWorkCount, "detailed published work count");
  expect(categorizedDirectoryCount.rows[0].count, expectedDirectoryCount, "categorized directory count");
  expect(orphanCount.rows[0].count, 0, "orphan source count");
  const actualBatchStatuses = new Map(
    importBatchStatuses.rows.map((row) => [row.batchKey, row.status])
  );
  expect(actualBatchStatuses.size, expectedBatchStatuses.size, "catalog import batch count");
  for (const [batchKey, status] of expectedBatchStatuses) {
    expect(actualBatchStatuses.get(batchKey), status, `catalog import batch ${batchKey} status`);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }

  console.log(`Database integrity: OK (${expectedDetectiveCount} detectives, ${expectedWorkCount} works, ${pictureBookCatalog.coverage.entryCount} picture-book entries, ${expectedRecommendationMappings.size} linked recommendations)`);
} finally {
  await client.end();
}

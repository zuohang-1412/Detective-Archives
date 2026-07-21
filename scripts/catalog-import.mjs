import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { z } from "zod";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

const { Client } = pg;
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const verificationSchema = z.enum([
  "MISSING", "SOURCE_CAPTURED", "PRIMARY_SOURCE_CONFIRMED"
]);
const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  label: z.string().min(1).max(200),
  url: z.url().refine((url) => url.startsWith("https://"), "source URL must use HTTPS"),
  quality: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/)
});
const workSchema = z.object({
  slug: slugSchema.max(120),
  titleZh: z.string().min(1).max(200),
  titleOriginal: z.string().max(240).optional(),
  mediaType: z.enum([
    "NOVEL", "SHORT_STORY", "COMIC", "FILM", "SERIES", "ANIMATION", "GAME", "OTHER"
  ]),
  releaseYear: z.number().int().min(1000).max(2200).optional(),
  summary: z.string().min(10).max(5000),
  creatorName: z.string().min(1).max(120).optional(),
  sourceId: z.string().min(1).max(100),
  linkType: z.enum([
    "PUBLISHER", "BOOKSTORE", "LIBRARY", "STREAMING", "OFFICIAL_SITE", "OTHER"
  ]),
  providerName: z.string().min(1).max(100),
  region: z.string().min(1).max(30).default("GLOBAL"),
  deactivateLinkUrls: z.array(
    z.url().refine((url) => url.startsWith("https://"), "replacement URL must use HTTPS")
  ).max(20).default([])
});
const detectiveSchema = z.object({
  catalogId: z.string().min(1).max(20),
  pictureBookEntryIds: z.array(z.string().min(1).max(20)).max(20).default([]),
  slug: slugSchema.max(100),
  nameZh: z.string().min(1).max(120),
  nameOriginal: z.string().max(160).optional(),
  nameEn: z.string().max(160).optional(),
  country: z.string().max(60).optional(),
  era: z.string().max(80).optional(),
  subjectKind: z.enum(["FICTIONAL", "HISTORICAL"]).default("FICTIONAL"),
  collection: z.enum(["CORE", "ARCHIVE_EXTENSION", "HISTORICAL_CASES"]),
  category: z.enum([
    "WORLD_LITERATURE", "SCREEN_DETECTIVES", "JAPANESE_POPULAR",
    "CHINESE_LITERATURE", "HISTORICAL_JUSTICE"
  ]),
  mediaTypes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/)).max(12),
  summary: z.string().min(10).max(5000),
  creatorName: z.string().min(1).max(120).optional(),
  aliases: z.array(z.string().min(1).max(160)).max(30).default([]),
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  featuredCases: z.array(z.string().min(1).max(240)).max(50).default([]),
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(20),
  verification: verificationSchema,
  status: z.enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED"]).default("DRAFT"),
  works: z.array(workSchema).max(30).default([])
});
const importSchema = z.object({
  schemaVersion: z.literal(1),
  batchKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  snapshotDate: z.iso.date(),
  contentPolicy: z.string().min(10).max(1000),
  sources: z.array(sourceSchema).min(1).max(500),
  detectives: z.array(detectiveSchema).min(1).max(500)
});

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

const fileArgument = process.argv.find((argument) => argument.startsWith("--file="));
const sourceFile = path.resolve(fileArgument
  ? fileArgument.slice("--file=".length)
  : "apps/api/src/data/catalog-expansion.json");
const apply = process.argv.includes("--apply");
const raw = await readFile(sourceFile, "utf8");
const input = importSchema.parse(JSON.parse(raw));
const checksum = createHash("sha256").update(raw).digest("hex");
const sourcesById = new Map(input.sources.map((source) => [source.id, source]));

const errors = [];
const warnings = [];
for (const value of duplicates(input.sources.map((source) => source.id))) {
  errors.push(`duplicate source id: ${value}`);
}
for (const value of duplicates(input.detectives.map((detective) => detective.slug))) {
  errors.push(`duplicate detective slug: ${value}`);
}
for (const value of duplicates(input.detectives.map((detective) => detective.catalogId))) {
  errors.push(`duplicate detective catalog id: ${value}`);
}
const allWorks = input.detectives.flatMap((detective) => detective.works);
for (const value of duplicates(allWorks.map((work) => work.slug))) {
  const versions = allWorks.filter((work) => work.slug === value);
  if (new Set(versions.map((work) => JSON.stringify(work))).size > 1) {
    errors.push(`conflicting duplicate work slug: ${value}`);
  }
}
for (const detective of input.detectives) {
  for (const sourceId of detective.sourceIds) {
    if (!sourcesById.has(sourceId)) errors.push(`${detective.slug}: unknown source ${sourceId}`);
  }
  for (const work of detective.works) {
    if (!sourcesById.has(work.sourceId)) errors.push(`${work.slug}: unknown source ${work.sourceId}`);
  }
}

const client = new Client(postgresConfig(targetDatabaseName()));
await client.connect();
let lockHeld = false;
try {
  const slugs = input.detectives.map((detective) => detective.slug);
  const catalogIds = input.detectives.map((detective) => detective.catalogId);
  const existingDetectives = await client.query(`
    SELECT id, slug, catalog_id AS "catalogId", name_zh AS "nameZh"
    FROM detectives
    WHERE slug = ANY($1) OR catalog_id = ANY($2)
  `, [slugs, catalogIds]);
  const bySlug = new Map(existingDetectives.rows.map((row) => [row.slug, row]));
  const byCatalogId = new Map(existingDetectives.rows
    .filter((row) => row.catalogId)
    .map((row) => [row.catalogId, row]));
  for (const detective of input.detectives) {
    const slugMatch = bySlug.get(detective.slug);
    const catalogMatch = byCatalogId.get(detective.catalogId);
    if (slugMatch && catalogMatch && slugMatch.id !== catalogMatch.id) {
      errors.push(`${detective.slug}: slug and catalog id resolve to different detectives`);
    } else if (catalogMatch && catalogMatch.slug !== detective.slug) {
      errors.push(`${detective.catalogId}: catalog id already belongs to ${catalogMatch.slug}`);
    } else if (slugMatch && slugMatch.catalogId && slugMatch.catalogId !== detective.catalogId) {
      errors.push(`${detective.slug}: slug already uses catalog id ${slugMatch.catalogId}`);
    } else if (slugMatch && slugMatch.nameZh !== detective.nameZh) {
      warnings.push(`${detective.slug}: published name will change from ${slugMatch.nameZh} to ${detective.nameZh}`);
    }
  }

  const workSlugs = [...new Set(allWorks.map((work) => work.slug))];
  const existingWorks = workSlugs.length
    ? await client.query(`
      SELECT id, slug, title_zh AS "titleZh" FROM works WHERE slug = ANY($1)
    `, [workSlugs])
    : { rows: [] };
  const existingWorksBySlug = new Map(existingWorks.rows.map((row) => [row.slug, row]));
  for (const work of allWorks) {
    const existing = existingWorksBySlug.get(work.slug);
    if (existing && existing.titleZh !== work.titleZh) {
      warnings.push(`${work.slug}: work title will change from ${existing.titleZh} to ${work.titleZh}`);
    }
  }

  const linkDeactivationRequests = allWorks.flatMap((work) =>
    work.deactivateLinkUrls.map((url) => ({ workSlug: work.slug, url }))
  );
  if (linkDeactivationRequests.length) {
    const existingRequestedLinks = await client.query(`
      SELECT work.slug AS "workSlug", link.url
      FROM work_links link
      JOIN works work ON work.id = link.work_id
      WHERE (work.slug, link.url) IN (
        SELECT * FROM UNNEST($1::text[], $2::text[])
      )
    `, [
      linkDeactivationRequests.map((request) => request.workSlug),
      linkDeactivationRequests.map((request) => request.url)
    ]);
    const foundRequestedLinks = new Set(
      existingRequestedLinks.rows.map((row) => `${row.workSlug}\u0000${row.url}`)
    );
    for (const request of linkDeactivationRequests) {
      if (!foundRequestedLinks.has(`${request.workSlug}\u0000${request.url}`)) {
        errors.push(`${request.workSlug}: replacement target link does not exist: ${request.url}`);
      }
    }
  }

  const pictureBookIds = [...new Set(input.detectives.flatMap((detective) => detective.pictureBookEntryIds))];
  if (pictureBookIds.length) {
    const pictureBooks = await client.query(`
      SELECT id FROM picture_book_entries WHERE id = ANY($1)
    `, [pictureBookIds]);
    const found = new Set(pictureBooks.rows.map((row) => row.id));
    for (const id of pictureBookIds) {
      if (!found.has(id)) errors.push(`unknown picture-book entry: ${id}`);
    }
  }

  const uniqueWorks = new Map(allWorks.map((work) => [work.slug, work]));
  const preview = {
    batchKey: input.batchKey,
    checksum,
    sourceFile,
    apply,
    changes: {
      detectiveCreates: input.detectives.filter((detective) => !bySlug.has(detective.slug)).length,
      detectiveUpdates: input.detectives.filter((detective) => bySlug.has(detective.slug)).length,
      workCreates: [...uniqueWorks.values()].filter((work) => !existingWorksBySlug.has(work.slug)).length,
      workUpdates: [...uniqueWorks.values()].filter((work) => existingWorksBySlug.has(work.slug)).length,
      pictureBookLinks: pictureBookIds.length,
      officialLinks: [...uniqueWorks.values()].length,
      linkDeactivations: linkDeactivationRequests.length
    },
    warnings,
    errors
  };
  console.log(JSON.stringify(preview, null, 2));
  if (errors.length) {
    process.exitCode = 1;
  } else if (apply) {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["detective_archives_catalog_import"]);
    lockHeld = true;
    await client.query("BEGIN");
    try {
      const prior = await client.query(`
        SELECT input_checksum AS checksum, status
        FROM catalog_import_batches WHERE batch_key = $1
      `, [input.batchKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].checksum !== checksum) {
          throw new Error(`Batch ${input.batchKey} was already recorded with a different checksum`);
        }
        if (prior.rows[0].status === "APPLIED") {
          throw Object.assign(new Error(`Catalog import ${input.batchKey}: already applied`), {
            code: "CATALOG_BATCH_ALREADY_APPLIED"
          });
        }
      }

      for (const detective of input.detectives) {
        const detectiveResult = await client.query(`
          INSERT INTO detectives (
            catalog_id, slug, name_zh, name_original, name_en, country, era,
            subject_kind, catalog_collection, catalog_category, media_types,
            summary, source_note, verification, status, published_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14, $15::content_status,
            CASE WHEN $15::content_status = 'PUBLISHED'::content_status THEN NOW() ELSE NULL END
          )
          ON CONFLICT (slug) DO UPDATE SET
            catalog_id = EXCLUDED.catalog_id,
            name_zh = EXCLUDED.name_zh,
            name_original = EXCLUDED.name_original,
            name_en = EXCLUDED.name_en,
            country = EXCLUDED.country,
            era = EXCLUDED.era,
            subject_kind = EXCLUDED.subject_kind,
            catalog_collection = EXCLUDED.catalog_collection,
            catalog_category = EXCLUDED.catalog_category,
            media_types = EXCLUDED.media_types,
            summary = EXCLUDED.summary,
            source_note = EXCLUDED.source_note,
            verification = EXCLUDED.verification,
            status = EXCLUDED.status,
            published_at = CASE
              WHEN EXCLUDED.status = 'PUBLISHED' THEN COALESCE(detectives.published_at, NOW())
              ELSE detectives.published_at
            END,
            updated_at = NOW()
          RETURNING id
        `, [
          detective.catalogId,
          detective.slug,
          detective.nameZh,
          detective.nameOriginal ?? null,
          detective.nameEn ?? null,
          detective.country ?? null,
          detective.era ?? null,
          detective.subjectKind,
          detective.collection,
          detective.category,
          detective.mediaTypes,
          detective.summary,
          `Catalog import ${input.batchKey}`,
          detective.verification,
          detective.status
        ]);
        const detectiveId = detectiveResult.rows[0].id;

        await client.query("DELETE FROM detective_aliases WHERE detective_id = $1", [detectiveId]);
        for (const alias of [...new Set(detective.aliases)]) {
          await client.query("INSERT INTO detective_aliases (detective_id, alias) VALUES ($1, $2)", [detectiveId, alias]);
        }
        await client.query("DELETE FROM detective_tags WHERE detective_id = $1", [detectiveId]);
        for (const tag of [...new Set(detective.tags)]) {
          await client.query("INSERT INTO detective_tags (detective_id, tag) VALUES ($1, $2)", [detectiveId, tag]);
        }
        await client.query("DELETE FROM detective_featured_works WHERE detective_id = $1", [detectiveId]);
        for (const [index, featuredCase] of detective.featuredCases.entries()) {
          await client.query(`
            INSERT INTO detective_featured_works (detective_id, source_label, display_order)
            VALUES ($1, $2, $3)
          `, [detectiveId, featuredCase, index]);
        }
        await client.query("DELETE FROM detective_sources WHERE detective_id = $1", [detectiveId]);
        for (const sourceId of detective.sourceIds) {
          const source = sourcesById.get(sourceId);
          await client.query(`
            INSERT INTO detective_sources (
              detective_id, source_id, source_label, source_url, source_quality, verification
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [detectiveId, source.id, source.label, source.url, source.quality, detective.verification]);
        }

        await client.query(`
          DELETE FROM detective_creators
          WHERE detective_id = $1 AND relation_type = 'CREATOR'
        `, [detectiveId]);
        if (detective.creatorName) {
          const creator = await client.query(`
            INSERT INTO creators (name_zh, status) VALUES ($1, 'PUBLISHED')
            ON CONFLICT (name_zh) DO UPDATE SET updated_at = NOW()
            RETURNING id
          `, [detective.creatorName]);
          await client.query(`
            INSERT INTO detective_creators (detective_id, creator_id, relation_type)
            VALUES ($1, $2, 'CREATOR')
          `, [detectiveId, creator.rows[0].id]);
        }

        for (const entryId of detective.pictureBookEntryIds) {
          await client.query(`
            UPDATE picture_book_entries SET detective_id = $2, updated_at = NOW() WHERE id = $1
          `, [entryId, detectiveId]);
        }

        for (const [workIndex, work] of detective.works.entries()) {
          const workResult = await client.query(`
            INSERT INTO works (
              slug, title_zh, title_original, media_type, release_year,
              summary, source_note, status, published_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PUBLISHED', NOW())
            ON CONFLICT (slug) DO UPDATE SET
              title_zh = EXCLUDED.title_zh,
              title_original = EXCLUDED.title_original,
              media_type = EXCLUDED.media_type,
              release_year = EXCLUDED.release_year,
              summary = EXCLUDED.summary,
              source_note = EXCLUDED.source_note,
              status = 'PUBLISHED',
              published_at = COALESCE(works.published_at, NOW()),
              updated_at = NOW()
            RETURNING id
          `, [
            work.slug,
            work.titleZh,
            work.titleOriginal ?? null,
            work.mediaType,
            work.releaseYear ?? null,
            work.summary,
            `Catalog import ${input.batchKey}; source ${work.sourceId}`
          ]);
          const workId = workResult.rows[0].id;
          if (work.deactivateLinkUrls.length) {
            await client.query(`
              UPDATE work_links
              SET is_active = FALSE, updated_at = NOW()
              WHERE work_id = $1 AND url = ANY($2)
            `, [workId, work.deactivateLinkUrls]);
          }
          await client.query(`
            INSERT INTO detective_works (detective_id, work_id, is_recommended, recommendation_order)
            VALUES ($1, $2, TRUE, $3)
            ON CONFLICT (detective_id, work_id) DO UPDATE SET
              is_recommended = TRUE,
              recommendation_order = EXCLUDED.recommendation_order
          `, [detectiveId, workId, workIndex]);

          const workCreatorName = work.creatorName ?? detective.creatorName;
          if (workCreatorName) {
            const creator = await client.query(`
              INSERT INTO creators (name_zh, status) VALUES ($1, 'PUBLISHED')
              ON CONFLICT (name_zh) DO UPDATE SET updated_at = NOW()
              RETURNING id
            `, [workCreatorName]);
            await client.query(`
              INSERT INTO work_creators (work_id, creator_id, credit_type)
              VALUES ($1, $2, 'AUTHOR') ON CONFLICT DO NOTHING
            `, [workId, creator.rows[0].id]);
          }
          const source = sourcesById.get(work.sourceId);
          await client.query(`
            INSERT INTO work_links (
              work_id, link_type, provider_name, url, region, is_active
            ) VALUES ($1, $2, $3, $4, $5, TRUE)
            ON CONFLICT (work_id, provider_name, url) DO UPDATE SET
              link_type = EXCLUDED.link_type,
              region = EXCLUDED.region,
              is_active = TRUE,
              updated_at = NOW()
          `, [workId, work.linkType, work.providerName, source.url, work.region]);
        }
      }

      await client.query(`
        INSERT INTO catalog_import_batches (
          batch_key, input_checksum, schema_version, source_file,
          status, change_summary, applied_at
        ) VALUES ($1, $2, $3, $4, 'APPLIED', $5, NOW())
        ON CONFLICT (batch_key) DO UPDATE SET
          input_checksum = EXCLUDED.input_checksum,
          schema_version = EXCLUDED.schema_version,
          source_file = EXCLUDED.source_file,
          status = 'APPLIED',
          change_summary = EXCLUDED.change_summary,
          error_summary = NULL,
          applied_at = NOW()
      `, [
        input.batchKey,
        checksum,
        input.schemaVersion,
        path.relative(process.cwd(), sourceFile),
        preview.changes
      ]);
      await client.query("COMMIT");
      console.log(`Catalog import ${input.batchKey}: applied`);
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "CATALOG_BATCH_ALREADY_APPLIED") {
        console.log(error.message);
        process.exitCode = 0;
      } else {
        throw error;
      }
    }
  }
} finally {
  if (lockHeld) {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["detective_archives_catalog_import"]);
  }
  await client.end();
}

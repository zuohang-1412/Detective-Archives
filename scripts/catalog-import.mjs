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
const pictureBookRecommendationMappingSchema = z.object({
  entryId: z.string().regex(/^PB-\d{3}-(?:STD|SP)$/),
  sourceLabel: z.string().min(1).max(240),
  workSlug: slugSchema.max(120)
});
const pictureBookRecommendationUnmappingSchema = z.object({
  entryId: z.string().regex(/^PB-\d{3}-(?:STD|SP)$/),
  sourceLabel: z.string().min(1).max(240)
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
  rollbackOf: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
  rollbackReason: z.string().min(10).max(1000).optional(),
  archiveDetectiveSlugs: z.array(slugSchema.max(100)).max(500).default([]),
  archiveWorkSlugs: z.array(slugSchema.max(120)).max(500).default([]),
  snapshotDate: z.iso.date(),
  contentPolicy: z.string().min(10).max(1000),
  sources: z.array(sourceSchema).max(500).default([]),
  detectives: z.array(detectiveSchema).max(500).default([]),
  pictureBookRecommendationMappings: z.array(
    pictureBookRecommendationMappingSchema
  ).max(500).default([]),
  pictureBookRecommendationUnmappings: z.array(
    pictureBookRecommendationUnmappingSchema
  ).max(500).default([])
}).superRefine((input, context) => {
  const hasCatalogRecords = input.sources.length > 0 || input.detectives.length > 0;
  if (hasCatalogRecords && (!input.sources.length || !input.detectives.length)) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "catalog records require both sources and detectives"
    });
  }
  if (input.rollbackOf) {
    if (!input.rollbackReason) {
      context.addIssue({ code: "custom", path: ["rollbackReason"], message: "rollback reason is required" });
    }
    if (input.rollbackOf === input.batchKey) {
      context.addIssue({ code: "custom", path: ["rollbackOf"], message: "a batch cannot roll back itself" });
    }
    if (!input.detectives.length
      && !input.archiveDetectiveSlugs.length
      && !input.archiveWorkSlugs.length
      && !input.pictureBookRecommendationMappings.length
      && !input.pictureBookRecommendationUnmappings.length) {
      context.addIssue({ code: "custom", path: [], message: "rollback batch must contain compensation" });
    }
  } else {
    if (input.rollbackReason) {
      context.addIssue({ code: "custom", path: ["rollbackReason"], message: "rollbackOf is required" });
    }
    if (input.archiveDetectiveSlugs.length || input.archiveWorkSlugs.length) {
      context.addIssue({ code: "custom", path: [], message: "archive operations require rollbackOf" });
    }
    if (input.pictureBookRecommendationUnmappings.length) {
      context.addIssue({
        code: "custom",
        path: ["pictureBookRecommendationUnmappings"],
        message: "recommendation unmapping requires rollbackOf"
      });
    }
    if (!hasCatalogRecords && !input.pictureBookRecommendationMappings.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "catalog batch requires records or recommendation mappings"
      });
    }
  }
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
const rollback = process.argv.includes("--rollback");
if (rollback && !fileArgument) {
  throw new Error("Rollback requires an explicit --file path");
}
const sourceFile = path.resolve(fileArgument
  ? fileArgument.slice("--file=".length)
  : "apps/api/src/data/catalog-expansion.json");
const apply = process.argv.includes("--apply");
const raw = await readFile(sourceFile, "utf8");
const input = importSchema.parse(JSON.parse(raw));
if (rollback !== Boolean(input.rollbackOf)) {
  throw new Error(input.rollbackOf
    ? "Rollback batches must use the explicit --rollback command"
    : "The --rollback command requires a batch with rollbackOf");
}
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
for (const value of duplicates(input.archiveDetectiveSlugs)) {
  errors.push(`duplicate archived detective slug: ${value}`);
}
for (const value of duplicates(input.archiveWorkSlugs)) {
  errors.push(`duplicate archived work slug: ${value}`);
}
const recommendationKey = (item) => `${item.entryId}\u0000${item.sourceLabel}`;
for (const value of duplicates(input.pictureBookRecommendationMappings.map(recommendationKey))) {
  errors.push(`duplicate picture-book recommendation mapping: ${value.replace("\u0000", " / ")}`);
}
for (const value of duplicates(input.pictureBookRecommendationUnmappings.map(recommendationKey))) {
  errors.push(`duplicate picture-book recommendation unmapping: ${value.replace("\u0000", " / ")}`);
}
const mappedRecommendationKeys = new Set(
  input.pictureBookRecommendationMappings.map(recommendationKey)
);
for (const item of input.pictureBookRecommendationUnmappings) {
  if (mappedRecommendationKeys.has(recommendationKey(item))) {
    errors.push(`${item.entryId} / ${item.sourceLabel}: cannot map and unmap the same recommendation`);
  }
}
for (const detective of input.detectives) {
  if (input.archiveDetectiveSlugs.includes(detective.slug)) {
    errors.push(`${detective.slug}: cannot restore and archive the same detective`);
  }
  for (const work of detective.works) {
    if (input.archiveWorkSlugs.includes(work.slug)) {
      errors.push(`${work.slug}: cannot restore and archive the same work`);
    }
  }
}
const allWorks = input.detectives.flatMap((detective) => detective.works);
const uniqueWorks = new Map(allWorks.map((work) => [work.slug, work]));
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

  const workSlugs = [...new Set([
    ...allWorks.map((work) => work.slug),
    ...input.pictureBookRecommendationMappings.map((mapping) => mapping.workSlug)
  ])];
  const existingWorks = workSlugs.length
    ? await client.query(`
      SELECT id, slug, title_zh AS "titleZh", status::text
      FROM works
      WHERE slug = ANY($1)
    `, [workSlugs])
    : { rows: [] };
  const existingWorksBySlug = new Map(existingWorks.rows.map((row) => [row.slug, row]));
  for (const work of allWorks) {
    const existing = existingWorksBySlug.get(work.slug);
    if (existing && existing.titleZh !== work.titleZh) {
      warnings.push(`${work.slug}: work title will change from ${existing.titleZh} to ${work.titleZh}`);
    }
  }

  if (input.archiveDetectiveSlugs.length) {
    const archivedDetectives = await client.query(`
      SELECT slug FROM detectives WHERE slug = ANY($1)
    `, [input.archiveDetectiveSlugs]);
    const found = new Set(archivedDetectives.rows.map((row) => row.slug));
    for (const slug of input.archiveDetectiveSlugs) {
      if (!found.has(slug)) errors.push(`cannot archive missing detective: ${slug}`);
    }
  }
  if (input.archiveWorkSlugs.length) {
    const archivedWorks = await client.query(`
      SELECT slug FROM works WHERE slug = ANY($1)
    `, [input.archiveWorkSlugs]);
    const found = new Set(archivedWorks.rows.map((row) => row.slug));
    for (const slug of input.archiveWorkSlugs) {
      if (!found.has(slug)) errors.push(`cannot archive missing work: ${slug}`);
    }
  }

  if (input.rollbackOf) {
    const recorded = await client.query(`
      SELECT input_checksum AS checksum, status
      FROM catalog_import_batches WHERE batch_key = $1
    `, [input.batchKey]);
    if (recorded.rows[0]?.checksum && recorded.rows[0].checksum !== checksum) {
      errors.push(`rollback batch ${input.batchKey} was recorded with a different checksum`);
    } else if (recorded.rows[0]?.status === "APPLIED") {
      warnings.push(`rollback batch ${input.batchKey} is already applied`);
    } else {
      const target = await client.query(`
        SELECT batch_key AS "batchKey", status
        FROM catalog_import_batches WHERE batch_key = $1
      `, [input.rollbackOf]);
      const batch = target.rows[0];
      if (!batch) {
        errors.push(`rollback target does not exist: ${input.rollbackOf}`);
      } else if (batch.status !== "APPLIED") {
        errors.push(`rollback target is not applied: ${input.rollbackOf} (${batch.status})`);
      } else {
        const latest = await client.query(`
          SELECT batch_key AS "batchKey"
          FROM catalog_import_batches
          WHERE status = 'APPLIED'
          ORDER BY applied_at DESC NULLS LAST, created_at DESC, batch_key DESC
          LIMIT 1
        `);
        if (latest.rows[0]?.batchKey !== input.rollbackOf) {
          errors.push(`rollback target is not the latest applied batch; latest is ${latest.rows[0]?.batchKey ?? "none"}`);
        }
      }
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

  const recommendationRequests = [
    ...input.pictureBookRecommendationMappings,
    ...input.pictureBookRecommendationUnmappings
  ];
  const existingRecommendations = recommendationRequests.length
    ? await client.query(`
      SELECT
        recommendation.entry_id AS "entryId",
        recommendation.source_label AS "sourceLabel",
        work.slug AS "workSlug"
      FROM picture_book_recommendations recommendation
      LEFT JOIN works work ON work.id = recommendation.work_id
      WHERE (recommendation.entry_id, recommendation.source_label) IN (
        SELECT * FROM UNNEST($1::text[], $2::text[])
      )
    `, [
      recommendationRequests.map((request) => request.entryId),
      recommendationRequests.map((request) => request.sourceLabel)
    ])
    : { rows: [] };
  const recommendationsByKey = new Map(
    existingRecommendations.rows.map((row) => [recommendationKey(row), row])
  );
  for (const mapping of input.pictureBookRecommendationMappings) {
    const key = recommendationKey(mapping);
    const existingWork = existingWorksBySlug.get(mapping.workSlug);
    if (!recommendationsByKey.has(key)) {
      errors.push(`${mapping.entryId}: recommendation label does not exist: ${mapping.sourceLabel}`);
    }
    if (!existingWork && !uniqueWorks.has(mapping.workSlug)) {
      errors.push(`${mapping.entryId}: mapped work does not exist: ${mapping.workSlug}`);
    } else if (existingWork?.status !== "PUBLISHED" && !uniqueWorks.has(mapping.workSlug)) {
      errors.push(`${mapping.entryId}: mapped work is not published: ${mapping.workSlug}`);
    }
  }
  for (const unmapping of input.pictureBookRecommendationUnmappings) {
    const existing = recommendationsByKey.get(recommendationKey(unmapping));
    if (!existing) {
      errors.push(`${unmapping.entryId}: recommendation label does not exist: ${unmapping.sourceLabel}`);
    } else if (!existing.workSlug) {
      warnings.push(`${unmapping.entryId}: recommendation is already unmapped: ${unmapping.sourceLabel}`);
    }
  }

  const preview = {
    batchKey: input.batchKey,
    checksum,
    sourceFile,
    apply,
    rollbackOf: input.rollbackOf ?? null,
    changes: {
      detectiveCreates: input.detectives.filter((detective) => !bySlug.has(detective.slug)).length,
      detectiveUpdates: input.detectives.filter((detective) => bySlug.has(detective.slug)).length,
      workCreates: [...uniqueWorks.values()].filter((work) => !existingWorksBySlug.has(work.slug)).length,
      workUpdates: [...uniqueWorks.values()].filter((work) => existingWorksBySlug.has(work.slug)).length,
      pictureBookLinks: pictureBookIds.length,
      officialLinks: [...uniqueWorks.values()].length,
      linkDeactivations: linkDeactivationRequests.length,
      pictureBookRecommendationMappings: input.pictureBookRecommendationMappings.length,
      pictureBookRecommendationUnmappings: input.pictureBookRecommendationUnmappings.length,
      detectiveArchives: input.archiveDetectiveSlugs.length,
      workArchives: input.archiveWorkSlugs.length
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
        if (["APPLIED", "ROLLED_BACK"].includes(prior.rows[0].status)) {
          const state = prior.rows[0].status === "APPLIED" ? "already applied" : "rolled back; skipped";
          throw Object.assign(new Error(`Catalog import ${input.batchKey}: ${state}`), {
            code: "CATALOG_BATCH_NOOP"
          });
        }
      }

      if (input.rollbackOf) {
        const target = await client.query(`
          SELECT batch_key AS "batchKey", status
          FROM catalog_import_batches
          WHERE batch_key = $1
          FOR UPDATE
        `, [input.rollbackOf]);
        const batch = target.rows[0];
        if (!batch || batch.status !== "APPLIED") {
          throw new Error(`Rollback target must still be applied: ${input.rollbackOf}`);
        }
        const latest = await client.query(`
          SELECT batch_key AS "batchKey"
          FROM catalog_import_batches
          WHERE status = 'APPLIED'
          ORDER BY applied_at DESC NULLS LAST, created_at DESC, batch_key DESC
          LIMIT 1
        `);
        if (latest.rows[0]?.batchKey !== input.rollbackOf) {
          throw new Error(`Rollback target is no longer latest; latest is ${latest.rows[0]?.batchKey ?? "none"}`);
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

      for (const mapping of input.pictureBookRecommendationMappings) {
        const changed = await client.query(`
          UPDATE picture_book_recommendations recommendation
          SET work_id = work.id
          FROM works work
          WHERE recommendation.entry_id = $1
            AND recommendation.source_label = $2
            AND work.slug = $3
            AND work.status = 'PUBLISHED'
          RETURNING recommendation.id
        `, [mapping.entryId, mapping.sourceLabel, mapping.workSlug]);
        if (changed.rowCount !== 1) {
          throw new Error(
            `${mapping.entryId}: recommendation mapping changed before apply: ${mapping.sourceLabel}`
          );
        }
      }
      for (const unmapping of input.pictureBookRecommendationUnmappings) {
        const changed = await client.query(`
          UPDATE picture_book_recommendations
          SET work_id = NULL
          WHERE entry_id = $1 AND source_label = $2
          RETURNING id
        `, [unmapping.entryId, unmapping.sourceLabel]);
        if (changed.rowCount !== 1) {
          throw new Error(
            `${unmapping.entryId}: recommendation unmapping changed before apply: ${unmapping.sourceLabel}`
          );
        }
      }

      if (input.archiveWorkSlugs.length) {
        await client.query(`
          UPDATE work_links
          SET is_active = FALSE, updated_at = NOW()
          WHERE work_id IN (SELECT id FROM works WHERE slug = ANY($1))
        `, [input.archiveWorkSlugs]);
        await client.query(`
          UPDATE works
          SET status = 'ARCHIVED', updated_at = NOW()
          WHERE slug = ANY($1)
        `, [input.archiveWorkSlugs]);
      }
      if (input.archiveDetectiveSlugs.length) {
        await client.query(`
          UPDATE picture_book_entries
          SET detective_id = NULL, updated_at = NOW()
          WHERE detective_id IN (SELECT id FROM detectives WHERE slug = ANY($1))
        `, [input.archiveDetectiveSlugs]);
        await client.query(`
          UPDATE detectives
          SET status = 'ARCHIVED', updated_at = NOW()
          WHERE slug = ANY($1)
        `, [input.archiveDetectiveSlugs]);
      }

      if (input.rollbackOf) {
        const rolledBack = await client.query(`
          UPDATE catalog_import_batches
          SET status = 'ROLLED_BACK',
            change_summary = change_summary || jsonb_build_object(
              'rolledBackBy', $2::text,
              'rolledBackAt', NOW(),
              'rollbackReason', $3::text
            )
          WHERE batch_key = $1 AND status = 'APPLIED'
          RETURNING id
        `, [input.rollbackOf, input.batchKey, input.rollbackReason]);
        if (!rolledBack.rows[0]) {
          throw new Error(`Rollback target changed before compensation completed: ${input.rollbackOf}`);
        }
      }

      const changeSummary = input.rollbackOf
        ? { ...preview.changes, rollbackOf: input.rollbackOf, rollbackReason: input.rollbackReason }
        : preview.changes;

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
        changeSummary
      ]);
      await client.query("COMMIT");
      console.log(`Catalog import ${input.batchKey}: applied`);
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "CATALOG_BATCH_NOOP") {
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

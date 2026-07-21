import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

const { Client } = pg;
const coreDetectives = JSON.parse(
  await readFile(path.resolve("apps/api/src/data/core-detectives.json"), "utf8")
);
const coreWorkDetails = JSON.parse(
  await readFile(path.resolve("apps/api/src/data/core-work-details.json"), "utf8")
);
const archiveDirectory = JSON.parse(
  await readFile(path.resolve("apps/api/src/data/archive-directory-index.json"), "utf8")
);
const pictureBookCatalog = JSON.parse(
  await readFile(path.resolve("apps/api/src/data/picture-book-index.json"), "utf8")
);
const coreWorkDetailsBySlug = new Map(
  coreWorkDetails.map((detail) => [detail.slug, detail])
);

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) {
    throw new Error(`Cannot create a stable slug for ${value}`);
  }
  return slug;
}

function verificationStatus(value) {
  return value === "AUTHORITATIVE_SOURCE_CONFIRMED"
    ? "PRIMARY_SOURCE_CONFIRMED"
    : value;
}

async function upsertCreator(client, name) {
  const result = await client.query(
    `
      INSERT INTO creators (name_zh, status)
      VALUES ($1, 'PUBLISHED')
      ON CONFLICT (name_zh) DO UPDATE
      SET updated_at = NOW()
      RETURNING id
    `,
    [name]
  );
  return result.rows[0].id;
}

async function replaceTags(client, detectiveId, tags) {
  await client.query("DELETE FROM detective_tags WHERE detective_id = $1", [detectiveId]);
  for (const tag of tags) {
    await client.query(
      "INSERT INTO detective_tags (detective_id, tag) VALUES ($1, $2)",
      [detectiveId, tag]
    );
  }
}

async function seedCoreDetectives(client, detectiveIdsBySlug) {
  for (const detective of coreDetectives) {
    const detectiveResult = await client.query(
      `
        INSERT INTO detectives (
          slug, name_zh, name_original, country, subject_kind,
          catalog_collection, media_types, summary, source_note,
          verification, status, published_at
        )
        VALUES ($1, $2, $3, $4, 'FICTIONAL', 'CORE', $5, $6, $7,
          'SOURCE_CAPTURED', 'PUBLISHED', NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name_zh = EXCLUDED.name_zh,
          name_original = EXCLUDED.name_original,
          country = EXCLUDED.country,
          media_types = EXCLUDED.media_types,
          summary = EXCLUDED.summary,
          source_note = EXCLUDED.source_note,
          status = 'PUBLISHED',
          published_at = COALESCE(detectives.published_at, NOW()),
          updated_at = NOW()
        RETURNING id
      `,
      [
        detective.slug,
        detective.nameZh,
        detective.nameOriginal,
        detective.country,
        [...new Set(detective.works.map((work) => work.type))],
        detective.summary,
        "MVP core catalog; source verification remains in progress"
      ]
    );
    const detectiveId = detectiveResult.rows[0].id;
    detectiveIdsBySlug.set(detective.slug, detectiveId);
    await replaceTags(client, detectiveId, detective.tags);

    const creatorId = await upsertCreator(client, detective.creatorName);
    await client.query(
      `
        INSERT INTO detective_creators (detective_id, creator_id, relation_type)
        VALUES ($1, $2, 'CREATOR')
        ON CONFLICT DO NOTHING
      `,
      [detectiveId, creatorId]
    );

    for (let index = 0; index < detective.works.length; index += 1) {
      const work = detective.works[index];
      const workSlug = work.id.replace(/^work_/, "").replaceAll("_", "-");
      const workDetail = coreWorkDetailsBySlug.get(workSlug);
      if (!workDetail) {
        throw new Error(`Missing core work detail: ${workSlug}`);
      }
      const workResult = await client.query(
        `
          INSERT INTO works (
            slug, title_zh, title_original, media_type, release_year,
            summary, source_note, status, published_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'PUBLISHED', NOW())
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
        `,
        [
          workSlug,
          work.titleZh,
          work.titleOriginal,
          work.type,
          work.releaseYear,
          workDetail.summary,
          "Core catalog with official link verification"
        ]
      );
      const workId = workResult.rows[0].id;
      await client.query(
        `
          INSERT INTO detective_works (
            detective_id, work_id, is_recommended, recommendation_order
          )
          VALUES ($1, $2, TRUE, $3)
          ON CONFLICT (detective_id, work_id) DO UPDATE SET
            is_recommended = TRUE,
            recommendation_order = EXCLUDED.recommendation_order
        `,
        [detectiveId, workId, index]
      );

      const workCreatorId = await upsertCreator(client, work.creatorName);
      await client.query(
        `
          INSERT INTO work_creators (work_id, creator_id, credit_type)
          VALUES ($1, $2, 'AUTHOR')
          ON CONFLICT DO NOTHING
        `,
        [workId, workCreatorId]
      );

      for (const link of workDetail.links) {
        await client.query(
          `
            INSERT INTO work_links (
              work_id, link_type, provider_name, url, region,
              is_active, last_checked_at
            )
            VALUES ($1, $2, $3, $4, $5, TRUE, $6)
            ON CONFLICT (work_id, provider_name, url) DO UPDATE SET
              link_type = EXCLUDED.link_type,
              region = EXCLUDED.region,
              is_active = TRUE,
              last_checked_at = EXCLUDED.last_checked_at,
              updated_at = NOW()
          `,
          [
            workId,
            link.linkType,
            link.providerName,
            link.url,
            link.region,
            link.lastCheckedAt
          ]
        );
      }
    }
  }
}

async function seedArchiveDirectory(client, detectiveIdsBySlug) {
  const sourcesById = new Map(archiveDirectory.sources.map((source) => [source.id, source]));

  for (const entry of archiveDirectory.entries) {
    const slug = slugify(entry.names.en);
    const subjectKind = entry.collection === "HISTORICAL_CASES" ? "HISTORICAL" : "FICTIONAL";
    const detectiveResult = await client.query(
      `
        INSERT INTO detectives (
          catalog_id, catalog_category, slug, name_zh, name_original, name_en, country,
          subject_kind, catalog_collection, media_types, summary,
          source_note, verification, status, published_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          'PUBLISHED', NOW())
        ON CONFLICT (slug) DO UPDATE SET
          catalog_id = EXCLUDED.catalog_id,
          catalog_category = EXCLUDED.catalog_category,
          name_zh = EXCLUDED.name_zh,
          name_original = EXCLUDED.name_original,
          name_en = EXCLUDED.name_en,
          country = EXCLUDED.country,
          subject_kind = EXCLUDED.subject_kind,
          catalog_collection = EXCLUDED.catalog_collection,
          media_types = EXCLUDED.media_types,
          summary = EXCLUDED.summary,
          source_note = EXCLUDED.source_note,
          verification = EXCLUDED.verification,
          status = 'PUBLISHED',
          published_at = COALESCE(detectives.published_at, NOW()),
          updated_at = NOW()
        RETURNING id
      `,
      [
        entry.id,
        entry.category,
        slug,
        entry.names.zh,
        entry.names.original,
        entry.names.en,
        entry.region,
        subjectKind,
        entry.collection,
        entry.mediaTypes,
        entry.summary,
        "Archive directory seed; see detective_sources for provenance",
        verificationStatus(entry.verification)
      ]
    );
    const detectiveId = detectiveResult.rows[0].id;
    detectiveIdsBySlug.set(slug, detectiveId);
    await replaceTags(client, detectiveId, entry.tags);

    await client.query("DELETE FROM detective_aliases WHERE detective_id = $1", [detectiveId]);
    for (const alias of entry.names.aliases) {
      await client.query(
        "INSERT INTO detective_aliases (detective_id, alias) VALUES ($1, $2)",
        [detectiveId, alias]
      );
    }

    await client.query("DELETE FROM detective_featured_works WHERE detective_id = $1", [detectiveId]);
    for (let index = 0; index < entry.featuredWorks.length; index += 1) {
      await client.query(
        `
          INSERT INTO detective_featured_works (detective_id, source_label, display_order)
          VALUES ($1, $2, $3)
        `,
        [detectiveId, entry.featuredWorks[index], index]
      );
    }

    await client.query("DELETE FROM detective_sources WHERE detective_id = $1", [detectiveId]);
    for (const sourceId of entry.sourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) {
        throw new Error(`Unknown archive-directory source: ${sourceId}`);
      }
      await client.query(
        `
          INSERT INTO detective_sources (
            detective_id, source_id, source_label, source_url,
            source_quality, verification
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          detectiveId,
          source.id,
          source.label,
          source.url,
          source.quality,
          verificationStatus(entry.verification)
        ]
      );
    }

    if (entry.creatorName) {
      const creatorId = await upsertCreator(client, entry.creatorName);
      await client.query(
        `
          INSERT INTO detective_creators (detective_id, creator_id, relation_type)
          VALUES ($1, $2, 'CREATOR')
          ON CONFLICT DO NOTHING
        `,
        [detectiveId, creatorId]
      );
    }
  }
}

async function seedPictureBook(client, detectiveIdsBySlug) {
  for (const source of pictureBookCatalog.sources) {
    await client.query(
      `
        INSERT INTO picture_book_sources (id, label, url, source_quality)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          url = EXCLUDED.url,
          source_quality = EXCLUDED.source_quality,
          updated_at = NOW()
      `,
      [source.id, source.label, source.url, source.quality]
    );
  }

  for (const entry of pictureBookCatalog.entries) {
    const detectiveId = entry.detectiveSlug
      ? detectiveIdsBySlug.get(entry.detectiveSlug) ?? null
      : null;
    await client.query(
      `
        INSERT INTO picture_book_entries (
          id, volume_no, edition, detective_id, name_zh, name_original,
          name_en, release_date, identity_verification
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          volume_no = EXCLUDED.volume_no,
          edition = EXCLUDED.edition,
          detective_id = EXCLUDED.detective_id,
          name_zh = EXCLUDED.name_zh,
          name_original = EXCLUDED.name_original,
          name_en = EXCLUDED.name_en,
          release_date = EXCLUDED.release_date,
          identity_verification = EXCLUDED.identity_verification,
          updated_at = NOW()
      `,
      [
        entry.id,
        entry.volumeNo,
        entry.edition,
        detectiveId,
        entry.names.zh,
        entry.names.original,
        entry.names.en,
        entry.releaseDate,
        entry.verification.identity
      ]
    );

    await client.query("DELETE FROM picture_book_entry_sources WHERE entry_id = $1", [entry.id]);
    for (let index = 0; index < entry.sourceIds.length; index += 1) {
      const sourceId = entry.sourceIds[index];
      const sourceUrl = entry.sourceUrls[index];
      if (!sourceId || !sourceUrl) {
        throw new Error(`Picture-book source mismatch: ${entry.id}`);
      }
      await client.query(
        `
          INSERT INTO picture_book_entry_sources (entry_id, source_id, source_url)
          VALUES ($1, $2, $3)
        `,
        [entry.id, sourceId, sourceUrl]
      );
    }

    await client.query("DELETE FROM picture_book_entry_aliases WHERE entry_id = $1", [entry.id]);
    for (const alias of entry.names.aliases) {
      await client.query(
        "INSERT INTO picture_book_entry_aliases (entry_id, alias) VALUES ($1, $2)",
        [entry.id, alias]
      );
    }

    await client.query("DELETE FROM picture_book_recommendations WHERE entry_id = $1", [entry.id]);
    for (let index = 0; index < entry.recommendedWorks.length; index += 1) {
      await client.query(
        `
          INSERT INTO picture_book_recommendations (
            entry_id, source_label, display_order, verification
          )
          VALUES ($1, $2, $3, $4)
        `,
        [entry.id, entry.recommendedWorks[index], index, entry.verification.recommendedWorks]
      );
    }
  }
}

const client = new Client(postgresConfig(targetDatabaseName()));
let seedLockHeld = false;

try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["detective_archives_catalog_seed"]);
  seedLockHeld = true;
  await client.query("BEGIN");
  try {
    const detectiveIdsBySlug = new Map();
    await seedCoreDetectives(client, detectiveIdsBySlug);
    await seedArchiveDirectory(client, detectiveIdsBySlug);
    await seedPictureBook(client, detectiveIdsBySlug);
    await client.query("COMMIT");
    console.log(
      `Catalog seed: complete (${coreDetectives.length} core, ${archiveDirectory.entries.length} directory, ${pictureBookCatalog.entries.length} picture-book entries)`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
} finally {
  if (seedLockHeld) {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["detective_archives_catalog_seed"]);
  }
  await client.end();
}

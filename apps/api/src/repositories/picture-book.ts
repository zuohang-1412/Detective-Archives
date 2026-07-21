import { pictureBookCatalog as fallbackCatalog } from "../data/picture-book.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

interface PictureBookRow {
  id: string;
  volumeNo: number;
  edition: "STANDARD" | "SPECIAL";
  detectiveSlug: string | null;
  nameZh: string;
  nameOriginal: string | null;
  nameEn: string | null;
  releaseDate: string | null;
  identityVerification: string;
  recommendedVerification: string;
  aliases: string[];
  recommendedWorks: string[];
  sourceIds: string[];
  sourceUrls: string[];
  sourceLabel: string;
}

export interface ListPictureBookOptions {
  q?: string | undefined;
  fromVolume: number;
  toVolume: number;
  edition?: "STANDARD" | "SPECIAL" | undefined;
  identityStatus?: string | undefined;
  page: number;
  pageSize: number;
}

const pictureBookSelect = `
  SELECT
    pbe.id,
    pbe.volume_no AS "volumeNo",
    pbe.edition::text AS edition,
    d.slug AS "detectiveSlug",
    pbe.name_zh AS "nameZh",
    pbe.name_original AS "nameOriginal",
    pbe.name_en AS "nameEn",
    pbe.release_date::text AS "releaseDate",
    pbe.identity_verification::text AS "identityVerification",
    COALESCE((
      SELECT pbr.verification::text
      FROM picture_book_recommendations pbr
      WHERE pbr.entry_id = pbe.id
      ORDER BY pbr.display_order
      LIMIT 1
    ), 'MISSING') AS "recommendedVerification",
    COALESCE((
      SELECT array_agg(pbea.alias ORDER BY pbea.alias)
      FROM picture_book_entry_aliases pbea
      WHERE pbea.entry_id = pbe.id
    ), ARRAY[]::varchar[]) AS aliases,
    COALESCE((
      SELECT array_agg(pbr.source_label ORDER BY pbr.display_order)
      FROM picture_book_recommendations pbr
      WHERE pbr.entry_id = pbe.id
    ), ARRAY[]::varchar[]) AS "recommendedWorks",
    COALESCE((
      SELECT array_agg(pbes.source_id ORDER BY pbes.source_id)
      FROM picture_book_entry_sources pbes
      WHERE pbes.entry_id = pbe.id
    ), ARRAY[]::varchar[]) AS "sourceIds",
    COALESCE((
      SELECT array_agg(pbes.source_url ORDER BY pbes.source_id)
      FROM picture_book_entry_sources pbes
      WHERE pbes.entry_id = pbe.id
    ), ARRAY[]::text[]) AS "sourceUrls",
    COALESCE((
      SELECT pbs.label
      FROM picture_book_entry_sources pbes
      JOIN picture_book_sources pbs ON pbs.id = pbes.source_id
      WHERE pbes.entry_id = pbe.id
      ORDER BY pbes.source_id
      LIMIT 1
    ), '来源待补充') AS "sourceLabel"
  FROM picture_book_entries pbe
  LEFT JOIN detectives d ON d.id = pbe.detective_id AND d.status = 'PUBLISHED'
`;

function toPictureBookEntry(row: PictureBookRow) {
  return {
    id: row.id,
    volumeNo: row.volumeNo,
    edition: row.edition,
    names: {
      zh: row.nameZh,
      original: row.nameOriginal,
      en: row.nameEn,
      sourceLabel: row.sourceLabel,
      aliases: row.aliases
    },
    recommendedWorks: row.recommendedWorks,
    detectiveSlug: row.detectiveSlug,
    releaseDate: row.releaseDate,
    sourceIds: row.sourceIds,
    sourceUrls: row.sourceUrls,
    verification: {
      identity: row.identityVerification,
      recommendedWorks: row.recommendedVerification
    }
  };
}

function databaseFilter(options: ListPictureBookOptions) {
  const values: unknown[] = [options.fromVolume, options.toVolume];
  const clauses = ["pbe.volume_no BETWEEN $1 AND $2"];
  if (options.q) {
    values.push(`%${options.q}%`);
    clauses.push(`(
      pbe.id ILIKE $${values.length}
      OR pbe.name_zh ILIKE $${values.length}
      OR pbe.name_original ILIKE $${values.length}
      OR pbe.name_en ILIKE $${values.length}
      OR EXISTS (
        SELECT 1 FROM picture_book_entry_aliases pbea
        WHERE pbea.entry_id = pbe.id AND pbea.alias ILIKE $${values.length}
      )
      OR EXISTS (
        SELECT 1 FROM picture_book_recommendations pbr
        WHERE pbr.entry_id = pbe.id AND pbr.source_label ILIKE $${values.length}
      )
    )`);
  }
  if (options.edition) {
    values.push(options.edition);
    clauses.push(`pbe.edition::text = $${values.length}`);
  }
  if (options.identityStatus) {
    values.push(options.identityStatus);
    clauses.push(`pbe.identity_verification::text = $${values.length}`);
  }
  return { where: clauses.join(" AND "), values };
}

async function databaseCoverage(database: DatabaseClient) {
  const result = await queryRows<{
    firstVolume: number | null;
    latestPublishedVolume: number | null;
    standardVolumeCount: string;
    entryCount: string;
    entriesWithRecommendedWorks: string;
  }>(database, `
    SELECT
      MIN(volume_no) AS "firstVolume",
      MAX(volume_no) AS "latestPublishedVolume",
      COUNT(*) FILTER (WHERE edition = 'STANDARD')::text AS "standardVolumeCount",
      COUNT(*)::text AS "entryCount",
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM picture_book_recommendations pbr
          WHERE pbr.entry_id = picture_book_entries.id
        )
      )::text AS "entriesWithRecommendedWorks"
    FROM picture_book_entries
  `);
  const row = result.rows[0];
  return {
    firstVolume: row?.firstVolume ?? 1,
    latestPublishedVolume: row?.latestPublishedVolume ?? 0,
    standardVolumeCount: Number.parseInt(row?.standardVolumeCount ?? "0", 10),
    entryCount: Number.parseInt(row?.entryCount ?? "0", 10),
    entriesWithRecommendedWorks: Number.parseInt(row?.entriesWithRecommendedWorks ?? "0", 10)
  };
}

export async function listPictureBookEntries(
  database: DatabaseClient | undefined,
  options: ListPictureBookOptions
) {
  if (!database) {
    const normalizedQuery = options.q?.toLocaleLowerCase("zh-CN");
    const filtered = fallbackCatalog.entries.filter((entry) => {
      const searchable = [
        entry.id,
        entry.names.zh,
        entry.names.original,
        entry.names.en,
        ...entry.names.aliases,
        ...entry.recommendedWorks
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return entry.volumeNo >= options.fromVolume
        && entry.volumeNo <= options.toVolume
        && (!options.edition || entry.edition === options.edition)
        && (!options.identityStatus || entry.verification.identity === options.identityStatus)
        && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
    const start = (options.page - 1) * options.pageSize;
    return {
      data: filtered.slice(start, start + options.pageSize),
      total: filtered.length,
      coverage: fallbackCatalog.coverage,
      snapshotDate: fallbackCatalog.snapshotDate
    };
  }

  const { where, values } = databaseFilter(options);
  const [countResult, rows, coverage] = await Promise.all([
    queryRows<{ total: string }>(
      database,
      `SELECT COUNT(*)::text AS total FROM picture_book_entries pbe WHERE ${where}`,
      values
    ),
    queryRows<PictureBookRow>(
      database,
      `${pictureBookSelect} WHERE ${where}
       ORDER BY pbe.volume_no, pbe.edition
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, options.pageSize, (options.page - 1) * options.pageSize]
    ),
    databaseCoverage(database)
  ]);
  return {
    data: rows.rows.map(toPictureBookEntry),
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10),
    coverage,
    snapshotDate: fallbackCatalog.snapshotDate
  };
}

export async function getPictureBookEntry(database: DatabaseClient | undefined, id: string) {
  if (!database) {
    return fallbackCatalog.entries.find((item) => item.id === id) ?? null;
  }
  const result = await queryRows<PictureBookRow>(
    database,
    `${pictureBookSelect} WHERE pbe.id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? toPictureBookEntry(row) : null;
}

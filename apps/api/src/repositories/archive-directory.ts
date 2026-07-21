import { archiveDirectory as fallbackDirectory } from "../data/archive-directory.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

interface ArchiveRow {
  id: string;
  collection: "ARCHIVE_EXTENSION" | "HISTORICAL_CASES";
  category: string;
  nameZh: string;
  nameOriginal: string | null;
  nameEn: string | null;
  region: string | null;
  creatorName: string | null;
  mediaTypes: string[];
  summary: string;
  verification: string;
  aliases: string[];
  featuredWorks: string[];
  tags: string[];
  sourceIds: string[];
}

export interface ListArchiveOptions {
  q?: string | undefined;
  collection?: "ARCHIVE_EXTENSION" | "HISTORICAL_CASES" | undefined;
  category?: string | undefined;
  page: number;
  pageSize: number;
}

const archiveSelect = `
  SELECT
    d.catalog_id AS id,
    d.catalog_collection::text AS collection,
    d.catalog_category AS category,
    d.name_zh AS "nameZh",
    d.name_original AS "nameOriginal",
    d.name_en AS "nameEn",
    d.country AS region,
    d.media_types AS "mediaTypes",
    d.summary,
    d.verification::text AS verification,
    (
      SELECT string_agg(c.name_zh, '、' ORDER BY c.name_zh)
      FROM detective_creators dc
      JOIN creators c ON c.id = dc.creator_id
      WHERE dc.detective_id = d.id AND c.status = 'PUBLISHED'
    ) AS "creatorName",
    COALESCE((
      SELECT array_agg(da.alias ORDER BY da.alias)
      FROM detective_aliases da WHERE da.detective_id = d.id
    ), ARRAY[]::varchar[]) AS aliases,
    COALESCE((
      SELECT array_agg(dfw.source_label ORDER BY dfw.display_order)
      FROM detective_featured_works dfw WHERE dfw.detective_id = d.id
    ), ARRAY[]::varchar[]) AS "featuredWorks",
    COALESCE((
      SELECT array_agg(dt.tag ORDER BY dt.tag)
      FROM detective_tags dt WHERE dt.detective_id = d.id
    ), ARRAY[]::varchar[]) AS tags,
    COALESCE((
      SELECT array_agg(ds.source_id ORDER BY ds.source_id)
      FROM detective_sources ds WHERE ds.detective_id = d.id
    ), ARRAY[]::varchar[]) AS "sourceIds"
  FROM detectives d
`;

function toArchiveEntry(row: ArchiveRow) {
  return {
    id: row.id,
    collection: row.collection,
    category: row.category,
    names: {
      zh: row.nameZh,
      original: row.nameOriginal ?? row.nameZh,
      en: row.nameEn,
      aliases: row.aliases
    },
    region: row.region ?? "待核验",
    creatorName: row.creatorName,
    mediaTypes: row.mediaTypes,
    summary: row.summary,
    featuredWorks: row.featuredWorks,
    tags: row.tags,
    sourceIds: row.sourceIds,
    verification: row.verification
  };
}

function databaseFilter(options: ListArchiveOptions) {
  const clauses = [
    "d.status = 'PUBLISHED'",
    "d.catalog_collection IN ('ARCHIVE_EXTENSION', 'HISTORICAL_CASES')"
  ];
  const values: unknown[] = [];
  if (options.q) {
    values.push(`%${options.q}%`);
    clauses.push(`(
      d.catalog_id ILIKE $${values.length}
      OR d.name_zh ILIKE $${values.length}
      OR d.name_original ILIKE $${values.length}
      OR d.name_en ILIKE $${values.length}
      OR EXISTS (SELECT 1 FROM detective_aliases da WHERE da.detective_id = d.id AND da.alias ILIKE $${values.length})
      OR EXISTS (SELECT 1 FROM detective_tags dt WHERE dt.detective_id = d.id AND dt.tag ILIKE $${values.length})
      OR EXISTS (SELECT 1 FROM detective_featured_works dfw WHERE dfw.detective_id = d.id AND dfw.source_label ILIKE $${values.length})
      OR EXISTS (
        SELECT 1 FROM detective_creators dc
        JOIN creators c ON c.id = dc.creator_id
        WHERE dc.detective_id = d.id AND c.name_zh ILIKE $${values.length}
      )
    )`);
  }
  if (options.collection) {
    values.push(options.collection);
    clauses.push(`d.catalog_collection::text = $${values.length}`);
  }
  if (options.category) {
    values.push(options.category);
    clauses.push(`d.catalog_category = $${values.length}`);
  }
  return { where: clauses.join(" AND "), values };
}

async function databaseCoverage(database: DatabaseClient) {
  const result = await queryRows<{
    extensionCount: string;
    historicalCount: string;
    entryCount: string;
  }>(database, `
    SELECT
      COUNT(*) FILTER (WHERE catalog_collection = 'ARCHIVE_EXTENSION')::text AS "extensionCount",
      COUNT(*) FILTER (WHERE catalog_collection = 'HISTORICAL_CASES')::text AS "historicalCount",
      COUNT(*)::text AS "entryCount"
    FROM detectives
    WHERE status = 'PUBLISHED'
      AND catalog_collection IN ('ARCHIVE_EXTENSION', 'HISTORICAL_CASES')
  `);
  const row = result.rows[0];
  return {
    extensionCount: Number.parseInt(row?.extensionCount ?? "0", 10),
    historicalCount: Number.parseInt(row?.historicalCount ?? "0", 10),
    entryCount: Number.parseInt(row?.entryCount ?? "0", 10)
  };
}

export async function listArchiveEntries(
  database: DatabaseClient | undefined,
  options: ListArchiveOptions
) {
  if (!database) {
    const normalizedQuery = options.q?.toLocaleLowerCase("zh-CN");
    const filtered = fallbackDirectory.entries.filter((entry) => {
      const searchable = [
        entry.id,
        entry.names.zh,
        entry.names.original,
        entry.names.en,
        ...entry.names.aliases,
        entry.region,
        entry.creatorName,
        ...entry.featuredWorks,
        ...entry.tags
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return (!options.collection || entry.collection === options.collection)
        && (!options.category || entry.category === options.category)
        && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
    const start = (options.page - 1) * options.pageSize;
    return {
      data: filtered.slice(start, start + options.pageSize),
      total: filtered.length,
      coverage: fallbackDirectory.coverage,
      snapshotDate: fallbackDirectory.snapshotDate
    };
  }

  const { where, values } = databaseFilter(options);
  const [countResult, rows, coverage] = await Promise.all([
    queryRows<{ total: string }>(
      database,
      `SELECT COUNT(*)::text AS total FROM detectives d WHERE ${where}`,
      values
    ),
    queryRows<ArchiveRow>(
      database,
      `${archiveSelect} WHERE ${where} ORDER BY d.catalog_id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, options.pageSize, (options.page - 1) * options.pageSize]
    ),
    databaseCoverage(database)
  ]);
  return {
    data: rows.rows.map(toArchiveEntry),
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10),
    coverage,
    snapshotDate: fallbackDirectory.snapshotDate
  };
}

export async function getArchiveEntry(database: DatabaseClient | undefined, id: string) {
  if (!database) {
    const entry = fallbackDirectory.entries.find((item) => item.id === id);
    if (!entry) return null;
    return {
      data: entry,
      sources: fallbackDirectory.sources.filter((source) => entry.sourceIds.includes(source.id))
    };
  }

  const entryResult = await queryRows<ArchiveRow>(
    database,
    `${archiveSelect}
     WHERE d.status = 'PUBLISHED'
       AND d.catalog_collection IN ('ARCHIVE_EXTENSION', 'HISTORICAL_CASES')
       AND d.catalog_id = $1`,
    [id]
  );
  const row = entryResult.rows[0];
  if (!row) return null;
  const sourceResult = await queryRows<{
    id: string;
    label: string;
    url: string;
    quality: string;
  }>(database, `
    SELECT ds.source_id AS id, ds.source_label AS label,
      ds.source_url AS url, ds.source_quality AS quality
    FROM detective_sources ds
    JOIN detectives d ON d.id = ds.detective_id
    WHERE d.catalog_id = $1
    ORDER BY ds.source_id
  `, [id]);
  return { data: toArchiveEntry(row), sources: sourceResult.rows };
}

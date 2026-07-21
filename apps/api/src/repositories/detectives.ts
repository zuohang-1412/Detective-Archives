import { detectives as fallbackDetectives } from "../data/detectives.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

interface DetectiveRow {
  id: string;
  catalogId: string | null;
  slug: string;
  nameZh: string;
  nameOriginal: string | null;
  nameEn: string | null;
  country: string | null;
  era: string | null;
  subjectKind: string;
  collection: string;
  category: string | null;
  mediaTypes: string[];
  summary: string;
  verification: string;
  creatorName: string | null;
  aliases: string[];
  tags: string[];
  featuredCases: string[];
  sources: Array<{
    label: string;
    url: string;
    quality: string;
    verification: string;
  }>;
  works: Array<{
    id: string;
    slug: string;
    titleZh: string;
    titleOriginal: string | null;
    type: string;
    releaseYear: number | null;
    creatorName: string | null;
  }>;
}

export interface ListDetectivesOptions {
  q?: string | undefined;
  country?: string | undefined;
  era?: string | undefined;
  category?: string | undefined;
  subjectKind?: string | undefined;
  tag?: string | undefined;
  page: number;
  pageSize: number;
}

const detectiveSelect = `
  SELECT
    d.id,
    d.catalog_id AS "catalogId",
    d.slug,
    d.name_zh AS "nameZh",
    d.name_original AS "nameOriginal",
    d.name_en AS "nameEn",
    d.country,
    d.era,
    d.subject_kind::text AS "subjectKind",
    d.catalog_collection::text AS collection,
    d.catalog_category AS category,
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
      FROM detective_aliases da
      WHERE da.detective_id = d.id
    ), ARRAY[]::varchar[]) AS aliases,
    COALESCE((
      SELECT array_agg(dt.tag ORDER BY dt.tag)
      FROM detective_tags dt
      WHERE dt.detective_id = d.id
    ), ARRAY[]::varchar[]) AS tags,
    COALESCE((
      SELECT array_agg(feature.source_label ORDER BY feature.display_order, feature.source_label)
      FROM detective_featured_works feature
      WHERE feature.detective_id = d.id
    ), ARRAY[]::varchar[]) AS "featuredCases",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'label', source.source_label,
        'url', source.source_url,
        'quality', source.source_quality,
        'verification', source.verification::text
      ) ORDER BY source.source_id)
      FROM detective_sources source
      WHERE source.detective_id = d.id
    ), '[]'::jsonb) AS sources,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', w.id,
          'slug', w.slug,
          'titleZh', w.title_zh,
          'titleOriginal', w.title_original,
          'type', w.media_type::text,
          'releaseYear', w.release_year,
          'creatorName', (
            SELECT string_agg(wc_creator.name_zh, '、' ORDER BY wc_creator.name_zh)
            FROM work_creators wc
            JOIN creators wc_creator ON wc_creator.id = wc.creator_id
            WHERE wc.work_id = w.id
          )
        ) ORDER BY dw.recommendation_order NULLS LAST, w.release_year
      )
      FROM detective_works dw
      JOIN works w ON w.id = dw.work_id
      WHERE dw.detective_id = d.id AND w.status = 'PUBLISHED'
    ), '[]'::jsonb) AS works
  FROM detectives d
`;

function databaseFilter(options: ListDetectivesOptions) {
  const clauses = ["d.status = 'PUBLISHED'"];
  const values: unknown[] = [];
  if (options.q) {
    values.push(`%${options.q}%`);
    clauses.push(`(
      d.name_zh ILIKE $${values.length}
      OR d.name_original ILIKE $${values.length}
      OR d.name_en ILIKE $${values.length}
      OR EXISTS (
        SELECT 1 FROM detective_aliases da_search
        WHERE da_search.detective_id = d.id AND da_search.alias ILIKE $${values.length}
      )
      OR EXISTS (
        SELECT 1 FROM detective_tags dt_search
        WHERE dt_search.detective_id = d.id AND dt_search.tag ILIKE $${values.length}
      )
      OR EXISTS (
        SELECT 1
        FROM detective_creators dc_search
        JOIN creators c_search ON c_search.id = dc_search.creator_id
        WHERE dc_search.detective_id = d.id AND c_search.name_zh ILIKE $${values.length}
      )
    )`);
  }
  if (options.country) {
    values.push(options.country);
    clauses.push(`d.country = $${values.length}`);
  }
  if (options.era) {
    values.push(options.era);
    clauses.push(`d.era = $${values.length}`);
  }
  if (options.category) {
    values.push(options.category);
    clauses.push(`d.catalog_category = $${values.length}`);
  }
  if (options.subjectKind) {
    values.push(options.subjectKind);
    clauses.push(`d.subject_kind::text = $${values.length}`);
  }
  if (options.tag) {
    values.push(options.tag);
    clauses.push(`EXISTS (
      SELECT 1 FROM detective_tags dt_filter
      WHERE dt_filter.detective_id = d.id AND dt_filter.tag = $${values.length}
    )`);
  }
  return { where: clauses.join(" AND "), values };
}

export async function listDetectives(
  database: DatabaseClient | undefined,
  options: ListDetectivesOptions
) {
  if (!database) {
    const normalizedQuery = options.q?.toLocaleLowerCase("zh-CN");
    const filtered = fallbackDetectives.filter((detective) => {
      const searchable = [
        detective.nameZh,
        detective.nameOriginal,
        detective.creatorName,
        ...detective.tags
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return (!options.country || detective.country === options.country)
        && (!options.era || searchable.includes(options.era.toLocaleLowerCase("zh-CN")))
        && (!options.tag || detective.tags.includes(options.tag))
        && (!options.category)
        && (!options.subjectKind || options.subjectKind === "FICTIONAL")
        && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
    const start = (options.page - 1) * options.pageSize;
    return { data: filtered.slice(start, start + options.pageSize), total: filtered.length };
  }

  const { where, values } = databaseFilter(options);
  const countResult = await queryRows<{ total: string }>(
    database,
    `SELECT COUNT(*)::text AS total FROM detectives d WHERE ${where}`,
    values
  );
  const rows = await queryRows<DetectiveRow>(
    database,
    `${detectiveSelect}
     WHERE ${where}
     ORDER BY
       CASE d.catalog_collection WHEN 'CORE' THEN 0 WHEN 'ARCHIVE_EXTENSION' THEN 1 ELSE 2 END,
       d.catalog_id NULLS FIRST,
       d.name_zh
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, options.pageSize, (options.page - 1) * options.pageSize]
  );
  return {
    data: rows.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

export async function getDetectiveBySlug(
  database: DatabaseClient | undefined,
  slug: string
) {
  if (!database) {
    return fallbackDetectives.find((item) => item.slug === slug) ?? null;
  }
  const result = await queryRows<DetectiveRow>(
    database,
    `${detectiveSelect}
     WHERE d.status = 'PUBLISHED'
       AND (
         d.slug = $1
         OR EXISTS (
           SELECT 1 FROM detective_slug_redirects redirect
           WHERE redirect.detective_id = d.id AND redirect.old_slug = $1
         )
       )
     ORDER BY CASE WHEN d.slug = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [slug]
  );
  return result.rows[0] ?? null;
}

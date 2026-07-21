import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";
import { works as fallbackWorks } from "../data/works.js";

interface WorkRow {
  id: string;
  slug: string;
  titleZh: string;
  titleOriginal: string | null;
  type: string;
  releaseYear: number | null;
  summary: string | null;
  coverUrl: string | null;
  creators: Array<{ nameZh: string; creditType: string }>;
  detectives: Array<{ slug: string; nameZh: string }>;
  links: Array<{
    id: string;
    linkType: string;
    providerName: string;
    url: string;
    region: string;
    lastCheckedAt: string | null;
  }>;
}

export interface ListWorksOptions {
  q?: string | undefined;
  type?: string | undefined;
  page: number;
  pageSize: number;
}

const workSelect = `
  SELECT
    w.id,
    w.slug,
    w.title_zh AS "titleZh",
    w.title_original AS "titleOriginal",
    w.media_type::text AS type,
    w.release_year AS "releaseYear",
    w.summary,
    w.cover_url AS "coverUrl",
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('nameZh', c.name_zh, 'creditType', wc.credit_type)
        ORDER BY c.name_zh
      )
      FROM work_creators wc
      JOIN creators c ON c.id = wc.creator_id
      WHERE wc.work_id = w.id AND c.status = 'PUBLISHED'
    ), '[]'::jsonb) AS creators,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('slug', d.slug, 'nameZh', d.name_zh)
        ORDER BY dw.recommendation_order NULLS LAST, d.name_zh
      )
      FROM detective_works dw
      JOIN detectives d ON d.id = dw.detective_id
      WHERE dw.work_id = w.id AND d.status = 'PUBLISHED'
    ), '[]'::jsonb) AS detectives,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', wl.id,
          'linkType', wl.link_type::text,
          'providerName', wl.provider_name,
          'url', wl.url,
          'region', wl.region,
          'lastCheckedAt', wl.last_checked_at
        ) ORDER BY wl.provider_name
      )
      FROM work_links wl
      WHERE wl.work_id = w.id AND wl.is_active = TRUE
    ), '[]'::jsonb) AS links
  FROM works w
`;

function databaseFilter(options: ListWorksOptions) {
  const clauses = ["w.status = 'PUBLISHED'"];
  const values: unknown[] = [];

  if (options.q) {
    values.push(`%${options.q}%`);
    clauses.push(`(
      w.title_zh ILIKE $${values.length}
      OR w.title_original ILIKE $${values.length}
      OR EXISTS (
        SELECT 1
        FROM work_creators wc_search
        JOIN creators c_search ON c_search.id = wc_search.creator_id
        WHERE wc_search.work_id = w.id AND c_search.name_zh ILIKE $${values.length}
      )
    )`);
  }
  if (options.type) {
    values.push(options.type);
    clauses.push(`w.media_type::text = $${values.length}`);
  }

  return { where: clauses.join(" AND "), values };
}

export async function listWorks(
  database: DatabaseClient | undefined,
  options: ListWorksOptions
) {
  if (!database) {
    const normalizedQuery = options.q?.toLocaleLowerCase("zh-CN");
    const filtered = fallbackWorks.filter((work) => {
      const searchable = [
        work.titleZh,
        work.titleOriginal,
        ...work.creators.map((creator) => creator.nameZh),
        ...work.detectives.map((detective) => detective.nameZh)
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return (!options.type || work.type === options.type)
        && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
    const start = (options.page - 1) * options.pageSize;
    return {
      data: filtered.slice(start, start + options.pageSize),
      total: filtered.length
    };
  }

  const { where, values } = databaseFilter(options);
  const countResult = await queryRows<{ total: string }>(
    database,
    `SELECT COUNT(*)::text AS total FROM works w WHERE ${where}`,
    values
  );
  const pageValues = [...values, options.pageSize, (options.page - 1) * options.pageSize];
  const rows = await queryRows<WorkRow>(
    database,
    `${workSelect}
     WHERE ${where}
     ORDER BY w.published_at DESC NULLS LAST, w.title_zh
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    pageValues
  );
  return {
    data: rows.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

export async function getWorkBySlug(
  database: DatabaseClient | undefined,
  slug: string
) {
  if (!database) {
    return fallbackWorks.find((work) => work.slug === slug) ?? null;
  }

  const result = await queryRows<WorkRow>(
    database,
    `${workSelect} WHERE w.status = 'PUBLISHED' AND w.slug = $1`,
    [slug]
  );
  return result.rows[0] ?? null;
}

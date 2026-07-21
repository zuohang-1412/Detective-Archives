import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export type ProgressStatus =
  | "WISHLIST"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "PAUSED"
  | "DROPPED";

interface ShelfRow {
  id: string;
  workId: string;
  status: ProgressStatus;
  progressPercent: number;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  work: {
    id: string;
    slug: string;
    titleZh: string;
    titleOriginal: string | null;
    type: string;
    releaseYear: number | null;
    coverUrl: string | null;
    creatorNames: string[];
    isAvailable: boolean;
  };
}

const shelfSelect = `
  SELECT
    shelf.id,
    shelf.work_id AS "workId",
    shelf.status::text AS status,
    shelf.progress_percent AS "progressPercent",
    shelf.started_at AS "startedAt",
    shelf.completed_at AS "completedAt",
    shelf.updated_at AS "updatedAt",
    jsonb_build_object(
      'id', work.id,
      'slug', work.slug,
      'titleZh', work.title_zh,
      'titleOriginal', work.title_original,
      'type', work.media_type::text,
      'releaseYear', work.release_year,
      'coverUrl', work.cover_url,
      'isAvailable', work.status = 'PUBLISHED',
      'creatorNames', COALESCE((
        SELECT jsonb_agg(creator.name_zh ORDER BY creator.name_zh)
        FROM work_creators credit
        JOIN creators creator ON creator.id = credit.creator_id
        WHERE credit.work_id = work.id
      ), '[]'::jsonb)
    ) AS work
  FROM shelf_items shelf
  JOIN works work ON work.id = shelf.work_id
`;

export async function listShelfItems(
  database: DatabaseClient,
  userId: string,
  status: ProgressStatus | undefined,
  page: number,
  pageSize: number
) {
  const values: unknown[] = [userId];
  const clauses = ["shelf.user_id = $1"];
  if (status) {
    values.push(status);
    clauses.push(`shelf.status::text = $${values.length}`);
  }
  const countResult = await queryRows<{ total: string }>(database, `
    SELECT COUNT(*)::text AS total
    FROM shelf_items shelf
    JOIN works work ON work.id = shelf.work_id
    WHERE ${clauses.join(" AND ")}
  `, values);
  values.push(pageSize, (page - 1) * pageSize);
  const result = await queryRows<ShelfRow>(database, `
    ${shelfSelect}
    WHERE ${clauses.join(" AND ")}
    ORDER BY shelf.updated_at DESC, shelf.id
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);
  return {
    data: result.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

export async function getShelfItem(
  database: DatabaseClient,
  userId: string,
  workId: string
) {
  const result = await queryRows<ShelfRow>(database, `
    ${shelfSelect}
    WHERE shelf.user_id = $1 AND shelf.work_id = $2
  `, [userId, workId]);
  return result.rows[0] ?? null;
}

export async function upsertShelfItem(
  database: DatabaseClient,
  userId: string,
  workId: string,
  status: ProgressStatus,
  progressPercent?: number | undefined
) {
  const result = await queryRows<{ id: string }>(database, `
    WITH changed AS (
      INSERT INTO shelf_items (
        user_id, work_id, status, progress_percent, started_at, completed_at
      )
      SELECT
        $1,
        work.id,
        $3::progress_status,
        CASE WHEN $3 = 'COMPLETED' THEN 100 ELSE COALESCE($4, 0) END,
        CASE WHEN $3 = 'IN_PROGRESS' THEN NOW() ELSE NULL END,
        CASE WHEN $3 = 'COMPLETED' THEN NOW() ELSE NULL END
      FROM works work
      WHERE work.id = $2 AND work.status = 'PUBLISHED'
      ON CONFLICT (user_id, work_id) DO UPDATE SET
        status = EXCLUDED.status,
        progress_percent = CASE
          WHEN EXCLUDED.status = 'COMPLETED' THEN 100
          ELSE COALESCE($4, shelf_items.progress_percent)
        END,
        started_at = CASE
          WHEN EXCLUDED.status = 'IN_PROGRESS' THEN COALESCE(shelf_items.started_at, NOW())
          ELSE shelf_items.started_at
        END,
        completed_at = CASE WHEN EXCLUDED.status = 'COMPLETED' THEN NOW() ELSE NULL END,
        updated_at = NOW()
      RETURNING id, user_id, work_id, completed_at
    ), engagement AS (
      INSERT INTO shelf_engagement_facts (
        user_id, work_id, first_added_at, first_completed_at
      )
      SELECT user_id, work_id, NOW(), completed_at FROM changed
      ON CONFLICT (user_id, work_id) DO UPDATE
      SET first_added_at = LEAST(
          shelf_engagement_facts.first_added_at,
          EXCLUDED.first_added_at
        ),
        first_completed_at = COALESCE(
          shelf_engagement_facts.first_completed_at,
          EXCLUDED.first_completed_at
        )
    )
    SELECT id FROM changed
  `, [userId, workId, status, progressPercent ?? null]);
  if (!result.rows[0]) return null;
  return getShelfItem(database, userId, workId);
}

export async function removeShelfItem(
  database: DatabaseClient,
  userId: string,
  workId: string
) {
  const result = await queryRows<{ id: string }>(database, `
    DELETE FROM shelf_items
    WHERE user_id = $1 AND work_id = $2
    RETURNING id
  `, [userId, workId]);
  return Boolean(result.rows[0]);
}

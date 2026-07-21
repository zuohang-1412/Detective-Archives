import { withTransaction } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export async function getAdminDashboard(database: DatabaseClient) {
  const result = await queryRows<{
    userCount: number;
    publishedDetectiveCount: number;
    publishedWorkCount: number;
    pendingReviewCount: number;
    pendingCommentCount: number;
    openReportCount: number;
    activeLinkCount: number;
    brokenLinkCount: number;
    unconfirmedLinkCount: number;
    staleLinkCount: number;
    openLinkFeedbackCount: number;
  }>(database, `
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE is_active = TRUE) AS "userCount",
      (SELECT COUNT(*)::int FROM detectives WHERE status = 'PUBLISHED') AS "publishedDetectiveCount",
      (SELECT COUNT(*)::int FROM works WHERE status = 'PUBLISHED') AS "publishedWorkCount",
      (SELECT COUNT(*)::int FROM reviews WHERE status = 'PENDING_REVIEW' AND deleted_at IS NULL) AS "pendingReviewCount",
      (SELECT COUNT(*)::int FROM comments WHERE status = 'PENDING_REVIEW' AND deleted_at IS NULL) AS "pendingCommentCount",
      (SELECT COUNT(*)::int FROM reports WHERE status IN ('OPEN', 'PROCESSING')) AS "openReportCount",
      (SELECT COUNT(*)::int FROM work_links WHERE is_active = TRUE) AS "activeLinkCount",
      (SELECT COUNT(*)::int FROM work_links
        WHERE is_active = TRUE AND last_check_ok = FALSE) AS "brokenLinkCount",
      (SELECT COUNT(*)::int FROM work_links
        WHERE is_active = TRUE
          AND last_check_ok IS NULL
          AND last_checked_at IS NOT NULL
          AND last_check_error IS NOT NULL) AS "unconfirmedLinkCount",
      (SELECT COUNT(*)::int FROM work_links
        WHERE is_active = TRUE
          AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '90 days')) AS "staleLinkCount",
      (SELECT COUNT(*)::int FROM work_link_feedback
        WHERE status = 'OPEN') AS "openLinkFeedbackCount"
  `);
  return result.rows[0];
}

export async function getModerationQueue(database: DatabaseClient) {
  const [reviewResult, commentResult, reportResult] = await Promise.all([
    queryRows(database, `
      SELECT
        review.id,
        review.review_type::text AS "reviewType",
        review.title,
        review.body,
        review.rating,
        review.contains_spoiler AS "containsSpoiler",
        review.created_at AS "createdAt",
        jsonb_build_object('id', author.id, 'displayName', author.display_name) AS author,
        jsonb_build_object('id', work.id, 'slug', work.slug, 'titleZh', work.title_zh) AS work
      FROM reviews review
      JOIN users author ON author.id = review.user_id
      JOIN works work ON work.id = review.work_id
      WHERE review.status = 'PENDING_REVIEW' AND review.deleted_at IS NULL
      ORDER BY review.created_at
      LIMIT 100
    `),
    queryRows(database, `
      SELECT
        comment.id,
        comment.review_id AS "reviewId",
        comment.body,
        comment.contains_spoiler AS "containsSpoiler",
        comment.created_at AS "createdAt",
        jsonb_build_object('id', author.id, 'displayName', author.display_name) AS author,
        jsonb_build_object(
          'id', review.id,
          'title', review.title,
          'body', LEFT(review.body, 160)
        ) AS review
      FROM comments comment
      JOIN users author ON author.id = comment.user_id
      JOIN reviews review ON review.id = comment.review_id
      WHERE comment.status = 'PENDING_REVIEW' AND comment.deleted_at IS NULL
      ORDER BY comment.created_at
      LIMIT 100
    `),
    queryRows(database, `
      SELECT
        report.id,
        report.target_type AS "targetType",
        report.target_id AS "targetId",
        report.reason_code AS "reasonCode",
        report.description,
        report.status::text AS status,
        report.created_at AS "createdAt",
        jsonb_build_object('id', reporter.id, 'displayName', reporter.display_name) AS reporter,
        CASE
          WHEN report.target_type = 'REVIEW' THEN (
            SELECT LEFT(review.body, 300) FROM reviews review WHERE review.id = report.target_id
          )
          WHEN report.target_type = 'COMMENT' THEN (
            SELECT LEFT(comment.body, 300) FROM comments comment WHERE comment.id = report.target_id
          )
        END AS "targetPreview"
      FROM reports report
      JOIN users reporter ON reporter.id = report.reporter_id
      WHERE report.status IN ('OPEN', 'PROCESSING')
      ORDER BY report.created_at
      LIMIT 100
    `)
  ]);
  return {
    reviews: reviewResult.rows,
    comments: commentResult.rows,
    reports: reportResult.rows
  };
}

export async function moderateContent(
  database: DatabaseClient,
  moderatorId: string,
  targetType: "REVIEW" | "COMMENT",
  targetId: string,
  action: "PUBLISH" | "HIDE" | "RESTORE" | "REJECT",
  reason: string,
  requestId: string
) {
  const table = targetType === "REVIEW" ? "reviews" : "comments";
  const status = action === "PUBLISH" || action === "RESTORE" ? "PUBLISHED" : "HIDDEN";
  return withTransaction(database, async (connection) => {
    const changed = await queryRows<{ id: string; status: string }>(connection, `
      UPDATE ${table}
      SET status = $2::content_status,
        published_at = CASE
          WHEN $2::text = 'PUBLISHED' THEN COALESCE(published_at, NOW())
          ELSE published_at
        END,
        updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, status::text
    `, [targetId, status]);
    const content = changed.rows[0];
    if (!content) return null;
    await connection.query(`
      INSERT INTO moderation_records (moderator_id, target_type, target_id, action, reason)
      VALUES ($1, $2, $3, $4, $5)
    `, [moderatorId, targetType, targetId, action, reason]);
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, jsonb_build_object('reason', $6::text))
    `, [moderatorId, `MODERATION_${action}`, targetType, targetId, requestId, reason]);
    return content;
  });
}

export async function handleReport(
  database: DatabaseClient,
  moderatorId: string,
  reportId: string,
  status: "PROCESSING" | "RESOLVED" | "REJECTED",
  resolutionNote: string,
  requestId: string
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    WITH changed AS (
      UPDATE reports
      SET status = $3::report_status,
        handled_by = $1,
        handled_at = CASE WHEN $3::text IN ('RESOLVED', 'REJECTED') THEN NOW() ELSE NULL END,
        resolution_note = $4
      WHERE id = $2 AND status IN ('OPEN', 'PROCESSING')
      RETURNING id, status::text
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      )
      SELECT $1, 'REPORT_' || $3::text, 'REPORT', id, $5,
        jsonb_build_object('resolutionNote', $4::text)
      FROM changed
    )
    SELECT id, status FROM changed
  `, [moderatorId, reportId, status, resolutionNote, requestId]);
  return result.rows[0] ?? null;
}

export async function suspendUser(
  database: DatabaseClient,
  moderatorId: string,
  userId: string,
  durationHours: number,
  reason: string,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const result = await queryRows<{ id: string; suspendedUntil: string }>(connection, `
      UPDATE users
      SET suspended_until = NOW() + ($2::text || ' hours')::interval,
        updated_at = NOW()
      WHERE id = $1 AND role = 'USER'
      RETURNING id, suspended_until AS "suspendedUntil"
    `, [userId, durationHours]);
    const user = result.rows[0];
    if (!user) return null;
    await connection.query(`
      INSERT INTO moderation_records (moderator_id, target_type, target_id, action, reason)
      VALUES ($1, 'USER', $2, 'SUSPEND_USER', $3)
    `, [moderatorId, userId, reason]);
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'USER_SUSPEND', 'USER', $2, $3,
        jsonb_build_object('reason', $4::text, 'durationHours', $5::int)
      )
    `, [moderatorId, userId, requestId, reason, durationHours]);
    return user;
  });
}

export interface AdminWorkInput {
  slug: string;
  titleZh: string;
  titleOriginal?: string | undefined;
  mediaType: string;
  releaseYear?: number | undefined;
  summary?: string | undefined;
  coverUrl?: string | undefined;
  creatorName?: string | undefined;
}

export async function listAdminWorks(database: DatabaseClient, query?: string | undefined) {
  const result = await queryRows(database, `
    SELECT
      work.id,
      work.slug,
      work.title_zh AS "titleZh",
      work.title_original AS "titleOriginal",
      work.media_type::text AS "mediaType",
      work.release_year AS "releaseYear",
      work.summary,
      work.cover_url AS "coverUrl",
      work.status::text AS status,
      work.updated_at AS "updatedAt",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', link.id,
          'linkType', link.link_type::text,
          'providerName', link.provider_name,
          'url', link.url,
          'region', link.region,
          'isActive', link.is_active,
          'lastCheckedAt', link.last_checked_at,
          'lastCheckOk', link.last_check_ok,
          'lastStatusCode', link.last_status_code,
          'lastCheckError', link.last_check_error,
          'consecutiveFailures', link.consecutive_failures,
          'clickCount', (
            SELECT COUNT(*)::int FROM work_link_click_events click
            WHERE click.work_link_id = link.id
          ),
          'openFeedbackCount', (
            SELECT COUNT(*)::int FROM work_link_feedback feedback
            WHERE feedback.work_link_id = link.id AND feedback.status = 'OPEN'
          )
        ) ORDER BY link.provider_name)
        FROM work_links link WHERE link.work_id = work.id
      ), '[]'::jsonb) AS links
    FROM works work
    WHERE $1::text IS NULL
      OR work.title_zh ILIKE '%' || $1 || '%'
      OR work.title_original ILIKE '%' || $1 || '%'
      OR work.slug ILIKE '%' || $1 || '%'
    ORDER BY work.updated_at DESC
    LIMIT 200
  `, [query ?? null]);
  return result.rows;
}

async function replaceWorkCreator(
  connection: { query(sql: string, values?: unknown[]): Promise<unknown> },
  workId: string,
  creatorName?: string | undefined
) {
  if (!creatorName) return;
  const creator = await queryRows<{ id: string }>(connection, `
    INSERT INTO creators (name_zh, status)
    VALUES ($1, 'PUBLISHED')
    ON CONFLICT (name_zh) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [creatorName]);
  await connection.query("DELETE FROM work_creators WHERE work_id = $1 AND credit_type = 'AUTHOR'", [workId]);
  await connection.query(`
    INSERT INTO work_creators (work_id, creator_id, credit_type)
    VALUES ($1, $2, 'AUTHOR')
  `, [workId, creator.rows[0]?.id]);
}

export async function createAdminWork(
  database: DatabaseClient,
  actorId: string,
  input: AdminWorkInput,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const result = await queryRows<{ id: string }>(connection, `
      INSERT INTO works (
        slug, title_zh, title_original, media_type, release_year,
        summary, cover_url, status, source_note
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', 'Created in operations console')
      RETURNING id
    `, [
      input.slug,
      input.titleZh,
      input.titleOriginal ?? null,
      input.mediaType,
      input.releaseYear ?? null,
      input.summary ?? null,
      input.coverUrl ?? null
    ]);
    const work = result.rows[0];
    if (!work) throw new Error("Work creation did not return a record");
    await replaceWorkCreator(connection, work.id, input.creatorName);
    await connection.query(`
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      VALUES ($1, 'WORK_CREATE', 'WORK', $2, $3)
    `, [actorId, work.id, requestId]);
    return work;
  });
}

export async function updateAdminWork(
  database: DatabaseClient,
  actorId: string,
  workId: string,
  input: AdminWorkInput,
  requestId: string,
  draftOnly: boolean
) {
  return withTransaction(database, async (connection) => {
    const result = await queryRows<{ id: string }>(connection, `
      UPDATE works
      SET slug = $2,
        title_zh = $3,
        title_original = $4,
        media_type = $5,
        release_year = $6,
        summary = $7,
        cover_url = $8,
        status = CASE
          WHEN $9::boolean AND status = 'PENDING_REVIEW' THEN 'DRAFT'::content_status
          ELSE status
        END,
        updated_at = NOW()
      WHERE id = $1
        AND (NOT $9::boolean OR status IN ('DRAFT', 'PENDING_REVIEW'))
      RETURNING id
    `, [
      workId,
      input.slug,
      input.titleZh,
      input.titleOriginal ?? null,
      input.mediaType,
      input.releaseYear ?? null,
      input.summary ?? null,
      input.coverUrl ?? null,
      draftOnly
    ]);
    if (!result.rows[0]) return null;
    await replaceWorkCreator(connection, workId, input.creatorName);
    await connection.query(`
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      VALUES ($1, 'WORK_UPDATE', 'WORK', $2, $3)
    `, [actorId, workId, requestId]);
    return result.rows[0];
  });
}

export async function setAdminWorkStatus(
  database: DatabaseClient,
  actorId: string,
  workId: string,
  status: "DRAFT" | "PENDING_REVIEW" | "PUBLISHED" | "HIDDEN" | "ARCHIVED",
  requestId: string
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    WITH changed AS (
      UPDATE works
      SET status = $3::content_status,
        published_at = CASE WHEN $3::text = 'PUBLISHED' THEN COALESCE(published_at, NOW()) ELSE published_at END,
        updated_at = NOW()
      WHERE id = $2
        AND CASE $3::text
          WHEN 'DRAFT' THEN status = 'PENDING_REVIEW'
          WHEN 'PENDING_REVIEW' THEN status = 'DRAFT'
          WHEN 'PUBLISHED' THEN status IN ('PENDING_REVIEW', 'HIDDEN')
          WHEN 'HIDDEN' THEN status = 'PUBLISHED'
          WHEN 'ARCHIVED' THEN status IN ('PUBLISHED', 'HIDDEN')
          ELSE FALSE
        END
      RETURNING id, status::text
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'WORK_STATUS_' || $3::text, 'WORK', id, $4 FROM changed
    )
    SELECT id, status FROM changed
  `, [actorId, workId, status, requestId]);
  return result.rows[0] ?? null;
}

export async function createAdminWorkLink(
  database: DatabaseClient,
  actorId: string,
  workId: string,
  input: {
    linkType: string;
    providerName: string;
    url: string;
    region: string;
  },
  requestId: string,
  isActive: boolean
) {
  const result = await queryRows<{ id: string; isActive: boolean }>(database, `
    WITH created AS (
      INSERT INTO work_links (
        work_id, link_type, provider_name, url, region, is_active, last_checked_at
      )
      SELECT id, $3, $4, $5, $6, $7, NOW()
      FROM works WHERE id = $2
      RETURNING id, is_active AS "isActive"
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'WORK_LINK_CREATE', 'WORK_LINK', id, $8 FROM created
    )
    SELECT id, "isActive" FROM created
  `, [
    actorId,
    workId,
    input.linkType,
    input.providerName,
    input.url,
    input.region,
    isActive,
    requestId
  ]);
  return result.rows[0] ?? null;
}

export async function setAdminWorkLinkActive(
  database: DatabaseClient,
  actorId: string,
  linkId: string,
  isActive: boolean,
  requestId: string
) {
  const result = await queryRows<{ id: string; isActive: boolean }>(database, `
    WITH changed AS (
      UPDATE work_links
      SET is_active = $3, updated_at = NOW()
      WHERE id = $2
      RETURNING id, is_active AS "isActive"
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      )
      SELECT $1, 'WORK_LINK_STATUS', 'WORK_LINK', id, $4,
        jsonb_build_object('isActive', $3::boolean)
      FROM changed
    )
    SELECT id, "isActive" FROM changed
  `, [actorId, linkId, isActive, requestId]);
  return result.rows[0] ?? null;
}

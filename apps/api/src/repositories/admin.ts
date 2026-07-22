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
    openAppealCount: number;
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
      (SELECT COUNT(*)::int FROM content_appeals WHERE status = 'OPEN') AS "openAppealCount",
      (SELECT COUNT(*)::int FROM work_links WHERE is_active = TRUE) AS "activeLinkCount",
      (SELECT COUNT(*)::int FROM work_links
        WHERE is_active = TRUE AND last_check_ok = FALSE) AS "brokenLinkCount",
      (SELECT COUNT(*)::int FROM work_links
        WHERE is_active = TRUE
          AND last_check_ok IS NULL
          AND last_checked_at IS NOT NULL
          AND last_check_error IS NOT NULL
          AND NOT (
            manual_review_status = 'VERIFIED'
            AND manual_reviewed_at >= NOW() - INTERVAL '90 days'
          )) AS "unconfirmedLinkCount",
      (SELECT COUNT(*)::int FROM work_links
        WHERE is_active = TRUE
          AND last_check_ok IS DISTINCT FROM FALSE
          AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '90 days')
          AND NOT (
            manual_review_status = 'VERIFIED'
            AND manual_reviewed_at >= NOW() - INTERVAL '90 days'
          )) AS "staleLinkCount",
      (SELECT COUNT(*)::int FROM work_link_feedback
        WHERE status = 'OPEN') AS "openLinkFeedbackCount"
  `);
  return result.rows[0];
}

export async function getModerationQueue(
  database: DatabaseClient,
  page: number,
  pageSize: number
) {
  const offset = (page - 1) * pageSize;
  const [
    reviewCount,
    commentCount,
    reportCount,
    appealCount,
    reviewResult,
    commentResult,
    reportResult,
    appealResult
  ] = await Promise.all([
    queryRows<{ total: number }>(database, `
      SELECT COUNT(*)::int AS total FROM reviews
      WHERE status = 'PENDING_REVIEW' AND deleted_at IS NULL
    `),
    queryRows<{ total: number }>(database, `
      SELECT COUNT(*)::int AS total FROM comments
      WHERE status = 'PENDING_REVIEW' AND deleted_at IS NULL
    `),
    queryRows<{ total: number }>(database, `
      SELECT COUNT(*)::int AS total FROM reports
      WHERE status IN ('OPEN', 'PROCESSING')
    `),
    queryRows<{ total: number }>(database, `
      SELECT COUNT(*)::int AS total FROM content_appeals
      WHERE status = 'OPEN'
    `),
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
      ORDER BY review.created_at, review.id
      LIMIT $1 OFFSET $2
    `, [pageSize, offset]),
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
      ORDER BY comment.created_at, comment.id
      LIMIT $1 OFFSET $2
    `, [pageSize, offset]),
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
        END AS "targetPreview",
        COALESCE(CASE
          WHEN report.target_type = 'REVIEW' THEN (
            SELECT review.contains_spoiler FROM reviews review WHERE review.id = report.target_id
          )
          WHEN report.target_type = 'COMMENT' THEN (
            SELECT comment.contains_spoiler FROM comments comment WHERE comment.id = report.target_id
          )
        END, FALSE) AS "targetContainsSpoiler"
      FROM reports report
      JOIN users reporter ON reporter.id = report.reporter_id
      WHERE report.status IN ('OPEN', 'PROCESSING')
      ORDER BY report.created_at, report.id
      LIMIT $1 OFFSET $2
    `, [pageSize, offset]),
    queryRows(database, `
      SELECT
        appeal.id,
        appeal.target_type AS "targetType",
        appeal.target_id AS "targetId",
        appeal.reason,
        appeal.status::text AS status,
        appeal.created_at AS "createdAt",
        jsonb_build_object(
          'id', appellant.id,
          'displayName', appellant.display_name
        ) AS appellant,
        CASE
          WHEN appeal.target_type = 'REVIEW' THEN (
            SELECT LEFT(review.body, 300) FROM reviews review
            WHERE review.id = appeal.target_id
          )
          WHEN appeal.target_type = 'COMMENT' THEN (
            SELECT LEFT(comment.body, 300) FROM comments comment
            WHERE comment.id = appeal.target_id
          )
        END AS "targetPreview"
      FROM content_appeals appeal
      JOIN users appellant ON appellant.id = appeal.appellant_id
      WHERE appeal.status = 'OPEN'
      ORDER BY appeal.created_at, appeal.id
      LIMIT $1 OFFSET $2
    `, [pageSize, offset])
  ]);
  return {
    reviews: reviewResult.rows,
    comments: commentResult.rows,
    reports: reportResult.rows,
    appeals: appealResult.rows,
    reviewTotal: reviewCount.rows[0]?.total ?? 0,
    commentTotal: commentCount.rows[0]?.total ?? 0,
    reportTotal: reportCount.rows[0]?.total ?? 0,
    appealTotal: appealCount.rows[0]?.total ?? 0
  };
}

export async function moderateContent(
  database: DatabaseClient,
  moderatorId: string,
  targetType: "REVIEW" | "COMMENT",
  targetId: string,
  action: "PUBLISH" | "HIDE" | "RESTORE" | "REJECT" | "MARK_SPOILER" | "UNMARK_SPOILER",
  reason: string,
  requestId: string
) {
  const table = targetType === "REVIEW" ? "reviews" : "comments";
  if (action === "MARK_SPOILER" || action === "UNMARK_SPOILER") {
    const containsSpoiler = action === "MARK_SPOILER";
    return withTransaction(database, async (connection) => {
      const currentResult = await queryRows<{
        id: string;
        status: string;
        containsSpoiler: boolean;
      }>(connection, `
        SELECT
          id,
          status::text AS status,
          contains_spoiler AS "containsSpoiler"
        FROM ${table}
        WHERE id = $1
          AND deleted_at IS NULL
          AND status IN ('PENDING_REVIEW', 'PUBLISHED', 'HIDDEN')
        FOR UPDATE
      `, [targetId]);
      const current = currentResult.rows[0];
      if (!current) return null;
      if (current.containsSpoiler === containsSpoiler) {
        return { ...current, unchanged: true };
      }

      const changedResult = await queryRows<{
        id: string;
        status: string;
        containsSpoiler: boolean;
      }>(connection, `
        UPDATE ${table}
        SET contains_spoiler = $2,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          status::text AS status,
          contains_spoiler AS "containsSpoiler"
      `, [targetId, containsSpoiler]);
      const changed = changedResult.rows[0];
      if (!changed) return null;
      await connection.query(`
        INSERT INTO moderation_records (moderator_id, target_type, target_id, action, reason)
        VALUES ($1, $2, $3, $4, $5)
      `, [moderatorId, targetType, targetId, action, reason]);
      await connection.query(`
        INSERT INTO audit_logs (
          actor_id, action, resource_type, resource_id, request_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5,
          jsonb_build_object(
            'reason', $6::text,
            'previousContainsSpoiler', $7::boolean,
            'containsSpoiler', $8::boolean
          )
        )
      `, [
        moderatorId,
        `MODERATION_${action}`,
        targetType,
        targetId,
        requestId,
        reason,
        current.containsSpoiler,
        containsSpoiler
      ]);
      return { ...changed, unchanged: false };
    });
  }
  const status = action === "PUBLISH" || action === "RESTORE"
    ? "PUBLISHED"
    : action === "REJECT"
      ? "REJECTED"
      : "HIDDEN";
  return withTransaction(database, async (connection) => {
    const changed = await queryRows<{ id: string; status: string }>(connection, `
      UPDATE ${table}
      SET status = $2::content_status,
        published_at = CASE
          WHEN $2::text = 'PUBLISHED' THEN COALESCE(published_at, NOW())
          ELSE published_at
        END,
        updated_at = NOW()
      WHERE id = $1
        AND deleted_at IS NULL
        AND CASE $3::text
          WHEN 'PUBLISH' THEN status = 'PENDING_REVIEW'
          WHEN 'REJECT' THEN status = 'PENDING_REVIEW'
          WHEN 'HIDE' THEN status = 'PUBLISHED'
          WHEN 'RESTORE' THEN status = 'HIDDEN'
          ELSE FALSE
        END
      RETURNING id, status::text
    `, [targetId, status, action]);
    const content = changed.rows[0];
    if (!content) return null;
    if (action === "RESTORE") {
      await connection.query(`
        UPDATE content_appeals
        SET status = 'APPROVED',
          handled_by = $1,
          handled_at = NOW(),
          resolution_note = $4,
          updated_at = NOW()
        WHERE target_type = $2
          AND target_id = $3
          AND status = 'OPEN'
      `, [moderatorId, targetType, targetId, reason]);
    }
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

export async function listAdminWorks(
  database: DatabaseClient,
  options: { q?: string | undefined; page: number; pageSize: number }
) {
  const count = await queryRows<{ total: number }>(database, `
    SELECT COUNT(*)::int AS total
    FROM works work
    WHERE $1::text IS NULL
      OR work.title_zh ILIKE '%' || $1 || '%'
      OR work.title_original ILIKE '%' || $1 || '%'
      OR work.slug ILIKE '%' || $1 || '%'
  `, [options.q ?? null]);
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
          'manualReviewStatus', link.manual_review_status,
          'manualReviewNote', link.manual_review_note,
          'manualReviewEvidence', link.manual_review_evidence,
          'manualReviewedAt', link.manual_reviewed_at,
          'manualReviewer', (
            SELECT jsonb_build_object('id', reviewer.id, 'displayName', reviewer.display_name)
            FROM users reviewer WHERE reviewer.id = link.manual_reviewer_id
          ),
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
    ORDER BY work.updated_at DESC, work.id
    LIMIT $2 OFFSET $3
  `, [options.q ?? null, options.pageSize, (options.page - 1) * options.pageSize]);
  return { data: result.rows, total: count.rows[0]?.total ?? 0 };
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

const workLinkReviewPredicate = `
  link.is_active = TRUE
  AND (
    link.last_check_ok = FALSE
    OR link.last_checked_at IS NULL
    OR link.last_checked_at < NOW() - INTERVAL '90 days'
    OR (link.last_check_ok IS NULL AND link.last_check_error IS NOT NULL)
  )
  AND (
    link.last_check_ok = FALSE
    OR link.manual_review_status IS DISTINCT FROM 'VERIFIED'
    OR link.manual_reviewed_at IS NULL
    OR link.manual_reviewed_at < NOW() - INTERVAL '90 days'
  )
`;

export async function listAdminWorkLinkReviews(
  database: DatabaseClient,
  options: { q?: string | undefined; page: number; pageSize: number }
) {
  const count = await queryRows<{ total: number }>(database, `
    SELECT COUNT(*)::int AS total
    FROM work_links link
    JOIN works work ON work.id = link.work_id
    WHERE work.status = 'PUBLISHED' AND ${workLinkReviewPredicate}
      AND (
        $1::text IS NULL
        OR work.title_zh ILIKE '%' || $1 || '%'
        OR work.slug ILIKE '%' || $1 || '%'
        OR link.provider_name ILIKE '%' || $1 || '%'
      )
  `, [options.q ?? null]);
  const result = await queryRows(database, `
    SELECT
      link.id,
      link.provider_name AS "providerName",
      link.url,
      link.region,
      link.last_checked_at AS "lastCheckedAt",
      link.last_check_ok AS "lastCheckOk",
      link.last_status_code AS "lastStatusCode",
      link.last_check_error AS "lastCheckError",
      link.consecutive_failures AS "consecutiveFailures",
      link.manual_review_status AS "manualReviewStatus",
      link.manual_review_note AS "manualReviewNote",
      link.manual_review_evidence AS "manualReviewEvidence",
      link.manual_reviewed_at AS "manualReviewedAt",
      CASE
        WHEN link.last_check_ok = FALSE THEN 'BROKEN'
        WHEN link.last_checked_at IS NULL THEN 'NEVER_CHECKED'
        WHEN link.last_checked_at < NOW() - INTERVAL '90 days' THEN 'STALE'
        ELSE 'UNCONFIRMED'
      END AS "reviewState",
      jsonb_build_object('id', work.id, 'slug', work.slug, 'titleZh', work.title_zh) AS work,
      (
        SELECT jsonb_build_object('id', reviewer.id, 'displayName', reviewer.display_name)
        FROM users reviewer WHERE reviewer.id = link.manual_reviewer_id
      ) AS "manualReviewer"
    FROM work_links link
    JOIN works work ON work.id = link.work_id
    WHERE work.status = 'PUBLISHED' AND ${workLinkReviewPredicate}
      AND (
        $1::text IS NULL
        OR work.title_zh ILIKE '%' || $1 || '%'
        OR work.slug ILIKE '%' || $1 || '%'
        OR link.provider_name ILIKE '%' || $1 || '%'
      )
    ORDER BY
      CASE
        WHEN link.last_check_ok = FALSE THEN 0
        WHEN link.last_checked_at IS NULL THEN 1
        WHEN link.last_checked_at < NOW() - INTERVAL '90 days' THEN 2
        ELSE 3
      END,
      link.last_checked_at ASC NULLS FIRST,
      link.id
    LIMIT $2 OFFSET $3
  `, [options.q ?? null, options.pageSize, (options.page - 1) * options.pageSize]);
  return { data: result.rows, total: count.rows[0]?.total ?? 0 };
}

export async function reviewAdminWorkLink(
  database: DatabaseClient,
  actorId: string,
  linkId: string,
  input: {
    decision: "VERIFIED" | "REJECTED";
    note: string;
    evidenceReference: string;
  },
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const existingResult = await queryRows<{
      id: string;
      isActive: boolean;
      manualReviewStatus: string | null;
      manualReviewNote: string | null;
      manualReviewEvidence: string | null;
      manualReviewerId: string | null;
      lastCheckOk: boolean | null;
    }>(connection, `
      SELECT
        id,
        is_active AS "isActive",
        manual_review_status AS "manualReviewStatus",
        manual_review_note AS "manualReviewNote",
        manual_review_evidence AS "manualReviewEvidence",
        manual_reviewer_id AS "manualReviewerId",
        last_check_ok AS "lastCheckOk"
      FROM work_links
      WHERE id = $1
      FOR UPDATE
    `, [linkId]);
    const existing = existingResult.rows[0];
    if (!existing) return { kind: "NOT_FOUND" as const };
    if (input.decision === "VERIFIED" && !existing.isActive) {
      return { kind: "INACTIVE" as const };
    }
    if (input.decision === "VERIFIED" && existing.lastCheckOk === false) {
      return { kind: "AUTOMATICALLY_BROKEN" as const };
    }
    const unchanged = existing.manualReviewStatus === input.decision
      && existing.manualReviewNote === input.note
      && existing.manualReviewEvidence === input.evidenceReference
      && existing.manualReviewerId === actorId;
    if (unchanged) {
      return {
        kind: "REVIEWED" as const,
        review: { id: existing.id, isActive: existing.isActive, decision: input.decision },
        unchanged: true
      };
    }
    const changed = await queryRows<{
      id: string;
      isActive: boolean;
      decision: "VERIFIED" | "REJECTED";
      reviewedAt: string;
    }>(connection, `
      UPDATE work_links
      SET manual_review_status = $3::text,
        manual_review_note = $4,
        manual_review_evidence = $5,
        manual_reviewed_at = NOW(),
        manual_reviewer_id = $1,
        is_active = CASE WHEN $3::text = 'REJECTED' THEN FALSE ELSE is_active END,
        updated_at = NOW()
      WHERE id = $2
      RETURNING
        id,
        is_active AS "isActive",
        manual_review_status AS decision,
        manual_reviewed_at AS "reviewedAt"
    `, [actorId, linkId, input.decision, input.note, input.evidenceReference]);
    const review = changed.rows[0];
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'WORK_LINK_MANUAL_' || $3::text, 'WORK_LINK', $2, $6,
        jsonb_build_object(
          'decision', $3::text,
          'note', $4::text,
          'evidenceReference', $5::text
        )
      )
    `, [actorId, linkId, input.decision, input.note, input.evidenceReference, requestId]);
    return { kind: "REVIEWED" as const, review, unchanged: false };
  });
}

export async function setAdminWorkLinkActive(
  database: DatabaseClient,
  actorId: string,
  linkId: string,
  isActive: boolean,
  requestId: string
) {
  const result = await queryRows<{ id: string; isActive: boolean }>(database, `
    WITH current AS (
      SELECT id, is_active
      FROM work_links
      WHERE id = $2
      FOR UPDATE
    ), changed AS (
      UPDATE work_links link
      SET is_active = $3,
        manual_review_status = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.manual_review_status END,
        manual_review_note = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.manual_review_note END,
        manual_review_evidence = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.manual_review_evidence END,
        manual_reviewed_at = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.manual_reviewed_at END,
        manual_reviewer_id = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.manual_reviewer_id END,
        last_checked_at = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.last_checked_at END,
        last_status_code = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.last_status_code END,
        last_check_ok = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.last_check_ok END,
        last_check_error = CASE WHEN $3 AND current.is_active = FALSE THEN NULL ELSE link.last_check_error END,
        consecutive_failures = CASE WHEN $3 AND current.is_active = FALSE THEN 0 ELSE link.consecutive_failures END,
        updated_at = NOW()
      FROM current
      WHERE link.id = current.id
      RETURNING
        link.id,
        link.is_active AS "isActive",
        ($3::boolean AND current.is_active = FALSE) AS "verificationReset"
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      )
      SELECT $1, 'WORK_LINK_STATUS', 'WORK_LINK', id, $4,
        jsonb_build_object(
          'isActive', $3::boolean,
          'verificationReset', changed."verificationReset"
        )
      FROM changed
    )
    SELECT id, "isActive" FROM changed
  `, [actorId, linkId, isActive, requestId]);
  return result.rows[0] ?? null;
}

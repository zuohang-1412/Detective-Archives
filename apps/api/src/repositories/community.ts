import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export type ReviewType = "SHORT" | "LONG";

export interface ReviewInput {
  reviewType: ReviewType;
  title?: string | undefined;
  body: string;
  rating?: number | undefined;
  containsSpoiler: boolean;
}

export interface ContentSafetyAudit {
  status: "PASS" | "REVIEW" | "UNAVAILABLE" | "NOT_CONFIGURED";
  label?: number | undefined;
  traceId?: string | undefined;
}

interface ReviewRow {
  id: string;
  workId: string;
  reviewType: ReviewType;
  title: string | null;
  body: string;
  rating: number | null;
  containsSpoiler: boolean;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { id: string; displayName: string; avatarUrl: string | null };
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  appeal?: {
    id: string;
    status: string;
    reason: string;
    resolutionNote: string | null;
    createdAt: string;
    handledAt: string | null;
  } | null;
  work?: {
    id: string;
    slug: string;
    titleZh: string;
    titleOriginal: string | null;
  };
}

interface CommentRow {
  id: string;
  reviewId: string;
  parentId: string | null;
  body: string;
  containsSpoiler: boolean;
  publishedAt: string | null;
  createdAt: string;
  author: { id: string; displayName: string; avatarUrl: string | null };
  likeCount: number;
  likedByMe: boolean;
}

const publicReviewSelect = `
  SELECT
    review.id,
    review.work_id AS "workId",
    review.review_type::text AS "reviewType",
    review.title,
    review.body,
    review.rating,
    review.contains_spoiler AS "containsSpoiler",
    review.status::text AS status,
    review.published_at AS "publishedAt",
    review.created_at AS "createdAt",
    review.updated_at AS "updatedAt",
    jsonb_build_object(
      'id', author.id,
      'displayName', author.display_name,
      'avatarUrl', author.avatar_url
    ) AS author,
    jsonb_build_object(
      'id', work.id,
      'slug', work.slug,
      'titleZh', work.title_zh,
      'titleOriginal', work.title_original
    ) AS work,
    (SELECT COUNT(*)::int FROM review_likes likes WHERE likes.review_id = review.id) AS "likeCount",
    (SELECT COUNT(*)::int FROM comments comment
      WHERE comment.review_id = review.id
        AND comment.status = 'PUBLISHED'
        AND comment.deleted_at IS NULL) AS "commentCount",
    CASE WHEN $1::uuid IS NULL THEN FALSE ELSE EXISTS (
      SELECT 1 FROM review_likes likes
      WHERE likes.review_id = review.id AND likes.user_id = $1
    ) END AS "likedByMe"
  FROM reviews review
  JOIN users author ON author.id = review.user_id
  JOIN works work ON work.id = review.work_id
`;

export async function listPublicReviews(
  database: DatabaseClient,
  workId: string,
  viewerId: string | null,
  page: number,
  pageSize: number
) {
  const countResult = await queryRows<{ total: string }>(database, `
    SELECT COUNT(*)::text AS total
    FROM reviews review
    JOIN users author ON author.id = review.user_id
    JOIN works work ON work.id = review.work_id
    WHERE review.work_id = $1
      AND review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND author.is_active = TRUE
      AND work.status = 'PUBLISHED'
  `, [workId]);
  const result = await queryRows<ReviewRow>(database, `
    ${publicReviewSelect}
    WHERE review.work_id = $2
      AND review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND author.is_active = TRUE
      AND work.status = 'PUBLISHED'
    ORDER BY review.published_at DESC, review.created_at DESC, review.id
    LIMIT $3 OFFSET $4
  `, [viewerId, workId, pageSize, (page - 1) * pageSize]);
  return {
    data: result.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

export async function getPublicReview(
  database: DatabaseClient,
  reviewId: string,
  viewerId: string | null
) {
  const result = await queryRows<ReviewRow>(database, `
    ${publicReviewSelect}
    WHERE review.id = $2
      AND review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND author.is_active = TRUE
      AND work.status = 'PUBLISHED'
  `, [viewerId, reviewId]);
  return result.rows[0] ?? null;
}

export async function listCommunityReviews(
  database: DatabaseClient,
  viewerId: string | null,
  reviewType: ReviewType | null,
  page: number,
  pageSize: number
) {
  const countResult = await queryRows<{ total: string }>(database, `
    SELECT COUNT(*)::text AS total
    FROM reviews review
    JOIN users author ON author.id = review.user_id
    JOIN works work ON work.id = review.work_id
    WHERE review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND author.is_active = TRUE
      AND work.status = 'PUBLISHED'
      AND ($1::review_type IS NULL OR review.review_type = $1)
  `, [reviewType]);
  const result = await queryRows<ReviewRow>(database, `
    ${publicReviewSelect}
    WHERE review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND author.is_active = TRUE
      AND work.status = 'PUBLISHED'
      AND ($2::review_type IS NULL OR review.review_type = $2)
    ORDER BY review.published_at DESC, review.created_at DESC, review.id
    LIMIT $3 OFFSET $4
  `, [viewerId, reviewType, pageSize, (page - 1) * pageSize]);
  return {
    data: result.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

const myReviewSelect = `
  SELECT
      review.id,
      review.work_id AS "workId",
      review.review_type::text AS "reviewType",
      review.title,
      review.body,
      review.rating,
      review.contains_spoiler AS "containsSpoiler",
      review.status::text AS status,
      review.published_at AS "publishedAt",
      review.created_at AS "createdAt",
      review.updated_at AS "updatedAt",
      jsonb_build_object(
        'id', account.id,
        'displayName', account.display_name,
        'avatarUrl', account.avatar_url
      ) AS author,
      jsonb_build_object(
        'id', work.id,
        'slug', work.slug,
        'titleZh', work.title_zh,
        'titleOriginal', work.title_original
      ) AS work,
      (SELECT COUNT(*)::int FROM review_likes likes WHERE likes.review_id = review.id) AS "likeCount",
      (SELECT COUNT(*)::int FROM comments comment
        WHERE comment.review_id = review.id
          AND comment.status = 'PUBLISHED'
          AND comment.deleted_at IS NULL) AS "commentCount",
      EXISTS (
        SELECT 1 FROM review_likes likes
        WHERE likes.review_id = review.id AND likes.user_id = $1
      ) AS "likedByMe",
      (
        SELECT jsonb_build_object(
          'id', appeal.id,
          'status', appeal.status,
          'reason', appeal.reason,
          'resolutionNote', appeal.resolution_note,
          'createdAt', appeal.created_at,
          'handledAt', appeal.handled_at
        )
        FROM content_appeals appeal
        WHERE appeal.target_type = 'REVIEW' AND appeal.target_id = review.id
        ORDER BY appeal.created_at DESC, appeal.id DESC
        LIMIT 1
      ) AS appeal
  FROM reviews review
  JOIN users account ON account.id = review.user_id
  JOIN works work ON work.id = review.work_id
`;

export async function listMyReviews(
  database: DatabaseClient,
  userId: string,
  page: number,
  pageSize: number
) {
  const countResult = await queryRows<{ total: string }>(database, `
    SELECT COUNT(*)::text AS total
    FROM reviews
    WHERE user_id = $1 AND deleted_at IS NULL
  `, [userId]);
  const result = await queryRows<ReviewRow>(database, `
    ${myReviewSelect}
    WHERE review.user_id = $1 AND review.deleted_at IS NULL
    ORDER BY review.updated_at DESC, review.id
    LIMIT $2 OFFSET $3
  `, [userId, pageSize, (page - 1) * pageSize]);
  return {
    data: result.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

export async function getMyReview(
  database: DatabaseClient,
  userId: string,
  reviewId: string
) {
  const result = await queryRows<ReviewRow>(database, `
    ${myReviewSelect}
    WHERE review.user_id = $1 AND review.id = $2 AND review.deleted_at IS NULL
  `, [userId, reviewId]);
  return result.rows[0] ?? null;
}

export async function createReview(
  database: DatabaseClient,
  userId: string,
  workId: string,
  input: ReviewInput,
  requestId: string,
  contentSafety: ContentSafetyAudit
) {
  const result = await queryRows<{ id: string }>(database, `
    WITH created AS (
      INSERT INTO reviews (
        user_id, work_id, review_type, title, body, rating,
        contains_spoiler, status
      )
      SELECT $1, work.id, $3, $4, $5, $6, $7, 'PENDING_REVIEW'
      FROM works work
      WHERE work.id = $2 AND work.status = 'PUBLISHED'
      RETURNING id
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      )
      SELECT $1, 'REVIEW_CREATE', 'REVIEW', id, $8, $9::jsonb FROM created
    )
    SELECT id FROM created
  `, [
    userId,
    workId,
    input.reviewType,
    input.title ?? null,
    input.body,
    input.rating ?? null,
    input.containsSpoiler,
    requestId,
    { contentSafety }
  ]);
  const id = result.rows[0]?.id;
  if (!id) return null;
  return getMyReview(database, userId, id);
}

export async function updateReview(
  database: DatabaseClient,
  userId: string,
  reviewId: string,
  input: ReviewInput,
  requestId: string,
  contentSafety: ContentSafetyAudit
) {
  const result = await queryRows<{ id: string }>(database, `
    WITH changed AS (
      UPDATE reviews
      SET review_type = $3,
        title = $4,
        body = $5,
        rating = $6,
        contains_spoiler = $7,
        status = 'PENDING_REVIEW',
        published_at = NULL,
        updated_at = NOW()
      WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL
      RETURNING id
    ), cancelled_appeals AS (
      UPDATE content_appeals
      SET status = 'CANCELLED',
        handled_at = NOW(),
        resolution_note = 'AUTHOR_CHANGED_CONTENT',
        updated_at = NOW()
      WHERE target_type = 'REVIEW'
        AND target_id IN (SELECT id FROM changed)
        AND status = 'OPEN'
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      )
      SELECT $1, 'REVIEW_UPDATE', 'REVIEW', id, $8, $9::jsonb FROM changed
    )
    SELECT id FROM changed
  `, [
    userId,
    reviewId,
    input.reviewType,
    input.title ?? null,
    input.body,
    input.rating ?? null,
    input.containsSpoiler,
    requestId,
    { contentSafety }
  ]);
  if (!result.rows[0]) return null;
  return getMyReview(database, userId, reviewId);
}

export async function softDeleteReview(
  database: DatabaseClient,
  userId: string,
  reviewId: string,
  requestId: string
) {
  const result = await queryRows<{ id: string }>(database, `
    WITH removed AS (
      UPDATE reviews
      SET deleted_at = NOW(), status = 'HIDDEN', updated_at = NOW()
      WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL
      RETURNING id
    ), cancelled_appeals AS (
      UPDATE content_appeals
      SET status = 'CANCELLED',
        handled_at = NOW(),
        resolution_note = 'AUTHOR_DELETED_CONTENT',
        updated_at = NOW()
      WHERE target_type = 'REVIEW'
        AND target_id IN (SELECT id FROM removed)
        AND status = 'OPEN'
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'REVIEW_DELETE', 'REVIEW', id, $3 FROM removed
    )
    SELECT id FROM removed
  `, [userId, reviewId, requestId]);
  return Boolean(result.rows[0]);
}

export async function listPublicComments(
  database: DatabaseClient,
  reviewId: string,
  viewerId: string | null,
  page: number,
  pageSize: number
) {
  const countResult = await queryRows<{ total: string }>(database, `
    SELECT COUNT(*)::text AS total
    FROM comments comment
    JOIN users author ON author.id = comment.user_id
    JOIN reviews review ON review.id = comment.review_id
    JOIN users review_author ON review_author.id = review.user_id
    JOIN works work ON work.id = review.work_id
    WHERE comment.review_id = $1
      AND comment.status = 'PUBLISHED'
      AND comment.deleted_at IS NULL
      AND author.is_active = TRUE
      AND review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND review_author.is_active = TRUE
      AND work.status = 'PUBLISHED'
  `, [reviewId]);
  const result = await queryRows<CommentRow>(database, `
    SELECT
      comment.id,
      comment.review_id AS "reviewId",
      comment.parent_id AS "parentId",
      comment.body,
      comment.contains_spoiler AS "containsSpoiler",
      comment.published_at AS "publishedAt",
      comment.created_at AS "createdAt",
      jsonb_build_object(
        'id', author.id,
        'displayName', author.display_name,
        'avatarUrl', author.avatar_url
      ) AS author,
      (SELECT COUNT(*)::int FROM comment_likes likes WHERE likes.comment_id = comment.id) AS "likeCount",
      CASE WHEN $1::uuid IS NULL THEN FALSE ELSE EXISTS (
        SELECT 1 FROM comment_likes likes
        WHERE likes.comment_id = comment.id AND likes.user_id = $1
      ) END AS "likedByMe"
    FROM comments comment
    JOIN users author ON author.id = comment.user_id
    JOIN reviews review ON review.id = comment.review_id
    JOIN users review_author ON review_author.id = review.user_id
    JOIN works work ON work.id = review.work_id
    WHERE comment.review_id = $2
      AND comment.status = 'PUBLISHED'
      AND comment.deleted_at IS NULL
      AND author.is_active = TRUE
      AND review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND review_author.is_active = TRUE
      AND work.status = 'PUBLISHED'
    ORDER BY comment.published_at, comment.created_at, comment.id
    LIMIT $3 OFFSET $4
  `, [viewerId, reviewId, pageSize, (page - 1) * pageSize]);
  return {
    data: result.rows,
    total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10)
  };
}

export async function createComment(
  database: DatabaseClient,
  userId: string,
  reviewId: string,
  parentId: string | null,
  body: string,
  containsSpoiler: boolean,
  requestId: string,
  contentSafety: ContentSafetyAudit
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    WITH created AS (
      INSERT INTO comments (
        review_id, user_id, parent_id, body, contains_spoiler, status
      )
      SELECT review.id, $1, $3, $4, $5, 'PENDING_REVIEW'
      FROM reviews review
      JOIN users review_author ON review_author.id = review.user_id
      JOIN works work ON work.id = review.work_id
      WHERE review.id = $2
        AND review.status = 'PUBLISHED'
        AND review.deleted_at IS NULL
        AND review_author.is_active = TRUE
        AND work.status = 'PUBLISHED'
        AND (
          $3::uuid IS NULL
          OR EXISTS (
            SELECT 1 FROM comments parent
            WHERE parent.id = $3
              AND parent.review_id = review.id
              AND parent.status = 'PUBLISHED'
              AND parent.deleted_at IS NULL
          )
        )
      RETURNING id, status::text
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      )
      SELECT $1, 'COMMENT_CREATE', 'COMMENT', id, $6, $7::jsonb FROM created
    )
    SELECT id, status FROM created
  `, [userId, reviewId, parentId, body, containsSpoiler, requestId, { contentSafety }]);
  return result.rows[0] ?? null;
}

export async function softDeleteComment(
  database: DatabaseClient,
  userId: string,
  commentId: string,
  requestId: string
) {
  const result = await queryRows<{ id: string }>(database, `
    WITH removed AS (
      UPDATE comments
      SET deleted_at = NOW(), status = 'HIDDEN', updated_at = NOW()
      WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL
      RETURNING id
    ), cancelled_appeals AS (
      UPDATE content_appeals
      SET status = 'CANCELLED',
        handled_at = NOW(),
        resolution_note = 'AUTHOR_DELETED_CONTENT',
        updated_at = NOW()
      WHERE target_type = 'COMMENT'
        AND target_id IN (SELECT id FROM removed)
        AND status = 'OPEN'
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'COMMENT_DELETE', 'COMMENT', id, $3 FROM removed
    )
    SELECT id FROM removed
  `, [userId, commentId, requestId]);
  return Boolean(result.rows[0]);
}

export async function setLike(
  database: DatabaseClient,
  userId: string,
  targetType: "REVIEW" | "COMMENT",
  targetId: string,
  liked: boolean
) {
  const table = targetType === "REVIEW" ? "review_likes" : "comment_likes";
  const targetColumn = targetType === "REVIEW" ? "review_id" : "comment_id";
  const visibleTargetFrom = (targetIdPlaceholder: string) => targetType === "REVIEW"
    ? `
      FROM reviews target
      JOIN users author ON author.id = target.user_id
      JOIN works work ON work.id = target.work_id
      WHERE target.id = ${targetIdPlaceholder}
        AND target.status = 'PUBLISHED'
        AND target.deleted_at IS NULL
        AND author.is_active = TRUE
        AND work.status = 'PUBLISHED'
    `
    : `
      FROM comments target
      JOIN users author ON author.id = target.user_id
      JOIN reviews review ON review.id = target.review_id
      JOIN users review_author ON review_author.id = review.user_id
      JOIN works work ON work.id = review.work_id
      WHERE target.id = ${targetIdPlaceholder}
        AND target.status = 'PUBLISHED'
        AND target.deleted_at IS NULL
        AND author.is_active = TRUE
        AND review.status = 'PUBLISHED'
        AND review.deleted_at IS NULL
        AND review_author.is_active = TRUE
        AND work.status = 'PUBLISHED'
    `;
  const target = await queryRows<{ exists: boolean }>(database, `
    SELECT EXISTS (
      SELECT 1 ${visibleTargetFrom("$1")}
    ) AS exists
  `, [targetId]);
  if (!target.rows[0]?.exists) return null;
  if (liked) {
    await database.query(`
      INSERT INTO ${table} (user_id, ${targetColumn})
      SELECT $1, target.id
      ${visibleTargetFrom("$2")}
      ON CONFLICT DO NOTHING
    `, [userId, targetId]);
  } else {
    await database.query(`
      DELETE FROM ${table} WHERE user_id = $1 AND ${targetColumn} = $2
    `, [userId, targetId]);
  }
  const result = await queryRows<{ likeCount: number }>(database, `
    SELECT COUNT(*)::int AS "likeCount" FROM ${table} WHERE ${targetColumn} = $1
  `, [targetId]);
  return result.rows[0]?.likeCount ?? 0;
}

export async function createReport(
  database: DatabaseClient,
  userId: string,
  input: {
    targetType: "REVIEW" | "COMMENT";
    targetId: string;
    reasonCode: string;
    description?: string | undefined;
  },
  requestId: string
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    WITH created AS (
      INSERT INTO reports (
        reporter_id, target_type, target_id, reason_code, description
      )
      SELECT $1, $2::varchar, $3::uuid, $4, $5
      WHERE (
        $2::varchar = 'REVIEW' AND EXISTS (
          SELECT 1
          FROM reviews review
          JOIN users author ON author.id = review.user_id
          JOIN works work ON work.id = review.work_id
          WHERE review.id = $3::uuid
            AND review.status = 'PUBLISHED'
            AND review.deleted_at IS NULL
            AND author.is_active = TRUE
            AND work.status = 'PUBLISHED'
        )
      ) OR (
        $2::varchar = 'COMMENT' AND EXISTS (
          SELECT 1
          FROM comments comment
          JOIN users author ON author.id = comment.user_id
          JOIN reviews review ON review.id = comment.review_id
          JOIN users review_author ON review_author.id = review.user_id
          JOIN works work ON work.id = review.work_id
          WHERE comment.id = $3::uuid
            AND comment.status = 'PUBLISHED'
            AND comment.deleted_at IS NULL
            AND author.is_active = TRUE
            AND review.status = 'PUBLISHED'
            AND review.deleted_at IS NULL
            AND review_author.is_active = TRUE
            AND work.status = 'PUBLISHED'
        )
      )
      RETURNING id, status::text
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'REPORT_CREATE', 'REPORT', id, $6 FROM created
    )
    SELECT id, status FROM created
  `, [
    userId,
    input.targetType,
    input.targetId,
    input.reasonCode,
    input.description ?? null,
    requestId
  ]);
  return result.rows[0] ?? null;
}

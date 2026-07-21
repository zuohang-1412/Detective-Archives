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
    FROM reviews
    WHERE work_id = $1 AND status = 'PUBLISHED' AND deleted_at IS NULL
  `, [workId]);
  const result = await queryRows<ReviewRow>(database, `
    ${publicReviewSelect}
    WHERE review.work_id = $2
      AND review.status = 'PUBLISHED'
      AND review.deleted_at IS NULL
      AND author.is_active = TRUE
    ORDER BY review.published_at DESC, review.created_at DESC
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
  `, [viewerId, reviewId]);
  return result.rows[0] ?? null;
}

export async function listMyReviews(database: DatabaseClient, userId: string) {
  const result = await queryRows<ReviewRow>(database, `
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
      ) AS "likedByMe"
    FROM reviews review
    JOIN users account ON account.id = review.user_id
    JOIN works work ON work.id = review.work_id
    WHERE review.user_id = $1 AND review.deleted_at IS NULL
    ORDER BY review.updated_at DESC
  `, [userId]);
  return result.rows;
}

export async function getMyReview(
  database: DatabaseClient,
  userId: string,
  reviewId: string
) {
  const reviews = await listMyReviews(database, userId);
  return reviews.find((review) => review.id === reviewId) ?? null;
}

export async function createReview(
  database: DatabaseClient,
  userId: string,
  workId: string,
  input: ReviewInput,
  requestId: string
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
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'REVIEW_CREATE', 'REVIEW', id, $8 FROM created
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
    requestId
  ]);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const reviews = await listMyReviews(database, userId);
  return reviews.find((review) => review.id === id) ?? null;
}

export async function updateReview(
  database: DatabaseClient,
  userId: string,
  reviewId: string,
  input: ReviewInput,
  requestId: string
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
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'REVIEW_UPDATE', 'REVIEW', id, $8 FROM changed
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
    requestId
  ]);
  if (!result.rows[0]) return null;
  const reviews = await listMyReviews(database, userId);
  return reviews.find((review) => review.id === reviewId) ?? null;
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
  viewerId: string | null
) {
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
    WHERE comment.review_id = $2
      AND comment.status = 'PUBLISHED'
      AND comment.deleted_at IS NULL
      AND author.is_active = TRUE
    ORDER BY comment.published_at, comment.created_at
  `, [viewerId, reviewId]);
  return result.rows;
}

export async function createComment(
  database: DatabaseClient,
  userId: string,
  reviewId: string,
  parentId: string | null,
  body: string,
  containsSpoiler: boolean,
  requestId: string
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    WITH created AS (
      INSERT INTO comments (
        review_id, user_id, parent_id, body, contains_spoiler, status
      )
      SELECT review.id, $1, $3, $4, $5, 'PENDING_REVIEW'
      FROM reviews review
      WHERE review.id = $2
        AND review.status = 'PUBLISHED'
        AND review.deleted_at IS NULL
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
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'COMMENT_CREATE', 'COMMENT', id, $6 FROM created
    )
    SELECT id, status FROM created
  `, [userId, reviewId, parentId, body, containsSpoiler, requestId]);
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
  const targetTable = targetType === "REVIEW" ? "reviews" : "comments";
  const targetColumn = targetType === "REVIEW" ? "review_id" : "comment_id";
  const target = await queryRows<{ exists: boolean }>(database, `
    SELECT EXISTS (
      SELECT 1 FROM ${targetTable}
      WHERE id = $1 AND status = 'PUBLISHED' AND deleted_at IS NULL
    ) AS exists
  `, [targetId]);
  if (!target.rows[0]?.exists) return null;
  if (liked) {
    await database.query(`
      INSERT INTO ${table} (user_id, ${targetColumn})
      SELECT $1, target.id
      FROM ${targetTable} target
      WHERE target.id = $2
        AND target.status = 'PUBLISHED'
        AND target.deleted_at IS NULL
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
          SELECT 1 FROM reviews
          WHERE id = $3::uuid AND status = 'PUBLISHED' AND deleted_at IS NULL
        )
      ) OR (
        $2::varchar = 'COMMENT' AND EXISTS (
          SELECT 1 FROM comments
          WHERE id = $3::uuid AND status = 'PUBLISHED' AND deleted_at IS NULL
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

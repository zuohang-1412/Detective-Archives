import { withTransaction } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export interface UserDataExport {
  schemaVersion: 1;
  generatedAt: string;
  data: Record<string, unknown>;
}

export async function exportUserData(
  database: DatabaseClient,
  userId: string,
  currentSessionId: string,
  requestId: string
): Promise<UserDataExport | null> {
  return withTransaction(database, async (connection) => {
    const result = await queryRows<{ data: Record<string, unknown> }>(connection, `
      SELECT jsonb_build_object(
        'account', jsonb_build_object(
          'id', account.id,
          'displayName', account.display_name,
          'avatarUrl', account.avatar_url,
          'bio', account.bio,
          'role', account.role::text,
          'isActive', account.is_active,
          'suspendedUntil', account.suspended_until,
          'termsAcceptedAt', account.terms_accepted_at,
          'termsVersion', account.terms_version,
          'privacyAcceptedAt', account.privacy_accepted_at,
          'privacyVersion', account.privacy_version,
          'createdAt', account.created_at,
          'updatedAt', account.updated_at
        ),
        'identities', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'provider', identity.provider,
            'providerSubject', identity.provider_subject,
            'unionSubject', identity.union_subject,
            'createdAt', identity.created_at
          ) ORDER BY identity.created_at, identity.id)
          FROM user_identities identity
          WHERE identity.user_id = account.id
        ), '[]'::jsonb),
        'sessions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'isCurrent', session.id = $2,
            'expiresAt', session.expires_at,
            'lastSeenAt', session.last_seen_at,
            'revokedAt', session.revoked_at,
            'createdAt', session.created_at
          ) ORDER BY session.created_at, session.id)
          FROM user_sessions session
          WHERE session.user_id = account.id
        ), '[]'::jsonb),
        'shelf', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', shelf.id,
            'work', jsonb_build_object(
              'id', work.id,
              'slug', work.slug,
              'titleZh', work.title_zh,
              'titleOriginal', work.title_original,
              'mediaType', work.media_type::text
            ),
            'status', shelf.status::text,
            'progressPercent', shelf.progress_percent,
            'startedAt', shelf.started_at,
            'completedAt', shelf.completed_at,
            'createdAt', shelf.created_at,
            'updatedAt', shelf.updated_at
          ) ORDER BY shelf.created_at, shelf.id)
          FROM shelf_items shelf
          JOIN works work ON work.id = shelf.work_id
          WHERE shelf.user_id = account.id
        ), '[]'::jsonb),
        'shelfEngagementFacts', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'workId', fact.work_id,
            'firstAddedAt', fact.first_added_at,
            'firstCompletedAt', fact.first_completed_at
          ) ORDER BY fact.first_added_at, fact.work_id)
          FROM shelf_engagement_facts fact
          WHERE fact.user_id = account.id
        ), '[]'::jsonb),
        'reviews', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', review.id,
            'work', jsonb_build_object(
              'id', work.id,
              'slug', work.slug,
              'titleZh', work.title_zh
            ),
            'reviewType', review.review_type::text,
            'title', review.title,
            'body', review.body,
            'rating', review.rating,
            'containsSpoiler', review.contains_spoiler,
            'status', review.status::text,
            'publishedAt', review.published_at,
            'deletedAt', review.deleted_at,
            'createdAt', review.created_at,
            'updatedAt', review.updated_at
          ) ORDER BY review.created_at, review.id)
          FROM reviews review
          JOIN works work ON work.id = review.work_id
          WHERE review.user_id = account.id
        ), '[]'::jsonb),
        'comments', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', comment.id,
            'reviewId', comment.review_id,
            'parentId', comment.parent_id,
            'body', comment.body,
            'containsSpoiler', comment.contains_spoiler,
            'status', comment.status::text,
            'publishedAt', comment.published_at,
            'deletedAt', comment.deleted_at,
            'createdAt', comment.created_at,
            'updatedAt', comment.updated_at
          ) ORDER BY comment.created_at, comment.id)
          FROM comments comment
          WHERE comment.user_id = account.id
        ), '[]'::jsonb),
        'likes', jsonb_build_object(
          'reviews', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'reviewId', likes.review_id,
              'createdAt', likes.created_at
            ) ORDER BY likes.created_at, likes.review_id)
            FROM review_likes likes
            WHERE likes.user_id = account.id
          ), '[]'::jsonb),
          'comments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'commentId', likes.comment_id,
              'createdAt', likes.created_at
            ) ORDER BY likes.created_at, likes.comment_id)
            FROM comment_likes likes
            WHERE likes.user_id = account.id
          ), '[]'::jsonb)
        ),
        'reports', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', report.id,
            'targetType', report.target_type,
            'targetId', report.target_id,
            'reasonCode', report.reason_code,
            'description', report.description,
            'status', report.status::text,
            'handledAt', report.handled_at,
            'createdAt', report.created_at
          ) ORDER BY report.created_at, report.id)
          FROM reports report
          WHERE report.reporter_id = account.id
        ), '[]'::jsonb),
        'appeals', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', appeal.id,
            'targetType', appeal.target_type,
            'targetId', appeal.target_id,
            'reason', appeal.reason,
            'status', appeal.status::text,
            'resolutionNote', appeal.resolution_note,
            'handledAt', appeal.handled_at,
            'createdAt', appeal.created_at,
            'updatedAt', appeal.updated_at
          ) ORDER BY appeal.created_at, appeal.id)
          FROM content_appeals appeal
          WHERE appeal.appellant_id = account.id
        ), '[]'::jsonb),
        'linkFeedback', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', feedback.id,
            'workLinkId', feedback.work_link_id,
            'reasonCode', feedback.reason_code,
            'description', feedback.description,
            'status', feedback.status,
            'handledAt', feedback.handled_at,
            'createdAt', feedback.created_at,
            'updatedAt', feedback.updated_at
          ) ORDER BY feedback.created_at, feedback.id)
          FROM work_link_feedback feedback
          WHERE feedback.user_id = account.id
        ), '[]'::jsonb),
        'officialLinkClicks', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'workLinkId', click.work_link_id,
            'providerName', link.provider_name,
            'url', link.url,
            'createdAt', click.created_at
          ) ORDER BY click.created_at, click.id)
          FROM work_link_click_events click
          JOIN work_links link ON link.id = click.work_link_id
          WHERE click.user_id = account.id
        ), '[]'::jsonb),
        'activityDays', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'date', activity.activity_date,
            'firstSeenAt', activity.first_seen_at,
            'lastSeenAt', activity.last_seen_at,
            'eventCount', activity.event_count
          ) ORDER BY activity.activity_date)
          FROM user_activity_days activity
          WHERE activity.user_id = account.id
        ), '[]'::jsonb),
        'aiCreationTasks', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', task.id,
            'title', task.title,
            'promptSummary', task.prompt_summary,
            'modelProvider', task.model_provider,
            'modelName', task.model_name,
            'status', task.status::text,
            'outputUrl', task.output_url,
            'errorCode', task.error_code,
            'costMinorUnits', task.cost_minor_units,
            'createdAt', task.created_at,
            'updatedAt', task.updated_at,
            'completedAt', task.completed_at
          ) ORDER BY task.created_at, task.id)
          FROM ai_creation_tasks task
          WHERE task.user_id = account.id
        ), '[]'::jsonb),
        'moderationDecisions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'targetType', record.target_type,
            'targetId', record.target_id,
            'action', record.action::text,
            'reason', record.reason,
            'createdAt', record.created_at
          ) ORDER BY record.created_at, record.id)
          FROM moderation_records record
          WHERE (record.target_type = 'USER' AND record.target_id = account.id)
            OR (record.target_type = 'REVIEW' AND EXISTS (
              SELECT 1 FROM reviews review
              WHERE review.id = record.target_id AND review.user_id = account.id
            ))
            OR (record.target_type = 'COMMENT' AND EXISTS (
              SELECT 1 FROM comments comment
              WHERE comment.id = record.target_id AND comment.user_id = account.id
            ))
        ), '[]'::jsonb),
        'auditEvents', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'action', audit.action,
            'resourceType', audit.resource_type,
            'resourceId', audit.resource_id,
            'metadata', audit.metadata,
            'createdAt', audit.created_at
          ) ORDER BY audit.created_at, audit.id)
          FROM audit_logs audit
          WHERE audit.actor_id = account.id
        ), '[]'::jsonb)
      ) AS data
      FROM users account
      WHERE account.id = $1 AND account.is_active = TRUE
    `, [userId, currentSessionId]);
    const data = result.rows[0]?.data;
    if (!data) return null;

    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'DATA_EXPORT', 'USER', $1, $2,
        jsonb_build_object('schemaVersion', 1)
      )
    `, [userId, requestId]);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      data
    };
  });
}

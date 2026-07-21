import { withTransaction } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export async function trackWorkLinkClick(
  database: DatabaseClient,
  linkId: string,
  userId: string | null,
  requestId: string
) {
  const result = await queryRows<{ url: string }>(database, `
    WITH visible_link AS (
      SELECT link.id, link.url
      FROM work_links link
      JOIN works work ON work.id = link.work_id
      WHERE link.id = $1 AND link.is_active = TRUE AND work.status = 'PUBLISHED'
    ), tracked AS (
      INSERT INTO work_link_click_events (work_link_id, user_id, request_id)
      SELECT id, $2, $3 FROM visible_link
    )
    SELECT url FROM visible_link
  `, [linkId, userId, requestId]);
  return result.rows[0] ?? null;
}

export async function createWorkLinkFeedback(
  database: DatabaseClient,
  linkId: string,
  userId: string | null,
  reasonCode: string,
  description: string | undefined
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    INSERT INTO work_link_feedback (
      work_link_id, user_id, reason_code, description
    )
    SELECT link.id, $2, $3, $4
    FROM work_links link
    JOIN works work ON work.id = link.work_id
    WHERE link.id = $1 AND link.is_active = TRUE AND work.status = 'PUBLISHED'
    RETURNING id, status
  `, [linkId, userId, reasonCode, description ?? null]);
  return result.rows[0] ?? null;
}

export async function listAdminWorkLinkFeedback(database: DatabaseClient) {
  const result = await queryRows(database, `
    SELECT
      feedback.id,
      feedback.reason_code AS "reasonCode",
      feedback.description,
      feedback.status,
      feedback.created_at AS "createdAt",
      jsonb_build_object(
        'id', link.id,
        'providerName', link.provider_name,
        'url', link.url,
        'isActive', link.is_active,
        'workId', work.id,
        'workTitle', work.title_zh
      ) AS link,
      CASE WHEN account.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', account.id, 'displayName', account.display_name
      ) END AS reporter,
      (
        SELECT COUNT(*)::int FROM work_link_click_events click
        WHERE click.work_link_id = link.id
      ) AS "clickCount"
    FROM work_link_feedback feedback
    JOIN work_links link ON link.id = feedback.work_link_id
    JOIN works work ON work.id = link.work_id
    LEFT JOIN users account ON account.id = feedback.user_id
    WHERE feedback.status = 'OPEN'
    ORDER BY feedback.created_at
    LIMIT 200
  `);
  return result.rows;
}

export async function handleWorkLinkFeedback(
  database: DatabaseClient,
  actorId: string,
  feedbackId: string,
  status: "RESOLVED" | "REJECTED",
  resolutionNote: string,
  deactivateLink: boolean,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const changed = await queryRows<{ id: string; linkId: string; status: string }>(connection, `
      UPDATE work_link_feedback
      SET status = $2,
        handled_by = $3,
        handled_at = NOW(),
        resolution_note = $4,
        updated_at = NOW()
      WHERE id = $1 AND status = 'OPEN'
      RETURNING id, work_link_id AS "linkId", status
    `, [feedbackId, status, actorId, resolutionNote]);
    const feedback = changed.rows[0];
    if (!feedback) return null;
    if (deactivateLink) {
      await connection.query(`
        UPDATE work_links SET is_active = FALSE, updated_at = NOW() WHERE id = $1
      `, [feedback.linkId]);
    }
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'WORK_LINK_FEEDBACK_' || $3::text, 'WORK_LINK_FEEDBACK', $2, $4,
        jsonb_build_object(
          'resolutionNote', $5::text,
          'deactivateLink', $6::boolean,
          'workLinkId', $7::text
        )
      )
    `, [actorId, feedback.id, status, requestId, resolutionNote, deactivateLink, feedback.linkId]);
    return feedback;
  });
}

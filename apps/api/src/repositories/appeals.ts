import { withTransaction } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export type AppealTargetType = "REVIEW" | "COMMENT";

export async function createContentAppeal(
  database: DatabaseClient,
  userId: string,
  targetType: AppealTargetType,
  targetId: string,
  reason: string,
  requestId: string
) {
  const table = targetType === "REVIEW" ? "reviews" : "comments";
  const result = await queryRows<{
    id: string;
    targetType: AppealTargetType;
    targetId: string;
    reason: string;
    status: string;
    createdAt: string;
  }>(database, `
    WITH owned_hidden_content AS (
      SELECT id FROM ${table}
      WHERE id = $2
        AND user_id = $1
        AND status = 'HIDDEN'
        AND deleted_at IS NULL
    ), created AS (
      INSERT INTO content_appeals (
        appellant_id, target_type, target_id, reason
      )
      SELECT $1, $3, id, $4 FROM owned_hidden_content
      RETURNING
        id,
        target_type AS "targetType",
        target_id AS "targetId",
        reason,
        status::text AS status,
        created_at AS "createdAt"
    ), audit AS (
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id,
        metadata
      )
      SELECT $1, 'CONTENT_APPEAL_CREATE', 'CONTENT_APPEAL', id, $5,
        jsonb_build_object('targetType', "targetType", 'targetId', "targetId")
      FROM created
    )
    SELECT * FROM created
  `, [userId, targetId, targetType, reason, requestId]);
  return result.rows[0] ?? null;
}

export async function handleContentAppeal(
  database: DatabaseClient,
  moderatorId: string,
  appealId: string,
  status: "APPROVED" | "REJECTED",
  resolutionNote: string,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const locked = await queryRows<{
      id: string;
      targetType: AppealTargetType;
      targetId: string;
    }>(connection, `
      SELECT id, target_type AS "targetType", target_id AS "targetId"
      FROM content_appeals
      WHERE id = $1 AND status = 'OPEN'
      FOR UPDATE
    `, [appealId]);
    const appeal = locked.rows[0];
    if (!appeal) return { kind: "NOT_FOUND" as const };

    const table = appeal.targetType === "REVIEW" ? "reviews" : "comments";
    if (status === "APPROVED") {
      const restored = await queryRows<{ id: string }>(connection, `
        UPDATE ${table}
        SET status = 'PUBLISHED',
          published_at = COALESCE(published_at, NOW()),
          updated_at = NOW()
        WHERE id = $1
          AND status = 'HIDDEN'
          AND deleted_at IS NULL
        RETURNING id
      `, [appeal.targetId]);
      if (!restored.rows[0]) return { kind: "CONTENT_CHANGED" as const };
      await connection.query(`
        INSERT INTO moderation_records (
          moderator_id, target_type, target_id, action, reason
        ) VALUES ($1, $2, $3, 'RESTORE', $4)
      `, [moderatorId, appeal.targetType, appeal.targetId, resolutionNote]);
    }

    const changed = await queryRows<{
      id: string;
      status: string;
      handledAt: string;
    }>(connection, `
      UPDATE content_appeals
      SET status = $2,
        handled_by = $3,
        handled_at = NOW(),
        resolution_note = $4,
        updated_at = NOW()
      WHERE id = $1 AND status = 'OPEN'
      RETURNING id, status::text AS status, handled_at AS "handledAt"
    `, [appealId, status, moderatorId, resolutionNote]);
    const handled = changed.rows[0];
    if (!handled) return { kind: "NOT_FOUND" as const };

    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id,
        metadata
      ) VALUES (
        $1, 'CONTENT_APPEAL_' || $2::text, 'CONTENT_APPEAL', $3, $4,
        jsonb_build_object(
          'targetType', $5::text,
          'targetId', $6::text,
          'resolutionNote', $7::text
        )
      )
    `, [
      moderatorId,
      status,
      appealId,
      requestId,
      appeal.targetType,
      appeal.targetId,
      resolutionNote
    ]);
    return { kind: "HANDLED" as const, appeal: handled };
  });
}

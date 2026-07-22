import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { currentAgreementVersions } from "./agreements.js";
import type { DatabaseClient, DatabaseConnection } from "../db/types.js";
import { queryRows } from "../db/types.js";

export interface AuthUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  role: "USER" | "EDITOR" | "MODERATOR" | "ADMIN";
}

export interface SessionRow extends AuthUser {
  sessionId: string;
  wechatOpenId: string | null;
}

export interface AccountRightsSessionRow extends SessionRow {
  agreementsCurrent: boolean;
  isSuspended: boolean;
  suspendedUntil: string | null;
}

export function sessionTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionToken() {
  return `da_${randomBytes(32).toString("base64url")}`;
}

export function bearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 20 ? token : null;
}

export async function findActiveSession(
  database: DatabaseClient,
  token: string
): Promise<SessionRow | null> {
  const result = await queryRows<SessionRow>(database, `
    WITH active_session AS (
      UPDATE user_sessions session
      SET last_seen_at = NOW()
      FROM users account
      WHERE session.token_hash = $1
        AND session.user_id = account.id
        AND session.revoked_at IS NULL
        AND session.expires_at > NOW()
        AND account.is_active = TRUE
        AND (account.suspended_until IS NULL OR account.suspended_until <= NOW())
        AND (
          NOT EXISTS (
            SELECT 1 FROM user_identities agreement_identity
            WHERE agreement_identity.user_id = account.id
              AND agreement_identity.provider = 'WECHAT'
          )
          OR (
            account.terms_version = $2
            AND account.privacy_version = $3
          )
        )
      RETURNING
        session.id AS "sessionId",
        account.id,
        account.display_name AS "displayName",
        account.avatar_url AS "avatarUrl",
        account.bio,
        account.role::text AS role,
        (
          SELECT identity.provider_subject
          FROM user_identities identity
          WHERE identity.user_id = account.id AND identity.provider = 'WECHAT'
          LIMIT 1
        ) AS "wechatOpenId"
    ), activity AS (
      INSERT INTO user_activity_days (
        user_id, activity_date, first_seen_at, last_seen_at, event_count
      )
      SELECT id, (NOW() AT TIME ZONE 'UTC')::date, NOW(), NOW(), 1
      FROM active_session
      ON CONFLICT (user_id, activity_date) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at,
        event_count = user_activity_days.event_count + 1
    )
    SELECT * FROM active_session
  `, [
    sessionTokenHash(token),
    currentAgreementVersions.termsVersion,
    currentAgreementVersions.privacyVersion
  ]);
  return result.rows[0] ?? null;
}

export async function findAccountRightsSession(
  database: DatabaseClient,
  token: string
): Promise<AccountRightsSessionRow | null> {
  const result = await queryRows<AccountRightsSessionRow>(database, `
    UPDATE user_sessions session
    SET last_seen_at = NOW()
    FROM users account
    WHERE session.token_hash = $1
      AND session.user_id = account.id
      AND session.revoked_at IS NULL
      AND session.expires_at > NOW()
      AND account.is_active = TRUE
    RETURNING
      session.id AS "sessionId",
      account.id,
      account.display_name AS "displayName",
      account.avatar_url AS "avatarUrl",
      account.bio,
      account.role::text AS role,
      (
        NOT EXISTS (
          SELECT 1 FROM user_identities agreement_identity
          WHERE agreement_identity.user_id = account.id
            AND agreement_identity.provider = 'WECHAT'
        )
        OR (
          account.terms_version = $2
          AND account.privacy_version = $3
        )
      ) AS "agreementsCurrent",
      account.suspended_until AS "suspendedUntil",
      account.suspended_until IS NOT NULL
        AND account.suspended_until > NOW() AS "isSuspended",
      (
        SELECT identity.provider_subject
        FROM user_identities identity
        WHERE identity.user_id = account.id AND identity.provider = 'WECHAT'
        LIMIT 1
      ) AS "wechatOpenId"
  `, [
    sessionTokenHash(token),
    currentAgreementVersions.termsVersion,
    currentAgreementVersions.privacyVersion
  ]);
  return result.rows[0] ?? null;
}

export async function withTransaction<T>(
  database: DatabaseClient,
  callback: (connection: DatabaseConnection) => Promise<T>
) {
  if (!database.connect) {
    throw new Error("Database transactions are not supported by this client");
  }
  const connection = await database.connect();
  try {
    await connection.query("BEGIN");
    const result = await callback(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

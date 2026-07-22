import { createHash } from "node:crypto";
import type { WechatIdentity } from "../auth/wechat.js";
import { createSessionToken, sessionTokenHash, withTransaction } from "../auth/session.js";
import type { AuthUser } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

interface RefreshableSession extends AuthUser {
  isSuspended: boolean;
  sessionId: string;
  sessionTtlSeconds: number;
  suspendedUntil: string | null;
}

export async function refreshUserSession(
  database: DatabaseClient,
  token: string
): Promise<LoginResult | null> {
  return withTransaction(database, async (connection) => {
    const current = await queryRows<RefreshableSession>(connection, `
      SELECT
        session.id AS "sessionId",
        GREATEST(
          60,
          CEIL(EXTRACT(EPOCH FROM (session.expires_at - session.created_at)))::integer
        ) AS "sessionTtlSeconds",
        account.id,
        account.display_name AS "displayName",
        account.avatar_url AS "avatarUrl",
        account.bio,
        account.role::text AS role,
        account.suspended_until AS "suspendedUntil",
        account.suspended_until IS NOT NULL
          AND account.suspended_until > NOW() AS "isSuspended"
      FROM user_sessions session
      JOIN users account ON account.id = session.user_id
      WHERE session.token_hash = $1
        AND session.revoked_at IS NULL
        AND session.expires_at > NOW()
        AND account.is_active = TRUE
      FOR UPDATE OF session
    `, [sessionTokenHash(token)]);
    const session = current.rows[0];
    if (!session) return null;

    await connection.query(`
      UPDATE user_sessions
      SET revoked_at = NOW(), last_seen_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
    `, [session.sessionId]);

    const refreshedToken = createSessionToken();
    const expiresAt = new Date(Date.now() + session.sessionTtlSeconds * 1000);
    await connection.query(`
      INSERT INTO user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `, [session.id, sessionTokenHash(refreshedToken), expiresAt]);
    if (!session.isSuspended) await recordUserActivity(connection, session.id);

    const {
      sessionId: _sessionId,
      sessionTtlSeconds: _sessionTtlSeconds,
      isSuspended,
      suspendedUntil,
      ...user
    } = session;
    return {
      token: refreshedToken,
      expiresAt: expiresAt.toISOString(),
      user: { ...user, isSuspended, suspendedUntil }
    };
  });
}

export async function loginWechatUser(
  database: DatabaseClient,
  identity: WechatIdentity,
  profile: { displayName: string; avatarUrl?: string | undefined },
  sessionTtlSeconds: number
): Promise<LoginResult> {
  return withTransaction(database, async (connection) => {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `WECHAT:${identity.providerSubject}`
    ]);
    const existing = await queryRows<AuthUser>(connection, `
      SELECT
        account.id,
        account.display_name AS "displayName",
        account.avatar_url AS "avatarUrl",
        account.bio,
        account.role::text AS role
      FROM user_identities identity
      JOIN users account ON account.id = identity.user_id
      WHERE identity.provider = 'WECHAT' AND identity.provider_subject = $1
      FOR UPDATE OF account
    `, [identity.providerSubject]);

    let user = existing.rows[0];
    if (!user) {
      const created = await queryRows<AuthUser>(connection, `
        INSERT INTO users (
          display_name, avatar_url, terms_accepted_at, privacy_accepted_at
        )
        VALUES ($1, $2, NOW(), NOW())
        RETURNING id, display_name AS "displayName", avatar_url AS "avatarUrl",
          bio, role::text AS role
      `, [profile.displayName, profile.avatarUrl ?? null]);
      user = created.rows[0];
      if (!user) throw new Error("User creation did not return a record");
      await connection.query(`
        INSERT INTO user_identities (
          user_id, provider, provider_subject, union_subject
        ) VALUES ($1, 'WECHAT', $2, $3)
      `, [user.id, identity.providerSubject, identity.unionSubject ?? null]);
    } else {
      await connection.query(`
        UPDATE users
        SET terms_accepted_at = COALESCE(terms_accepted_at, NOW()),
          privacy_accepted_at = COALESCE(privacy_accepted_at, NOW()),
          updated_at = NOW()
        WHERE id = $1
      `, [user.id]);
      if (identity.unionSubject) {
        await connection.query(`
          UPDATE user_identities
          SET union_subject = COALESCE(union_subject, $2)
          WHERE provider = 'WECHAT' AND provider_subject = $1
        `, [identity.providerSubject, identity.unionSubject]);
      }
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    await connection.query(`
      INSERT INTO user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `, [user.id, sessionTokenHash(token), expiresAt]);
    await recordUserActivity(connection, user.id);
    return { token, expiresAt: expiresAt.toISOString(), user };
  });
}

export async function deactivateUserAccount(
  database: DatabaseClient,
  userId: string,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const active = await queryRows<{ id: string }>(connection, `
      SELECT id FROM users
      WHERE id = $1 AND role = 'USER' AND is_active = TRUE
      FOR UPDATE
    `, [userId]);
    if (!active.rows[0]) return false;

    await connection.query(`
      UPDATE reviews
      SET status = 'HIDDEN', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
      WHERE user_id = $1
    `, [userId]);
    await connection.query(`
      UPDATE comments
      SET status = 'HIDDEN', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
      WHERE user_id = $1
    `, [userId]);
    await connection.query(`
      UPDATE content_appeals
      SET status = 'CANCELLED',
        handled_at = NOW(),
        resolution_note = 'ACCOUNT_DEACTIVATED',
        updated_at = NOW()
      WHERE appellant_id = $1 AND status = 'OPEN'
    `, [userId]);
    await connection.query("DELETE FROM shelf_items WHERE user_id = $1", [userId]);
    await connection.query("DELETE FROM shelf_engagement_facts WHERE user_id = $1", [userId]);
    await connection.query("DELETE FROM user_activity_days WHERE user_id = $1", [userId]);
    await connection.query("DELETE FROM review_likes WHERE user_id = $1", [userId]);
    await connection.query("DELETE FROM comment_likes WHERE user_id = $1", [userId]);
    await connection.query("UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1", [userId]);
    await connection.query("DELETE FROM user_identities WHERE user_id = $1", [userId]);
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id
      ) VALUES ($1, 'ACCOUNT_DEACTIVATE', 'USER', $1, $2)
    `, [userId, requestId]);
    await connection.query(`
      UPDATE users
      SET display_name = '已注销用户',
        avatar_url = NULL,
        bio = NULL,
        is_active = FALSE,
        deactivated_at = NOW(),
        deactivation_reason = 'USER_REQUEST',
        updated_at = NOW()
      WHERE id = $1
    `, [userId]);
    return true;
  });
}

export async function loginAdminUser(
  database: DatabaseClient,
  loginId: string,
  sessionTtlSeconds: number
): Promise<LoginResult> {
  const providerSubject = createHash("sha256").update(loginId).digest("hex");
  return withTransaction(database, async (connection) => {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `ADMIN:${providerSubject}`
    ]);
    const existing = await queryRows<AuthUser>(connection, `
      SELECT
        account.id,
        account.display_name AS "displayName",
        account.avatar_url AS "avatarUrl",
        account.bio,
        account.role::text AS role
      FROM user_identities identity
      JOIN users account ON account.id = identity.user_id
      WHERE identity.provider = 'ADMIN' AND identity.provider_subject = $1
      FOR UPDATE OF account
    `, [providerSubject]);

    let user = existing.rows[0];
    if (!user) {
      const created = await queryRows<AuthUser>(connection, `
        INSERT INTO users (display_name, role)
        VALUES ('档案馆管理员', 'ADMIN')
        RETURNING id, display_name AS "displayName", avatar_url AS "avatarUrl",
          bio, role::text AS role
      `);
      user = created.rows[0];
      if (!user) throw new Error("Admin creation did not return a record");
      await connection.query(`
        INSERT INTO user_identities (user_id, provider, provider_subject)
        VALUES ($1, 'ADMIN', $2)
      `, [user.id, providerSubject]);
    }
    if (user.role !== "ADMIN") {
      throw new Error("Configured admin identity no longer has the ADMIN role");
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    await connection.query(`
      INSERT INTO user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `, [user.id, sessionTokenHash(token), expiresAt]);
    return { token, expiresAt: expiresAt.toISOString(), user };
  });
}

async function recordUserActivity(
  database: Pick<DatabaseClient, "query">,
  userId: string
) {
  await database.query(`
    INSERT INTO user_activity_days (
      user_id, activity_date, first_seen_at, last_seen_at, event_count
    ) VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, NOW(), NOW(), 1)
    ON CONFLICT (user_id, activity_date) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at,
      event_count = user_activity_days.event_count + 1
  `, [userId]);
}

import { createHash } from "node:crypto";
import {
  currentAgreementVersions,
  type AgreementVersions
} from "../auth/agreements.js";
import type { WechatIdentity } from "../auth/wechat.js";
import { createSessionToken, sessionTokenHash, withTransaction } from "../auth/session.js";
import type { AuthUser } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: AgreementAwareAuthUser;
}

export interface AgreementAwareAuthUser extends AuthUser {
  agreementsCurrent: boolean;
  agreementVersions: AgreementVersions;
}

interface RefreshableSession extends AuthUser {
  agreementsCurrent: boolean;
  isSuspended: boolean;
  sessionId: string;
  sessionTtlSeconds: number;
  suspendedUntil: string | null;
}

interface StoredWechatUser extends AuthUser {
  privacyVersion: string | null;
  termsVersion: string | null;
}

function withAgreementStatus(
  user: AuthUser,
  agreementsCurrent: boolean
): AgreementAwareAuthUser {
  return {
    ...user,
    agreementsCurrent,
    agreementVersions: { ...currentAgreementVersions }
  };
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
          AND account.suspended_until > NOW() AS "isSuspended"
      FROM user_sessions session
      JOIN users account ON account.id = session.user_id
      WHERE session.token_hash = $1
        AND session.revoked_at IS NULL
        AND session.expires_at > NOW()
        AND account.is_active = TRUE
      FOR UPDATE OF session
    `, [
      sessionTokenHash(token),
      currentAgreementVersions.termsVersion,
      currentAgreementVersions.privacyVersion
    ]);
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
      agreementsCurrent,
      isSuspended,
      suspendedUntil,
      ...user
    } = session;
    return {
      token: refreshedToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        ...withAgreementStatus(user, agreementsCurrent),
        isSuspended,
        suspendedUntil
      }
    };
  });
}

export async function loginWechatUser(
  database: DatabaseClient,
  identity: WechatIdentity,
  profile: { displayName: string; avatarUrl?: string | undefined },
  sessionTtlSeconds: number,
  requestId: string
): Promise<LoginResult> {
  return withTransaction(database, async (connection) => {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `WECHAT:${identity.providerSubject}`
    ]);
    const existing = await queryRows<StoredWechatUser>(connection, `
      SELECT
        account.id,
        account.display_name AS "displayName",
        account.avatar_url AS "avatarUrl",
        account.bio,
        account.role::text AS role,
        account.terms_version AS "termsVersion",
        account.privacy_version AS "privacyVersion"
      FROM user_identities identity
      JOIN users account ON account.id = identity.user_id
      WHERE identity.provider = 'WECHAT' AND identity.provider_subject = $1
      FOR UPDATE OF account
    `, [identity.providerSubject]);

    const storedUser = existing.rows[0];
    const agreementsChanged = !storedUser
      || storedUser.termsVersion !== currentAgreementVersions.termsVersion
      || storedUser.privacyVersion !== currentAgreementVersions.privacyVersion;
    let user: AuthUser | undefined = storedUser
      ? {
          id: storedUser.id,
          displayName: storedUser.displayName,
          avatarUrl: storedUser.avatarUrl,
          bio: storedUser.bio,
          role: storedUser.role
        }
      : undefined;
    if (!user) {
      const created = await queryRows<AuthUser>(connection, `
        INSERT INTO users (
          display_name, avatar_url,
          terms_accepted_at, terms_version,
          privacy_accepted_at, privacy_version
        )
        VALUES ($1, $2, NOW(), $3, NOW(), $4)
        RETURNING id, display_name AS "displayName", avatar_url AS "avatarUrl",
          bio, role::text AS role
      `, [
        profile.displayName,
        profile.avatarUrl ?? null,
        currentAgreementVersions.termsVersion,
        currentAgreementVersions.privacyVersion
      ]);
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
        SET terms_accepted_at = CASE
            WHEN terms_version IS DISTINCT FROM $2 THEN NOW()
            ELSE COALESCE(terms_accepted_at, NOW())
          END,
          terms_version = $2,
          privacy_accepted_at = CASE
            WHEN privacy_version IS DISTINCT FROM $3 THEN NOW()
            ELSE COALESCE(privacy_accepted_at, NOW())
          END,
          privacy_version = $3,
          updated_at = NOW()
        WHERE id = $1
      `, [
        user.id,
        currentAgreementVersions.termsVersion,
        currentAgreementVersions.privacyVersion
      ]);
      if (identity.unionSubject) {
        await connection.query(`
          UPDATE user_identities
          SET union_subject = COALESCE(union_subject, $2)
          WHERE provider = 'WECHAT' AND provider_subject = $1
        `, [identity.providerSubject, identity.unionSubject]);
      }
    }

    if (agreementsChanged) {
      await connection.query(`
        INSERT INTO audit_logs (
          actor_id, action, resource_type, resource_id, request_id, metadata
        ) VALUES (
          $1, 'AGREEMENTS_ACCEPT', 'USER', $1, $2,
          jsonb_build_object(
            'termsVersion', $3::text,
            'privacyVersion', $4::text,
            'source', 'WECHAT_LOGIN'
          )
        )
      `, [
        user.id,
        requestId,
        currentAgreementVersions.termsVersion,
        currentAgreementVersions.privacyVersion
      ]);
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    await connection.query(`
      INSERT INTO user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `, [user.id, sessionTokenHash(token), expiresAt]);
    await recordUserActivity(connection, user.id);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: withAgreementStatus(user, true)
    };
  });
}

export async function acceptCurrentUserAgreements(
  database: DatabaseClient,
  userId: string,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    const accepted = await queryRows<{ id: string }>(connection, `
      UPDATE users
      SET terms_accepted_at = NOW(),
        terms_version = $2,
        privacy_accepted_at = NOW(),
        privacy_version = $3,
        updated_at = NOW()
      WHERE id = $1
        AND is_active = TRUE
        AND (
          terms_version IS DISTINCT FROM $2
          OR privacy_version IS DISTINCT FROM $3
        )
        AND EXISTS (
          SELECT 1 FROM user_identities identity
          WHERE identity.user_id = users.id AND identity.provider = 'WECHAT'
        )
      RETURNING id
    `, [
      userId,
      currentAgreementVersions.termsVersion,
      currentAgreementVersions.privacyVersion
    ]);
    if (!accepted.rows[0]) {
      const eligible = await queryRows<{ id: string }>(connection, `
        SELECT id FROM users
        WHERE id = $1
          AND is_active = TRUE
          AND EXISTS (
            SELECT 1 FROM user_identities identity
            WHERE identity.user_id = users.id AND identity.provider = 'WECHAT'
          )
      `, [userId]);
      return eligible.rows[0] ? "ALREADY_CURRENT" as const : "UNAVAILABLE" as const;
    }

    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'AGREEMENTS_ACCEPT', 'USER', $1, $2,
        jsonb_build_object(
          'termsVersion', $3::text,
          'privacyVersion', $4::text,
          'source', 'RECONSENT'
        )
      )
    `, [
      userId,
      requestId,
      currentAgreementVersions.termsVersion,
      currentAgreementVersions.privacyVersion
    ]);
    return "ACCEPTED" as const;
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
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: withAgreementStatus(user, true)
    };
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

import { createHash } from "node:crypto";
import type { WechatIdentity } from "../auth/wechat.js";
import { createSessionToken, sessionTokenHash, withTransaction } from "../auth/session.js";
import type { AuthUser } from "../auth/session.js";
import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

interface LoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
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
        INSERT INTO users (display_name, avatar_url)
        VALUES ($1, $2)
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
    } else if (identity.unionSubject) {
      await connection.query(`
        UPDATE user_identities
        SET union_subject = COALESCE(union_subject, $2)
        WHERE provider = 'WECHAT' AND provider_subject = $1
      `, [identity.providerSubject, identity.unionSubject]);
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

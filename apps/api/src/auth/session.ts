import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { DatabaseClient, DatabaseConnection } from "../db/types.js";
import { queryRows } from "../db/types.js";

export interface AuthUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  role: "USER" | "EDITOR" | "MODERATOR" | "ADMIN";
}

interface SessionRow extends AuthUser {
  sessionId: string;
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
    UPDATE user_sessions session
    SET last_seen_at = NOW()
    FROM users account
    WHERE session.token_hash = $1
      AND session.user_id = account.id
      AND session.revoked_at IS NULL
      AND session.expires_at > NOW()
      AND account.is_active = TRUE
      AND (account.suspended_until IS NULL OR account.suspended_until <= NOW())
    RETURNING
      session.id AS "sessionId",
      account.id,
      account.display_name AS "displayName",
      account.avatar_url AS "avatarUrl",
      account.bio,
      account.role::text AS role
  `, [sessionTokenHash(token)]);
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

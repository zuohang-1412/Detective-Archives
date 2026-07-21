import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { DatabaseClient } from "../db/types.js";

export type CatalogViewEventType =
  | "DETECTIVE_LIST_VIEW"
  | "DETECTIVE_DETAIL_VIEW"
  | "WORK_LIST_VIEW"
  | "WORK_DETAIL_VIEW";

const visitorIdPattern = /^[A-Za-z0-9_-]{16,80}$/;

export function hashVisitorId(header: unknown) {
  if (typeof header !== "string" || !visitorIdPattern.test(header)) return null;
  return createHash("sha256").update(header).digest("hex");
}

export function visitorHashFromRequest(request: FastifyRequest) {
  return hashVisitorId(request.headers["x-visitor-id"]);
}

export async function recordCatalogView(
  database: DatabaseClient | undefined,
  request: FastifyRequest,
  eventType: CatalogViewEventType,
  targetId: string | null
) {
  const visitorHash = visitorHashFromRequest(request);
  if (!database || !visitorHash) return;
  try {
    await database.query(`
      INSERT INTO catalog_view_events (
        visitor_hash, event_type, target_id, request_id
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [visitorHash, eventType, targetId, request.id]);
  } catch (error) {
    request.log.warn({ err: error, eventType }, "catalog analytics write failed");
  }
}

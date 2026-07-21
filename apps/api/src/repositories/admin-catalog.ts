import { withTransaction } from "../auth/session.js";
import type { DatabaseClient, DatabaseConnection } from "../db/types.js";
import { queryRows } from "../db/types.js";

export interface AdminDetectiveSourceInput {
  label: string;
  url: string;
  quality: string;
  verification: "MISSING" | "SOURCE_CAPTURED" | "PRIMARY_SOURCE_CONFIRMED";
}

export interface AdminDetectiveInput {
  catalogId?: string | undefined;
  slug: string;
  nameZh: string;
  nameOriginal?: string | undefined;
  nameEn?: string | undefined;
  country?: string | undefined;
  era?: string | undefined;
  subjectKind: "FICTIONAL" | "HISTORICAL";
  collection: "CORE" | "ARCHIVE_EXTENSION" | "HISTORICAL_CASES";
  category?: string | undefined;
  mediaTypes: string[];
  summary: string;
  sourceNote?: string | undefined;
  verification: "MISSING" | "SOURCE_CAPTURED" | "PRIMARY_SOURCE_CONFIRMED";
  creatorName?: string | undefined;
  aliases: string[];
  tags: string[];
  featuredCases: string[];
  sources: AdminDetectiveSourceInput[];
}

export async function listAdminDetectives(
  database: DatabaseClient,
  query?: string | undefined
) {
  const result = await queryRows(database, `
    SELECT
      detective.id,
      detective.catalog_id AS "catalogId",
      detective.slug,
      detective.name_zh AS "nameZh",
      detective.name_original AS "nameOriginal",
      detective.name_en AS "nameEn",
      detective.country,
      detective.era,
      detective.subject_kind::text AS "subjectKind",
      detective.catalog_collection::text AS collection,
      detective.catalog_category AS category,
      detective.media_types AS "mediaTypes",
      detective.summary,
      detective.source_note AS "sourceNote",
      detective.verification::text AS verification,
      detective.status::text AS status,
      detective.updated_at AS "updatedAt",
      (
        SELECT string_agg(creator.name_zh, '、' ORDER BY creator.name_zh)
        FROM detective_creators relation
        JOIN creators creator ON creator.id = relation.creator_id
        WHERE relation.detective_id = detective.id AND relation.relation_type = 'CREATOR'
      ) AS "creatorName",
      COALESCE((
        SELECT array_agg(alias.alias ORDER BY alias.alias)
        FROM detective_aliases alias WHERE alias.detective_id = detective.id
      ), ARRAY[]::varchar[]) AS aliases,
      COALESCE((
        SELECT array_agg(tag.tag ORDER BY tag.tag)
        FROM detective_tags tag WHERE tag.detective_id = detective.id
      ), ARRAY[]::varchar[]) AS tags,
      COALESCE((
        SELECT array_agg(feature.source_label ORDER BY feature.display_order, feature.source_label)
        FROM detective_featured_works feature WHERE feature.detective_id = detective.id
      ), ARRAY[]::varchar[]) AS "featuredCases",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'label', source.source_label,
          'url', source.source_url,
          'quality', source.source_quality,
          'verification', source.verification::text
        ) ORDER BY source.source_id)
        FROM detective_sources source WHERE source.detective_id = detective.id
      ), '[]'::jsonb) AS sources
    FROM detectives detective
    WHERE $1::text IS NULL
      OR detective.name_zh ILIKE '%' || $1 || '%'
      OR detective.name_original ILIKE '%' || $1 || '%'
      OR detective.name_en ILIKE '%' || $1 || '%'
      OR detective.slug ILIKE '%' || $1 || '%'
      OR detective.catalog_id ILIKE '%' || $1 || '%'
    ORDER BY detective.updated_at DESC, detective.name_zh
    LIMIT 300
  `, [query ?? null]);
  return result.rows;
}

async function replaceDetectiveRelations(
  connection: DatabaseConnection,
  detectiveId: string,
  input: AdminDetectiveInput
) {
  await connection.query("DELETE FROM detective_aliases WHERE detective_id = $1", [detectiveId]);
  for (const alias of input.aliases) {
    await connection.query(`
      INSERT INTO detective_aliases (detective_id, alias) VALUES ($1, $2)
    `, [detectiveId, alias]);
  }

  await connection.query("DELETE FROM detective_tags WHERE detective_id = $1", [detectiveId]);
  for (const tag of input.tags) {
    await connection.query(`
      INSERT INTO detective_tags (detective_id, tag) VALUES ($1, $2)
    `, [detectiveId, tag]);
  }

  await connection.query(`
    DELETE FROM detective_creators
    WHERE detective_id = $1 AND relation_type = 'CREATOR'
  `, [detectiveId]);
  if (input.creatorName) {
    const creator = await queryRows<{ id: string }>(connection, `
      INSERT INTO creators (name_zh, status)
      VALUES ($1, 'PUBLISHED')
      ON CONFLICT (name_zh) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `, [input.creatorName]);
    await connection.query(`
      INSERT INTO detective_creators (detective_id, creator_id, relation_type)
      VALUES ($1, $2, 'CREATOR')
    `, [detectiveId, creator.rows[0]?.id]);
  }

  await connection.query("DELETE FROM detective_sources WHERE detective_id = $1", [detectiveId]);
  for (const [index, source] of input.sources.entries()) {
    await connection.query(`
      INSERT INTO detective_sources (
        detective_id, source_id, source_label, source_url, source_quality, verification
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      detectiveId,
      `ADMIN-${String(index + 1).padStart(3, "0")}`,
      source.label,
      source.url,
      source.quality,
      source.verification
    ]);
  }

  await connection.query("DELETE FROM detective_featured_works WHERE detective_id = $1", [detectiveId]);
  for (const [index, featuredCase] of input.featuredCases.entries()) {
    await connection.query(`
      INSERT INTO detective_featured_works (detective_id, source_label, display_order)
      VALUES ($1, $2, $3)
    `, [detectiveId, featuredCase, index]);
  }
}

export async function createAdminDetective(
  database: DatabaseClient,
  actorId: string,
  input: AdminDetectiveInput,
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('DETECTIVE_SLUGS'))");
    const reserved = await queryRows<{ exists: boolean }>(connection, `
      SELECT EXISTS(SELECT 1 FROM detective_slug_redirects WHERE old_slug = $1) AS exists
    `, [input.slug]);
    if (reserved.rows[0]?.exists) {
      throw Object.assign(new Error("Detective slug is reserved by a redirect"), {
        code: "DETECTIVE_SLUG_RESERVED"
      });
    }
    const created = await queryRows<{ id: string }>(connection, `
      INSERT INTO detectives (
        catalog_id, slug, name_zh, name_original, name_en, country, era,
        subject_kind, catalog_collection, catalog_category, media_types,
        summary, source_note, verification, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, 'DRAFT'
      )
      RETURNING id
    `, [
      input.catalogId ?? null,
      input.slug,
      input.nameZh,
      input.nameOriginal ?? null,
      input.nameEn ?? null,
      input.country ?? null,
      input.era ?? null,
      input.subjectKind,
      input.collection,
      input.category ?? null,
      input.mediaTypes,
      input.summary,
      input.sourceNote ?? null,
      input.verification
    ]);
    const detective = created.rows[0];
    if (!detective) throw new Error("Detective creation did not return a record");
    await replaceDetectiveRelations(connection, detective.id, input);
    await connection.query(`
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      VALUES ($1, 'DETECTIVE_CREATE', 'DETECTIVE', $2, $3)
    `, [actorId, detective.id, requestId]);
    return detective;
  });
}

export async function updateAdminDetective(
  database: DatabaseClient,
  actorId: string,
  detectiveId: string,
  input: AdminDetectiveInput,
  requestId: string,
  draftOnly: boolean
) {
  return withTransaction(database, async (connection) => {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('DETECTIVE_SLUGS'))");
    const current = await queryRows<{ slug: string }>(connection, `
      SELECT slug FROM detectives
      WHERE id = $1 AND (NOT $2::boolean OR status IN ('DRAFT', 'PENDING_REVIEW'))
      FOR UPDATE
    `, [detectiveId, draftOnly]);
    const currentDetective = current.rows[0];
    if (!currentDetective) return null;

    const reserved = await queryRows<{ detectiveId: string }>(connection, `
      SELECT detective_id AS "detectiveId" FROM detective_slug_redirects WHERE old_slug = $1
    `, [input.slug]);
    if (reserved.rows[0] && reserved.rows[0].detectiveId !== detectiveId) {
      throw Object.assign(new Error("Detective slug is reserved by a redirect"), {
        code: "DETECTIVE_SLUG_RESERVED"
      });
    }
    await connection.query(`
      DELETE FROM detective_slug_redirects WHERE old_slug = $1 AND detective_id = $2
    `, [input.slug, detectiveId]);

    await connection.query(`
      UPDATE detectives
      SET catalog_id = $2,
        slug = $3,
        name_zh = $4,
        name_original = $5,
        name_en = $6,
        country = $7,
        era = $8,
        subject_kind = $9,
        catalog_collection = $10,
        catalog_category = $11,
        media_types = $12,
        summary = $13,
        source_note = $14,
        verification = $15,
        status = CASE
          WHEN $16::boolean AND status = 'PENDING_REVIEW' THEN 'DRAFT'::content_status
          ELSE status
        END,
        updated_at = NOW()
      WHERE id = $1
    `, [
      detectiveId,
      input.catalogId ?? null,
      input.slug,
      input.nameZh,
      input.nameOriginal ?? null,
      input.nameEn ?? null,
      input.country ?? null,
      input.era ?? null,
      input.subjectKind,
      input.collection,
      input.category ?? null,
      input.mediaTypes,
      input.summary,
      input.sourceNote ?? null,
      input.verification,
      draftOnly
    ]);
    if (currentDetective.slug !== input.slug) {
      await connection.query(`
        INSERT INTO detective_slug_redirects (old_slug, detective_id) VALUES ($1, $2)
      `, [currentDetective.slug, detectiveId]);
    }
    await replaceDetectiveRelations(connection, detectiveId, input);
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'DETECTIVE_UPDATE', 'DETECTIVE', $2, $3,
        jsonb_build_object('previousSlug', $4::text, 'slug', $5::text)
      )
    `, [actorId, detectiveId, requestId, currentDetective.slug, input.slug]);
    return { id: detectiveId };
  });
}

export async function setAdminDetectiveStatus(
  database: DatabaseClient,
  actorId: string,
  detectiveId: string,
  status: "DRAFT" | "PENDING_REVIEW" | "PUBLISHED" | "HIDDEN" | "ARCHIVED",
  requestId: string
) {
  const result = await queryRows<{ id: string; status: string }>(database, `
    WITH changed AS (
      UPDATE detectives
      SET status = $3::content_status,
        published_at = CASE WHEN $3::text = 'PUBLISHED' THEN COALESCE(published_at, NOW()) ELSE published_at END,
        updated_at = NOW()
      WHERE id = $2
        AND CASE $3::text
          WHEN 'DRAFT' THEN status = 'PENDING_REVIEW'
          WHEN 'PENDING_REVIEW' THEN status = 'DRAFT'
          WHEN 'PUBLISHED' THEN status IN ('PENDING_REVIEW', 'HIDDEN')
          WHEN 'HIDDEN' THEN status = 'PUBLISHED'
          WHEN 'ARCHIVED' THEN status IN ('PUBLISHED', 'HIDDEN')
          ELSE FALSE
        END
      RETURNING id, status::text
    ), audit AS (
      INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
      SELECT $1, 'DETECTIVE_STATUS_' || $3::text, 'DETECTIVE', id, $4 FROM changed
    )
    SELECT id, status FROM changed
  `, [actorId, detectiveId, status, requestId]);
  return result.rows[0] ?? null;
}

export async function listAdminUsers(
  database: DatabaseClient,
  options: { q?: string | undefined; role?: string | undefined; page: number; pageSize: number }
) {
  const values: unknown[] = [];
  const clauses = ["TRUE"];
  if (options.q) {
    values.push(`%${options.q}%`);
    clauses.push(`(account.display_name ILIKE $${values.length} OR account.id::text ILIKE $${values.length})`);
  }
  if (options.role) {
    values.push(options.role);
    clauses.push(`account.role::text = $${values.length}`);
  }
  const where = clauses.join(" AND ");
  const count = await queryRows<{ total: number }>(database, `
    SELECT COUNT(*)::int AS total FROM users account WHERE ${where}
  `, values);
  const rows = await queryRows(database, `
    SELECT
      account.id,
      account.display_name AS "displayName",
      account.role::text AS role,
      account.is_active AS "isActive",
      account.suspended_until AS "suspendedUntil",
      account.created_at AS "createdAt",
      COALESCE((
        SELECT array_agg(identity.provider ORDER BY identity.provider)
        FROM user_identities identity WHERE identity.user_id = account.id
      ), ARRAY[]::varchar[]) AS providers
    FROM users account
    WHERE ${where}
    ORDER BY account.created_at DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, [...values, options.pageSize, (options.page - 1) * options.pageSize]);
  return { data: rows.rows, total: count.rows[0]?.total ?? 0 };
}

export async function setAdminUserRole(
  database: DatabaseClient,
  actorId: string,
  userId: string,
  role: "USER" | "EDITOR" | "MODERATOR" | "ADMIN",
  requestId: string
) {
  return withTransaction(database, async (connection) => {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('ADMIN_ROLE_ASSIGNMENT'))");
    const target = await queryRows<{ id: string; role: string }>(connection, `
      SELECT id, role::text AS role FROM users
      WHERE id = $1 AND is_active = TRUE
      FOR UPDATE
    `, [userId]);
    const current = target.rows[0];
    if (!current) return { kind: "NOT_FOUND" as const };
    if (current.role === "ADMIN" && role !== "ADMIN") {
      const adminCount = await queryRows<{ count: number }>(connection, `
        SELECT COUNT(*)::int AS count FROM users WHERE role = 'ADMIN' AND is_active = TRUE
      `);
      if ((adminCount.rows[0]?.count ?? 0) <= 1) return { kind: "LAST_ADMIN" as const };
    }
    const updated = await queryRows<{ id: string; role: string }>(connection, `
      UPDATE users SET role = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, role::text AS role
    `, [userId, role]);
    await connection.query(`
      INSERT INTO audit_logs (
        actor_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        $1, 'USER_ROLE_CHANGE', 'USER', $2, $3,
        jsonb_build_object('previousRole', $4::text, 'role', $5::text)
      )
    `, [actorId, userId, requestId, current.role, role]);
    return { kind: "UPDATED" as const, user: updated.rows[0] };
  });
}

export async function listAdminAuditLogs(
  database: DatabaseClient,
  options: {
    action?: string | undefined;
    resourceType?: string | undefined;
    actorId?: string | undefined;
    page: number;
    pageSize: number;
  }
) {
  const values: unknown[] = [];
  const clauses = ["TRUE"];
  if (options.action) {
    values.push(options.action);
    clauses.push(`audit.action = $${values.length}`);
  }
  if (options.resourceType) {
    values.push(options.resourceType);
    clauses.push(`audit.resource_type = $${values.length}`);
  }
  if (options.actorId) {
    values.push(options.actorId);
    clauses.push(`audit.actor_id = $${values.length}`);
  }
  const where = clauses.join(" AND ");
  const count = await queryRows<{ total: number }>(database, `
    SELECT COUNT(*)::int AS total FROM audit_logs audit WHERE ${where}
  `, values);
  const rows = await queryRows(database, `
    SELECT
      audit.id,
      audit.action,
      audit.resource_type AS "resourceType",
      audit.resource_id AS "resourceId",
      audit.request_id AS "requestId",
      audit.metadata,
      audit.created_at AS "createdAt",
      CASE WHEN actor.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', actor.id, 'displayName', actor.display_name, 'role', actor.role::text
      ) END AS actor
    FROM audit_logs audit
    LEFT JOIN users actor ON actor.id = audit.actor_id
    WHERE ${where}
    ORDER BY audit.created_at DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, [...values, options.pageSize, (options.page - 1) * options.pageSize]);
  return { data: rows.rows, total: count.rows[0]?.total ?? 0 };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildApp } from "../apps/api/dist/app.js";
import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";
import {
  catalogSlugify,
  loadCatalogBatches,
  uniqueImportedWorks
} from "./lib/catalog-batches.mjs";

const database = createDatabasePoolFromEnv();
assert.ok(database, "PostgreSQL configuration is required for the database API check");
const testAdminLoginId = "detective-archives-admin-check";
const testAdminPassword = "integration-admin-password";
const testVisitorId = "db_api_analytics_visitor_123456";
const testVisitorHash = createHash("sha256").update(testVisitorId).digest("hex");
const testWorkSlug = "database-api-check-work";
const coreDetectives = JSON.parse(await readFile(
  new URL("../apps/api/src/data/core-detectives.json", import.meta.url), "utf8"
));
const coreWorkDetails = JSON.parse(await readFile(
  new URL("../apps/api/src/data/core-work-details.json", import.meta.url), "utf8"
));
const archiveDirectory = JSON.parse(await readFile(
  new URL("../apps/api/src/data/archive-directory-index.json", import.meta.url), "utf8"
));
const { batches } = await loadCatalogBatches();
const expectedPublishedWorkCount = new Set([
  ...coreWorkDetails.map((work) => work.slug),
  ...uniqueImportedWorks(batches).keys()
]).size;
const expectedPublishedDetectiveCount = new Set([
  ...coreDetectives.map((detective) => detective.slug),
  ...archiveDirectory.entries.map((detective) => catalogSlugify(detective.names.en)),
  ...batches.flatMap(({ input }) => input.detectives.map((detective) => detective.slug))
]).size;
const testDetectiveSlug = "database-api-check-detective";
const testDetectiveUpdatedSlug = "database-api-check-detective-updated";
let deactivatedTestUserId = null;
const testIdentitySubjects = [
  "detective-archives-db-api-check-primary",
  "detective-archives-db-api-check-secondary",
  "detective-archives-db-api-check-deactivation",
  "detective-archives-db-api-check-editor",
  "detective-archives-db-api-check-concurrent",
  createHash("sha256").update(testAdminLoginId).digest("hex")
];
async function cleanupTestUsers() {
  await database.query("DELETE FROM catalog_view_events WHERE visitor_hash = $1", [testVisitorHash]);
  await database.query("DELETE FROM work_link_click_events WHERE visitor_hash = $1", [testVisitorHash]);
  await database.query(`
    DELETE FROM content_appeals
    WHERE appellant_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
    OR target_id IN (
      SELECT review.id FROM reviews review
      JOIN user_identities identity ON identity.user_id = review.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
      UNION
      SELECT comment.id FROM comments comment
      JOIN user_identities identity ON identity.user_id = comment.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  await database.query(`
    DELETE FROM audit_logs
    WHERE actor_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  await database.query(`
    DELETE FROM moderation_records
    WHERE moderator_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
    OR target_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
      UNION
      SELECT review.id FROM reviews review
      JOIN user_identities identity ON identity.user_id = review.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
      UNION
      SELECT comment.id FROM comments comment
      JOIN user_identities identity ON identity.user_id = comment.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  await database.query(`
    DELETE FROM reports
    WHERE reporter_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
    OR target_id IN (
      SELECT review.id FROM reviews review
      JOIN user_identities identity ON identity.user_id = review.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
      UNION
      SELECT comment.id FROM comments comment
      JOIN user_identities identity ON identity.user_id = comment.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  await database.query(`
    DELETE FROM comments
    WHERE user_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
    OR review_id IN (
      SELECT review.id FROM reviews review
      JOIN user_identities identity ON identity.user_id = review.user_id
      WHERE identity.provider IN ('WECHAT', 'ADMIN') AND identity.provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  await database.query(`
    DELETE FROM reviews
    WHERE user_id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  await database.query("DELETE FROM works WHERE slug = $1", [testWorkSlug]);
  await database.query("DELETE FROM detectives WHERE slug = ANY($1)", [[
    testDetectiveSlug,
    testDetectiveUpdatedSlug
  ]]);
  await database.query(`
    DELETE FROM users
    WHERE id IN (
      SELECT user_id FROM user_identities
      WHERE provider IN ('WECHAT', 'ADMIN') AND provider_subject = ANY($1)
    )
  `, [testIdentitySubjects]);
  if (deactivatedTestUserId) {
    await database.query("DELETE FROM audit_logs WHERE actor_id = $1", [deactivatedTestUserId]);
    await database.query("DELETE FROM users WHERE id = $1", [deactivatedTestUserId]);
    deactivatedTestUserId = null;
  }
}
await cleanupTestUsers();
const expectedIntegrationIndexes = [
  "idx_reviews_user_export",
  "idx_comments_user_export",
  "idx_reports_reporter_export",
  "idx_work_link_feedback_user_export",
  "idx_work_link_click_events_user_export",
  "idx_moderation_records_target_export",
  "idx_audit_logs_actor_export",
  "idx_reviews_public_feed",
  "idx_reviews_public_feed_type"
];
const integrationIndexResult = await database.query(`
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = current_schema()
    AND indexname = ANY($1::text[])
`, [expectedIntegrationIndexes]);
assert.deepEqual(
  integrationIndexResult.rows.map(({ indexname }) => indexname).sort(),
  [...expectedIntegrationIndexes].sort(),
  "feature query indexes must be applied"
);
const app = await buildApp({
  database,
  contentSafetyCheck: async ({ openId, content }) => {
    assert.ok(testIdentitySubjects.includes(openId));
    if (content.includes("机器拒绝")) {
      return { suggestion: "risky", label: 300, traceId: "integration-risky" };
    }
    if (content.includes("需要人工复核")) {
      return { suggestion: "review", label: 200, traceId: "integration-review" };
    }
    if (content.includes("安全服务故障")) {
      throw new Error("simulated content safety outage");
    }
    return { suggestion: "pass", label: 100, traceId: "integration-pass" };
  },
  wechatCodeExchange: async (code) => ({
    providerSubject: code === "secondary-user"
      ? testIdentitySubjects[1]
      : code === "deactivation-user"
        ? testIdentitySubjects[2]
        : code === "editor-user"
          ? testIdentitySubjects[3]
          : code === "concurrent-user"
            ? testIdentitySubjects[4]
          : testIdentitySubjects[0]
  }),
  adminCredentialValidator: (loginId, password) => (
    loginId === testAdminLoginId && password === testAdminPassword
  ),
  sessionTtlSeconds: 3600
});

try {
  const checks = [
    ["/ready", (body) => assert.equal(body.database, "connected")],
    ["/api/v1/detectives?pageSize=50", (body) => {
      assert.equal(body.pagination.total, expectedPublishedDetectiveCount);
      assert.equal(body.facets.categories.length, 5);
      assert.ok(body.facets.countries.includes("日本"));
      assert.ok(body.facets.subjectKinds.includes("FICTIONAL"));
      assert.ok(body.facets.tags.length > 10);
    }],
    ["/api/v1/detectives/sherlock-holmes", (body) => {
      assert.equal(body.data.works[0].slug, "a-study-in-scarlet");
    }],
    ["/api/v1/detectives?country=%E6%97%A5%E6%9C%AC&era=%E5%BD%93%E4%BB%A3&category=JAPANESE_POPULAR&subjectKind=FICTIONAL&tag=%E6%9C%AC%E6%A0%BC%E6%8E%A8%E7%90%86&pageSize=50", (body) => {
      assert.ok(body.pagination.total > 0);
      assert.ok(body.data.every((detective) => detective.country === "日本"));
      assert.ok(body.data.every((detective) => detective.era === "当代"));
      assert.ok(body.data.every((detective) => detective.category === "JAPANESE_POPULAR"));
      assert.ok(body.data.every((detective) => detective.subjectKind === "FICTIONAL"));
      assert.ok(body.data.every((detective) => detective.tags.includes("本格推理")));
    }],
    ["/api/v1/archive-directory?pageSize=50", (body) => {
      assert.equal(body.pagination.total, archiveDirectory.coverage.entryCount);
      assert.equal(body.coverage.extensionCount, archiveDirectory.coverage.extensionCount);
    }],
    ["/api/v1/archive-directory?q=%E5%BF%83%E7%90%86%E7%BD%AA", (body) => {
      assert.equal(body.data[0].id, "EXT-CN-003");
    }],
    ["/api/v1/archive-directory?q=%E6%B3%95%E5%8C%BB%E6%8E%A8%E7%90%86", (body) => {
      assert.equal(body.data[0].id, "EXT-WL-014");
    }],
    ["/api/v1/picture-book?pageSize=150", (body) => {
      assert.equal(body.pagination.total, 109);
      assert.equal(body.data[0].id, "PB-001-STD");
      assert.equal(body.data[0].linkedRecommendations[0].workSlug, "the-valley-of-fear");
    }],
    ["/api/v1/picture-book?q=%E9%B2%81%E9%82%A6", (body) => {
      assert.equal(body.data[0].id, "PB-004-STD");
      assert.equal(
        body.data[0].linkedRecommendations[0].workSlug,
        "arsene-lupin-gentleman-burglar"
      );
    }],
    ["/api/v1/picture-book?q=%E5%B8%83%E6%9C%97%E7%A5%9E%E7%88%B6", (body) => {
      assert.equal(body.data[0].id, "PB-013-STD");
      assert.equal(body.data[0].linkedRecommendations[0].sourceLabel, "奇妙的脚步声");
      assert.equal(
        body.data[0].linkedRecommendations[0].workSlug,
        "the-innocence-of-father-brown"
      );
    }],
    ["/api/v1/works?pageSize=50", (body) => assert.equal(body.pagination.total, expectedPublishedWorkCount)],
    ["/api/v1/works/d-slope-murder-case", (body) => assert.equal(body.data.links.length, 2)],
    ["/api/v1/works/any-old-port-in-a-storm", (body) => {
      assert.equal(body.data.links.length, 1);
      assert.equal(body.data.links[0].providerName, "Prime Video");
    }]
  ];

  for (const [url, verify] of checks) {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { "x-visitor-id": testVisitorId }
    });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    verify(response.json());
  }

  const workResponse = await app.inject({
    method: "GET",
    url: "/api/v1/works/a-study-in-scarlet",
    headers: { "x-visitor-id": testVisitorId }
  });
  const workId = workResponse.json().data.id;
  const missingConsentResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: { code: "missing-consent" }
  });
  assert.equal(missingConsentResponse.statusCode, 400, missingConsentResponse.body);
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "database-api-check",
      agreements: { termsAccepted: true, privacyAccepted: true },
      profile: { displayName: "集成测试用户" }
    }
  });
  assert.equal(loginResponse.statusCode, 201, loginResponse.body);
  const token = loginResponse.json().data.token;
  const userId = loginResponse.json().data.user.id;
  let authorization = { authorization: `Bearer ${token}` };

  const repeatLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "database-api-check",
      agreements: { termsAccepted: true, privacyAccepted: true },
      profile: { displayName: "不会重复创建" }
    }
  });
  assert.equal(repeatLoginResponse.statusCode, 201, repeatLoginResponse.body);
  assert.equal(repeatLoginResponse.json().data.user.id, userId);

  const concurrentRefreshResponses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: { authorization: `Bearer ${repeatLoginResponse.json().data.token}` }
  })));
  assert.deepEqual(
    concurrentRefreshResponses.map((response) => response.statusCode).sort(),
    [200, 401]
  );

  const refreshResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: authorization
  });
  assert.equal(refreshResponse.statusCode, 200, refreshResponse.body);
  assert.notEqual(refreshResponse.json().data.token, token);
  assert.equal(refreshResponse.json().data.user.id, userId);
  const revokedTokenResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(revokedTokenResponse.statusCode, 401, revokedTokenResponse.body);
  authorization = {
    authorization: `Bearer ${refreshResponse.json().data.token}`
  };

  const meResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: authorization
  });
  assert.equal(meResponse.statusCode, 200, meResponse.body);
  assert.equal(meResponse.json().data.displayName, "集成测试用户");

  const wishlistResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: authorization,
    payload: { status: "WISHLIST" }
  });
  assert.equal(wishlistResponse.statusCode, 200, wishlistResponse.body);
  assert.equal(wishlistResponse.json().data.status, "WISHLIST");
  const shelfItemId = wishlistResponse.json().data.id;

  const repeatedWishlistResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: authorization,
    payload: { status: "WISHLIST" }
  });
  assert.equal(repeatedWishlistResponse.statusCode, 200, repeatedWishlistResponse.body);
  assert.equal(repeatedWishlistResponse.json().data.id, shelfItemId);

  const completedResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: authorization,
    payload: { status: "COMPLETED" }
  });
  assert.equal(completedResponse.statusCode, 200, completedResponse.body);
  assert.equal(completedResponse.json().data.progressPercent, 100);

  const shelfResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/shelf?status=COMPLETED",
    headers: authorization
  });
  assert.equal(shelfResponse.statusCode, 200, shelfResponse.body);
  assert.equal(shelfResponse.json().data.length, 1);
  assert.equal(shelfResponse.json().pagination.total, 1);
  assert.equal(shelfResponse.json().pagination.totalPages, 1);
  const invalidShelfPaginationResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/shelf?pageSize=51",
    headers: authorization
  });
  assert.equal(invalidShelfPaginationResponse.statusCode, 400, invalidShelfPaginationResponse.body);
  const pausedAfterCompletionResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: authorization,
    payload: { status: "PAUSED" }
  });
  assert.equal(pausedAfterCompletionResponse.statusCode, 200, pausedAfterCompletionResponse.body);
  assert.equal(pausedAfterCompletionResponse.json().data.completedAt, null);
  const persistentCompletionFact = await database.query(`
    SELECT first_added_at, first_completed_at
    FROM shelf_engagement_facts
    WHERE user_id = $1 AND work_id = $2
  `, [userId, workId]);
  assert.equal(persistentCompletionFact.rowCount, 1);
  assert.ok(persistentCompletionFact.rows[0].first_completed_at);

  const secondaryLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "secondary-user",
      agreements: { termsAccepted: true, privacyAccepted: true }
    }
  });
  assert.equal(secondaryLoginResponse.statusCode, 201, secondaryLoginResponse.body);
  let secondaryAuthorization = {
    authorization: `Bearer ${secondaryLoginResponse.json().data.token}`
  };
  const forbiddenAdminResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/dashboard",
    headers: secondaryAuthorization
  });
  assert.equal(forbiddenAdminResponse.statusCode, 403, forbiddenAdminResponse.body);

  const editorLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "editor-user",
      agreements: { termsAccepted: true, privacyAccepted: true }
    }
  });
  assert.equal(editorLoginResponse.statusCode, 201, editorLoginResponse.body);
  const editorUserId = editorLoginResponse.json().data.user.id;
  await database.query("UPDATE users SET role = 'EDITOR' WHERE id = $1", [editorUserId]);
  const editorAuthorization = {
    authorization: `Bearer ${editorLoginResponse.json().data.token}`
  };
  const forbiddenEditorModeration = await app.inject({
    method: "GET",
    url: "/api/v1/admin/moderation",
    headers: editorAuthorization
  });
  assert.equal(forbiddenEditorModeration.statusCode, 403, forbiddenEditorModeration.body);

  const concurrentLoginResponses = await Promise.all(Array.from({ length: 3 }, () => app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "concurrent-user",
      agreements: { termsAccepted: true, privacyAccepted: true }
    }
  })));
  concurrentLoginResponses.forEach((response) => {
    assert.equal(response.statusCode, 201, response.body);
  });
  const concurrentUserIds = new Set(
    concurrentLoginResponses.map((response) => response.json().data.user.id)
  );
  assert.equal(concurrentUserIds.size, 1);
  const concurrentIdentityCount = await database.query(`
    SELECT COUNT(*)::int AS count FROM user_identities
    WHERE provider = 'WECHAT' AND provider_subject = $1
  `, [testIdentitySubjects[4]]);
  assert.equal(concurrentIdentityCount.rows[0].count, 1);
  const concurrentAuthorization = {
    authorization: `Bearer ${concurrentLoginResponses[0].json().data.token}`
  };
  const concurrentShelfResponses = await Promise.all(Array.from({ length: 5 }, () => app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: concurrentAuthorization,
    payload: { status: "WISHLIST" }
  })));
  concurrentShelfResponses.forEach((response) => {
    assert.equal(response.statusCode, 200, response.body);
  });
  assert.equal(new Set(
    concurrentShelfResponses.map((response) => response.json().data.id)
  ).size, 1);

  const adminLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/admin",
    payload: { loginId: testAdminLoginId, password: testAdminPassword }
  });
  assert.equal(adminLoginResponse.statusCode, 201, adminLoginResponse.body);
  assert.equal(adminLoginResponse.json().data.user.role, "ADMIN");
  const adminUserId = adminLoginResponse.json().data.user.id;
  const adminAuthorization = {
    authorization: `Bearer ${adminLoginResponse.json().data.token}`
  };
  const dashboardResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/dashboard",
    headers: adminAuthorization
  });
  assert.equal(dashboardResponse.statusCode, 200, dashboardResponse.body);
  assert.ok(dashboardResponse.json().data.publishedDetectiveCount >= expectedPublishedDetectiveCount);
  assert.ok(Number.isInteger(dashboardResponse.json().data.brokenLinkCount));
  assert.ok(Number.isInteger(dashboardResponse.json().data.unconfirmedLinkCount));

  const usersResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/users?pageSize=50",
    headers: adminAuthorization
  });
  assert.equal(usersResponse.statusCode, 200, usersResponse.body);
  assert.ok(usersResponse.json().data.some((item) => item.id === editorUserId));
  assert.ok(usersResponse.json().pagination.total >= usersResponse.json().data.length);
  const oversizedAdminPageResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/users?pageSize=51",
    headers: adminAuthorization
  });
  assert.equal(oversizedAdminPageResponse.statusCode, 400, oversizedAdminPageResponse.body);
  const setEditorRoleResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${secondaryLoginResponse.json().data.user.id}/role`,
    headers: adminAuthorization,
    payload: { role: "EDITOR" }
  });
  assert.equal(setEditorRoleResponse.statusCode, 200, setEditorRoleResponse.body);
  assert.equal(setEditorRoleResponse.json().data.role, "EDITOR");
  const restoreUserRoleResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${secondaryLoginResponse.json().data.user.id}/role`,
    headers: adminAuthorization,
    payload: { role: "USER" }
  });
  assert.equal(restoreUserRoleResponse.statusCode, 200, restoreUserRoleResponse.body);
  const selfRoleResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${adminUserId}/role`,
    headers: adminAuthorization,
    payload: { role: "USER" }
  });
  assert.equal(selfRoleResponse.statusCode, 400, selfRoleResponse.body);

  const detectivePayload = {
    catalogId: "TEST-001",
    slug: testDetectiveSlug,
    nameZh: "数据库接口测试侦探",
    nameOriginal: "Database API Detective",
    nameEn: "Database API Detective",
    country: "测试地区",
    era: "自动化测试时代",
    subjectKind: "FICTIONAL",
    collection: "ARCHIVE_EXTENSION",
    category: "WORLD_LITERATURE",
    mediaTypes: ["NOVEL"],
    summary: "用于验证侦探档案创建、审核发布、地址变更与历史地址兼容的自动化测试资料。",
    sourceNote: "仅供自动化集成测试",
    verification: "SOURCE_CAPTURED",
    creatorName: "自动化测试作者",
    aliases: ["接口测试侦探"],
    tags: ["自动化测试", "本格推理"],
    featuredCases: ["测试庄园谜案", "接口密室事件"],
    sources: [{
      label: "自动化测试来源",
      url: "https://example.com/database-api-detective",
      quality: "PUBLISHER",
      verification: "SOURCE_CAPTURED"
    }]
  };
  const createDetectiveResponse = await app.inject({
    method: "POST",
    url: "/api/v1/admin/detectives",
    headers: editorAuthorization,
    payload: detectivePayload
  });
  assert.equal(createDetectiveResponse.statusCode, 201, createDetectiveResponse.body);
  const managedDetectiveId = createDetectiveResponse.json().data.id;
  const submitDetectiveResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/detectives/${managedDetectiveId}/status`,
    headers: editorAuthorization,
    payload: { status: "PENDING_REVIEW" }
  });
  assert.equal(submitDetectiveResponse.statusCode, 200, submitDetectiveResponse.body);
  const forbiddenDetectivePublish = await app.inject({
    method: "POST",
    url: `/api/v1/admin/detectives/${managedDetectiveId}/status`,
    headers: editorAuthorization,
    payload: { status: "PUBLISHED" }
  });
  assert.equal(forbiddenDetectivePublish.statusCode, 403, forbiddenDetectivePublish.body);
  const publishDetectiveResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/detectives/${managedDetectiveId}/status`,
    headers: adminAuthorization,
    payload: { status: "PUBLISHED" }
  });
  assert.equal(publishDetectiveResponse.statusCode, 200, publishDetectiveResponse.body);
  const publicDetectiveResponse = await app.inject({
    method: "GET",
    url: `/api/v1/detectives/${testDetectiveSlug}`
  });
  assert.equal(publicDetectiveResponse.statusCode, 200, publicDetectiveResponse.body);
  assert.deepEqual(publicDetectiveResponse.json().data.featuredCases, [
    "测试庄园谜案",
    "接口密室事件"
  ]);
  const updateDetectiveResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/detectives/${managedDetectiveId}`,
    headers: adminAuthorization,
    payload: { ...detectivePayload, slug: testDetectiveUpdatedSlug }
  });
  assert.equal(updateDetectiveResponse.statusCode, 200, updateDetectiveResponse.body);
  const oldSlugResponse = await app.inject({
    method: "GET",
    url: `/api/v1/detectives/${testDetectiveSlug}`
  });
  assert.equal(oldSlugResponse.statusCode, 200, oldSlugResponse.body);
  assert.equal(oldSlugResponse.json().data.slug, testDetectiveUpdatedSlug);
  const adminDetectiveListResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/detectives?q=database-api-check",
    headers: adminAuthorization
  });
  assert.equal(adminDetectiveListResponse.statusCode, 200, adminDetectiveListResponse.body);
  assert.equal(adminDetectiveListResponse.json().data[0].id, managedDetectiveId);
  assert.equal(adminDetectiveListResponse.json().pagination.total, 1);

  const createWorkResponse = await app.inject({
    method: "POST",
    url: "/api/v1/admin/works",
    headers: editorAuthorization,
    payload: {
      slug: testWorkSlug,
      titleZh: "数据库接口检查作品",
      mediaType: "NOVEL",
      releaseYear: 2026,
      summary: "仅用于自动化集成检查的作品草稿。"
    }
  });
  assert.equal(createWorkResponse.statusCode, 201, createWorkResponse.body);
  const managedWorkId = createWorkResponse.json().data.id;
  const adminWorkListResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/works?q=database-api-check&pageSize=1",
    headers: adminAuthorization
  });
  assert.equal(adminWorkListResponse.statusCode, 200, adminWorkListResponse.body);
  assert.equal(adminWorkListResponse.json().pagination.total, 1);
  const forbiddenEditorPublish = await app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${managedWorkId}/status`,
    headers: editorAuthorization,
    payload: { status: "PUBLISHED" }
  });
  assert.equal(forbiddenEditorPublish.statusCode, 403, forbiddenEditorPublish.body);
  const duplicateWorkResponse = await app.inject({
    method: "POST",
    url: "/api/v1/admin/works",
    headers: adminAuthorization,
    payload: {
      slug: testWorkSlug,
      titleZh: "重复标识",
      mediaType: "NOVEL"
    }
  });
  assert.equal(duplicateWorkResponse.statusCode, 409, duplicateWorkResponse.body);
  const createLinkResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${managedWorkId}/links`,
    headers: editorAuthorization,
    payload: {
      linkType: "PUBLISHER",
      providerName: "集成检查出版社",
      url: "https://example.com/detective-archives-integration-check",
      region: "GLOBAL"
    }
  });
  assert.equal(createLinkResponse.statusCode, 201, createLinkResponse.body);
  assert.equal(createLinkResponse.json().data.isActive, false);
  const managedLinkId = createLinkResponse.json().data.id;
  const forbiddenEditorLinkActivation = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}`,
    headers: editorAuthorization,
    payload: { isActive: true }
  });
  assert.equal(forbiddenEditorLinkActivation.statusCode, 403, forbiddenEditorLinkActivation.body);
  const submitWorkResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${managedWorkId}/status`,
    headers: editorAuthorization,
    payload: { status: "PENDING_REVIEW" }
  });
  assert.equal(submitWorkResponse.statusCode, 200, submitWorkResponse.body);
  assert.equal(submitWorkResponse.json().data.status, "PENDING_REVIEW");
  const publishWorkResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${managedWorkId}/status`,
    headers: adminAuthorization,
    payload: { status: "PUBLISHED" }
  });
  assert.equal(publishWorkResponse.statusCode, 200, publishWorkResponse.body);
  const forbiddenPublishedWorkEdit = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/works/${managedWorkId}`,
    headers: editorAuthorization,
    payload: {
      slug: testWorkSlug,
      titleZh: "编辑不应直接改已发布作品",
      mediaType: "NOVEL",
      releaseYear: 2026,
      summary: "该修改应被拒绝。"
    }
  });
  assert.equal(forbiddenPublishedWorkEdit.statusCode, 409, forbiddenPublishedWorkEdit.body);
  assert.equal(forbiddenPublishedWorkEdit.json().code, "WORK_NOT_EDITABLE");
  const enableLinkResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}`,
    headers: adminAuthorization,
    payload: { isActive: true }
  });
  assert.equal(enableLinkResponse.statusCode, 200, enableLinkResponse.body);
  await database.query(`
    UPDATE work_links
    SET last_checked_at = NOW(),
      last_check_ok = NULL,
      last_status_code = NULL,
      last_check_error = 'UND_ERR_CONNECT_TIMEOUT'
    WHERE id = $1
  `, [managedLinkId]);
  const linkReviewQueueResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/work-link-reviews?q=database-api-check",
    headers: adminAuthorization
  });
  assert.equal(linkReviewQueueResponse.statusCode, 200, linkReviewQueueResponse.body);
  assert.ok(linkReviewQueueResponse.json().data.some((item) => (
    item.id === managedLinkId
      && item.reviewState === "UNCONFIRMED"
      && item.lastCheckError === "UND_ERR_CONNECT_TIMEOUT"
  )));
  const forbiddenEditorLinkReview = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}/review`,
    headers: editorAuthorization,
    payload: {
      decision: "VERIFIED",
      note: "编辑不应直接登记人工复核结论",
      evidenceReference: "publisher-review-ticket-editor"
    }
  });
  assert.equal(forbiddenEditorLinkReview.statusCode, 403, forbiddenEditorLinkReview.body);
  const unsafeLinkReviewEvidence = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}/review`,
    headers: adminAuthorization,
    payload: {
      decision: "VERIFIED",
      note: "证据引用不应携带访问令牌",
      evidenceReference: "https://example.com/evidence?access_token=secret-value"
    }
  });
  assert.equal(unsafeLinkReviewEvidence.statusCode, 400, unsafeLinkReviewEvidence.body);
  const verifiedReviewPayload = {
    decision: "VERIFIED",
    note: "已在出版社页面人工确认作品和入口一致",
    evidenceReference: "publisher-review-ticket-verified"
  };
  const concurrentVerifyLinkReviewResponses = await Promise.all([
    app.inject({
      method: "PATCH",
      url: `/api/v1/admin/work-links/${managedLinkId}/review`,
      headers: adminAuthorization,
      payload: verifiedReviewPayload
    }),
    app.inject({
      method: "PATCH",
      url: `/api/v1/admin/work-links/${managedLinkId}/review`,
      headers: adminAuthorization,
      payload: verifiedReviewPayload
    })
  ]);
  assert.ok(concurrentVerifyLinkReviewResponses.every((response) => response.statusCode === 200));
  assert.deepEqual(
    concurrentVerifyLinkReviewResponses.map((response) => response.json().data.unchanged).sort(),
    [false, true]
  );
  assert.ok(concurrentVerifyLinkReviewResponses.every((response) => (
    response.json().data.decision === "VERIFIED"
  )));
  const resolvedLinkReviewQueueResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/work-link-reviews?q=database-api-check",
    headers: adminAuthorization
  });
  assert.equal(
    resolvedLinkReviewQueueResponse.json().data.some((item) => item.id === managedLinkId),
    false
  );
  await database.query(`
    UPDATE work_links
    SET last_checked_at = NOW(),
      last_check_ok = FALSE,
      last_status_code = 404,
      last_check_error = 'HTTP_404'
    WHERE id = $1
  `, [managedLinkId]);
  const brokenOverridesManualReviewResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/work-link-reviews?q=database-api-check",
    headers: adminAuthorization
  });
  assert.ok(brokenOverridesManualReviewResponse.json().data.some((item) => (
    item.id === managedLinkId && item.reviewState === "BROKEN"
  )));
  const cannotVerifyAutomaticallyBrokenLinkResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}/review`,
    headers: adminAuthorization,
    payload: {
      decision: "VERIFIED",
      note: "自动确认失效后不能由人工结论直接覆盖",
      evidenceReference: "publisher-review-ticket-broken"
    }
  });
  assert.equal(
    cannotVerifyAutomaticallyBrokenLinkResponse.statusCode,
    409,
    cannotVerifyAutomaticallyBrokenLinkResponse.body
  );
  assert.equal(
    cannotVerifyAutomaticallyBrokenLinkResponse.json().code,
    "WORK_LINK_AUTOMATICALLY_BROKEN"
  );
  const rejectLinkReviewResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}/review`,
    headers: adminAuthorization,
    payload: {
      decision: "REJECTED",
      note: "官方入口确认已经移除该作品页面",
      evidenceReference: "publisher-review-ticket-rejected"
    }
  });
  assert.equal(rejectLinkReviewResponse.statusCode, 200, rejectLinkReviewResponse.body);
  assert.equal(rejectLinkReviewResponse.json().data.isActive, false);
  const inactiveVerifiedLinkReviewResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}/review`,
    headers: adminAuthorization,
    payload: {
      decision: "VERIFIED",
      note: "停用链接不能直接确认有效",
      evidenceReference: "publisher-review-ticket-inactive"
    }
  });
  assert.equal(inactiveVerifiedLinkReviewResponse.statusCode, 409, inactiveVerifiedLinkReviewResponse.body);
  const manualReviewAuditResult = await database.query(`
    SELECT COUNT(*)::int AS count
    FROM audit_logs
    WHERE resource_type = 'WORK_LINK'
      AND resource_id = $1
      AND action IN ('WORK_LINK_MANUAL_VERIFIED', 'WORK_LINK_MANUAL_REJECTED')
  `, [managedLinkId]);
  assert.equal(manualReviewAuditResult.rows[0].count, 2);
  const reenableAfterManualRejection = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}`,
    headers: adminAuthorization,
    payload: { isActive: true }
  });
  assert.equal(reenableAfterManualRejection.statusCode, 200, reenableAfterManualRejection.body);
  const resetLinkReviewResult = await database.query(`
    SELECT
      is_active AS "isActive",
      last_checked_at AS "lastCheckedAt",
      last_check_ok AS "lastCheckOk",
      manual_review_status AS "manualReviewStatus",
      manual_reviewed_at AS "manualReviewedAt"
    FROM work_links WHERE id = $1
  `, [managedLinkId]);
  assert.deepEqual(resetLinkReviewResult.rows[0], {
    isActive: true,
    lastCheckedAt: null,
    lastCheckOk: null,
    manualReviewStatus: null,
    manualReviewedAt: null
  });
  const publicManagedWork = await app.inject({
    method: "GET",
    url: `/api/v1/works/${testWorkSlug}`
  });
  assert.equal(publicManagedWork.statusCode, 200, publicManagedWork.body);
  assert.equal(publicManagedWork.json().data.links.length, 1);
  const managedWorkReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/works/${managedWorkId}/reviews`,
    headers: secondaryAuthorization,
    payload: {
      reviewType: "SHORT",
      body: "这条公开评价用于验证作品下架后的社区可见性。",
      rating: 4,
      containsSpoiler: false
    }
  });
  assert.equal(managedWorkReviewResponse.statusCode, 201, managedWorkReviewResponse.body);
  const managedWorkReviewId = managedWorkReviewResponse.json().data.id;
  const publishManagedWorkReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${managedWorkReviewId}`,
    headers: adminAuthorization,
    payload: { action: "PUBLISH", reason: "验证社区动态下架一致性" }
  });
  assert.equal(
    publishManagedWorkReviewResponse.statusCode,
    200,
    publishManagedWorkReviewResponse.body
  );
  const communityBeforeWorkHiddenResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?reviewType=SHORT&pageSize=50"
  });
  assert.equal(
    communityBeforeWorkHiddenResponse.statusCode,
    200,
    communityBeforeWorkHiddenResponse.body
  );
  assert.ok(
    communityBeforeWorkHiddenResponse.json().data.some((item) => item.id === managedWorkReviewId)
  );
  assert.equal(
    communityBeforeWorkHiddenResponse.json().data.find((item) => item.id === managedWorkReviewId)
      .work.slug,
    testWorkSlug
  );
  await database.query("UPDATE users SET is_active = FALSE WHERE id = $1", [
    secondaryLoginResponse.json().data.user.id
  ]);
  const communityWithInactiveAuthorResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?reviewType=SHORT&pageSize=50"
  });
  assert.equal(
    communityWithInactiveAuthorResponse.statusCode,
    200,
    communityWithInactiveAuthorResponse.body
  );
  assert.equal(
    communityWithInactiveAuthorResponse.json().data.some((item) => item.id === managedWorkReviewId),
    false
  );
  const workReviewsWithInactiveAuthorResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${managedWorkId}/reviews?pageSize=50`
  });
  assert.equal(
    workReviewsWithInactiveAuthorResponse.statusCode,
    200,
    workReviewsWithInactiveAuthorResponse.body
  );
  assert.equal(workReviewsWithInactiveAuthorResponse.json().pagination.total, 0);
  await database.query("UPDATE users SET is_active = TRUE WHERE id = $1", [
    secondaryLoginResponse.json().data.user.id
  ]);
  const communityAfterAuthorRestoreResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?reviewType=SHORT&pageSize=50"
  });
  assert.ok(
    communityAfterAuthorRestoreResponse.json().data.some((item) => item.id === managedWorkReviewId)
  );
  const managedShelfResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${managedWorkId}`,
    headers: authorization,
    payload: { status: "WISHLIST" }
  });
  assert.equal(managedShelfResponse.statusCode, 200, managedShelfResponse.body);
  assert.equal(managedShelfResponse.json().data.work.isAvailable, true);
  const hideManagedWorkResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${managedWorkId}/status`,
    headers: adminAuthorization,
    payload: { status: "HIDDEN" }
  });
  assert.equal(hideManagedWorkResponse.statusCode, 200, hideManagedWorkResponse.body);
  const hiddenPublicWorkResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${testWorkSlug}`
  });
  assert.equal(hiddenPublicWorkResponse.statusCode, 404, hiddenPublicWorkResponse.body);
  const hiddenWorkReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${managedWorkReviewId}`
  });
  assert.equal(hiddenWorkReviewResponse.statusCode, 404, hiddenWorkReviewResponse.body);
  const communityAfterWorkHiddenResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?reviewType=SHORT&pageSize=50"
  });
  assert.equal(
    communityAfterWorkHiddenResponse.statusCode,
    200,
    communityAfterWorkHiddenResponse.body
  );
  assert.equal(
    communityAfterWorkHiddenResponse.json().data.some((item) => item.id === managedWorkReviewId),
    false
  );
  const hiddenWorkCommentResponse = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${managedWorkReviewId}/comments`,
    headers: authorization,
    payload: { body: "下架作品的评价不能继续回复。", containsSpoiler: false }
  });
  assert.equal(hiddenWorkCommentResponse.statusCode, 404, hiddenWorkCommentResponse.body);
  const hiddenWorkLikeResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/reviews/${managedWorkReviewId}/like`,
    headers: authorization
  });
  assert.equal(hiddenWorkLikeResponse.statusCode, 404, hiddenWorkLikeResponse.body);
  const hiddenWorkReportResponse = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: authorization,
    payload: {
      targetType: "REVIEW",
      targetId: managedWorkReviewId,
      reasonCode: "OTHER",
      description: "下架作品的评价不应继续接受举报写入"
    }
  });
  assert.equal(hiddenWorkReportResponse.statusCode, 404, hiddenWorkReportResponse.body);
  const retainedShelfItemResponse = await app.inject({
    method: "GET",
    url: `/api/v1/me/shelf/${managedWorkId}`,
    headers: authorization
  });
  assert.equal(retainedShelfItemResponse.statusCode, 200, retainedShelfItemResponse.body);
  assert.equal(retainedShelfItemResponse.json().data.work.isAvailable, false);
  const retainedShelfListResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/shelf?status=WISHLIST",
    headers: authorization
  });
  assert.ok(retainedShelfListResponse.json().data.some((item) => item.workId === managedWorkId));
  const updateHiddenShelfResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${managedWorkId}`,
    headers: authorization,
    payload: { status: "IN_PROGRESS" }
  });
  assert.equal(updateHiddenShelfResponse.statusCode, 404, updateHiddenShelfResponse.body);
  const removeHiddenShelfResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/me/shelf/${managedWorkId}`,
    headers: authorization
  });
  assert.equal(removeHiddenShelfResponse.statusCode, 204, removeHiddenShelfResponse.body);
  const restoreManagedWorkResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${managedWorkId}/status`,
    headers: adminAuthorization,
    payload: { status: "PUBLISHED" }
  });
  assert.equal(restoreManagedWorkResponse.statusCode, 200, restoreManagedWorkResponse.body);
  const restoredWorkReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${managedWorkReviewId}`
  });
  assert.equal(restoredWorkReviewResponse.statusCode, 200, restoredWorkReviewResponse.body);
  const trackedManagedWorkViewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${testWorkSlug}`,
    headers: { "x-visitor-id": testVisitorId }
  });
  assert.equal(trackedManagedWorkViewResponse.statusCode, 200, trackedManagedWorkViewResponse.body);
  const linkClickResponse = await app.inject({
    method: "POST",
    url: `/api/v1/work-links/${managedLinkId}/click`,
    headers: { ...authorization, "x-visitor-id": testVisitorId }
  });
  assert.equal(linkClickResponse.statusCode, 200, linkClickResponse.body);
  assert.equal(linkClickResponse.json().data.url, "https://example.com/detective-archives-integration-check");
  const linkFeedbackResponse = await app.inject({
    method: "POST",
    url: `/api/v1/work-links/${managedLinkId}/feedback`,
    headers: authorization,
    payload: { reasonCode: "BROKEN", description: "自动化验证失效链接反馈" }
  });
  assert.equal(linkFeedbackResponse.statusCode, 201, linkFeedbackResponse.body);
  const linkFeedbackId = linkFeedbackResponse.json().data.id;
  const duplicateLinkFeedbackResponse = await app.inject({
    method: "POST",
    url: `/api/v1/work-links/${managedLinkId}/feedback`,
    headers: authorization,
    payload: { reasonCode: "BROKEN" }
  });
  assert.equal(duplicateLinkFeedbackResponse.statusCode, 409, duplicateLinkFeedbackResponse.body);
  const linkFeedbackQueueResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/work-link-feedback",
    headers: adminAuthorization
  });
  assert.equal(linkFeedbackQueueResponse.statusCode, 200, linkFeedbackQueueResponse.body);
  assert.ok(linkFeedbackQueueResponse.json().data.some((item) => item.id === linkFeedbackId));
  assert.ok(linkFeedbackQueueResponse.json().pagination.total >= 1);
  const resolveLinkFeedbackResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-link-feedback/${linkFeedbackId}`,
    headers: adminAuthorization,
    payload: {
      status: "RESOLVED",
      resolutionNote: "自动化验证已处理",
      deactivateLink: true
    }
  });
  assert.equal(resolveLinkFeedbackResponse.statusCode, 200, resolveLinkFeedbackResponse.body);
  const hiddenAfterFeedbackResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${testWorkSlug}`
  });
  assert.equal(hiddenAfterFeedbackResponse.json().data.links.length, 0);
  const reenableLinkResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}`,
    headers: adminAuthorization,
    payload: { isActive: true }
  });
  assert.equal(reenableLinkResponse.statusCode, 200, reenableLinkResponse.body);
  const disableLinkResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/work-links/${managedLinkId}`,
    headers: adminAuthorization,
    payload: { isActive: false }
  });
  assert.equal(disableLinkResponse.statusCode, 200, disableLinkResponse.body);
  const disabledLinkClickResponse = await app.inject({
    method: "POST",
    url: `/api/v1/work-links/${managedLinkId}/click`,
    headers: authorization
  });
  assert.equal(disabledLinkClickResponse.statusCode, 404, disabledLinkClickResponse.body);
  assert.equal(disabledLinkClickResponse.json().code, "WORK_LINK_NOT_FOUND");
  const publicWorkWithoutLink = await app.inject({
    method: "GET",
    url: `/api/v1/works/${testWorkSlug}`
  });
  assert.equal(publicWorkWithoutLink.json().data.links.length, 0);
  const isolatedShelfResponse = await app.inject({
    method: "GET",
    url: `/api/v1/me/shelf/${workId}`,
    headers: secondaryAuthorization
  });
  assert.equal(isolatedShelfResponse.statusCode, 200, isolatedShelfResponse.body);
  assert.equal(isolatedShelfResponse.json().data, null);

  const rejectedRiskyReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/reviews`,
    headers: authorization,
    payload: {
      reviewType: "SHORT",
      body: "机器拒绝这段测试内容。",
      containsSpoiler: false
    }
  });
  assert.equal(rejectedRiskyReviewResponse.statusCode, 422, rejectedRiskyReviewResponse.body);
  assert.equal(rejectedRiskyReviewResponse.json().code, "CONTENT_NOT_ALLOWED");

  const reviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/reviews`,
    headers: authorization,
    payload: {
      reviewType: "SHORT",
      body: "这段评价需要人工复核，但仍应保持待审核。",
      rating: 5,
      containsSpoiler: false
    }
  });
  assert.equal(reviewResponse.statusCode, 201, reviewResponse.body);
  assert.equal(reviewResponse.json().data.status, "PENDING_REVIEW");
  const reviewId = reviewResponse.json().data.id;

  const ownPendingReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/me/reviews/${reviewId}`,
    headers: authorization
  });
  assert.equal(ownPendingReviewResponse.statusCode, 200, ownPendingReviewResponse.body);
  assert.equal(ownPendingReviewResponse.json().data.work.id, workId);
  assert.equal(ownPendingReviewResponse.json().data.status, "PENDING_REVIEW");
  const myReviewsPageResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/reviews?page=1&pageSize=1",
    headers: authorization
  });
  assert.equal(myReviewsPageResponse.statusCode, 200, myReviewsPageResponse.body);
  assert.equal(myReviewsPageResponse.json().data.length, 1);
  assert.equal(myReviewsPageResponse.json().pagination.total, 1);
  const reviewSafetyAudit = await database.query(`
    SELECT metadata->'contentSafety' AS safety
    FROM audit_logs
    WHERE action = 'REVIEW_CREATE' AND resource_id = $1
  `, [reviewId]);
  assert.deepEqual(reviewSafetyAudit.rows[0].safety, {
    status: "REVIEW",
    label: 200,
    traceId: "integration-review"
  });
  const otherUsersReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/me/reviews/${reviewId}`,
    headers: secondaryAuthorization
  });
  assert.equal(otherUsersReviewResponse.statusCode, 404, otherUsersReviewResponse.body);

  const longReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/reviews`,
    headers: authorization,
    payload: {
      reviewType: "LONG",
      title: "用于验证评价类型冲突",
      body: "安全服务故障时仍进入人工待审，但不能自动公开。",
      containsSpoiler: false
    }
  });
  assert.equal(longReviewResponse.statusCode, 201, longReviewResponse.body);
  const longReviewId = longReviewResponse.json().data.id;
  const unavailableSafetyAudit = await database.query(`
    SELECT metadata->'contentSafety' AS safety
    FROM audit_logs
    WHERE action = 'REVIEW_CREATE' AND resource_id = $1
  `, [longReviewId]);
  assert.deepEqual(unavailableSafetyAudit.rows[0].safety, { status: "UNAVAILABLE" });
  const rejectLongReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${longReviewId}`,
    headers: adminAuthorization,
    payload: { action: "REJECT", reason: "集成检查拒绝" }
  });
  assert.equal(rejectLongReviewResponse.statusCode, 200, rejectLongReviewResponse.body);
  assert.equal(rejectLongReviewResponse.json().data.status, "REJECTED");
  const rejectedOwnReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/me/reviews/${longReviewId}`,
    headers: authorization
  });
  assert.equal(rejectedOwnReviewResponse.statusCode, 200, rejectedOwnReviewResponse.body);
  assert.equal(rejectedOwnReviewResponse.json().data.status, "REJECTED");
  const invalidRejectedRestoreResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${longReviewId}`,
    headers: adminAuthorization,
    payload: { action: "RESTORE", reason: "拒绝内容不能直接恢复" }
  });
  assert.equal(invalidRejectedRestoreResponse.statusCode, 404, invalidRejectedRestoreResponse.body);
  const conflictingReviewUpdate = await app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${longReviewId}`,
    headers: authorization,
    payload: {
      reviewType: "SHORT",
      body: "不能覆盖已经存在的短评。",
      containsSpoiler: false
    }
  });
  assert.equal(conflictingReviewUpdate.statusCode, 409, conflictingReviewUpdate.body);
  assert.equal(conflictingReviewUpdate.json().code, "REVIEW_ALREADY_EXISTS");
  const resubmitRejectedReviewResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${longReviewId}`,
    headers: authorization,
    payload: {
      reviewType: "LONG",
      title: "修改后重新提交审核",
      body: "作者修改被拒绝的内容后，应重新进入待审核状态。",
      containsSpoiler: false
    }
  });
  assert.equal(resubmitRejectedReviewResponse.statusCode, 200, resubmitRejectedReviewResponse.body);
  assert.equal(resubmitRejectedReviewResponse.json().data.status, "PENDING_REVIEW");
  const removeLongReviewResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/reviews/${longReviewId}`,
    headers: authorization
  });
  assert.equal(removeLongReviewResponse.statusCode, 204, removeLongReviewResponse.body);

  const duplicateReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/reviews`,
    headers: authorization,
    payload: {
      reviewType: "SHORT",
      body: "重复评价不应被创建。",
      containsSpoiler: false
    }
  });
  assert.equal(duplicateReviewResponse.statusCode, 409, duplicateReviewResponse.body);

  const hiddenPendingResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${workId}/reviews`
  });
  assert.equal(hiddenPendingResponse.statusCode, 200, hiddenPendingResponse.body);
  assert.equal(hiddenPendingResponse.json().pagination.total, 0);

  const pendingReviewQueue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/moderation",
    headers: adminAuthorization
  });
  assert.equal(pendingReviewQueue.statusCode, 200, pendingReviewQueue.body);
  assert.ok(pendingReviewQueue.json().data.reviews.some((item) => item.id === reviewId));
  assert.ok(pendingReviewQueue.json().pagination.reviews.total >= 1);
  const forbiddenEditorSpoilerMarkResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${reviewId}`,
    headers: editorAuthorization,
    payload: { action: "MARK_SPOILER", reason: "编辑角色不能执行审核标记" }
  });
  assert.equal(
    forbiddenEditorSpoilerMarkResponse.statusCode,
    403,
    forbiddenEditorSpoilerMarkResponse.body
  );
  const concurrentMarkReviewSpoilerResponses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${reviewId}`,
    headers: adminAuthorization,
    payload: { action: "MARK_SPOILER", reason: "审核发现正文包含关键谜底" }
  })));
  for (const response of concurrentMarkReviewSpoilerResponses) {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.status, "PENDING_REVIEW");
    assert.equal(response.json().data.containsSpoiler, true);
  }
  assert.deepEqual(
    concurrentMarkReviewSpoilerResponses
      .map((response) => response.json().data.unchanged)
      .sort(),
    [false, true]
  );
  const reviewSpoilerAuditResult = await database.query(`
    SELECT
      (SELECT COUNT(*)::int FROM moderation_records
       WHERE target_type = 'REVIEW' AND target_id = $1 AND action = 'MARK_SPOILER') AS records,
      (SELECT COUNT(*)::int FROM audit_logs
       WHERE resource_type = 'REVIEW' AND resource_id = $1
         AND action = 'MODERATION_MARK_SPOILER') AS audits
  `, [reviewId]);
  assert.deepEqual(reviewSpoilerAuditResult.rows[0], { records: 1, audits: 1 });
  const oversizedModerationPageResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/moderation?pageSize=51",
    headers: adminAuthorization
  });
  assert.equal(oversizedModerationPageResponse.statusCode, 400, oversizedModerationPageResponse.body);
  const publishReviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${reviewId}`,
    headers: adminAuthorization,
    payload: { action: "PUBLISH", reason: "集成检查发布" }
  });
  assert.equal(publishReviewResponse.statusCode, 200, publishReviewResponse.body);
  assert.equal(publishReviewResponse.json().data.status, "PUBLISHED");
  const publicReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${workId}/reviews`
  });
  assert.equal(publicReviewResponse.statusCode, 200, publicReviewResponse.body);
  assert.equal(publicReviewResponse.json().data[0].containsSpoiler, true);
  const communityReviewResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?reviewType=SHORT&pageSize=50",
    headers: secondaryAuthorization
  });
  assert.equal(communityReviewResponse.statusCode, 200, communityReviewResponse.body);
  const communityReview = communityReviewResponse.json().data.find((item) => item.id === reviewId);
  assert.ok(communityReview);
  assert.equal(communityReview.work.id, workId);
  assert.equal(communityReview.containsSpoiler, true);
  assert.equal(communityReview.likedByMe, false);
  const unmarkPublishedReviewSpoilerResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${reviewId}`,
    headers: adminAuthorization,
    payload: { action: "UNMARK_SPOILER", reason: "复核确认正文没有泄露关键谜底" }
  });
  assert.equal(
    unmarkPublishedReviewSpoilerResponse.statusCode,
    200,
    unmarkPublishedReviewSpoilerResponse.body
  );
  assert.equal(unmarkPublishedReviewSpoilerResponse.json().data.status, "PUBLISHED");
  assert.equal(unmarkPublishedReviewSpoilerResponse.json().data.containsSpoiler, false);
  assert.equal(unmarkPublishedReviewSpoilerResponse.json().data.unchanged, false);
  const publicReviewAfterUnmarkResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${workId}/reviews`
  });
  assert.equal(publicReviewAfterUnmarkResponse.statusCode, 200, publicReviewAfterUnmarkResponse.body);
  assert.equal(publicReviewAfterUnmarkResponse.json().data[0].containsSpoiler, false);
  const longCommunityResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?reviewType=LONG&pageSize=50"
  });
  assert.equal(longCommunityResponse.statusCode, 200, longCommunityResponse.body);
  assert.equal(longCommunityResponse.json().data.some((item) => item.id === reviewId), false);
  const invalidCommunityPageResponse = await app.inject({
    method: "GET",
    url: "/api/v1/community/reviews?pageSize=51"
  });
  assert.equal(invalidCommunityPageResponse.statusCode, 400, invalidCommunityPageResponse.body);

  const hideReviewForAppealResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/REVIEW/${reviewId}`,
    headers: adminAuthorization,
    payload: { action: "HIDE", reason: "集成检查隐藏后申诉" }
  });
  assert.equal(hideReviewForAppealResponse.statusCode, 200, hideReviewForAppealResponse.body);
  const wrongOwnerAppealResponse = await app.inject({
    method: "POST",
    url: "/api/v1/appeals",
    headers: secondaryAuthorization,
    payload: { targetType: "REVIEW", targetId: reviewId, reason: "并非本人内容不能申诉" }
  });
  assert.equal(wrongOwnerAppealResponse.statusCode, 404, wrongOwnerAppealResponse.body);
  const appealResponse = await app.inject({
    method: "POST",
    url: "/api/v1/appeals",
    headers: authorization,
    payload: { targetType: "REVIEW", targetId: reviewId, reason: "内容没有违规，希望重新复核并恢复" }
  });
  assert.equal(appealResponse.statusCode, 201, appealResponse.body);
  const appealId = appealResponse.json().data.id;
  const duplicateAppealResponse = await app.inject({
    method: "POST",
    url: "/api/v1/appeals",
    headers: authorization,
    payload: { targetType: "REVIEW", targetId: reviewId, reason: "重复申诉应当被幂等保护" }
  });
  assert.equal(duplicateAppealResponse.statusCode, 409, duplicateAppealResponse.body);
  const ownHiddenReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/me/reviews/${reviewId}`,
    headers: authorization
  });
  assert.equal(ownHiddenReviewResponse.statusCode, 200, ownHiddenReviewResponse.body);
  assert.equal(ownHiddenReviewResponse.json().data.appeal.status, "OPEN");
  const appealQueueResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/moderation",
    headers: adminAuthorization
  });
  assert.ok(appealQueueResponse.json().data.appeals.some((item) => item.id === appealId));
  const approveAppealResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/appeals/${appealId}`,
    headers: adminAuthorization,
    payload: { status: "APPROVED", resolutionNote: "复核后确认可以恢复" }
  });
  assert.equal(approveAppealResponse.statusCode, 200, approveAppealResponse.body);
  assert.equal(approveAppealResponse.json().data.status, "APPROVED");
  const restoredReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${reviewId}`
  });
  assert.equal(restoredReviewResponse.statusCode, 200, restoredReviewResponse.body);

  const concurrentLikeResponses = await Promise.all(Array.from({ length: 5 }, () => app.inject({
    method: "PUT",
    url: `/api/v1/reviews/${reviewId}/like`,
    headers: secondaryAuthorization
  })));
  concurrentLikeResponses.forEach((response) => {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.likeCount, 1);
  });

  const commentResponse = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/comments`,
    headers: secondaryAuthorization,
    payload: { body: "我也注意到了前半段的伏笔。", containsSpoiler: false }
  });
  assert.equal(commentResponse.statusCode, 201, commentResponse.body);
  assert.equal(commentResponse.json().data.status, "PENDING_REVIEW");
  const commentId = commentResponse.json().data.id;
  const markCommentSpoilerResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/COMMENT/${commentId}`,
    headers: adminAuthorization,
    payload: { action: "MARK_SPOILER", reason: "回复包含案件真相，需要折叠" }
  });
  assert.equal(markCommentSpoilerResponse.statusCode, 200, markCommentSpoilerResponse.body);
  assert.equal(markCommentSpoilerResponse.json().data.containsSpoiler, true);
  const publishCommentResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/moderation/COMMENT/${commentId}`,
    headers: adminAuthorization,
    payload: { action: "PUBLISH", reason: "集成检查发布" }
  });
  assert.equal(publishCommentResponse.statusCode, 200, publishCommentResponse.body);
  assert.equal(publishCommentResponse.json().data.status, "PUBLISHED");

  const reviewDetailResponse = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${reviewId}`,
    headers: authorization
  });
  assert.equal(reviewDetailResponse.statusCode, 200, reviewDetailResponse.body);
  assert.equal(reviewDetailResponse.json().data.comments.length, 1);
  assert.equal(reviewDetailResponse.json().data.comments[0].containsSpoiler, true);
  assert.equal(reviewDetailResponse.json().data.commentPagination.total, 1);
  assert.equal(reviewDetailResponse.json().data.commentPagination.totalPages, 1);
  assert.equal(reviewDetailResponse.json().data.likedByMe, false);
  const invalidCommentPaginationResponse = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${reviewId}?commentPageSize=51`
  });
  assert.equal(invalidCommentPaginationResponse.statusCode, 400, invalidCommentPaginationResponse.body);
  assert.equal(invalidCommentPaginationResponse.json().code, "INVALID_REVIEW_QUERY");

  const concurrentReportResponses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: authorization,
    payload: { targetType: "COMMENT", targetId: commentId, reasonCode: "SPOILER" }
  })));
  assert.deepEqual(
    concurrentReportResponses.map((response) => response.statusCode).sort(),
    [201, 409]
  );
  const reportQueueResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/moderation",
    headers: adminAuthorization
  });
  const queuedReport = reportQueueResponse.json().data.reports.find(
    (item) => item.targetId === commentId
  );
  assert.ok(queuedReport);
  assert.equal(queuedReport.targetContainsSpoiler, true);
  const concurrentResolveResponses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
    method: "PATCH",
    url: `/api/v1/admin/reports/${queuedReport.id}`,
    headers: adminAuthorization,
    payload: { status: "RESOLVED", resolutionNote: "集成检查已处理" }
  })));
  assert.deepEqual(
    concurrentResolveResponses.map((response) => response.statusCode).sort(),
    [200, 404]
  );
  const successfulResolution = concurrentResolveResponses.find((response) => response.statusCode === 200);
  assert.equal(successfulResolution.json().data.status, "RESOLVED");
  const resolutionAuditCount = await database.query(`
    SELECT COUNT(*)::int AS count FROM audit_logs
    WHERE resource_type = 'REPORT' AND resource_id = $1 AND action = 'REPORT_RESOLVED'
  `, [queuedReport.id]);
  assert.equal(resolutionAuditCount.rows[0].count, 1);

  const activeDataExportResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/data-export",
    headers: authorization
  });
  assert.equal(activeDataExportResponse.statusCode, 200, activeDataExportResponse.body);
  assert.match(activeDataExportResponse.headers["content-type"] ?? "", /application\/json/);
  assert.match(
    activeDataExportResponse.headers["content-disposition"] ?? "",
    /attachment; filename="detective-archives-data-\d{4}-\d{2}-\d{2}\.json"/
  );
  assert.equal(activeDataExportResponse.headers["cache-control"], "no-store");
  const activeDataExport = activeDataExportResponse.json();
  assert.equal(activeDataExport.schemaVersion, 1);
  assert.equal(activeDataExport.data.account.id, userId);
  assert.ok(activeDataExport.data.identities.some(
    (identity) => identity.providerSubject === testIdentitySubjects[0]
  ));
  assert.equal(activeDataExport.data.reports.length, 1);
  assert.equal("resolutionNote" in activeDataExport.data.reports[0], false);
  assert.equal("handledBy" in activeDataExport.data.reports[0], false);
  assert.ok(activeDataExport.data.sessions.every(
    (session) => !("tokenHash" in session) && !("id" in session)
  ));
  assert.equal(activeDataExportResponse.body.includes(authorization.authorization.slice(7)), false);
  const exportAudit = await database.query(`
    SELECT COUNT(*)::int AS count FROM audit_logs
    WHERE actor_id = $1 AND action = 'DATA_EXPORT'
  `, [userId]);
  assert.equal(exportAudit.rows[0].count, 1);

  const wrongOwnerDeleteResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/comments/${commentId}`,
    headers: authorization
  });
  assert.equal(wrongOwnerDeleteResponse.statusCode, 404, wrongOwnerDeleteResponse.body);
  const commentDeleteResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/comments/${commentId}`,
    headers: secondaryAuthorization
  });
  assert.equal(commentDeleteResponse.statusCode, 204, commentDeleteResponse.body);

  const editReviewResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${reviewId}`,
    headers: authorization,
    payload: {
      reviewType: "SHORT",
      body: "修改后需要重新审核。",
      rating: 4,
      containsSpoiler: false
    }
  });
  assert.equal(editReviewResponse.statusCode, 200, editReviewResponse.body);
  assert.equal(editReviewResponse.json().data.status, "PENDING_REVIEW");
  const unpublishedAfterEdit = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${reviewId}`
  });
  assert.equal(unpublishedAfterEdit.statusCode, 404, unpublishedAfterEdit.body);

  const reviewDeleteResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/reviews/${reviewId}`,
    headers: authorization
  });
  assert.equal(reviewDeleteResponse.statusCode, 204, reviewDeleteResponse.body);

  const suspendUserResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/users/${secondaryLoginResponse.json().data.user.id}/suspend`,
    headers: adminAuthorization,
    payload: { durationHours: 1, reason: "集成检查用户处置" }
  });
  assert.equal(suspendUserResponse.statusCode, 200, suspendUserResponse.body);
  const suspendedSessionResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: secondaryAuthorization
  });
  assert.equal(suspendedSessionResponse.statusCode, 200, suspendedSessionResponse.body);
  assert.equal(suspendedSessionResponse.json().data.isSuspended, true);
  assert.ok(suspendedSessionResponse.json().data.suspendedUntil);
  assert.equal("wechatOpenId" in suspendedSessionResponse.json().data, false);
  const suspendedWriteResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: secondaryAuthorization,
    payload: { status: "WISHLIST" }
  });
  assert.equal(suspendedWriteResponse.statusCode, 403, suspendedWriteResponse.body);
  assert.equal(suspendedWriteResponse.json().code, "ACCOUNT_SUSPENDED");
  const suspendedFeedbackResponse = await app.inject({
    method: "POST",
    url: `/api/v1/work-links/${managedLinkId}/feedback`,
    headers: secondaryAuthorization,
    payload: { reasonCode: "OTHER", description: "暂停账号不得写入反馈" }
  });
  assert.equal(suspendedFeedbackResponse.statusCode, 403, suspendedFeedbackResponse.body);
  assert.equal(suspendedFeedbackResponse.json().code, "ACCOUNT_SUSPENDED");
  const suspendedDataExportResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/data-export",
    headers: secondaryAuthorization
  });
  assert.equal(suspendedDataExportResponse.statusCode, 200, suspendedDataExportResponse.body);
  assert.equal(
    suspendedDataExportResponse.json().data.account.id,
    secondaryLoginResponse.json().data.user.id
  );
  assert.equal(
    suspendedDataExportResponse.body.includes(secondaryAuthorization.authorization.slice(7)),
    false
  );
  const previousSuspendedAuthorization = secondaryAuthorization;
  const suspendedRefreshResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    headers: secondaryAuthorization
  });
  assert.equal(suspendedRefreshResponse.statusCode, 200, suspendedRefreshResponse.body);
  assert.equal(suspendedRefreshResponse.json().data.user.isSuspended, true);
  secondaryAuthorization = {
    authorization: `Bearer ${suspendedRefreshResponse.json().data.token}`
  };
  const revokedSuspendedSessionResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: previousSuspendedAuthorization
  });
  assert.equal(revokedSuspendedSessionResponse.statusCode, 401, revokedSuspendedSessionResponse.body);
  const refreshedSuspendedSessionResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: secondaryAuthorization
  });
  assert.equal(refreshedSuspendedSessionResponse.statusCode, 200, refreshedSuspendedSessionResponse.body);
  assert.equal(refreshedSuspendedSessionResponse.json().data.isSuspended, true);

  const auditResponse = await database.query(`
    SELECT COUNT(*)::int AS count FROM audit_logs
    WHERE actor_id = ANY($1) AND action IN (
      'REVIEW_CREATE', 'REVIEW_UPDATE', 'REVIEW_DELETE',
      'COMMENT_CREATE', 'COMMENT_DELETE', 'REPORT_CREATE'
    )
  `, [[userId, secondaryLoginResponse.json().data.user.id]]);
  assert.ok(auditResponse.rows[0].count >= 6);
  const adminAuditResponse = await database.query(`
    SELECT COUNT(*)::int AS count FROM audit_logs
    WHERE actor_id = $1 AND action IN (
      'MODERATION_PUBLISH', 'REPORT_RESOLVED', 'USER_SUSPEND'
    )
  `, [adminUserId]);
  assert.ok(adminAuditResponse.rows[0].count >= 4);
  const auditApiResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/audit-logs?action=USER_ROLE_CHANGE&pageSize=20",
    headers: adminAuthorization
  });
  assert.equal(auditApiResponse.statusCode, 200, auditApiResponse.body);
  assert.ok(auditApiResponse.json().data.length >= 2);

  const deactivationLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "deactivation-user",
      agreements: { termsAccepted: true, privacyAccepted: true }
    }
  });
  assert.equal(deactivationLoginResponse.statusCode, 201, deactivationLoginResponse.body);
  deactivatedTestUserId = deactivationLoginResponse.json().data.user.id;
  const deactivationAuthorization = {
    authorization: `Bearer ${deactivationLoginResponse.json().data.token}`
  };
  const consentRecord = await database.query(`
    SELECT terms_accepted_at, privacy_accepted_at FROM users WHERE id = $1
  `, [deactivatedTestUserId]);
  assert.ok(consentRecord.rows[0].terms_accepted_at);
  assert.ok(consentRecord.rows[0].privacy_accepted_at);
  const deactivationShelfResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/me/shelf/${workId}`,
    headers: deactivationAuthorization,
    payload: { status: "WISHLIST", progressPercent: 0 }
  });
  assert.equal(deactivationShelfResponse.statusCode, 200, deactivationShelfResponse.body);
  const suspendDeactivationUserResponse = await app.inject({
    method: "POST",
    url: `/api/v1/admin/users/${deactivatedTestUserId}/suspend`,
    headers: adminAuthorization,
    payload: { durationHours: 1, reason: "验证受限账号仍可行使数据权利" }
  });
  assert.equal(suspendDeactivationUserResponse.statusCode, 200, suspendDeactivationUserResponse.body);
  const suspendedDeactivationExportResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/data-export",
    headers: deactivationAuthorization
  });
  assert.equal(
    suspendedDeactivationExportResponse.statusCode,
    200,
    suspendedDeactivationExportResponse.body
  );
  assert.equal(
    suspendedDeactivationExportResponse.json().data.account.id,
    deactivatedTestUserId
  );
  const rateLimitedDataExportResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me/data-export",
    headers: deactivationAuthorization
  });
  assert.equal(rateLimitedDataExportResponse.statusCode, 429, rateLimitedDataExportResponse.body);
  const deactivateResponse = await app.inject({
    method: "DELETE",
    url: "/api/v1/me/account",
    headers: deactivationAuthorization,
    payload: { confirmation: "DELETE" }
  });
  assert.equal(deactivateResponse.statusCode, 204, deactivateResponse.body);
  const deactivatedSessionResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: deactivationAuthorization
  });
  assert.equal(deactivatedSessionResponse.statusCode, 401, deactivatedSessionResponse.body);
  const deactivatedRecord = await database.query(`
    SELECT is_active, display_name, deactivated_at,
      (SELECT COUNT(*)::int FROM user_identities WHERE user_id = users.id) AS identity_count,
      (SELECT COUNT(*)::int FROM shelf_engagement_facts WHERE user_id = users.id) AS shelf_fact_count,
      (SELECT COUNT(*)::int FROM user_activity_days WHERE user_id = users.id) AS activity_day_count
    FROM users WHERE id = $1
  `, [deactivatedTestUserId]);
  assert.equal(deactivatedRecord.rows[0].is_active, false);
  assert.equal(deactivatedRecord.rows[0].display_name, "已注销用户");
  assert.equal(deactivatedRecord.rows[0].identity_count, 0);
  assert.equal(deactivatedRecord.rows[0].shelf_fact_count, 0);
  assert.equal(deactivatedRecord.rows[0].activity_day_count, 0);

  const suspendedLogoutResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: secondaryAuthorization
  });
  assert.equal(suspendedLogoutResponse.statusCode, 204, suspendedLogoutResponse.body);
  const loggedOutSuspendedSessionResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: secondaryAuthorization
  });
  assert.equal(
    loggedOutSuspendedSessionResponse.statusCode,
    401,
    loggedOutSuspendedSessionResponse.body
  );

  const logoutResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: authorization
  });
  assert.equal(logoutResponse.statusCode, 204, logoutResponse.body);
  const expiredResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: authorization
  });
  assert.equal(expiredResponse.statusCode, 401, expiredResponse.body);

  await database.query(`
    UPDATE users SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1
  `, [userId]);
  await database.query(`
    UPDATE shelf_engagement_facts
    SET first_added_at = NOW() - INTERVAL '8 days' + INTERVAL '1 hour'
    WHERE user_id = $1
  `, [userId]);
  await database.query(`
    INSERT INTO user_activity_days (
      user_id, activity_date, first_seen_at, last_seen_at, event_count
    ) VALUES (
      $1,
      (NOW() AT TIME ZONE 'UTC')::date - 1,
      NOW() - INTERVAL '1 day',
      NOW() - INTERVAL '1 day',
      1
    )
    ON CONFLICT (user_id, activity_date) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at
  `, [userId]);

  const analyticsResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/analytics?days=90",
    headers: adminAuthorization
  });
  assert.equal(analyticsResponse.statusCode, 200, analyticsResponse.body);
  const analytics = analyticsResponse.json().data;
  assert.equal(analytics.periodDays, 90);
  assert.ok(analytics.archiveDetail.listVisitors >= 1);
  assert.ok(analytics.archiveDetail.detailVisitors >= 1);
  assert.ok(analytics.officialLink.detailVisitors >= 1);
  assert.ok(analytics.officialLink.clickVisitors >= 1);
  assert.ok(analytics.firstShelf.newUsers >= 1);
  assert.ok(analytics.firstShelf.convertedUsers >= 1);
  assert.ok(analytics.retention.day7.eligibleUsers >= 1);
  assert.ok(analytics.retention.day7.retainedUsers >= 1);
  assert.equal(typeof analytics.retention.day7.rate, "number");
  assert.equal(typeof analytics.communityModeration.commentReportRate, "number");
  assert.ok(analytics.communityModeration.handledAppeals >= 1);
  assert.ok(analytics.communityModeration.approvedAppeals >= 1);
  assert.ok(analytics.communityModeration.appealRecoveryRate > 0);

  console.log(
    `PostgreSQL API integration: OK (${checks.length} public checks, community feed, personal data export, product analytics, session rotation, role and audit administration, detective publishing, link feedback and manual review, concurrency, account and moderation lifecycle)`
  );
} finally {
  await cleanupTestUsers();
  await app.close();
}

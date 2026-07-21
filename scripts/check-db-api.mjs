import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildApp } from "../apps/api/dist/app.js";
import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";

const database = createDatabasePoolFromEnv();
assert.ok(database, "PostgreSQL configuration is required for the database API check");
const testAdminLoginId = "detective-archives-admin-check";
const testAdminPassword = "integration-admin-password";
const testWorkSlug = "database-api-check-work";
const catalogExpansion = JSON.parse(await readFile(
  new URL("../apps/api/src/data/catalog-expansion.json", import.meta.url),
  "utf8"
));
const expectedPublishedWorkCount = 5 + new Set(
  catalogExpansion.detectives.flatMap((detective) => detective.works.map((work) => work.slug))
).size;
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
const app = await buildApp({
  database,
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
    ["/api/v1/detectives?pageSize=50", (body) => assert.equal(body.pagination.total, 26)],
    ["/api/v1/detectives/sherlock-holmes", (body) => {
      assert.equal(body.data.works[0].slug, "a-study-in-scarlet");
    }],
    ["/api/v1/archive-directory?pageSize=50", (body) => assert.equal(body.pagination.total, 23)],
    ["/api/v1/archive-directory?q=%E5%BF%83%E7%90%86%E7%BD%AA", (body) => {
      assert.equal(body.data[0].id, "EXT-CN-003");
    }],
    ["/api/v1/picture-book?pageSize=150", (body) => assert.equal(body.pagination.total, 109)],
    ["/api/v1/picture-book?q=%E9%B2%81%E9%82%A6", (body) => {
      assert.equal(body.data[0].id, "PB-004-STD");
    }],
    ["/api/v1/works?pageSize=20", (body) => assert.equal(body.pagination.total, expectedPublishedWorkCount)],
    ["/api/v1/works/d-slope-murder-case", (body) => assert.equal(body.data.links.length, 2)]
  ];

  for (const [url, verify] of checks) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    verify(response.json());
  }

  const workResponse = await app.inject({
    method: "GET",
    url: "/api/v1/works/a-study-in-scarlet"
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

  const secondaryLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: {
      code: "secondary-user",
      agreements: { termsAccepted: true, privacyAccepted: true }
    }
  });
  assert.equal(secondaryLoginResponse.statusCode, 201, secondaryLoginResponse.body);
  const secondaryAuthorization = {
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
  assert.ok(dashboardResponse.json().data.publishedDetectiveCount >= 26);

  const usersResponse = await app.inject({
    method: "GET",
    url: "/api/v1/admin/users?pageSize=100",
    headers: adminAuthorization
  });
  assert.equal(usersResponse.statusCode, 200, usersResponse.body);
  assert.ok(usersResponse.json().data.some((item) => item.id === editorUserId));
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
  const publicManagedWork = await app.inject({
    method: "GET",
    url: `/api/v1/works/${testWorkSlug}`
  });
  assert.equal(publicManagedWork.statusCode, 200, publicManagedWork.body);
  assert.equal(publicManagedWork.json().data.links.length, 1);
  const linkClickResponse = await app.inject({
    method: "POST",
    url: `/api/v1/work-links/${managedLinkId}/click`,
    headers: authorization
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

  const reviewResponse = await app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/reviews`,
    headers: authorization,
    payload: {
      reviewType: "SHORT",
      body: "线索铺陈很公平，结尾值得回看。",
      rating: 5,
      containsSpoiler: true
    }
  });
  assert.equal(reviewResponse.statusCode, 201, reviewResponse.body);
  assert.equal(reviewResponse.json().data.status, "PENDING_REVIEW");
  const reviewId = reviewResponse.json().data.id;

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
  assert.equal(reviewDetailResponse.json().data.likedByMe, false);

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
  assert.equal(suspendedSessionResponse.statusCode, 401, suspendedSessionResponse.body);

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
      (SELECT COUNT(*)::int FROM user_identities WHERE user_id = users.id) AS identity_count
    FROM users WHERE id = $1
  `, [deactivatedTestUserId]);
  assert.equal(deactivatedRecord.rows[0].is_active, false);
  assert.equal(deactivatedRecord.rows[0].display_name, "已注销用户");
  assert.equal(deactivatedRecord.rows[0].identity_count, 0);

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

  console.log(
    `PostgreSQL API integration: OK (${checks.length} public checks, session rotation, role and audit administration, detective publishing, link feedback, concurrency, account, community and moderation lifecycle)`
  );
} finally {
  await cleanupTestUsers();
  await app.close();
}

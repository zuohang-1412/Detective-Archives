import assert from "node:assert/strict";
import { buildApp } from "../apps/api/dist/app.js";
import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";

const database = createDatabasePoolFromEnv();
assert.ok(database, "PostgreSQL configuration is required for the database API check");
const testProviderSubjects = [
  "detective-archives-db-api-check-primary",
  "detective-archives-db-api-check-secondary"
];
async function cleanupTestUsers() {
  await database.query(`
    DELETE FROM audit_logs
    WHERE actor_id IN (
      SELECT user_id FROM user_identities
      WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
    )
  `, [testProviderSubjects]);
  await database.query(`
    DELETE FROM reports
    WHERE reporter_id IN (
      SELECT user_id FROM user_identities
      WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
    )
    OR target_id IN (
      SELECT review.id FROM reviews review
      JOIN user_identities identity ON identity.user_id = review.user_id
      WHERE identity.provider = 'WECHAT' AND identity.provider_subject = ANY($1)
      UNION
      SELECT comment.id FROM comments comment
      JOIN user_identities identity ON identity.user_id = comment.user_id
      WHERE identity.provider = 'WECHAT' AND identity.provider_subject = ANY($1)
    )
  `, [testProviderSubjects]);
  await database.query(`
    DELETE FROM comments
    WHERE user_id IN (
      SELECT user_id FROM user_identities
      WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
    )
    OR review_id IN (
      SELECT review.id FROM reviews review
      JOIN user_identities identity ON identity.user_id = review.user_id
      WHERE identity.provider = 'WECHAT' AND identity.provider_subject = ANY($1)
    )
  `, [testProviderSubjects]);
  await database.query(`
    DELETE FROM reviews
    WHERE user_id IN (
      SELECT user_id FROM user_identities
      WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
    )
  `, [testProviderSubjects]);
  await database.query(`
    DELETE FROM users
    WHERE id IN (
      SELECT user_id FROM user_identities
      WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
    )
  `, [testProviderSubjects]);
}
await cleanupTestUsers();
const app = await buildApp({
  database,
  wechatCodeExchange: async (code) => ({
    providerSubject: code === "secondary-user"
      ? testProviderSubjects[1]
      : testProviderSubjects[0]
  }),
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
    ["/api/v1/works?pageSize=20", (body) => assert.equal(body.pagination.total, 5)],
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
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: { code: "database-api-check", profile: { displayName: "集成测试用户" } }
  });
  assert.equal(loginResponse.statusCode, 201, loginResponse.body);
  const token = loginResponse.json().data.token;
  const userId = loginResponse.json().data.user.id;
  const authorization = { authorization: `Bearer ${token}` };

  const repeatLoginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat",
    payload: { code: "database-api-check", profile: { displayName: "不会重复创建" } }
  });
  assert.equal(repeatLoginResponse.statusCode, 201, repeatLoginResponse.body);
  assert.equal(repeatLoginResponse.json().data.user.id, userId);

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
    payload: { code: "secondary-user" }
  });
  assert.equal(secondaryLoginResponse.statusCode, 201, secondaryLoginResponse.body);
  const secondaryAuthorization = {
    authorization: `Bearer ${secondaryLoginResponse.json().data.token}`
  };
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

  await database.query(`
    UPDATE reviews SET status = 'PUBLISHED', published_at = NOW()
    WHERE id = $1
  `, [reviewId]);
  const publicReviewResponse = await app.inject({
    method: "GET",
    url: `/api/v1/works/${workId}/reviews`
  });
  assert.equal(publicReviewResponse.statusCode, 200, publicReviewResponse.body);
  assert.equal(publicReviewResponse.json().data[0].containsSpoiler, true);

  const likeResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/reviews/${reviewId}/like`,
    headers: secondaryAuthorization
  });
  assert.equal(likeResponse.statusCode, 200, likeResponse.body);
  assert.equal(likeResponse.json().data.likeCount, 1);
  const repeatedLikeResponse = await app.inject({
    method: "PUT",
    url: `/api/v1/reviews/${reviewId}/like`,
    headers: secondaryAuthorization
  });
  assert.equal(repeatedLikeResponse.statusCode, 200, repeatedLikeResponse.body);
  assert.equal(repeatedLikeResponse.json().data.likeCount, 1);

  const commentResponse = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/comments`,
    headers: secondaryAuthorization,
    payload: { body: "我也注意到了前半段的伏笔。", containsSpoiler: false }
  });
  assert.equal(commentResponse.statusCode, 201, commentResponse.body);
  assert.equal(commentResponse.json().data.status, "PENDING_REVIEW");
  const commentId = commentResponse.json().data.id;
  await database.query(`
    UPDATE comments SET status = 'PUBLISHED', published_at = NOW()
    WHERE id = $1
  `, [commentId]);

  const reviewDetailResponse = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${reviewId}`,
    headers: authorization
  });
  assert.equal(reviewDetailResponse.statusCode, 200, reviewDetailResponse.body);
  assert.equal(reviewDetailResponse.json().data.comments.length, 1);
  assert.equal(reviewDetailResponse.json().data.likedByMe, false);

  const reportResponse = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: authorization,
    payload: { targetType: "COMMENT", targetId: commentId, reasonCode: "SPOILER" }
  });
  assert.equal(reportResponse.statusCode, 201, reportResponse.body);
  const duplicateReportResponse = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: authorization,
    payload: { targetType: "COMMENT", targetId: commentId, reasonCode: "SPOILER" }
  });
  assert.equal(duplicateReportResponse.statusCode, 409, duplicateReportResponse.body);

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

  const auditResponse = await database.query(`
    SELECT COUNT(*)::int AS count FROM audit_logs
    WHERE actor_id = ANY($1) AND action IN (
      'REVIEW_CREATE', 'REVIEW_UPDATE', 'REVIEW_DELETE',
      'COMMENT_CREATE', 'COMMENT_DELETE', 'REPORT_CREATE'
    )
  `, [[userId, secondaryLoginResponse.json().data.user.id]]);
  assert.ok(auditResponse.rows[0].count >= 6);

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
    `PostgreSQL API integration: OK (${checks.length} public checks, auth, shelf and community lifecycle)`
  );
} finally {
  await cleanupTestUsers();
  await app.close();
}

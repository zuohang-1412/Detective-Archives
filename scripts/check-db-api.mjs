import assert from "node:assert/strict";
import { buildApp } from "../apps/api/dist/app.js";
import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";

const database = createDatabasePoolFromEnv();
assert.ok(database, "PostgreSQL configuration is required for the database API check");
const testProviderSubjects = [
  "detective-archives-db-api-check-primary",
  "detective-archives-db-api-check-secondary"
];
await database.query(`
  DELETE FROM users
  WHERE id IN (
    SELECT user_id FROM user_identities
    WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
  )
`, [testProviderSubjects]);
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
    `PostgreSQL API integration: OK (${checks.length} public checks, auth and shelf lifecycle)`
  );
} finally {
  await database.query(`
    DELETE FROM users
    WHERE id IN (
    SELECT user_id FROM user_identities
      WHERE provider = 'WECHAT' AND provider_subject = ANY($1)
    )
  `, [testProviderSubjects]);
  await app.close();
}

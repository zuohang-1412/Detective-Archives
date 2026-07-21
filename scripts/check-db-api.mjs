import assert from "node:assert/strict";
import { buildApp } from "../apps/api/dist/app.js";
import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";

const database = createDatabasePoolFromEnv();
assert.ok(database, "PostgreSQL configuration is required for the database API check");
const app = await buildApp({ database });

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
  console.log(`PostgreSQL API integration: OK (${checks.length} endpoint checks)`);
} finally {
  await app.close();
}

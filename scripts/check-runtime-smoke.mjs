import assert from "node:assert/strict";

const baseUrl = new URL(process.env.RUNTIME_BASE_URL ?? "http://127.0.0.1:3000");
const metricsToken = process.env.METRICS_AUTH_TOKEN;
if (!metricsToken) throw new Error("METRICS_AUTH_TOKEN is required for the runtime smoke check");

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(new URL(pathname, baseUrl), {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function json(pathname, expectedStatus = 200, options = {}) {
  const response = await request(pathname, options);
  assert.equal(response.status, expectedStatus, `${pathname} returned ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store", `${pathname} must not be cached`);
  assert.ok(response.headers.get("x-request-id"), `${pathname} must include a request ID`);
  return response.json();
}

let ready = null;
let lastReadyError = null;
for (let attempt = 0; attempt < 90; attempt += 1) {
  try {
    const response = await request("/ready");
    if (response.status === 200) {
      ready = await response.json();
      break;
    }
    lastReadyError = new Error(`/ready returned ${response.status}`);
  } catch (error) {
    lastReadyError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!ready) throw lastReadyError ?? new Error("Runtime did not become ready");
assert.deepEqual(ready, {
  status: "ready",
  service: "detective-archives-api",
  database: "connected"
});

const health = await json("/health");
assert.equal(health.status, "ok");
assert.equal(health.service, "detective-archives-api");

const detectives = await json("/api/v1/detectives?pageSize=1");
assert.equal(detectives.pagination.total, 132);
assert.equal(detectives.data.length, 1);
assert.equal(detectives.facets.categories.length, 5);
assert.ok(detectives.facets.countries.includes("日本"));
assert.ok(detectives.facets.tags.length > 10);

const works = await json("/api/v1/works?pageSize=1");
assert.equal(works.pagination.total, 119);
assert.equal(works.data.length, 1);

const pictureBook = await json("/api/v1/picture-book?pageSize=1");
assert.equal(pictureBook.pagination.total, 109);
assert.equal(pictureBook.data.length, 1);

const missing = await json("/api/v1/detectives/not-a-real-detective", 404);
assert.equal(missing.code, "DETECTIVE_NOT_FOUND");

const admin = await request("/admin/");
assert.equal(admin.status, 200);
assert.match(admin.headers.get("content-type") ?? "", /^text\/html/);
assert.match(await admin.text(), /侦探档案馆/);

const metricsWithoutToken = await json("/metrics", 401);
assert.equal(metricsWithoutToken.code, "METRICS_AUTH_REQUIRED");
const metrics = await request("/metrics", {
  headers: { authorization: `Bearer ${metricsToken}` }
});
assert.equal(metrics.status, 200);
assert.match(metrics.headers.get("content-type") ?? "", /^text\/plain/);
assert.match(await metrics.text(), /detective_archives_http_requests_total/);

console.log(JSON.stringify({
  status: "runtime_smoke_ok",
  detectives: detectives.pagination.total,
  works: works.pagination.total,
  pictureBookEntries: pictureBook.pagination.total,
  admin: "reachable",
  metrics: "protected"
}));

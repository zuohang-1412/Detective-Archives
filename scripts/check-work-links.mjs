import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";
import { validatePublicHttpsUrl } from "./lib/link-safety.mjs";

const database = createDatabasePoolFromEnv();
if (!database) throw new Error("PostgreSQL configuration is required for link checks");

const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = limitArgument
  ? Number.parseInt(limitArgument.slice("--limit=".length), 10)
  : 500;
if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
  throw new Error("--limit must be an integer between 1 and 5000");
}
const failOnBroken = process.argv.includes("--fail-on-broken");
const onlyFailed = process.argv.includes("--only-failed");

async function fetchWithSafeRedirects(initialUrl, method) {
  let current = await validatePublicHttpsUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response;
    try {
      response = await fetch(current, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "DetectiveArchives-LinkHealth/1.0",
          accept: "text/html,application/xhtml+xml"
        }
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status < 300 || response.status >= 400) {
      await response.body?.cancel();
      return { response, finalUrl: current.toString() };
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return { response, finalUrl: current.toString() };
    if (redirectCount === 5) {
      throw Object.assign(new Error("TOO_MANY_REDIRECTS"), { code: "TOO_MANY_REDIRECTS" });
    }
    current = await validatePublicHttpsUrl(new URL(location, current).toString());
  }
  throw Object.assign(new Error("TOO_MANY_REDIRECTS"), { code: "TOO_MANY_REDIRECTS" });
}

function errorCode(error) {
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code).slice(0, 80);
  }
  return "FETCH_FAILED";
}

async function checkLink(link) {
  const startedAt = Date.now();
  try {
    let result = await fetchWithSafeRedirects(link.url, "HEAD");
    if (result.response.status === 405 || result.response.status === 501) {
      result = await fetchWithSafeRedirects(link.url, "GET");
    }
    const statusCode = result.response.status;
    const isOk = (statusCode >= 200 && statusCode < 400)
      || statusCode === 401
      || statusCode === 403;
    return {
      link,
      statusCode,
      isOk,
      responseTimeMs: Date.now() - startedAt,
      finalUrl: result.finalUrl,
      errorCode: isOk ? null : `HTTP_${statusCode}`
    };
  } catch (error) {
    return {
      link,
      statusCode: null,
      isOk: false,
      responseTimeMs: Date.now() - startedAt,
      finalUrl: null,
      errorCode: errorCode(error)
    };
  }
}

async function persistResult(result) {
  await database.query(`
    WITH recorded AS (
      INSERT INTO work_link_health_checks (
        work_link_id, status_code, is_ok, response_time_ms, final_url, error_code
      ) VALUES ($1, $2, $3, $4, $5, $6)
    )
    UPDATE work_links
    SET last_checked_at = NOW(),
      last_status_code = $2,
      last_check_ok = $3,
      last_check_error = $6,
      consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures + 1 END,
      updated_at = NOW()
    WHERE id = $1
  `, [
    result.link.id,
    result.statusCode,
    result.isOk,
    result.responseTimeMs,
    result.finalUrl,
    result.errorCode
  ]);
}

try {
  const links = await database.query(`
    SELECT link.id, link.url, link.provider_name AS "providerName", work.title_zh AS "workTitle"
    FROM work_links link
    JOIN works work ON work.id = link.work_id
    WHERE link.is_active = TRUE
      AND work.status = 'PUBLISHED'
      AND (NOT $2::boolean OR link.last_check_ok = FALSE)
    ORDER BY link.last_checked_at ASC NULLS FIRST, link.created_at
    LIMIT $1
  `, [limit, onlyFailed]);
  const results = [];
  const pending = [...links.rows];
  const workers = Array.from({ length: Math.min(5, pending.length) }, async () => {
    while (pending.length) {
      const link = pending.shift();
      if (!link) return;
      const result = await checkLink(link);
      await persistResult(result);
      results.push(result);
    }
  });
  await Promise.all(workers);

  const failures = results.filter((result) => !result.isOk);
  console.log(JSON.stringify({
    checked: results.length,
    healthy: results.length - failures.length,
    unhealthy: failures.length,
    failures: failures.map((result) => ({
      workTitle: result.link.workTitle,
      providerName: result.link.providerName,
      errorCode: result.errorCode,
      statusCode: result.statusCode
    }))
  }, null, 2));
  if (failOnBroken && failures.length) process.exitCode = 1;
} finally {
  await database.end();
}

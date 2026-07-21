import { createDatabasePoolFromEnv } from "../apps/api/dist/db/pool.js";
import {
  classifyLinkHealth,
  isHealthyLinkStatus,
  linkHealthOutcome
} from "./lib/link-health.mjs";
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

function integerArgument(name, fallback, minimum, maximum) {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  const parsed = argument
    ? Number.parseInt(argument.slice(name.length + 3), 10)
    : fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

const concurrency = integerArgument("concurrency", 5, 1, 20);
const retries = integerArgument("retries", 1, 0, 3);
const timeoutMs = integerArgument("timeout-ms", 10_000, 1_000, 60_000);

async function fetchWithSafeRedirects(initialUrl, method) {
  let current = await validatePublicHttpsUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    try {
      const headResult = await fetchWithSafeRedirects(link.url, "HEAD");
      if (isHealthyLinkStatus(headResult.response.status)) {
        return {
          link,
          statusCode: headResult.response.status,
          isOk: true,
          lastCheckOk: true,
          outcome: linkHealthOutcome.HEALTHY,
          responseTimeMs: Date.now() - startedAt,
          finalUrl: headResult.finalUrl,
          errorCode: null
        };
      }
    } catch {
      // Some official sites reject or stall HEAD requests. GET is authoritative.
    }

    let result = null;
    let resultError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        result = await fetchWithSafeRedirects(link.url, "GET");
        resultError = null;
        const outcome = classifyLinkHealth(result.response.status);
        if (outcome !== linkHealthOutcome.UNCONFIRMED || attempt === retries) break;
      } catch (error) {
        result = null;
        resultError = error;
        if (attempt === retries) throw error;
      }
    }
    if (!result) throw resultError ?? new Error("FETCH_FAILED");

    const statusCode = result.response.status;
    const outcome = classifyLinkHealth(statusCode);
    return {
      link,
      statusCode,
      isOk: outcome === linkHealthOutcome.HEALTHY,
      lastCheckOk: outcome === linkHealthOutcome.HEALTHY
        ? true
        : outcome === linkHealthOutcome.BROKEN
          ? false
          : null,
      outcome,
      responseTimeMs: Date.now() - startedAt,
      finalUrl: result.finalUrl,
      errorCode: outcome === linkHealthOutcome.HEALTHY ? null : `HTTP_${statusCode}`
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      link,
      statusCode: null,
      isOk: false,
      lastCheckOk: null,
      outcome: classifyLinkHealth(null, code),
      responseTimeMs: Date.now() - startedAt,
      finalUrl: null,
      errorCode: code
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
      last_check_ok = $7,
      last_check_error = $6,
      consecutive_failures = CASE
        WHEN $7::boolean IS TRUE THEN 0
        WHEN $7::boolean IS FALSE THEN consecutive_failures + 1
        ELSE 0
      END,
      updated_at = NOW()
    WHERE id = $1
  `, [
    result.link.id,
    result.statusCode,
    result.isOk,
    result.responseTimeMs,
    result.finalUrl,
    result.errorCode,
    result.lastCheckOk
  ]);
}

try {
  const links = await database.query(`
    SELECT link.id, link.url, link.provider_name AS "providerName", work.title_zh AS "workTitle"
    FROM work_links link
    JOIN works work ON work.id = link.work_id
    WHERE link.is_active = TRUE
      AND work.status = 'PUBLISHED'
      AND (NOT $2::boolean OR link.last_check_ok IS NOT TRUE)
    ORDER BY link.last_checked_at ASC NULLS FIRST, link.created_at
    LIMIT $1
  `, [limit, onlyFailed]);
  const results = [];
  const pending = [...links.rows];
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
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
  const broken = failures.filter((result) => result.outcome === linkHealthOutcome.BROKEN);
  const unconfirmed = failures.filter((result) => result.outcome === linkHealthOutcome.UNCONFIRMED);
  console.log(JSON.stringify({
    checked: results.length,
    healthy: results.length - failures.length,
    unhealthy: failures.length,
    broken: broken.length,
    unconfirmed: unconfirmed.length,
    settings: { concurrency, retries, timeoutMs },
    failures: failures.map((result) => ({
      workTitle: result.link.workTitle,
      providerName: result.link.providerName,
      outcome: result.outcome,
      errorCode: result.errorCode,
      statusCode: result.statusCode
    }))
  }, null, 2));
  if (failOnBroken && broken.length) process.exitCode = 1;
} finally {
  await database.end();
}

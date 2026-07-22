import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { isPrivateAddress } from "./link-safety.mjs";

export const PRODUCTION_PROBE_CHECKS = Object.freeze([
  "HEALTH",
  "READY",
  "DETECTIVES",
  "WORKS",
  "PICTURE_BOOK",
  "COMMUNITY",
  "ADMIN",
  "METRICS_UNAUTHENTICATED",
  "METRICS_AUTHENTICATED"
]);

export const PRODUCTION_DRILL_PHASES = Object.freeze([
  "CANDIDATE_BEFORE_ROLLBACK",
  "PREVIOUS_AFTER_ROLLBACK",
  "CANDIDATE_RESTORED"
]);

const maximumReceiptAgeMs = 30 * 24 * 60 * 60 * 1000;
const maximumBackupAgeMs = 26 * 60 * 60 * 1000;
const maximumDrillDurationMs = 2 * 60 * 60 * 1000;
const minimumCertificateValidityMs = 7 * 24 * 60 * 60 * 1000;
const futureClockToleranceMs = 5 * 60 * 1000;
const imageIdPattern = /^sha256:[0-9a-f]{64}$/i;
const sourceCommitPattern = /^[0-9a-f]{40}$/i;
const imageTagPattern = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function canonicalTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function exactHttpsOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.origin === value
      && url.username === ""
      && url.password === ""
      && (url.port === "" || url.port === "443")
      ? url
      : null;
  } catch {
    return null;
  }
}

function validChecks(checks) {
  if (!Array.isArray(checks) || checks.length !== PRODUCTION_PROBE_CHECKS.length) return false;
  const checkMap = new Map(checks.map((check) => [check?.id, check]));
  return checkMap.size === PRODUCTION_PROBE_CHECKS.length
    && PRODUCTION_PROBE_CHECKS.every((id) => checkMap.get(id)?.status === "PASSED");
}

function validTlsEvidence(evidence, checkedAt) {
  const validFrom = canonicalTime(evidence?.validFrom);
  const validTo = canonicalTime(evidence?.validTo);
  return evidence?.authorized === true
    && new Set(["TLSv1.2", "TLSv1.3"]).has(evidence.protocol)
    && fingerprintPattern.test(evidence.fingerprint256 || "")
    && validFrom !== null
    && validTo !== null
    && validFrom <= checkedAt + futureClockToleranceMs
    && validTo >= checkedAt + minimumCertificateValidityMs;
}

export function validPublicProductionProbe(probe, {
  publicApiOrigin = null,
  now = Date.now()
} = {}) {
  const origin = exactHttpsOrigin(probe?.publicApiOrigin);
  const checkedAt = canonicalTime(probe?.checkedAt);
  if (!origin
    || (publicApiOrigin && origin.origin !== publicApiOrigin)
    || checkedAt === null
    || checkedAt > now + futureClockToleranceMs
    || checkedAt < now - maximumReceiptAgeMs) return false;
  const expectedRedirect = new URL("/health", origin).href;
  return probe.schemaVersion === 1
    && probe.status === "PASSED"
    && new Set([301, 302, 307, 308]).has(probe.httpRedirect?.status)
    && probe.httpRedirect?.location === expectedRedirect
    && validTlsEvidence(probe.tls, checkedAt)
    && validChecks(probe.checks);
}

export async function inspectPublicTls(publicApiOrigin, {
  connectImpl = tls.connect
} = {}) {
  const url = exactHttpsOrigin(publicApiOrigin);
  if (!url) throw new Error("PUBLIC_API_BASE_URL must be an exact HTTPS origin");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const socket = connectImpl({
      host: url.hostname,
      port: Number(url.port || "443"),
      servername: url.hostname,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    }, () => {
      try {
        const certificate = socket.getPeerCertificate();
        const validFrom = new Date(certificate.valid_from).toISOString();
        const validTo = new Date(certificate.valid_to).toISOString();
        const result = {
          authorized: socket.authorized === true,
          protocol: socket.getProtocol(),
          validFrom,
          validTo,
          fingerprint256: certificate.fingerprint256
        };
        socket.end();
        finish(null, result);
      } catch (error) {
        socket.destroy();
        finish(error);
      }
    });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      finish(new Error("Public TLS handshake timed out"));
    });
    socket.once("error", (error) => finish(error));
  });
}

export async function probePublicProduction({
  publicApiOrigin,
  metricsToken,
  fetchImpl = fetch,
  lookupImpl = dns.lookup,
  tlsInspector = inspectPublicTls,
  tlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  now = Date.now()
}) {
  const origin = exactHttpsOrigin(publicApiOrigin);
  if (!origin) throw new Error("PUBLIC_API_BASE_URL must be an exact HTTPS origin");
  if (typeof metricsToken !== "string" || metricsToken.length < 24) {
    throw new Error("METRICS_AUTH_TOKEN is required for the public production probe");
  }
  if (tlsRejectUnauthorized === "0") {
    throw new Error("Public production probes cannot disable TLS certificate verification");
  }
  const addresses = await lookupImpl(origin.hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses)
    || addresses.length === 0
    || addresses.some((record) => isPrivateAddress(record.address))) {
    throw new Error("PUBLIC_API_BASE_URL must resolve only to public addresses");
  }
  const tlsEvidence = await tlsInspector(origin.origin);

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      return await fetchImpl(url, { redirect: "error", ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  const redirectSource = new URL(`http://${origin.hostname}/health`);
  const redirectResponse = await request(redirectSource, { redirect: "manual" });
  const redirectLocation = new URL(
    redirectResponse.headers.get("location") || "",
    redirectSource
  ).href;
  if (!new Set([301, 302, 307, 308]).has(redirectResponse.status)
    || redirectLocation !== new URL("/health", origin).href) {
    throw new Error("HTTP must redirect directly to the exact HTTPS health endpoint");
  }

  const checks = [];
  async function jsonCheck(id, pathname, validate, options = {}) {
    const { expectedStatus = 200, ...requestOptions } = options;
    const response = await request(new URL(pathname, origin), requestOptions);
    if (response.status !== expectedStatus) {
      throw new Error(`${id} returned ${response.status}`);
    }
    if (response.headers.get("cache-control") !== "no-store"
      || !response.headers.get("x-request-id")) {
      throw new Error(`${id} must be non-cacheable and include a request ID`);
    }
    const body = await response.json();
    if (!validate(body)) throw new Error(`${id} response shape is invalid`);
    checks.push({ id, status: "PASSED" });
  }

  await jsonCheck("HEALTH", "/health", (body) => (
    body?.status === "ok" && body?.service === "detective-archives-api"
  ));
  await jsonCheck("READY", "/ready", (body) => (
    body?.status === "ready" && body?.database === "connected"
  ));
  await jsonCheck("DETECTIVES", "/api/v1/detectives?pageSize=1", (body) => (
    Array.isArray(body?.data) && body?.pagination?.total > 0
  ));
  await jsonCheck("WORKS", "/api/v1/works?pageSize=1", (body) => (
    Array.isArray(body?.data) && body?.pagination?.total > 0
  ));
  await jsonCheck("PICTURE_BOOK", "/api/v1/picture-book?pageSize=1", (body) => (
    Array.isArray(body?.data) && body?.pagination?.total > 0
  ));
  await jsonCheck("COMMUNITY", "/api/v1/community/reviews?pageSize=1", (body) => (
    Array.isArray(body?.data) && Number.isInteger(body?.pagination?.total)
  ));

  const adminResponse = await request(new URL("/admin/", origin));
  if (adminResponse.status !== 200
    || !/^text\/html/i.test(adminResponse.headers.get("content-type") || "")
    || !(await adminResponse.text()).includes('src="/admin/app.js"')) {
    throw new Error("ADMIN is not reachable through the public HTTPS origin");
  }
  checks.push({ id: "ADMIN", status: "PASSED" });

  await jsonCheck(
    "METRICS_UNAUTHENTICATED",
    "/metrics",
    (body) => body?.code === "METRICS_AUTH_REQUIRED",
    { expectedStatus: 401 }
  );
  const metricsResponse = await request(new URL("/metrics", origin), {
    headers: { authorization: `Bearer ${metricsToken}` }
  });
  if (metricsResponse.status !== 200
    || !/^text\/plain/i.test(metricsResponse.headers.get("content-type") || "")
    || !(await metricsResponse.text()).includes("detective_archives_http_requests_total")) {
    throw new Error("Authenticated public metrics probe failed");
  }
  checks.push({ id: "METRICS_AUTHENTICATED", status: "PASSED" });

  const probe = {
    schemaVersion: 1,
    status: "PASSED",
    publicApiOrigin: origin.origin,
    checkedAt: new Date(now).toISOString(),
    httpRedirect: {
      status: redirectResponse.status,
      location: redirectLocation
    },
    tls: tlsEvidence,
    checks
  };
  if (!validPublicProductionProbe(probe, { publicApiOrigin: origin.origin, now })) {
    throw new Error("Public production probe evidence is invalid");
  }
  return probe;
}

export function validBackupEvidence(evidence, { now = Date.now() } = {}) {
  const completedAt = canonicalTime(evidence?.completedAt);
  return evidence?.status === "PASSED"
    && /^detective-archives-\d{8}T\d{6}Z\.dump$/.test(evidence.fileName || "")
    && /^[0-9a-f]{64}$/i.test(evidence.checksumSha256 || "")
    && Number.isSafeInteger(evidence.sizeBytes)
    && evidence.sizeBytes > 0
    && completedAt !== null
    && completedAt <= now + futureClockToleranceMs
    && completedAt >= now - maximumBackupAgeMs;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectRecentBackup(backupDirectory, { now = Date.now() } = {}) {
  if (!path.isAbsolute(backupDirectory)) {
    throw new Error("BACKUP_DIRECTORY must be absolute for production evidence");
  }
  const directory = await realpath(backupDirectory);
  if (directory === path.parse(directory).root) {
    throw new Error("BACKUP_DIRECTORY must be a dedicated directory");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^detective-archives-\d{8}T\d{6}Z\.dump$/.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    candidates.push({ filePath, name: entry.name, stats: await stat(filePath) });
  }
  candidates.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const latest = candidates[0];
  if (!latest) throw new Error("No verified deployment backup was found");
  const checksumSource = (await readFile(`${latest.filePath}.sha256`, "utf8")).trim();
  const checksumMatch = checksumSource.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
  if (!checksumMatch || checksumMatch[2] !== latest.name) {
    throw new Error("Deployment backup checksum sidecar is invalid");
  }
  const actualChecksum = await sha256File(latest.filePath);
  if (actualChecksum.toLowerCase() !== checksumMatch[1].toLowerCase()) {
    throw new Error("Deployment backup checksum does not match the archive");
  }
  const evidence = {
    status: "PASSED",
    fileName: latest.name,
    checksumSha256: actualChecksum,
    sizeBytes: latest.stats.size,
    completedAt: new Date(latest.stats.mtimeMs).toISOString()
  };
  if (!validBackupEvidence(evidence, { now })) {
    throw new Error("Deployment backup is empty, stale or timestamped in the future");
  }
  return evidence;
}

function validImage(image) {
  return imageTagPattern.test(image?.tag || "")
    && imageIdPattern.test(image?.imageId || "")
    && sourceCommitPattern.test(image?.sourceCommit || "");
}

export function validProductionReleaseReceipt(receipt, {
  now = Date.now(),
  publicApiOrigin = null,
  sourceCommit = null
} = {}) {
  const startedAt = canonicalTime(receipt?.startedAt);
  const completedAt = canonicalTime(receipt?.completedAt);
  const origin = exactHttpsOrigin(receipt?.publicApiOrigin);
  if (receipt?.schemaVersion !== 1
    || receipt.action !== "production_release_drill"
    || receipt.status !== "PASSED"
    || startedAt === null
    || completedAt === null
    || startedAt > completedAt
    || completedAt > now + futureClockToleranceMs
    || completedAt < now - maximumReceiptAgeMs
    || completedAt - startedAt > maximumDrillDurationMs
    || !Number.isSafeInteger(receipt.durationMs)
    || receipt.durationMs !== completedAt - startedAt
    || !origin
    || (publicApiOrigin && origin.origin !== publicApiOrigin)
    || !sourceCommitPattern.test(receipt.sourceCommit || "")
    || (sourceCommit && receipt.sourceCommit !== sourceCommit)
    || !validImage(receipt.candidate)
    || !validImage(receipt.previous)
    || receipt.candidate.sourceCommit !== receipt.sourceCommit
    || receipt.candidate.imageId === receipt.previous.imageId
    || receipt.candidate.sourceCommit === receipt.previous.sourceCommit
    || !validBackupEvidence(receipt.backup, { now: completedAt })) return false;

  if (!Array.isArray(receipt.phases) || receipt.phases.length !== PRODUCTION_DRILL_PHASES.length) {
    return false;
  }
  const expected = [
    {
      id: "CANDIDATE_BEFORE_ROLLBACK",
      currentTag: receipt.candidate.tag,
      previousTag: receipt.previous.tag,
      runningTag: receipt.candidate.tag,
      imageId: receipt.candidate.imageId
    },
    {
      id: "PREVIOUS_AFTER_ROLLBACK",
      currentTag: receipt.previous.tag,
      previousTag: receipt.candidate.tag,
      runningTag: receipt.previous.tag,
      imageId: receipt.previous.imageId
    },
    {
      id: "CANDIDATE_RESTORED",
      currentTag: receipt.candidate.tag,
      previousTag: receipt.previous.tag,
      runningTag: receipt.candidate.tag,
      imageId: receipt.candidate.imageId
    }
  ];
  let previousProbeTime = startedAt;
  for (let index = 0; index < expected.length; index += 1) {
    const phase = receipt.phases[index];
    const rule = expected[index];
    const checkedAt = canonicalTime(phase?.probe?.checkedAt);
    if (phase?.id !== rule.id
      || phase.currentTag !== rule.currentTag
      || phase.previousTag !== rule.previousTag
      || phase.runningTag !== rule.runningTag
      || phase.imageId !== rule.imageId
      || checkedAt === null
      || checkedAt < previousProbeTime
      || checkedAt > completedAt + futureClockToleranceMs
      || !validPublicProductionProbe(phase.probe, {
        publicApiOrigin: origin.origin,
        now: completedAt
      })) return false;
    previousProbeTime = checkedAt;
  }
  return receipt.phases[0].probe.tls.fingerprint256
    === receipt.phases[2].probe.tls.fingerprint256;
}

function validateState(state, expected) {
  if (state?.currentTag !== expected.currentTag
    || state?.previousTag !== expected.previousTag
    || state?.runningTag !== expected.runningTag) {
    throw new Error(`Release state mismatch during ${expected.id}`);
  }
}

export async function performProductionReleaseDrill({
  sourceCommit,
  publicApiOrigin,
  backup,
  getState,
  inspectImage,
  rollback,
  probe,
  now = Date.now,
  clock = () => new Date(now()).toISOString()
}) {
  if (!sourceCommitPattern.test(sourceCommit || "")) {
    throw new Error("A full source commit is required for the production release drill");
  }
  const origin = exactHttpsOrigin(publicApiOrigin);
  if (!origin) throw new Error("A public HTTPS API origin is required for the production release drill");
  if (!validBackupEvidence(backup, { now: now() })) {
    throw new Error("A recent verified deployment backup is required before rollback");
  }

  const initial = await getState();
  if (!imageTagPattern.test(initial?.currentTag || "")
    || !imageTagPattern.test(initial?.previousTag || "")
    || initial.currentTag === initial.previousTag
    || initial.runningTag !== initial.currentTag) {
    throw new Error("Current, previous and running image state is incomplete or inconsistent");
  }
  const candidate = { tag: initial.currentTag, ...(await inspectImage(initial.currentTag)) };
  const previous = { tag: initial.previousTag, ...(await inspectImage(initial.previousTag)) };
  if (!validImage(candidate)
    || !validImage(previous)
    || candidate.sourceCommit !== sourceCommit
    || initial.runningImageId !== candidate.imageId
    || candidate.imageId === previous.imageId
    || candidate.sourceCommit === previous.sourceCommit) {
    throw new Error("Candidate and previous images must be distinct and carry valid source labels");
  }

  const startedAt = clock();
  const phases = [];
  let candidateRestored = false;
  const capture = async (id, expectedState, expectedImage) => {
    const state = await getState();
    validateState(state, { id, ...expectedState });
    if (state.runningImageId !== expectedImage.imageId) {
      throw new Error(`Running container image ID mismatch during ${id}`);
    }
    const actualImage = await inspectImage(state.runningTag);
    if (actualImage.imageId !== expectedImage.imageId
      || actualImage.sourceCommit !== expectedImage.sourceCommit) {
      throw new Error(`Running image evidence mismatch during ${id}`);
    }
    return {
      id,
      currentTag: state.currentTag,
      previousTag: state.previousTag,
      runningTag: state.runningTag,
      imageId: actualImage.imageId,
      probe: await probe()
    };
  };

  try {
    phases.push(await capture(PRODUCTION_DRILL_PHASES[0], {
      currentTag: candidate.tag,
      previousTag: previous.tag,
      runningTag: candidate.tag
    }, candidate));
    await rollback(previous.tag);
    phases.push(await capture(PRODUCTION_DRILL_PHASES[1], {
      currentTag: previous.tag,
      previousTag: candidate.tag,
      runningTag: previous.tag
    }, previous));
    await rollback(candidate.tag);
    phases.push(await capture(PRODUCTION_DRILL_PHASES[2], {
      currentTag: candidate.tag,
      previousTag: previous.tag,
      runningTag: candidate.tag
    }, candidate));
    candidateRestored = true;
  } catch (error) {
    let recoveryFailed = false;
    if (!candidateRestored) {
      try {
        const state = await getState();
        if (state.currentTag !== candidate.tag || state.runningTag !== candidate.tag) {
          await rollback(candidate.tag);
        }
        const restored = await getState();
        recoveryFailed = restored.currentTag !== candidate.tag
          || restored.runningTag !== candidate.tag
          || restored.runningImageId !== candidate.imageId;
      } catch {
        recoveryFailed = true;
      }
    }
    const detail = String(error?.message || "unknown failure").replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 300);
    throw new Error(
      recoveryFailed
        ? `Production release drill failed and candidate restoration also failed: ${detail}`
        : `Production release drill failed; candidate was restored: ${detail}`
    );
  }

  const completedAt = clock();
  const receipt = {
    schemaVersion: 1,
    action: "production_release_drill",
    status: "PASSED",
    sourceCommit,
    publicApiOrigin: origin.origin,
    startedAt,
    completedAt,
    durationMs: Math.max(0, canonicalTime(completedAt) - canonicalTime(startedAt)),
    candidate,
    previous,
    backup,
    phases
  };
  if (!validProductionReleaseReceipt(receipt, {
    now: now(),
    publicApiOrigin: origin.origin,
    sourceCommit
  })) {
    throw new Error("Production release drill receipt is invalid");
  }
  return receipt;
}

export async function recordProductionReleaseReceipt({
  projectRoot = process.cwd(),
  manifestPath = path.join(projectRoot, "ops", "launch-readiness.json"),
  stateDirectory = path.join(projectRoot, ".release-state"),
  receipt
}) {
  const root = path.resolve(projectRoot);
  const expectedManifestPath = path.join(root, "ops", "launch-readiness.json");
  if (path.resolve(manifestPath) !== expectedManifestPath) {
    throw new Error("Production release evidence may only update ops/launch-readiness.json");
  }
  const resolvedStateDirectory = path.resolve(stateDirectory);
  if (resolvedStateDirectory === path.parse(resolvedStateDirectory).root
    || resolvedStateDirectory === root) {
    throw new Error("RELEASE_STATE_DIRECTORY must be a dedicated directory");
  }
  if (!validProductionReleaseReceipt(receipt, {
    now: Date.now(),
    publicApiOrigin: receipt?.publicApiOrigin,
    sourceCommit: receipt?.sourceCommit
  })) {
    throw new Error("Refusing to persist invalid production release evidence");
  }
  const manifestSource = await readFile(expectedManifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch {
    throw new Error("Launch readiness manifest must contain valid JSON");
  }
  if (manifest?.schemaVersion !== 1
    || manifest.validation === null
    || typeof manifest.validation !== "object"
    || Array.isArray(manifest.validation)) {
    throw new Error("Launch readiness manifest validation state is invalid");
  }

  const receiptDirectory = path.join(resolvedStateDirectory, "production-release");
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const safeTimestamp = receipt.completedAt.replaceAll(":", "").replaceAll(".", "-");
  const receiptFileName = `production-release-${receipt.sourceCommit.slice(0, 12)}-${safeTimestamp}.json`;
  const receiptPath = path.join(receiptDirectory, receiptFileName);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });

  const manifestSourceBeforeUpdate = await readFile(expectedManifestPath, "utf8");
  if (createHash("sha256").update(manifestSourceBeforeUpdate).digest("hex")
    !== createHash("sha256").update(manifestSource).digest("hex")) {
    throw new Error("Launch readiness manifest changed during the drill; receipt was preserved without overwriting it");
  }
  manifest.validation.productionReleaseReceipt = receipt;
  delete manifest.validation.tlsVerified;
  delete manifest.validation.productionReleaseCheckPassed;
  delete manifest.validation.rollbackPassed;
  const temporaryManifestPath = `${expectedManifestPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryManifestPath, expectedManifestPath);
  return { receiptFileName };
}

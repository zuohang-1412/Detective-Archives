import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectRecentBackup,
  performProductionReleaseDrill,
  probePublicProduction,
  recordProductionReleaseReceipt,
  validProductionReleaseReceipt,
  validPublicProductionProbe
} from "./lib/production-release-drill.mjs";

const publicApiOrigin = "https://api.detective-archives.example";
const metricsToken = "m".repeat(32);
const candidateCommit = "a".repeat(40);
const previousCommit = "b".repeat(40);
const candidateId = `sha256:${"1".repeat(64)}`;
const previousId = `sha256:${"2".repeat(64)}`;
const now = Date.now();

function tlsEvidence(timestamp = now) {
  return {
    authorized: true,
    protocol: "TLSv1.3",
    validFrom: new Date(timestamp - 24 * 60 * 60 * 1000).toISOString(),
    validTo: new Date(timestamp + 30 * 24 * 60 * 60 * 1000).toISOString(),
    fingerprint256: Array.from({ length: 32 }, () => "AA").join(":")
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": "production-drill-request"
    }
  });
}

async function productionFetch(url, options = {}) {
  const target = new URL(url);
  if (target.protocol === "http:") {
    return new Response(null, {
      status: 308,
      headers: { location: `${publicApiOrigin}/health` }
    });
  }
  if (target.pathname === "/health") {
    return jsonResponse({ status: "ok", service: "detective-archives-api" });
  }
  if (target.pathname === "/ready") {
    return jsonResponse({ status: "ready", database: "connected" });
  }
  if (target.pathname === "/api/v1/detectives") {
    return jsonResponse({ data: [{}], pagination: { total: 1 } });
  }
  if (target.pathname === "/api/v1/works") {
    return jsonResponse({ data: [{}], pagination: { total: 1 } });
  }
  if (target.pathname === "/api/v1/picture-book") {
    return jsonResponse({ data: [{}], pagination: { total: 1 } });
  }
  if (target.pathname === "/api/v1/community/reviews") {
    return jsonResponse({ data: [], pagination: { total: 0 } });
  }
  if (target.pathname === "/admin/") {
    return new Response('<script src="/admin/app.js"></script>', {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  if (target.pathname === "/metrics" && !options.headers?.authorization) {
    assert.equal("expectedStatus" in options, false, "test-only status must not reach fetch");
    return jsonResponse({ code: "METRICS_AUTH_REQUIRED" }, 401);
  }
  if (target.pathname === "/metrics") {
    assert.equal(options.headers.authorization, `Bearer ${metricsToken}`);
    return new Response("detective_archives_http_requests_total 1\n", {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4" }
    });
  }
  throw new Error(`Unexpected production probe target: ${target.href}`);
}

const probe = await probePublicProduction({
  publicApiOrigin,
  metricsToken,
  fetchImpl: productionFetch,
  lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  tlsInspector: async () => tlsEvidence(),
  now
});
assert.equal(validPublicProductionProbe(probe, { publicApiOrigin, now }), true);
await assert.rejects(() => probePublicProduction({
  publicApiOrigin,
  metricsToken,
  fetchImpl: productionFetch,
  lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
  tlsInspector: async () => tlsEvidence(),
  now
}), /public addresses/);
await assert.rejects(() => probePublicProduction({
  publicApiOrigin,
  metricsToken,
  fetchImpl: productionFetch,
  lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  tlsInspector: async () => tlsEvidence(),
  tlsRejectUnauthorized: "0",
  now
}), /cannot disable TLS/);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "detective-production-drill-"));
try {
  const backupDirectory = path.join(temporaryRoot, "backups");
  await mkdir(backupDirectory);
  const backupName = `detective-archives-${new Date(now).toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}.dump`;
  const backupPath = path.join(backupDirectory, backupName);
  const backupSource = Buffer.from("verified-production-backup");
  const checksum = createHash("sha256").update(backupSource).digest("hex");
  await writeFile(backupPath, backupSource);
  await writeFile(`${backupPath}.sha256`, `${checksum}  ${backupName}\n`);
  await utimes(backupPath, new Date(now), new Date(now));
  const backup = await inspectRecentBackup(backupDirectory, { now });
  assert.equal(backup.checksumSha256, checksum);

  const images = {
    candidate: { imageId: candidateId, sourceCommit: candidateCommit },
    previous: { imageId: previousId, sourceCommit: previousCommit }
  };
  const state = {
    currentTag: "candidate",
    previousTag: "previous",
    runningTag: "candidate",
    runningImageId: candidateId
  };
  const rollbackCalls = [];
  const rollback = async (tag) => {
    rollbackCalls.push(tag);
    const oldCurrent = state.currentTag;
    state.currentTag = tag;
    state.previousTag = oldCurrent;
    state.runningTag = tag;
    state.runningImageId = images[tag].imageId;
  };
  const receipt = await performProductionReleaseDrill({
    sourceCommit: candidateCommit,
    publicApiOrigin,
    backup,
    getState: async () => ({ ...state }),
    inspectImage: async (tag) => images[tag],
    rollback,
    probe: async () => structuredClone(probe),
    now: () => now,
    clock: () => new Date(now).toISOString()
  });
  assert.deepEqual(rollbackCalls, ["previous", "candidate"]);
  assert.equal(state.runningTag, "candidate");
  assert.equal(validProductionReleaseReceipt(receipt, {
    now,
    publicApiOrigin,
    sourceCommit: candidateCommit
  }), true);
  assert.equal(validProductionReleaseReceipt(receipt, {
    now,
    publicApiOrigin,
    sourceCommit: previousCommit
  }), false);
  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.phases[1].runningTag = "candidate";
  assert.equal(validProductionReleaseReceipt(tamperedReceipt, { now, publicApiOrigin }), false);
  const tamperedDuration = structuredClone(receipt);
  tamperedDuration.durationMs = 1;
  assert.equal(validProductionReleaseReceipt(tamperedDuration, { now, publicApiOrigin }), false);

  await assert.rejects(() => performProductionReleaseDrill({
    sourceCommit: candidateCommit,
    publicApiOrigin,
    backup,
    getState: async () => ({
      currentTag: "candidate",
      previousTag: "previous",
      runningTag: "candidate",
      runningImageId: previousId
    }),
    inspectImage: async (tag) => images[tag],
    rollback: async () => assert.fail("mismatched running image must block before rollback"),
    probe: async () => assert.fail("mismatched running image must block before probing"),
    now: () => now,
    clock: () => new Date(now).toISOString()
  }), /distinct and carry valid source labels/);

  const failureState = {
    currentTag: "candidate",
    previousTag: "previous",
    runningTag: "candidate",
    runningImageId: candidateId
  };
  const failureRollbacks = [];
  let probeCalls = 0;
  await assert.rejects(() => performProductionReleaseDrill({
    sourceCommit: candidateCommit,
    publicApiOrigin,
    backup,
    getState: async () => ({ ...failureState }),
    inspectImage: async (tag) => images[tag],
    rollback: async (tag) => {
      failureRollbacks.push(tag);
      const oldCurrent = failureState.currentTag;
      failureState.currentTag = tag;
      failureState.previousTag = oldCurrent;
      failureState.runningTag = tag;
      failureState.runningImageId = images[tag].imageId;
    },
    probe: async () => {
      probeCalls += 1;
      if (probeCalls === 2) throw new Error("simulated public failure");
      return structuredClone(probe);
    },
    now: () => now,
    clock: () => new Date(now).toISOString()
  }), /candidate was restored/);
  assert.deepEqual(failureRollbacks, ["previous", "candidate"]);
  assert.equal(failureState.runningTag, "candidate");

  const projectRoot = path.join(temporaryRoot, "project");
  const stateDirectory = path.join(temporaryRoot, "release-state");
  await mkdir(path.join(projectRoot, "ops"), { recursive: true });
  const manifestPath = path.join(projectRoot, "ops", "launch-readiness.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    validation: {
      tlsVerified: true,
      productionReleaseCheckPassed: true,
      rollbackPassed: true
    }
  }, null, 2)}\n`);
  const recorded = await recordProductionReleaseReceipt({
    projectRoot,
    manifestPath,
    stateDirectory,
    receipt
  });
  assert.match(recorded.receiptFileName, /^production-release-/);
  const persistedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(persistedManifest.validation.productionReleaseReceipt, receipt);
  assert.equal("tlsVerified" in persistedManifest.validation, false);
  assert.equal("productionReleaseCheckPassed" in persistedManifest.validation, false);
  assert.equal("rollbackPassed" in persistedManifest.validation, false);

  await writeFile(`${backupPath}.sha256`, `${"0".repeat(64)}  ${backupName}\n`);
  await assert.rejects(() => inspectRecentBackup(backupDirectory, { now }), /does not match/);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Production release drill checks: OK (public TLS, backup, rollback recovery and receipt verified)");

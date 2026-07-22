import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertOperationsDrillGitStatus,
  buildOperationsDrillReceipt,
  OPERATIONS_DRILL_SCENARIOS,
  recordOperationsDrill,
  validOperationsDrillReceipt
} from "./lib/operations-drill.mjs";

assert.equal(assertOperationsDrillGitStatus(""), true);
assert.equal(assertOperationsDrillGitStatus(
  " M project.config.json\n M apps/miniprogram/config.js\n"
), true);
assert.throws(
  () => assertOperationsDrillGitStatus(" M docs/runbook.md\n"),
  /committed source/
);

const now = Date.parse("2026-07-22T01:30:00.000Z");
const sourceCommit = "a".repeat(40);
const runbookSource = "# Operations runbook\n".repeat(10);
const manifest = {
  schemaVersion: 1,
  operator: {
    contentModerator: "内容审核负责人甲",
    alertResponder: "生产告警负责人乙"
  },
  validation: {}
};
const record = {
  schemaVersion: 1,
  status: "PASSED",
  contentModerator: manifest.operator.contentModerator,
  alertResponder: manifest.operator.alertResponder,
  completedAt: "2026-07-22T01:25:00.000Z",
  evidenceReference: "OPS-2026-0722 发布演练工单",
  scenarios: OPERATIONS_DRILL_SCENARIOS.map((id) => ({
    id,
    result: "PASSED",
    evidenceReference: `OPS-2026-0722#${id}`
  }))
};

const receipt = buildOperationsDrillReceipt({
  record,
  manifest,
  sourceCommit,
  runbookSource,
  now
});
const runbookSha256 = createHash("sha256").update(runbookSource).digest("hex");
assert.equal(validOperationsDrillReceipt(receipt, { now, runbookSha256 }), true);
assert.equal(receipt.scenarios.map(({ id }) => id).join(","), OPERATIONS_DRILL_SCENARIOS.join(","));
assert.equal(
  validOperationsDrillReceipt(receipt, { now, runbookSha256: "b".repeat(64) }),
  false,
  "A receipt for a different runbook must be rejected"
);
assert.equal(
  validOperationsDrillReceipt({ ...receipt, completedAt: "2026-01-01T00:00:00.000Z" }, { now }),
  false,
  "Stale training evidence must be rejected"
);
assert.equal(
  validOperationsDrillReceipt({
    ...receipt,
    evidenceReference: `https://evidence.invalid/result?${["access", "token"].join("_")}=not-a-secret`
  }, { now }),
  false,
  "Evidence references must reject embedded access tokens"
);

assert.throws(() => buildOperationsDrillReceipt({
  record: { ...record, scenarios: record.scenarios.slice(1) },
  manifest,
  sourceCommit,
  runbookSource,
  now
}), /must pass exactly/);
assert.throws(() => buildOperationsDrillReceipt({
  record: {
    ...record,
    scenarios: [record.scenarios[0], record.scenarios[0], ...record.scenarios.slice(1, 3)]
  },
  manifest,
  sourceCommit,
  runbookSource,
  now
}), /must pass exactly/);
assert.throws(() => buildOperationsDrillReceipt({
  record: { ...record, contentModerator: "另一位审核员" },
  manifest,
  sourceCommit,
  runbookSource,
  now
}), /must match/);
assert.throws(() => buildOperationsDrillReceipt({
  record: { ...record, completedAt: "2026-07-22T01:25:00Z" },
  manifest,
  sourceCommit,
  runbookSource,
  now
}), /completion time/);
assert.throws(() => buildOperationsDrillReceipt({
  record: { ...record, completedAt: "2026-07-22T01:36:00.000Z" },
  manifest,
  sourceCommit,
  runbookSource,
  now
}), /completion time/);
const placeholderManifest = structuredClone(manifest);
placeholderManifest.operator.contentModerator = "上线前填写审核负责人";
assert.throws(() => buildOperationsDrillReceipt({
  record: {
    ...record,
    contentModerator: placeholderManifest.operator.contentModerator
  },
  manifest: placeholderManifest,
  sourceCommit,
  runbookSource,
  now
}), /non-placeholder names/);
assert.throws(() => buildOperationsDrillReceipt({
  record,
  manifest: { ...manifest, validation: [] },
  sourceCommit,
  runbookSource,
  now
}), /validation state must be an object/);

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "detective-operations-drill-project-"));
const externalRoot = await mkdtemp(path.join(os.tmpdir(), "detective-operations-drill-record-"));
try {
  await mkdir(path.join(projectRoot, "ops"), { recursive: true });
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "ops", "launch-readiness.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(path.join(projectRoot, "docs", "runbook.md"), runbookSource);
  const recordPath = path.join(externalRoot, "operations-drill.json");
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const result = await recordOperationsDrill({
    projectRoot,
    recordPath,
    sourceCommit,
    now
  });
  const updatedManifest = JSON.parse(await readFile(
    path.join(projectRoot, "ops", "launch-readiness.json"),
    "utf8"
  ));
  assert.deepEqual(updatedManifest.validation.operationsDrillReceipt, result.receipt);
  assert.equal(
    JSON.parse(await readFile(path.join(projectRoot, result.receiptPath), "utf8")).status,
    "PASSED"
  );

  const internalRecordPath = path.join(projectRoot, "operations-drill.json");
  await writeFile(internalRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(recordOperationsDrill({
    projectRoot,
    recordPath: internalRecordPath,
    sourceCommit,
    now
  }), /outside the repository/);
  await assert.rejects(recordOperationsDrill({
    projectRoot,
    recordPath: "relative-operations-drill.json",
    sourceCommit,
    now
  }), /path must be absolute/);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}

console.log("Operations drill evidence: OK (4 scenarios, external source, bound receipt, atomic manifest update)");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalogBatches } from "./lib/catalog-batches.mjs";

const dataDirectory = path.resolve("apps/api/src/data");
const readJson = (filename) => readFile(path.join(dataDirectory, filename), "utf8").then(JSON.parse);

const [audit, pictureBookIndex, archiveDirectory, { batches }, dataSourcesDocument] = await Promise.all([
  readJson("content-audit-sample-2026-07-22.json"),
  readJson("picture-book-index.json"),
  readJson("archive-directory-index.json"),
  loadCatalogBatches(),
  readFile(path.resolve("docs/data-sources.md"), "utf8")
]);

assert.equal(audit.schemaVersion, 1);
assert.match(audit.auditDate, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(audit.sampleCount, audit.samples.length);
assert.ok(audit.method.length >= 80);

const effectiveDetectives = new Map();
const effectiveBatchKeys = new Map();
for (const { input } of batches) {
  for (const detective of input.detectives) {
    effectiveDetectives.set(detective.catalogId, detective);
    effectiveBatchKeys.set(detective.catalogId, input.batchKey);
  }
}

const pictureBookEntries = new Map(pictureBookIndex.entries.map((entry) => [entry.id, entry]));
const directoryEntries = new Map(archiveDirectory.entries.map((entry) => [entry.id, entry]));
const sampleIds = new Set();
const allowedResults = new Set(["PASS", "CORRECTED", "FOLLOW_UP"]);

for (const sample of audit.samples) {
  assert.equal(sampleIds.has(sample.recordId), false, `duplicate audit sample ${sample.recordId}`);
  sampleIds.add(sample.recordId);
  assert.equal(allowedResults.has(sample.result), true, `${sample.recordId}: invalid audit result`);
  assert.ok(sample.note.length >= 20, `${sample.recordId}: audit note is too short`);
  assert.ok(sample.evidenceSourceIds.length >= 1, `${sample.recordId}: evidence is required`);

  if (sample.recordSet === "PICTURE_BOOK") {
    const entry = pictureBookEntries.get(sample.recordId);
    const detective = effectiveDetectives.get(sample.recordId);
    assert.ok(entry, `${sample.recordId}: missing picture-book entry`);
    assert.ok(detective, `${sample.recordId}: missing effective detective record`);
    if (entry.detectiveSlug) {
      assert.equal(entry.detectiveSlug, sample.detectiveSlug, `${sample.recordId}: picture-book slug mismatch`);
    }
    assert.equal(detective.slug, sample.detectiveSlug, `${sample.recordId}: detective slug mismatch`);
    assert.equal(detective.nameZh, sample.expected.nameZh, `${sample.recordId}: name mismatch`);
    assert.equal(detective.creatorName ?? null, sample.expected.creatorName, `${sample.recordId}: creator mismatch`);
    assert.equal(
      detective.featuredCases.includes(sample.expected.featuredCase),
      true,
      `${sample.recordId}: featured case mismatch`
    );
    assert.equal(
      detective.works.some((work) => work.slug === sample.workSlug),
      true,
      `${sample.recordId}: audited work is missing`
    );
    const availableSources = new Set([...entry.sourceIds, ...detective.sourceIds]);
    for (const sourceId of sample.evidenceSourceIds) {
      assert.equal(availableSources.has(sourceId), true, `${sample.recordId}: unavailable evidence ${sourceId}`);
    }
    if (sample.result === "CORRECTED") {
      assert.equal(
        effectiveBatchKeys.get(sample.recordId),
        sample.correctionBatchKey,
        `${sample.recordId}: correction batch is not effective`
      );
    }
  } else {
    assert.equal(sample.recordSet, "ARCHIVE_DIRECTORY", `${sample.recordId}: invalid record set`);
    const entry = directoryEntries.get(sample.recordId);
    assert.ok(entry, `${sample.recordId}: missing archive-directory entry`);
    assert.equal(entry.names.zh, sample.expected.nameZh, `${sample.recordId}: name mismatch`);
    assert.equal(entry.creatorName ?? null, sample.expected.creatorName, `${sample.recordId}: creator mismatch`);
    assert.equal(
      entry.featuredWorks.includes(sample.expected.featuredCase),
      true,
      `${sample.recordId}: featured work mismatch`
    );
    for (const sourceId of sample.evidenceSourceIds) {
      assert.equal(entry.sourceIds.includes(sourceId), true, `${sample.recordId}: unavailable evidence ${sourceId}`);
    }
  }

  if (sample.result === "FOLLOW_UP") {
    assert.ok(sample.nextAction?.length >= 40, `${sample.recordId}: follow-up action is required`);
  }
}

const pictureSamples = audit.samples.filter((sample) => sample.recordSet === "PICTURE_BOOK");
const directorySamples = audit.samples.filter((sample) => sample.recordSet === "ARCHIVE_DIRECTORY");
assert.ok(pictureSamples.length >= 20, "audit must include at least 20 picture-book entries");
assert.ok(directorySamples.length >= 6, "audit must include at least 6 archive-directory entries");

const sampledVolumes = pictureSamples.map((sample) => pictureBookEntries.get(sample.recordId).volumeNo);
for (const [minimum, maximum] of [[1, 25], [26, 58], [59, 80], [81, 102], [103, 108]]) {
  assert.equal(
    sampledVolumes.some((volume) => volume >= minimum && volume <= maximum),
    true,
    `audit is missing volume stratum ${minimum}-${maximum}`
  );
}
assert.equal(sampleIds.has("PB-105-SP"), true, "audit must include the volume 105 special edition");

const auditedDirectoryCategories = new Set(
  directorySamples.map((sample) => directoryEntries.get(sample.recordId).category)
);
for (const category of [
  "WORLD_LITERATURE",
  "SCREEN_DETECTIVES",
  "JAPANESE_POPULAR",
  "CHINESE_LITERATURE",
  "HISTORICAL_JUSTICE"
]) {
  assert.equal(auditedDirectoryCategories.has(category), true, `audit is missing directory category ${category}`);
}

const corrected = audit.samples.filter((sample) => sample.result === "CORRECTED");
const passed = audit.samples.filter((sample) => sample.result === "PASS");
const followUps = audit.samples.filter((sample) => sample.result === "FOLLOW_UP");
assert.equal(corrected.length, 7, "the recorded content-fix batches must cover seven audit corrections");
assert.equal(followUps.length, 0, "all sampled follow-up records must be resolved");
assert.equal(
  dataSourcesDocument.includes(
    `共抽样 ${audit.samples.length} 条：${pictureSamples.length} 条图鉴记录、${directorySamples.length} 条扩展/历史目录记录`
  ),
  true,
  "data-sources audit coverage summary must match the machine-readable evidence"
);
assert.equal(
  dataSourcesDocument.includes(
    `${audit.samples.length} 条样本现为 ${corrected.length} 条已纠正、${passed.length} 条通过、${followUps.length} 条待补证；当前 ${effectiveDetectives.size} 位正式人物记录均达到 \`PRIMARY_SOURCE_CONFIRMED\``
  ),
  true,
  "data-sources audit result summary must match the machine-readable evidence"
);

const unconfirmedCatalogRecords = [...effectiveDetectives.values()]
  .filter((detective) => detective.verification !== "PRIMARY_SOURCE_CONFIRMED")
  .map((detective) => detective.catalogId);
assert.deepEqual(
  unconfirmedCatalogRecords,
  [],
  `formal catalog still contains source-captured records: ${unconfirmedCatalogRecords.join(", ")}`
);

for (const [catalogId, detective] of effectiveDetectives) {
  for (const featuredCase of detective.featuredCases) {
    assert.equal(/）》$/.test(featuredCase), false, `${catalogId}: mismatched closing title mark`);
    assert.equal(
      [...featuredCase].filter((character) => character === "（").length,
      [...featuredCase].filter((character) => character === "）").length,
      `${catalogId}: unbalanced Chinese parentheses`
    );
  }
}

console.log(
  `Content audit: OK (${audit.samples.length} samples, ${passed.length} passed, ${corrected.length} corrections, ${followUps.length} documented follow-up)`
);

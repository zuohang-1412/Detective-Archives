import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalogBatches, uniqueImportedWorks } from "./lib/catalog-batches.mjs";

const { manifest, batches } = await loadCatalogBatches();
assert.equal(manifest.schemaVersion, 1);

const batchKeys = new Set();
const slugCatalogIds = new Map();
const catalogIdSlugs = new Map();
const workTitles = new Map();
const pictureBookIds = new Set();
const knownDetectiveSlugs = new Set();
const knownWorkSlugs = new Set();
let detectiveRecordCount = 0;
let previousBatchKey = null;

for (const { input, filename } of batches) {
  assert.equal(input.schemaVersion, 1, `${filename}: schemaVersion must be 1`);
  assert.match(input.batchKey, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(batchKeys.has(input.batchKey), false, `duplicate batch key ${input.batchKey}`);
  const isRollback = Boolean(input.rollbackOf);
  if (isRollback) {
    assert.equal(input.rollbackOf, previousBatchKey, `${filename}: rollback must target the latest manifest batch`);
    assert.ok(typeof input.rollbackReason === "string" && input.rollbackReason.length >= 10);
    assert.ok(
      input.detectives.length
        || (input.archiveDetectiveSlugs ?? []).length
        || (input.archiveWorkSlugs ?? []).length,
      `${filename}: rollback batch must contain compensation`
    );
  } else {
    assert.equal(input.rollbackReason, undefined, `${filename}: rollbackReason requires rollbackOf`);
    assert.deepEqual(input.archiveDetectiveSlugs ?? [], [], `${filename}: archive detectives require rollbackOf`);
    assert.deepEqual(input.archiveWorkSlugs ?? [], [], `${filename}: archive works require rollbackOf`);
    assert.ok(Array.isArray(input.sources) && input.sources.length > 0);
    assert.ok(Array.isArray(input.detectives) && input.detectives.length > 0);
  }
  batchKeys.add(input.batchKey);
  previousBatchKey = input.batchKey;
  assert.ok(Array.isArray(input.sources));
  assert.ok(Array.isArray(input.detectives));

  for (const slug of input.archiveDetectiveSlugs ?? []) {
    assert.equal(knownDetectiveSlugs.has(slug), true, `${filename}: cannot archive unknown detective ${slug}`);
  }
  for (const slug of input.archiveWorkSlugs ?? []) {
    assert.equal(knownWorkSlugs.has(slug), true, `${filename}: cannot archive unknown work ${slug}`);
  }

  const sourceIds = new Set(input.sources.map((source) => source.id));
  assert.equal(sourceIds.size, input.sources.length, `${filename}: source ids must be unique`);
  for (const source of input.sources) assert.match(source.url, /^https:\/\//);

  const batchDetectiveSlugs = new Set();
  const batchCatalogIds = new Set();
  const batchWorkSlugs = new Set();
  for (const detective of input.detectives) {
    detectiveRecordCount += 1;
    assert.equal(batchDetectiveSlugs.has(detective.slug), false, `duplicate detective slug ${detective.slug}`);
    assert.equal(batchCatalogIds.has(detective.catalogId), false, `duplicate catalog id ${detective.catalogId}`);
    batchDetectiveSlugs.add(detective.slug);
    batchCatalogIds.add(detective.catalogId);
    knownDetectiveSlugs.add(detective.slug);
    assert.equal(
      slugCatalogIds.has(detective.slug) && slugCatalogIds.get(detective.slug) !== detective.catalogId,
      false,
      `${detective.slug}: conflicting catalog id across batches`
    );
    assert.equal(
      catalogIdSlugs.has(detective.catalogId) && catalogIdSlugs.get(detective.catalogId) !== detective.slug,
      false,
      `${detective.catalogId}: conflicting detective slug across batches`
    );
    slugCatalogIds.set(detective.slug, detective.catalogId);
    catalogIdSlugs.set(detective.catalogId, detective.slug);
    assert.ok(detective.summary.length >= 10);
    assert.ok(detective.sourceIds.length >= 1);
    detective.sourceIds.forEach((sourceId) => {
      assert.equal(sourceIds.has(sourceId), true, `${detective.slug}: unknown source ${sourceId}`);
    });
    for (const entryId of detective.pictureBookEntryIds ?? []) {
      assert.match(entryId, /^PB-\d{3}-(STD|SP)$/);
      if (!isRollback) {
        assert.equal(pictureBookIds.has(entryId), false, `duplicate picture-book link ${entryId}`);
      }
      pictureBookIds.add(entryId);
    }
    for (const work of detective.works) {
      assert.equal(batchWorkSlugs.has(work.slug), false, `duplicate work slug ${work.slug}`);
      batchWorkSlugs.add(work.slug);
      knownWorkSlugs.add(work.slug);
      assert.ok(work.summary.length >= 10);
      assert.equal(sourceIds.has(work.sourceId), true, `${work.slug}: unknown source ${work.sourceId}`);
      if (!isRollback) {
        assert.equal(
          workTitles.has(work.slug) && workTitles.get(work.slug) !== work.titleZh,
          false,
          `${work.slug}: conflicting title across batches`
        );
      }
      workTitles.set(work.slug, work.titleZh);
    }
  }

  const serialized = JSON.stringify(input).toLowerCase();
  for (const forbidden of ["coverurl", "imageurl", "sourcetext", "excerpt", "fulltext"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, `${filename}: forbidden field ${forbidden}`);
  }
}

const uniqueWorks = uniqueImportedWorks(batches);
const [packageJson, importerScript, runnerScript] = await Promise.all([
  readFile(path.resolve("package.json"), "utf8").then(JSON.parse),
  readFile(path.resolve("scripts/catalog-import.mjs"), "utf8"),
  readFile(path.resolve("scripts/run-catalog-imports.mjs"), "utf8")
]);
assert.match(packageJson.scripts["catalog:rollback:preflight"], /--rollback/);
assert.match(packageJson.scripts["catalog:rollback:apply"], /--rollback --apply/);
for (const rollbackCapability of [
  "archiveDetectiveSlugs",
  "archiveWorkSlugs",
  "CATALOG_BATCH_NOOP",
  "status = 'ROLLED_BACK'",
  "Rollback target is no longer latest"
]) {
  assert.ok(importerScript.includes(rollbackCapability), `catalog importer must implement ${rollbackCapability}`);
}
assert.match(runnerScript, /batch\.input\.rollbackOf/);
console.log(
  `Catalog expansion integrity: OK (${batches.length} batches, ${detectiveRecordCount} detective records, ${uniqueWorks.size} formal works, ${pictureBookIds.size} picture-book links)`
);

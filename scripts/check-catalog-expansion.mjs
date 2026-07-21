import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const input = JSON.parse(await readFile(
  new URL("../apps/api/src/data/catalog-expansion.json", import.meta.url),
  "utf8"
));
assert.equal(input.schemaVersion, 1);
assert.match(input.batchKey, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.equal(input.detectives.length, 8);
const sourceIds = new Set(input.sources.map((source) => source.id));
assert.equal(sourceIds.size, input.sources.length, "source ids must be unique");
for (const source of input.sources) {
  assert.match(source.url, /^https:\/\//);
}
const detectiveSlugs = new Set();
const catalogIds = new Set();
const workSlugs = new Set();
for (const detective of input.detectives) {
  assert.equal(detectiveSlugs.has(detective.slug), false, `duplicate detective slug ${detective.slug}`);
  assert.equal(catalogIds.has(detective.catalogId), false, `duplicate catalog id ${detective.catalogId}`);
  detectiveSlugs.add(detective.slug);
  catalogIds.add(detective.catalogId);
  assert.ok(detective.summary.length >= 10);
  assert.ok(detective.sourceIds.length >= 1);
  detective.sourceIds.forEach((sourceId) => {
    assert.equal(sourceIds.has(sourceId), true, `${detective.slug}: unknown source ${sourceId}`);
  });
  for (const work of detective.works) {
    assert.equal(workSlugs.has(work.slug), false, `duplicate work slug ${work.slug}`);
    workSlugs.add(work.slug);
    assert.ok(work.summary.length >= 10);
    assert.equal(sourceIds.has(work.sourceId), true, `${work.slug}: unknown source ${work.sourceId}`);
  }
}
assert.equal(workSlugs.size, 8);
const serialized = JSON.stringify(input).toLowerCase();
for (const forbidden of ["coverurl", "imageurl", "sourcetext", "excerpt", "fulltext"]) {
  assert.equal(serialized.includes(`\"${forbidden}\"`), false, `forbidden field ${forbidden}`);
}

console.log("Catalog expansion integrity: OK (8 detectives updated, 8 formal works)");

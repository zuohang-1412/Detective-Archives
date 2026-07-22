import { readFile } from "node:fs/promises";
import path from "node:path";

const catalogPath = path.resolve("apps/api/src/data/picture-book-index.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const errors = [];

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

assert(catalog.schemaVersion === 1, "schemaVersion must be 1");
assert(catalog.coverage?.firstVolume === 1, "coverage must start at volume 1");
assert(catalog.coverage?.latestPublishedVolume === 108, "latest published volume must be 108");
assert(catalog.coverage?.standardVolumeCount === 108, "standard volume count must be 108");
assert(catalog.coverage?.entryCount === 109, "entry count must include 108 standard + 1 special");
assert(catalog.coverage?.entriesWithRecommendedWorks === 109, "all 109 entries should have recommendations");

const ids = new Set();
const standardVolumes = new Set();
const knownSourceIds = new Set(catalog.sources.map((source) => source.id));

for (const entry of catalog.entries) {
  assert(/^PB-\d{3}-(STD|SP)$/.test(entry.id), `invalid entry id: ${entry.id}`);
  assert(!ids.has(entry.id), `duplicate entry id: ${entry.id}`);
  ids.add(entry.id);
  assert(Number.isInteger(entry.volumeNo), `volume must be an integer: ${entry.id}`);
  assert(entry.volumeNo >= 1 && entry.volumeNo <= 108, `volume out of range: ${entry.id}`);
  assert(["STANDARD", "SPECIAL"].includes(entry.edition), `invalid edition: ${entry.id}`);
  assert(typeof entry.names?.zh === "string" && entry.names.zh.length > 0, `missing Chinese name: ${entry.id}`);
  assert(Array.isArray(entry.names?.aliases), `aliases must be an array: ${entry.id}`);
  assert(Array.isArray(entry.recommendedWorks), `recommendedWorks must be an array: ${entry.id}`);
  assert(
    entry.recommendedWorks.length === 0
      ? entry.verification.recommendedWorks === "MISSING"
      : ["SOURCE_CAPTURED", "PRIMARY_SOURCE_CONFIRMED"].includes(entry.verification.recommendedWorks),
    `recommendation verification does not match captured labels: ${entry.id}`
  );
  assert(Array.isArray(entry.sourceIds) && entry.sourceIds.length > 0, `missing source: ${entry.id}`);
  assert(entry.sourceIds.every((id) => knownSourceIds.has(id)), `unknown source id: ${entry.id}`);
  assert(entry.sourceUrls.every((url) => url.startsWith("https://")), `source URL must use HTTPS: ${entry.id}`);
  assert(!("summary" in entry), `copyright-sensitive summary must not be stored: ${entry.id}`);
  assert(!("imageUrl" in entry), `source image must not be stored: ${entry.id}`);

  if (entry.edition === "STANDARD") {
    assert(!standardVolumes.has(entry.volumeNo), `duplicate standard volume: ${entry.volumeNo}`);
    standardVolumes.add(entry.volumeNo);
  }
}

const entriesWithRecommendations = catalog.entries
  .filter((entry) => entry.recommendedWorks.length > 0);
assert(
  entriesWithRecommendations.length === catalog.coverage.entriesWithRecommendedWorks,
  "recommendation coverage must match the captured entries"
);
const missingRecommendationIds = catalog.entries
  .filter((entry) => entry.recommendedWorks.length === 0)
  .map((entry) => entry.id);
assert(
  missingRecommendationIds.length === 0,
  "every published picture-book entry must have a captured recommendation label"
);

for (let volume = 1; volume <= 108; volume += 1) {
  assert(standardVolumes.has(volume), `missing standard volume: ${volume}`);
}

const special105 = catalog.entries.find((entry) => entry.id === "PB-105-SP");
assert(special105?.names.zh === "工藤新一", "volume 105 special entry must be 工藤新一");
assert(
  special105?.verification.identity === "PRIMARY_SOURCE_CONFIRMED",
  "volume 105 special entry must be confirmed by a primary source"
);
assert(
  special105?.recommendedWorks?.includes("最初の挨拶"),
  "volume 105 special recommendation must be captured"
);

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  `Catalog integrity: OK (${catalog.coverage.entryCount} entries, ${catalog.coverage.standardVolumeCount} standard volumes)`
);

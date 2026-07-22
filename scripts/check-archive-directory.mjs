import { readFile } from "node:fs/promises";
import path from "node:path";

const directoryPath = path.resolve("apps/api/src/data/archive-directory-index.json");
const pictureBookPath = path.resolve("apps/api/src/data/picture-book-index.json");
const directory = JSON.parse(await readFile(directoryPath, "utf8"));
const pictureBook = JSON.parse(await readFile(pictureBookPath, "utf8"));
const errors = [];

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function normalized(value) {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/[·・\s]/g, "");
}

assert(directory.schemaVersion === 1, "schemaVersion must be 1");
assert(directory.coverage?.extensionCount === 26, "extension count must be 26");
assert(directory.coverage?.historicalCount === 3, "historical count must be 3");
assert(directory.coverage?.entryCount === 29, "directory entry count must be 29");
assert(directory.entries.length === directory.coverage.entryCount, "coverage entry count must match data");

const sourceIds = new Set();
for (const source of directory.sources) {
  assert(!sourceIds.has(source.id), `duplicate source id: ${source.id}`);
  sourceIds.add(source.id);
  assert(source.url.startsWith("https://"), `source URL must use HTTPS: ${source.id}`);
}

const pictureBookNames = new Set(
  pictureBook.entries.flatMap((entry) => [
    entry.names.zh,
    entry.names.original,
    entry.names.en,
    ...entry.names.aliases
  ]).filter(Boolean).map(normalized)
);

const ids = new Set();
const directoryNameOwners = new Map();
let extensionCount = 0;
let historicalCount = 0;

for (const entry of directory.entries) {
  assert(/^(EXT|HIS)-(WL|SC|JP|CN)-\d{3}$/.test(entry.id), `invalid entry id: ${entry.id}`);
  assert(!ids.has(entry.id), `duplicate entry id: ${entry.id}`);
  ids.add(entry.id);

  const entryNames = [
    entry.names.zh,
    entry.names.original,
    entry.names.en,
    ...entry.names.aliases
  ].filter(Boolean);
  for (const name of new Set(entryNames.map(normalized))) {
    const owner = directoryNameOwners.get(name);
    assert(!owner || owner === entry.id, `directory name or alias collides: ${entry.id} and ${owner}`);
    directoryNameOwners.set(name, entry.id);
    assert(!pictureBookNames.has(name), `entry name or alias duplicates picture-book data: ${entry.id}`);
  }

  assert(Array.isArray(entry.names.aliases), `aliases must be an array: ${entry.id}`);
  assert(Array.isArray(entry.mediaTypes) && entry.mediaTypes.length > 0, `missing media type: ${entry.id}`);
  assert(Array.isArray(entry.featuredWorks) && entry.featuredWorks.length > 0, `missing featured work: ${entry.id}`);
  assert(Array.isArray(entry.tags) && entry.tags.length > 0, `missing tags: ${entry.id}`);
  assert(typeof entry.summary === "string" && entry.summary.length > 0, `missing summary: ${entry.id}`);
  assert(entry.summary.length <= 160, `summary is too long: ${entry.id}`);
  assert(Array.isArray(entry.sourceIds) && entry.sourceIds.length > 0, `missing source: ${entry.id}`);
  assert(entry.sourceIds.every((id) => sourceIds.has(id)), `unknown source id: ${entry.id}`);
  assert(!("imageUrl" in entry), `source image must not be stored: ${entry.id}`);
  assert(!("sourceDescription" in entry), `source description must not be copied: ${entry.id}`);

  if (entry.collection === "ARCHIVE_EXTENSION") {
    extensionCount += 1;
    assert(entry.id.startsWith("EXT-"), `extension entry must use EXT id: ${entry.id}`);
    assert(entry.creatorName, `fictional entry must include a creator: ${entry.id}`);
  } else if (entry.collection === "HISTORICAL_CASES") {
    historicalCount += 1;
    assert(entry.id.startsWith("HIS-"), `historical entry must use HIS id: ${entry.id}`);
    assert(entry.category === "HISTORICAL_JUSTICE", `historical category mismatch: ${entry.id}`);
    assert(entry.creatorName === null, `historical entry must not claim a creator: ${entry.id}`);
  } else {
    assert(false, `invalid collection: ${entry.id}`);
  }
}

assert(extensionCount === directory.coverage.extensionCount, "extension coverage mismatch");
assert(historicalCount === directory.coverage.historicalCount, "historical coverage mismatch");

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  `Archive directory integrity: OK (${extensionCount} extensions, ${historicalCount} historical entries)`
);

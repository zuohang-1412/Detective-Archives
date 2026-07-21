import { readFile } from "node:fs/promises";
import path from "node:path";

const detectives = JSON.parse(
  await readFile(path.resolve("apps/api/src/data/core-detectives.json"), "utf8")
);
const details = JSON.parse(
  await readFile(path.resolve("apps/api/src/data/core-work-details.json"), "utf8")
);

const expectedSlugs = detectives.flatMap((detective) =>
  detective.works.map((work) => work.id.replace(/^work_/, "").replaceAll("_", "-"))
);
const actualSlugs = details.map((detail) => detail.slug);

if (new Set(actualSlugs).size !== actualSlugs.length) {
  throw new Error("Core work detail slugs must be unique");
}
if (expectedSlugs.length !== actualSlugs.length
  || expectedSlugs.some((slug) => !actualSlugs.includes(slug))) {
  throw new Error("Every core work must have exactly one detail record");
}

const urls = [];
for (const detail of details) {
  if (typeof detail.summary !== "string" || detail.summary.length < 20) {
    throw new Error(`${detail.slug}: summary is missing or too short`);
  }
  if (!Array.isArray(detail.links) || detail.links.length === 0) {
    throw new Error(`${detail.slug}: at least one official link is required`);
  }
  for (const link of detail.links) {
    const url = new URL(link.url);
    if (url.protocol !== "https:") {
      throw new Error(`${detail.slug}: official links must use HTTPS`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(link.lastCheckedAt)) {
      throw new Error(`${detail.slug}: invalid lastCheckedAt`);
    }
    urls.push(link.url);
  }
}
if (new Set(urls).size !== urls.length) {
  throw new Error("Core work official links must be unique");
}

console.log(`Core work integrity: OK (${details.length} works, ${urls.length} official links)`);

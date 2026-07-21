import { readFile } from "node:fs/promises";
import path from "node:path";

export const catalogDataDirectory = path.resolve("apps/api/src/data");
export const catalogManifestPath = path.join(
  catalogDataDirectory,
  "catalog-expansion-manifest.json"
);

export function catalogSlugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error(`Cannot create a stable catalog slug for ${value}`);
  return slug;
}

export async function loadCatalogBatches() {
  const manifest = JSON.parse(await readFile(catalogManifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.batches) || manifest.batches.length === 0) {
    throw new Error("Catalog expansion manifest must contain at least one schema v1 batch");
  }
  if (new Set(manifest.batches).size !== manifest.batches.length) {
    throw new Error("Catalog expansion manifest batch filenames must be unique");
  }

  const batches = [];
  for (const filename of manifest.batches) {
    if (typeof filename !== "string" || !/^catalog-expansion(?:-[a-z0-9]+)*\.json$/.test(filename)) {
      throw new Error(`Invalid catalog batch filename: ${filename}`);
    }
    const filePath = path.resolve(catalogDataDirectory, filename);
    if (path.dirname(filePath) !== catalogDataDirectory) {
      throw new Error(`Catalog batch must stay inside the catalog data directory: ${filename}`);
    }
    const raw = await readFile(filePath, "utf8");
    batches.push({ filename, filePath, raw, input: JSON.parse(raw) });
  }

  return { manifest, batches };
}

export function uniqueImportedWorks(batches) {
  return new Map(
    batches.flatMap(({ input }) => input.detectives)
      .flatMap((detective) => detective.works)
      .map((work) => [work.slug, work])
  );
}

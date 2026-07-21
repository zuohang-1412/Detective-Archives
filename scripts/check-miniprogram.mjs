import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve("apps/miniprogram");
const appConfigPath = path.join(root, "app.json");

async function assertFile(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Expected file: ${filePath}`);
  }
}

async function parseJson(filePath) {
  const source = await readFile(filePath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

async function checkScript(filePath) {
  const source = await readFile(filePath, "utf8");
  try {
    new vm.Script(source, { filename: filePath });
  } catch (error) {
    throw new Error(`Invalid JavaScript in ${filePath}: ${error.message}`);
  }
}

const appConfig = await parseJson(appConfigPath);
if (!Array.isArray(appConfig.pages) || appConfig.pages.length === 0) {
  throw new Error("app.json must declare at least one page");
}

await checkScript(path.join(root, "app.js"));
await checkScript(path.join(root, "config.js"));
await parseJson(path.join(root, "sitemap.json"));
await checkScript(path.join(root, "services/api.js"));

for (const page of appConfig.pages) {
  const base = path.join(root, page);
  await Promise.all([
    assertFile(`${base}.wxml`),
    assertFile(`${base}.wxss`),
    parseJson(`${base}.json`),
    checkScript(`${base}.js`)
  ]);
}

const archiveScript = await readFile(path.join(root, "pages/archive/archive.js"), "utf8");
const archiveTemplate = await readFile(path.join(root, "pages/archive/archive.wxml"), "utf8");
for (const filterName of ["country", "era", "category", "subjectKind", "tag"]) {
  if (!archiveScript.includes(`key: "${filterName}"`)) {
    throw new Error(`Archive page must expose the ${filterName} filter`);
  }
}
for (const behavior of ["onFilterChange", "onClearFilters", "onLoadMore", "onReachBottom"]) {
  if (!archiveScript.includes(`${behavior}(`)) {
    throw new Error(`Archive page must implement ${behavior}`);
  }
}
if (!archiveTemplate.includes('bindchange="onFilterChange"')) {
  throw new Error("Archive template must bind the detective filter picker");
}
if (!archiveTemplate.includes('bindtap="onLoadMore"')) {
  throw new Error("Archive template must expose detective pagination");
}

console.log(`Mini program structure and syntax: OK (${appConfig.pages.length} pages)`);

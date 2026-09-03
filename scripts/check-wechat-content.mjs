import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content", "wechat");
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function parseFrontMatter(file, source) {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    failures.push(`${relative(file)}: missing front matter`);
    return {};
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    failures.push(`${relative(file)}: unterminated front matter`);
    return {};
  }
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/);
    if (match) metadata[match[1]] = match[2].trim();
  }
  return metadata;
}

async function verifyLocalReference(article, rawReference, label) {
  const reference = rawReference.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
  if (!reference || /^(?:https?:|data:|#)/i.test(reference)) return;
  const target = path.resolve(path.dirname(article), decodeURIComponent(reference));
  const safePrefix = `${contentRoot}${path.sep}`;
  if (target !== contentRoot && !target.startsWith(safePrefix)) {
    failures.push(`${relative(article)}: ${label} escapes content/wechat: ${rawReference}`);
    return;
  }
  try {
    const targetStat = await stat(target);
    if (!targetStat.isFile()) failures.push(`${relative(article)}: ${label} is not a file: ${rawReference}`);
  } catch {
    failures.push(`${relative(article)}: missing ${label}: ${rawReference}`);
  }
}

const allFiles = await walk(contentRoot);
const articleFiles = allFiles
  .filter((file) => file.endsWith(".md"))
  .filter((file) => !["README.md", "generation-record.md"].includes(path.basename(file)))
  .sort();

if (articleFiles.length === 0) failures.push("No WeChat articles were found");

const titles = new Map();
const publishOrders = new Map();
const allowedStatuses = new Set(["draft", "ready_for_review", "ready_for_publish", "published", "retired"]);
let localImageReferences = 0;

for (const article of articleFiles) {
  const source = await readFile(article, "utf8");
  const metadata = parseFrontMatter(article, source);
  for (const key of ["title", "summary", "status", "coverText", "estimatedReadMinutes"]) {
    if (!metadata[key]) failures.push(`${relative(article)}: missing ${key}`);
  }
  if (metadata.status && !allowedStatuses.has(metadata.status)) {
    failures.push(`${relative(article)}: unsupported status ${metadata.status}`);
  }
  if (metadata.estimatedReadMinutes && !/^[1-9]\d*$/.test(metadata.estimatedReadMinutes)) {
    failures.push(`${relative(article)}: estimatedReadMinutes must be a positive integer`);
  }
  if (metadata.title) {
    const duplicate = titles.get(metadata.title);
    if (duplicate) failures.push(`${relative(article)}: duplicate title also used by ${duplicate}`);
    else titles.set(metadata.title, relative(article));
  }
  if (metadata.publishOrder) {
    if (!/^[1-9]\d*$/.test(metadata.publishOrder)) {
      failures.push(`${relative(article)}: publishOrder must be a positive integer`);
    } else {
      const duplicate = publishOrders.get(metadata.publishOrder);
      if (duplicate) failures.push(`${relative(article)}: duplicate publishOrder also used by ${duplicate}`);
      else publishOrders.set(metadata.publishOrder, relative(article));
    }
  }
  if (source.length < 800) failures.push(`${relative(article)}: article is unexpectedly short`);
  if (!/^#{1,3}\s+.+/m.test(source)) failures.push(`${relative(article)}: no semantic heading found`);
  const declaresOriginalWork = /原创/.test(source);
  if (!declaresOriginalWork && !/(资料来源|参考资料|阅读入口)/.test(source)) {
    failures.push(`${relative(article)}: non-original article is missing a source or reading-entry section`);
  }
  if (!/(版权|授权|公共领域|原创|不使用[^。\n]*截图)/.test(source)) {
    failures.push(`${relative(article)}: missing copyright or originality statement`);
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (/(?:Image|Mark)$/.test(key)) {
      await verifyLocalReference(article, value, key);
      localImageReferences += 1;
    }
  }
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    await verifyLocalReference(article, match[1], "Markdown image");
    localImageReferences += 1;
  }
}

const manifestPath = path.join(root, "apps", "api", "src", "data", "catalog-expansion-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.batches) || manifest.batches.length === 0) {
  failures.push("Public catalog manifest contains no batches");
} else {
  for (const batch of manifest.batches) {
    const batchFile = typeof batch === "string" ? batch : batch.file;
    if (!batchFile) {
      failures.push("Catalog batch entry has no file name");
      continue;
    }
    const batchPath = path.join(path.dirname(manifestPath), batchFile);
    try {
      if (!(await stat(batchPath)).isFile()) failures.push(`Catalog batch is not a file: ${batchFile}`);
    } catch {
      failures.push(`Missing Git-backed catalog batch: ${batchFile}`);
    }
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const forbiddenTracked = tracked.filter((file) => (
  /(?:^|\/)\.env(?:\.|$)/.test(file) && file !== ".env.example"
  || /\.dump(?:\.(?:enc|sha256))*$/i.test(file)
  || /^content\/wechat\/publish\/.*\.docx$/i.test(file)
));
for (const file of forbiddenTracked) failures.push(`Sensitive or generated file is tracked: ${file}`);

if (failures.length > 0) {
  throw new Error(`WeChat content check failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  `WeChat content: OK (${articleFiles.length} articles, ${localImageReferences} local image references, ${manifest.batches.length} Git-backed catalog batches)`
);

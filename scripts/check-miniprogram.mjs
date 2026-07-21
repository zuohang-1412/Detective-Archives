import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve("apps/miniprogram");
const appConfigPath = path.join(root, "app.json");
const projectConfigPath = path.resolve("project.config.json");

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

async function checkTemplate(filePath) {
  const source = (await readFile(filePath, "utf8")).replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  const tagPattern = /<\/?([a-zA-Z][\w-]*)\b[^>]*>/g;
  let match;
  while ((match = tagPattern.exec(source))) {
    const fullTag = match[0];
    const tagName = match[1];
    if (fullTag.startsWith("</")) {
      const openTag = stack.pop();
      if (openTag !== tagName) {
        throw new Error(`Unbalanced WXML in ${filePath}: expected </${openTag || "none"}> but found </${tagName}>`);
      }
    } else if (!fullTag.endsWith("/>")) {
      stack.push(tagName);
    }
  }
  if (stack.length) {
    throw new Error(`Unbalanced WXML in ${filePath}: missing </${stack.at(-1)}>`);
  }
}

const appConfig = await parseJson(appConfigPath);
const projectConfig = await parseJson(projectConfigPath);
if (!Array.isArray(appConfig.pages) || appConfig.pages.length === 0) {
  throw new Error("app.json must declare at least one page");
}
if (appConfig.__usePrivacyCheck__ !== true) {
  throw new Error("app.json must explicitly enable the WeChat privacy authorization flow");
}
if (!/^\d+\.\d+\.\d+$/.test(projectConfig.libVersion || "")) {
  throw new Error("project.config.json must pin an explicit stable WeChat base-library version");
}

await checkScript(path.join(root, "app.js"));
await checkScript(path.join(root, "config.js"));
await parseJson(path.join(root, "sitemap.json"));
await checkScript(path.join(root, "services/api.js"));

for (const page of appConfig.pages) {
  const base = path.join(root, page);
  await Promise.all([
    checkTemplate(`${base}.wxml`),
    assertFile(`${base}.wxss`),
    parseJson(`${base}.json`),
    checkScript(`${base}.js`)
  ]);
}

const archiveScript = await readFile(path.join(root, "pages/archive/archive.js"), "utf8");
const archiveTemplate = await readFile(path.join(root, "pages/archive/archive.wxml"), "utf8");
const apiScript = await readFile(path.join(root, "services/api.js"), "utf8");
const meScript = await readFile(path.join(root, "pages/me/me.js"), "utf8");
const meTemplate = await readFile(path.join(root, "pages/me/me.wxml"), "utf8");
const reviewEditorScript = await readFile(path.join(root, "pages/review-editor/review-editor.js"), "utf8");
const reviewDetailTemplate = await readFile(path.join(root, "pages/review-detail/review-detail.wxml"), "utf8");
const reviewDetailScript = await readFile(path.join(root, "pages/review-detail/review-detail.js"), "utf8");
const workScript = await readFile(path.join(root, "pages/work/work.js"), "utf8");
const workTemplate = await readFile(path.join(root, "pages/work/work.wxml"), "utf8");
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
if (!archiveScript.includes("openRecommendedWork(")
  || !archiveTemplate.includes('catchtap="openRecommendedWork"')
  || !archiveTemplate.includes("linkedRecommendations")
  || !archiveTemplate.includes("关联作品：")) {
  throw new Error("Picture-book entries must link mapped recommendations to formal works");
}
for (const apiBehavior of ["getMyReview", "updateReview", "deleteReview", "deleteComment", "createAppeal"]) {
  if (!apiScript.includes(`function ${apiBehavior}(`)) {
    throw new Error(`Mini Program API must implement ${apiBehavior}`);
  }
}
if (!meScript.includes("appealMyReview(") || !meTemplate.includes('catchtap="appealMyReview"')) {
  throw new Error("My Archives must expose review appeals");
}
for (const privacyCapability of ["getPrivacySetting", "openPrivacyContract", "handleAgreePrivacyAuthorization"]) {
  if (!meScript.includes(privacyCapability)) {
    throw new Error(`My Archives must integrate WeChat privacy capability: ${privacyCapability}`);
  }
}
if (!meTemplate.includes('open-type="agreePrivacyAuthorization"')
  || !meTemplate.includes('bindagreeprivacyauthorization="handleAgreePrivacyAuthorization"')
  || !meTemplate.includes('bindtap="openPlatformPrivacy"')) {
  throw new Error("My Archives must expose the WeChat privacy contract and authorization control");
}
for (const analyticsCapability of ["VISITOR_ID_KEY", "getVisitorId", '"x-visitor-id"']) {
  if (!apiScript.includes(analyticsCapability)) {
    throw new Error(`Mini Program API must include privacy-minimized analytics: ${analyticsCapability}`);
  }
}
for (const behavior of ["editMyReview", "deleteMyReview"]) {
  if (!meScript.includes(`${behavior}(`) || !meTemplate.includes(`catchtap="${behavior}"`)) {
    throw new Error(`My Archives must expose ${behavior}`);
  }
}
for (const shelfRetentionCapability of ["work.isAvailable", "removeUnavailableShelf"]) {
  if (!meScript.includes(shelfRetentionCapability) && !meTemplate.includes(shelfRetentionCapability)) {
    throw new Error(`My Archives must retain unavailable shelf entries: ${shelfRetentionCapability}`);
  }
}
if (!reviewEditorScript.includes("getMyReview") || !reviewEditorScript.includes("updateReview")) {
  throw new Error("Review editor must load and update an existing review");
}
for (const behavior of ["editReview", "deleteOwnReview", "deleteOwnComment"]) {
  if (!reviewDetailTemplate.includes(`bindtap="${behavior}"`)) {
    throw new Error(`Review detail must expose ${behavior}`);
  }
}
if (!apiScript.includes("async function listAllPages(")) {
  throw new Error("Private shelf and review lists must load bounded API pages");
}
if (!workScript.includes("loadMoreReviews(") || !workTemplate.includes('bindtap="loadMoreReviews"')) {
  throw new Error("Work detail must expose public review pagination");
}
if (!workScript.includes("链接已失效或暂不可用") || !workScript.includes("无法继续打开这条正版渠道")) {
  throw new Error("Work detail must stop when server-side link validation fails");
}
if (!reviewDetailScript.includes("loadMoreComments(") || !reviewDetailTemplate.includes('bindtap="loadMoreComments"')) {
  throw new Error("Review detail must expose public comment pagination");
}
for (const reportCapability of ["reportDescription", "selectReportReason", "submitReport"]) {
  if (!reviewDetailScript.includes(reportCapability) && !reviewDetailTemplate.includes(reportCapability)) {
    throw new Error(`Review detail must expose complete report input: ${reportCapability}`);
  }
}
if (!/class="report-description"[\s\S]{0,80}maxlength="500"/.test(reviewDetailTemplate)) {
  throw new Error("Report description must match the API 500-character limit");
}

console.log(`Mini program structure and syntax: OK (${appConfig.pages.length} pages)`);

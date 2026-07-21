import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve("apps/admin");
const files = ["index.html", "app.js", "styles.css"];
for (const file of files) {
  const filePath = path.join(root, file);
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Expected admin asset: ${filePath}`);
}

const script = await readFile(path.join(root, "app.js"), "utf8");
new vm.Script(script, { filename: "apps/admin/app.js" });
if (script.includes("innerHTML")) {
  throw new Error("Admin UI must not render API content with innerHTML");
}
for (const healthLabel of ["确认失效链接", "待人工复核", "超期未巡检"]) {
  if (!script.includes(healthLabel)) {
    throw new Error(`Admin UI must expose link health state: ${healthLabel}`);
  }
}
for (const paginationCapability of ["listAllAdminPages", "listAllModerationPages", "pageSize=50"]) {
  if (!script.includes(paginationCapability)) {
    throw new Error(`Admin UI must load bounded paginated data: ${paginationCapability}`);
  }
}
for (const analyticsCapability of ["/admin/analytics?days=90", "renderAnalytics", "archiveDetail", "day30", "appealRecoveryRate"]) {
  if (!script.includes(analyticsCapability)) {
    throw new Error(`Admin UI must expose product analytics: ${analyticsCapability}`);
  }
}
for (const appealCapability of ["appealQueue", "renderAppeals", "/admin/appeals/"]) {
  if (!script.includes(appealCapability)) {
    throw new Error(`Admin UI must expose content appeals: ${appealCapability}`);
  }
}

const html = await readFile(path.join(root, "index.html"), "utf8");
for (const asset of ["/admin/styles.css", "/admin/app.js"]) {
  if (!html.includes(asset)) throw new Error(`Admin HTML does not reference ${asset}`);
}
for (const analyticsElement of ["analyticsMetrics", "analyticsPeriod"]) {
  if (!html.includes(`id="${analyticsElement}"`)) {
    throw new Error(`Admin HTML must include ${analyticsElement}`);
  }
}

console.log("Admin console structure and syntax: OK");

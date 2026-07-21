import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { loadRuntimeConfig } from "../apps/api/dist/runtime-config.js";

const environment = { ...process.env, NODE_ENV: "production" };
const apiConfig = loadRuntimeConfig(environment);

const root = path.resolve();
const project = JSON.parse(await readFile(path.join(root, "project.config.json"), "utf8"));
const configSource = await readFile(path.join(root, "apps/miniprogram/config.js"), "utf8");
const moduleContext = { exports: {} };
vm.runInNewContext(configSource, { module: moduleContext, exports: moduleContext.exports }, {
  filename: "apps/miniprogram/config.js"
});
const miniConfig = moduleContext.exports;

if (!/^wx[a-zA-Z0-9]{6,}$/.test(project.appid) || project.appid === "touristappid") {
  throw new Error("project.config.json must contain the production Mini Program AppID");
}
if (project.setting?.urlCheck !== true) {
  throw new Error("Mini Program production builds must enable URL domain checks");
}
if (!/^\d+\.\d+\.\d+$/.test(project.libVersion || "")) {
  throw new Error("Mini Program production builds must pin a stable base-library version");
}
const publicApi = new URL(miniConfig.apiBaseUrl);
if (publicApi.protocol !== "https:" || publicApi.origin !== miniConfig.apiBaseUrl) {
  throw new Error("Mini Program apiBaseUrl must be an exact HTTPS origin");
}
for (const [name, value] of Object.entries({
  operatorName: miniConfig.operatorName,
  privacyContact: miniConfig.privacyContact
})) {
  if (typeof value !== "string" || value.trim().length < 3 || /上线前|replace|example/i.test(value)) {
    throw new Error(`Mini Program ${name} must be replaced with production information`);
  }
}

console.log(JSON.stringify({
  status: "production_config_ready",
  apiHost: apiConfig.host,
  apiPort: apiConfig.port,
  corsOriginCount: Array.isArray(apiConfig.corsOrigin) ? apiConfig.corsOrigin.length : 1,
  miniprogramAppIdConfigured: true,
  publicApiOrigin: publicApi.origin
}));

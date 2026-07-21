import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const appId = required("MINIPROGRAM_APP_ID");
const apiBaseUrl = required("PUBLIC_API_BASE_URL");
const operatorName = required("OPERATOR_NAME");
const privacyContact = required("PRIVACY_CONTACT");

if (!/^wx[a-zA-Z0-9]{6,}$/.test(appId)) {
  throw new Error("MINIPROGRAM_APP_ID is not a valid WeChat Mini Program AppID");
}
const apiUrl = new URL(apiBaseUrl);
if (apiUrl.protocol !== "https:" || apiUrl.origin !== apiBaseUrl) {
  throw new Error("PUBLIC_API_BASE_URL must be an exact HTTPS origin without a path");
}
if (/上线前|replace|example/i.test(`${operatorName} ${privacyContact}`)) {
  throw new Error("Operator and privacy contact placeholders must be replaced");
}

const root = path.resolve();
const projectPath = path.join(root, "project.config.json");
const project = JSON.parse(await readFile(projectPath, "utf8"));
project.appid = appId;
project.setting = { ...project.setting, urlCheck: true };

const configSource = `module.exports = ${JSON.stringify({
  apiBaseUrl,
  operatorName,
  privacyContact
}, null, 2)};\n`;

await writeFile(path.join(root, "apps/miniprogram/config.js"), configSource, "utf8");
await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
console.log("Mini Program production configuration: written");

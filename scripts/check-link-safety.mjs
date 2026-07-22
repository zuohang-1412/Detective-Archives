import assert from "node:assert/strict";
import {
  classifyLinkHealth,
  isHealthyLinkStatus,
  linkHealthErrorCode,
  linkHealthOutcome
} from "./lib/link-health.mjs";
import { isPrivateAddress, validateUrlShape } from "./lib/link-safety.mjs";

for (const address of [
  "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
  "172.16.0.1", "172.31.255.255", "192.0.2.1", "192.168.1.1", "198.18.0.1",
  "198.51.100.1", "203.0.113.1", "224.0.0.1", "::", "::1", "fc00::1",
  "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
  "0:0:0:0:0:ffff:c0a8:1"
]) {
  assert.equal(isPrivateAddress(address), true, `${address} must be blocked`);
}
for (const address of [
  "1.1.1.1", "8.8.8.8", "93.184.216.34", "192.1.1.1", "198.51.99.1",
  "203.0.112.1", "2606:4700:4700::1111"
]) {
  assert.equal(isPrivateAddress(address), false, `${address} must be allowed`);
}
assert.equal(validateUrlShape("https://example.com/path").hostname, "example.com");
assert.throws(() => validateUrlShape("http://example.com"), { code: "HTTPS_REQUIRED" });
assert.throws(
  () => validateUrlShape("https://user:password@example.com"),
  { code: "URL_CREDENTIALS_FORBIDDEN" }
);
for (const status of [200, 204, 301, 401, 403]) {
  assert.equal(isHealthyLinkStatus(status), true, `${status} must be healthy`);
  assert.equal(classifyLinkHealth(status), linkHealthOutcome.HEALTHY);
}
for (const status of [400, 404, 410]) {
  assert.equal(classifyLinkHealth(status), linkHealthOutcome.BROKEN);
}
for (const status of [405, 429, 451, 500, 503]) {
  assert.equal(classifyLinkHealth(status), linkHealthOutcome.UNCONFIRMED);
}
assert.equal(classifyLinkHealth(null, "TIMEOUT"), linkHealthOutcome.UNCONFIRMED);
assert.equal(
  linkHealthErrorCode(Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" })
  })),
  "UND_ERR_CONNECT_TIMEOUT"
);
assert.equal(linkHealthErrorCode(Object.assign(new Error("aborted"), { name: "AbortError" })), "TIMEOUT");

console.log("Link safety checks: OK (unsafe destinations blocked; hard failures separated from transient checks)");

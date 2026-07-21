import dns from "node:dns/promises";
import net from "node:net";

function safetyError(code) {
  return Object.assign(new Error(code), { code });
}

export function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (net.isIPv6(normalized)) {
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

export function validateUrlShape(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw safetyError("HTTPS_REQUIRED");
  if (url.username || url.password) throw safetyError("URL_CREDENTIALS_FORBIDDEN");
  return url;
}

export async function validatePublicHttpsUrl(value) {
  const url = validateUrlShape(value);
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw safetyError("NON_PUBLIC_DESTINATION");
  }
  return url;
}

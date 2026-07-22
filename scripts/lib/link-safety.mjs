import dns from "node:dns/promises";
import net from "node:net";

function safetyError(code) {
  return Object.assign(new Error(code), { code });
}

function mappedIpv4Address(address) {
  if (!net.isIPv6(address)) return null;
  let canonical;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const match = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (net.isIPv6(normalized)) {
    const mappedIpv4 = mappedIpv4Address(normalized);
    if (mappedIpv4) return isPrivateAddress(mappedIpv4);
    const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    return canonical === "::"
      || canonical === "::1"
      || canonical.startsWith("fc")
      || canonical.startsWith("fd")
      || canonical.startsWith("fe8")
      || canonical.startsWith("fe9")
      || canonical.startsWith("fea")
      || canonical.startsWith("feb")
      || canonical.startsWith("ff")
      || canonical.startsWith("2001:db8:");
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

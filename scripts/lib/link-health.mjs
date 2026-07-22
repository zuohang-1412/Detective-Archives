export const linkHealthOutcome = Object.freeze({
  HEALTHY: "HEALTHY",
  BROKEN: "BROKEN",
  UNCONFIRMED: "UNCONFIRMED"
});

const confirmedBrokenStatuses = new Set([400, 404, 410]);

export function isHealthyLinkStatus(statusCode) {
  return (statusCode >= 200 && statusCode < 400)
    || statusCode === 401
    || statusCode === 403;
}

export function classifyLinkHealth(statusCode, errorCode = null) {
  if (statusCode !== null && isHealthyLinkStatus(statusCode)) {
    return linkHealthOutcome.HEALTHY;
  }
  if (statusCode !== null && confirmedBrokenStatuses.has(statusCode)) {
    return linkHealthOutcome.BROKEN;
  }
  if (errorCode || statusCode !== null) {
    return linkHealthOutcome.UNCONFIRMED;
  }
  return linkHealthOutcome.UNCONFIRMED;
}

export function linkHealthErrorCode(error) {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof Error && current.name === "AbortError") return "TIMEOUT";
    if (typeof current !== "object" || current === null) break;
    if ("code" in current && typeof current.code === "string" && current.code.trim()) {
      return current.code.trim().slice(0, 80);
    }
    current = "cause" in current ? current.cause : null;
  }
  return "FETCH_FAILED";
}

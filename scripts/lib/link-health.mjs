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

import { validCandidateUploadReceipt } from "./miniprogram-release.mjs";
import { validOperationsDrillReceipt } from "./operations-drill.mjs";
import { validProductionReleaseReceipt } from "./production-release-drill.mjs";

const PHASES = ["PRE_DEPLOY", "POST_DEPLOY", "SUBMISSION", "RELEASE"];
const placeholderPattern = /(?:replace|example|your[-_. ]|strong-password|managed-postgres|change-?me|dummy|test-only|ci-only|上线前|待填写|todo)/i;

function present(value, minimumLength = 1) {
  return typeof value === "string"
    && value.trim().length >= minimumLength
    && !placeholderPattern.test(value);
}

function exactHttpsOrigin(value) {
  if (!present(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.origin === value
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function validAppId(value) {
  return present(value) && /^wx[a-zA-Z0-9]{6,}$/.test(value);
}

function item(id, phase, owner, ready, detail) {
  return {
    id,
    phase,
    owner,
    status: ready ? "READY" : "MISSING_OR_INVALID",
    detail
  };
}

function nested(input, ...keys) {
  let value = input;
  for (const key of keys) value = value?.[key];
  return value;
}

function databaseConfigured(environment) {
  if (present(environment.DATABASE_URL)) {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(environment.DATABASE_URL).protocol)
        && !placeholderPattern.test(environment.DATABASE_URL);
    } catch {
      return false;
    }
  }
  return ["PGHOST", "PGUSER", "PGPASSWORD"].every((key) => present(environment[key]));
}

function corsConfigured(value) {
  if (!present(value) || value.includes("*")) return false;
  return value.split(",").map((origin) => origin.trim()).every(exactHttpsOrigin);
}

export function auditLaunchReadiness({
  environment = {},
  manifest = {},
  operationsRunbookSha256 = null,
  sourceCommit = null
} = {}) {
  const appId = environment.WECHAT_APP_ID?.trim();
  const miniProgramAppId = environment.MINIPROGRAM_APP_ID?.trim();
  const operatorName = nested(manifest, "operator", "legalName");
  const privacyContact = nested(manifest, "operator", "privacyContact");
  const databasePrivate = nested(manifest, "infrastructure", "databasePrivate") === true;
  const sslMode = environment.PGSSLMODE?.trim().toLowerCase();
  const secureDatabaseTransport = ["verify-ca", "verify-full"].includes(sslMode)
    || (databasePrivate && ["disable", "allow", "prefer"].includes(sslMode));
  const sourceCommitValid = /^[0-9a-f]{40}$/i.test(sourceCommit || "");
  const productionReleaseReceiptValid = sourceCommitValid
    && validProductionReleaseReceipt(
      nested(manifest, "validation", "productionReleaseReceipt"),
      {
        publicApiOrigin: environment.PUBLIC_API_BASE_URL,
        sourceCommit
      }
    );

  return [
    item("database_configuration", "PRE_DEPLOY", "ENGINEERING", databaseConfigured(environment),
      "Production PostgreSQL connection is configured without placeholder values."),
    item("database_transport", "PRE_DEPLOY", "INFRASTRUCTURE", secureDatabaseTransport,
      "Database TLS verification is enabled, or an explicitly private database network is attested."),
    item("wechat_app_identity", "PRE_DEPLOY", "WECHAT_OWNER",
      validAppId(appId) && validAppId(miniProgramAppId) && appId === miniProgramAppId,
      "API and Mini Program AppIDs are valid and identical."),
    item("wechat_app_secret", "PRE_DEPLOY", "WECHAT_OWNER", present(environment.WECHAT_APP_SECRET, 16),
      "A non-placeholder AppSecret is available to the API runtime."),
    item("wechat_production_login", "PRE_DEPLOY", "ENGINEERING", environment.WECHAT_DEV_LOGIN === "false",
      "Development login is explicitly disabled."),
    item("public_api_origin", "PRE_DEPLOY", "INFRASTRUCTURE",
      exactHttpsOrigin(environment.PUBLIC_API_BASE_URL) && corsConfigured(environment.CORS_ORIGIN),
      "The public API and CORS allowlist use exact HTTPS origins without wildcards."),
    item("trusted_proxy", "PRE_DEPLOY", "INFRASTRUCTURE", environment.TRUST_PROXY === "true",
      "Reverse-proxy trust is explicitly enabled for the production topology."),
    item("admin_credentials", "PRE_DEPLOY", "OPERATIONS",
      present(environment.ADMIN_LOGIN_ID, 3) && present(environment.ADMIN_LOGIN_PASSWORD, 16),
      "Independent non-placeholder operations credentials meet the minimum length."),
    item("metrics_credentials", "PRE_DEPLOY", "OPERATIONS", present(environment.METRICS_AUTH_TOKEN, 24),
      "An independent monitoring token meets the minimum length."),
    item("operator_identity", "PRE_DEPLOY", "LEGAL",
      present(operatorName, 3)
        && present(privacyContact, 3)
        && environment.OPERATOR_NAME?.trim() === operatorName?.trim()
        && environment.PRIVACY_CONTACT?.trim() === privacyContact?.trim(),
      "Runtime operator and privacy contact match the non-secret launch manifest."),
    item("operations_ownership", "PRE_DEPLOY", "OPERATIONS",
      present(nested(manifest, "operator", "contentModerator"), 2)
        && present(nested(manifest, "operator", "alertResponder"), 2),
      "Content moderation and production alert owners are named."),
    item("production_server", "PRE_DEPLOY", "INFRASTRUCTURE",
      nested(manifest, "infrastructure", "serverProvisioned") === true,
      "The production server is provisioned and access-controlled."),
    item("domain_filing", "PRE_DEPLOY", "INFRASTRUCTURE",
      nested(manifest, "infrastructure", "domainFiled") === true,
      "The API domain has the filing or regulatory status required for launch."),
    item("database_private", "PRE_DEPLOY", "INFRASTRUCTURE", databasePrivate,
      "The production database is not exposed to the public internet."),

    item("tls_verified", "POST_DEPLOY", "INFRASTRUCTURE",
      productionReleaseReceiptValid,
      "A current release receipt proves the public certificate and HTTP-to-HTTPS redirect."),
    item("production_release_check", "POST_DEPLOY", "ENGINEERING",
      productionReleaseReceiptValid,
      "A current release receipt proves the real production runtime probes passed."),
    item("rollback_drill", "POST_DEPLOY", "ENGINEERING",
      productionReleaseReceiptValid,
      "A current release receipt proves the previous-image rollback and candidate recovery passed."),
    item("monitoring_and_alerting", "POST_DEPLOY", "OPERATIONS",
      nested(manifest, "infrastructure", "monitoringReady") === true,
      "External readiness monitoring, metrics collection and alert routing are active."),
    item("offsite_backup", "POST_DEPLOY", "OPERATIONS",
      nested(manifest, "infrastructure", "offsiteBackupReady") === true,
      "Daily encrypted backup and independent storage are active."),
    item("content_safety_live", "POST_DEPLOY", "WECHAT_OWNER",
      nested(manifest, "validation", "contentSafetyPassed") === true,
      "Live WeChat content-safety pass, review, rejection and dependency-failure paths were verified."),

    item("operations_drill", "SUBMISSION", "OPERATIONS",
      /^[0-9a-f]{64}$/i.test(operationsRunbookSha256 || "")
        && validOperationsDrillReceipt(
          nested(manifest, "validation", "operationsDrillReceipt"),
          { runbookSha256: operationsRunbookSha256 }
        ),
      "Named operators passed the four-scenario drill against the current operations runbook."),
    item("wechat_service_category", "SUBMISSION", "WECHAT_OWNER",
      nested(manifest, "wechat", "serviceCategoryConfigured") === true,
      "The Mini Program service category is configured."),
    item("wechat_privacy_guide", "SUBMISSION", "LEGAL",
      nested(manifest, "wechat", "privacyGuideConfigured") === true,
      "The WeChat privacy protection guide matches the product behavior."),
    item("user_agreement_approved", "SUBMISSION", "LEGAL",
      nested(manifest, "wechat", "userAgreementApproved") === true,
      "The final user agreement and privacy text are approved."),
    item("wechat_request_domain", "SUBMISSION", "WECHAT_OWNER",
      nested(manifest, "wechat", "requestDomainConfigured") === true,
      "The HTTPS API origin is registered as a legal request domain."),
    item("ios_device_flow", "SUBMISSION", "QA",
      nested(manifest, "validation", "iosDevicePassed") === true,
      "The complete production flow passed on a real iOS WeChat device."),
    item("android_device_flow", "SUBMISSION", "QA",
      nested(manifest, "validation", "androidDevicePassed") === true,
      "The complete production flow passed on a real Android WeChat device."),
    item("candidate_uploaded", "SUBMISSION", "WECHAT_OWNER",
      sourceCommitValid
        && nested(manifest, "wechat", "candidateUploaded") === true
        && validCandidateUploadReceipt(
          nested(manifest, "wechat", "candidateUploadReceipt"),
          appId,
          sourceCommit
        ),
      "The verified candidate has a valid successful upload receipt for this AppID and source commit."),
    item("review_submitted", "SUBMISSION", "WECHAT_OWNER",
      nested(manifest, "wechat", "reviewSubmitted") === true,
      "The candidate and required declarations were submitted for review."),

    item("platform_review", "RELEASE", "WECHAT_OWNER",
      nested(manifest, "wechat", "reviewApproved") === true,
      "WeChat platform review is approved for this candidate."),
    item("production_released", "RELEASE", "WECHAT_OWNER",
      nested(manifest, "wechat", "released") === true,
      "The approved Mini Program version is released to production users.")
  ];
}

export function summarizeLaunchReadiness(items, targetPhase = "RELEASE") {
  if (!PHASES.includes(targetPhase)) throw new Error(`Unsupported launch phase: ${targetPhase}`);
  const targetIndex = PHASES.indexOf(targetPhase);
  const scopedItems = items.filter((entry) => PHASES.indexOf(entry.phase) <= targetIndex);
  const blockers = scopedItems.filter((entry) => entry.status !== "READY");
  let readyThrough = null;
  for (const phase of PHASES) {
    if (PHASES.indexOf(phase) > targetIndex) break;
    const phaseItems = items.filter((entry) => entry.phase === phase);
    if (phaseItems.every((entry) => entry.status === "READY")) readyThrough = phase;
    else break;
  }
  return {
    status: blockers.length === 0 ? "READY" : "BLOCKED",
    targetPhase,
    readyThrough,
    ready: scopedItems.length - blockers.length,
    total: scopedItems.length,
    blockers: blockers.map((entry) => ({
      id: entry.id,
      phase: entry.phase,
      owner: entry.owner,
      detail: entry.detail
    })),
    items
  };
}

export { PHASES };

export const currentAgreementVersions = {
  termsVersion: "2026-07-22",
  privacyVersion: "2026-07-22"
} as const;

export interface AgreementVersions {
  termsVersion: string;
  privacyVersion: string;
}

export function hasCurrentAgreementVersions(versions: AgreementVersions) {
  return versions.termsVersion === currentAgreementVersions.termsVersion
    && versions.privacyVersion === currentAgreementVersions.privacyVersion;
}

ALTER TABLE users
  ADD COLUMN terms_version VARCHAR(20),
  ADD COLUMN privacy_version VARCHAR(20);

UPDATE users
SET terms_version = '2026-07-22',
  privacy_version = '2026-07-22'
WHERE terms_accepted_at IS NOT NULL
  AND privacy_accepted_at IS NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_terms_acceptance_complete CHECK (
    (terms_accepted_at IS NULL AND terms_version IS NULL)
    OR (terms_accepted_at IS NOT NULL AND terms_version IS NOT NULL)
  ),
  ADD CONSTRAINT users_privacy_acceptance_complete CHECK (
    (privacy_accepted_at IS NULL AND privacy_version IS NULL)
    OR (privacy_accepted_at IS NOT NULL AND privacy_version IS NOT NULL)
  );

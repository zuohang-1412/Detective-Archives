ALTER TABLE users
  ADD COLUMN terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN privacy_accepted_at TIMESTAMPTZ,
  ADD COLUMN deactivated_at TIMESTAMPTZ,
  ADD COLUMN deactivation_reason VARCHAR(200);

CREATE INDEX idx_users_deactivated
  ON users (deactivated_at)
  WHERE deactivated_at IS NOT NULL;

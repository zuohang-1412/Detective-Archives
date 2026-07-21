ALTER TABLE work_links
  ADD COLUMN last_status_code SMALLINT,
  ADD COLUMN last_check_ok BOOLEAN,
  ADD COLUMN last_check_error VARCHAR(300),
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0);

CREATE TABLE work_link_health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_link_id UUID NOT NULL REFERENCES work_links(id) ON DELETE CASCADE,
  status_code SMALLINT,
  is_ok BOOLEAN NOT NULL,
  response_time_ms INTEGER CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  final_url TEXT,
  error_code VARCHAR(80),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_link_health_checks_link_checked
  ON work_link_health_checks (work_link_id, checked_at DESC);

CREATE TABLE catalog_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key VARCHAR(100) NOT NULL UNIQUE,
  input_checksum CHAR(64) NOT NULL,
  schema_version SMALLINT NOT NULL,
  source_file VARCHAR(300) NOT NULL,
  status VARCHAR(20) NOT NULL,
  change_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ,
  CHECK (status IN ('PREVIEWED', 'APPLIED', 'FAILED', 'ROLLED_BACK'))
);

CREATE INDEX idx_catalog_import_batches_status_created
  ON catalog_import_batches (status, created_at DESC);

CREATE TYPE appeal_status AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE content_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appellant_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status appeal_status NOT NULL DEFAULT 'OPEN',
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  resolution_note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (target_type IN ('REVIEW', 'COMMENT')),
  CHECK (char_length(reason) BETWEEN 5 AND 500),
  CHECK (
    (status = 'OPEN' AND handled_by IS NULL AND handled_at IS NULL AND resolution_note IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED') AND handled_by IS NOT NULL AND handled_at IS NOT NULL AND resolution_note IS NOT NULL)
    OR
    (status = 'CANCELLED' AND handled_by IS NULL AND handled_at IS NOT NULL AND resolution_note IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_content_appeals_one_open_target
  ON content_appeals (target_type, target_id)
  WHERE status = 'OPEN';

CREATE INDEX idx_content_appeals_queue
  ON content_appeals (status, created_at, id);

CREATE INDEX idx_content_appeals_appellant
  ON content_appeals (appellant_id, created_at DESC);

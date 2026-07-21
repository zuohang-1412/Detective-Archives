ALTER TABLE detectives
  ADD COLUMN era VARCHAR(80);

CREATE TABLE detective_slug_redirects (
  old_slug VARCHAR(100) PRIMARY KEY,
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE INDEX idx_detective_slug_redirects_detective
  ON detective_slug_redirects (detective_id);

CREATE TABLE work_link_click_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_link_id UUID NOT NULL REFERENCES work_links(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  request_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_link_click_events_link_created
  ON work_link_click_events (work_link_id, created_at DESC);

CREATE TABLE work_link_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_link_id UUID NOT NULL REFERENCES work_links(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason_code VARCHAR(40) NOT NULL,
  description VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  resolution_note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (reason_code IN (
    'BROKEN', 'WRONG_DESTINATION', 'REGION_UNAVAILABLE', 'COPYRIGHT_CONCERN', 'OTHER'
  )),
  CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED'))
);

CREATE INDEX idx_work_link_feedback_queue
  ON work_link_feedback (status, created_at);

CREATE UNIQUE INDEX idx_work_link_feedback_one_open_per_user
  ON work_link_feedback (work_link_id, user_id, reason_code)
  WHERE status = 'OPEN' AND user_id IS NOT NULL;

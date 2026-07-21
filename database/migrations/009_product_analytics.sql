CREATE TABLE catalog_view_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_hash CHAR(64) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  target_id UUID,
  request_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (event_type IN (
    'DETECTIVE_LIST_VIEW',
    'DETECTIVE_DETAIL_VIEW',
    'WORK_LIST_VIEW',
    'WORK_DETAIL_VIEW'
  )),
  CHECK (
    (event_type IN ('DETECTIVE_LIST_VIEW', 'WORK_LIST_VIEW') AND target_id IS NULL)
    OR
    (event_type IN ('DETECTIVE_DETAIL_VIEW', 'WORK_DETAIL_VIEW') AND target_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_catalog_view_events_request
  ON catalog_view_events (request_id, event_type)
  WHERE request_id IS NOT NULL;

CREATE INDEX idx_catalog_view_events_metric_window
  ON catalog_view_events (event_type, created_at DESC, visitor_hash);

ALTER TABLE work_link_click_events
  ADD COLUMN visitor_hash CHAR(64);

CREATE INDEX idx_work_link_click_events_visitor_created
  ON work_link_click_events (visitor_hash, created_at DESC)
  WHERE visitor_hash IS NOT NULL;

CREATE TABLE user_activity_days (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date DATE NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_count INTEGER NOT NULL DEFAULT 1 CHECK (event_count > 0),
  PRIMARY KEY (user_id, activity_date)
);

CREATE INDEX idx_user_activity_days_retention
  ON user_activity_days (activity_date, user_id);

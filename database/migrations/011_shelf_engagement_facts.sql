CREATE TABLE shelf_engagement_facts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  first_added_at TIMESTAMPTZ NOT NULL,
  first_completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, work_id),
  CHECK (first_completed_at IS NULL OR first_completed_at >= first_added_at)
);

INSERT INTO shelf_engagement_facts (
  user_id, work_id, first_added_at, first_completed_at
)
SELECT user_id, work_id, created_at, completed_at
FROM shelf_items
ON CONFLICT (user_id, work_id) DO NOTHING;

CREATE INDEX idx_shelf_engagement_first_added
  ON shelf_engagement_facts (first_added_at, user_id);

CREATE INDEX idx_shelf_engagement_first_completed
  ON shelf_engagement_facts (first_completed_at, user_id, work_id)
  WHERE first_completed_at IS NOT NULL;

CREATE UNIQUE INDEX idx_reviews_one_active_per_type
  ON reviews (user_id, work_id, review_type)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_reports_one_open_per_target
  ON reports (reporter_id, target_type, target_id)
  WHERE status IN ('OPEN', 'PROCESSING');

ALTER TABLE reports
  ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('REVIEW', 'COMMENT'));

CREATE INDEX idx_reviews_user_updated
  ON reviews (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_comments_user_updated
  ON comments (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

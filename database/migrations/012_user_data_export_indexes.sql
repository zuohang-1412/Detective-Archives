CREATE INDEX idx_reviews_user_export
  ON reviews (user_id, created_at, id);

CREATE INDEX idx_comments_user_export
  ON comments (user_id, created_at, id);

CREATE INDEX idx_reports_reporter_export
  ON reports (reporter_id, created_at, id);

CREATE INDEX idx_work_link_feedback_user_export
  ON work_link_feedback (user_id, created_at, id)
  WHERE user_id IS NOT NULL;

CREATE INDEX idx_work_link_click_events_user_export
  ON work_link_click_events (user_id, created_at, id)
  WHERE user_id IS NOT NULL;

CREATE INDEX idx_moderation_records_target_export
  ON moderation_records (target_type, target_id, created_at, id);

CREATE INDEX idx_audit_logs_actor_export
  ON audit_logs (actor_id, created_at, id)
  WHERE actor_id IS NOT NULL;

ALTER TABLE work_links
  ADD COLUMN manual_review_status VARCHAR(20),
  ADD COLUMN manual_review_note VARCHAR(500),
  ADD COLUMN manual_review_evidence VARCHAR(500),
  ADD COLUMN manual_reviewed_at TIMESTAMPTZ,
  ADD COLUMN manual_reviewer_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT work_links_manual_review_status_check
    CHECK (
      manual_review_status IS NULL
      OR manual_review_status IN ('VERIFIED', 'REJECTED')
    ),
  ADD CONSTRAINT work_links_manual_review_fields_check
    CHECK (
      (
        manual_review_status IS NULL
        AND manual_review_note IS NULL
        AND manual_review_evidence IS NULL
        AND manual_reviewed_at IS NULL
        AND manual_reviewer_id IS NULL
      )
      OR (
        manual_review_status IS NOT NULL
        AND manual_review_note IS NOT NULL
        AND manual_review_evidence IS NOT NULL
        AND manual_reviewed_at IS NOT NULL
        AND manual_reviewer_id IS NOT NULL
      )
    );

CREATE INDEX idx_work_links_manual_review_queue
  ON work_links (is_active, last_check_ok, last_checked_at, manual_reviewed_at)
  WHERE is_active = TRUE;

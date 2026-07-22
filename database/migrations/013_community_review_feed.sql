CREATE INDEX idx_reviews_public_feed
  ON reviews (published_at DESC, created_at DESC, id)
  WHERE status = 'PUBLISHED' AND deleted_at IS NULL;

CREATE INDEX idx_reviews_public_feed_type
  ON reviews (review_type, published_at DESC, created_at DESC, id)
  WHERE status = 'PUBLISHED' AND deleted_at IS NULL;

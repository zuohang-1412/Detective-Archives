ALTER TABLE detectives
  ADD COLUMN IF NOT EXISTS catalog_category VARCHAR(40);

ALTER TABLE detectives
  DROP CONSTRAINT IF EXISTS detectives_catalog_category_check;

ALTER TABLE detectives
  ADD CONSTRAINT detectives_catalog_category_check
  CHECK (
    catalog_category IS NULL
    OR catalog_category IN (
      'WORLD_LITERATURE',
      'SCREEN_DETECTIVES',
      'JAPANESE_POPULAR',
      'CHINESE_LITERATURE',
      'HISTORICAL_JUSTICE'
    )
  );

CREATE INDEX IF NOT EXISTS idx_detectives_directory_category
  ON detectives (catalog_collection, catalog_category, status, catalog_id);

CREATE TABLE IF NOT EXISTS picture_book_entry_aliases (
  entry_id VARCHAR(20) NOT NULL REFERENCES picture_book_entries(id) ON DELETE CASCADE,
  alias VARCHAR(200) NOT NULL,
  PRIMARY KEY (entry_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_picture_book_entry_aliases_alias
  ON picture_book_entry_aliases (alias);

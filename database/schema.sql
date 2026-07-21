CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('USER', 'EDITOR', 'MODERATOR', 'ADMIN');
CREATE TYPE content_status AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'HIDDEN', 'ARCHIVED');
CREATE TYPE media_type AS ENUM ('NOVEL', 'SHORT_STORY', 'COMIC', 'FILM', 'SERIES', 'ANIMATION', 'GAME', 'OTHER');
CREATE TYPE progress_status AS ENUM ('WISHLIST', 'IN_PROGRESS', 'COMPLETED', 'PAUSED', 'DROPPED');
CREATE TYPE review_type AS ENUM ('SHORT', 'LONG');
CREATE TYPE link_type AS ENUM ('PUBLISHER', 'BOOKSTORE', 'LIBRARY', 'STREAMING', 'OFFICIAL_SITE', 'OTHER');
CREATE TYPE report_status AS ENUM ('OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED');
CREATE TYPE moderation_action AS ENUM ('PUBLISH', 'HIDE', 'RESTORE', 'REJECT', 'WARN', 'SUSPEND_USER');
CREATE TYPE ai_task_status AS ENUM ('DRAFT', 'QUEUED', 'GENERATING', 'SUCCEEDED', 'FAILED', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED');
CREATE TYPE picture_book_edition AS ENUM ('STANDARD', 'SPECIAL');
CREATE TYPE verification_status AS ENUM ('MISSING', 'SOURCE_CAPTURED', 'PRIMARY_SOURCE_CONFIRMED');
CREATE TYPE detective_subject_kind AS ENUM ('FICTIONAL', 'HISTORICAL');
CREATE TYPE catalog_collection AS ENUM ('CORE', 'ARCHIVE_EXTENSION', 'HISTORICAL_CASES');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(60) NOT NULL,
  avatar_url TEXT,
  bio VARCHAR(300),
  role user_role NOT NULL DEFAULT 'USER',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  suspended_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL,
  provider_subject VARCHAR(160) NOT NULL,
  union_subject VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_zh VARCHAR(120) NOT NULL UNIQUE,
  name_original VARCHAR(160),
  country VARCHAR(60),
  summary TEXT,
  status content_status NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE detectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id VARCHAR(20) UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  name_zh VARCHAR(120) NOT NULL,
  name_original VARCHAR(160),
  name_en VARCHAR(160),
  country VARCHAR(60),
  subject_kind detective_subject_kind NOT NULL DEFAULT 'FICTIONAL',
  catalog_collection catalog_collection NOT NULL DEFAULT 'CORE',
  media_types VARCHAR(30)[] NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  source_note TEXT,
  verification verification_status NOT NULL DEFAULT 'SOURCE_CAPTURED',
  status content_status NOT NULL DEFAULT 'DRAFT',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE detective_creators (
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  relation_type VARCHAR(30) NOT NULL DEFAULT 'CREATOR',
  PRIMARY KEY (detective_id, creator_id, relation_type)
);

CREATE TABLE detective_tags (
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  tag VARCHAR(40) NOT NULL,
  PRIMARY KEY (detective_id, tag)
);

CREATE TABLE detective_aliases (
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  alias VARCHAR(160) NOT NULL,
  PRIMARY KEY (detective_id, alias)
);

CREATE TABLE detective_sources (
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  source_id VARCHAR(100) NOT NULL,
  source_label VARCHAR(200) NOT NULL,
  source_url TEXT NOT NULL,
  source_quality VARCHAR(30) NOT NULL,
  verification verification_status NOT NULL DEFAULT 'SOURCE_CAPTURED',
  PRIMARY KEY (detective_id, source_id)
);

CREATE TABLE detective_featured_works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  work_id UUID,
  source_label VARCHAR(240) NOT NULL,
  display_order SMALLINT NOT NULL DEFAULT 0,
  UNIQUE (detective_id, source_label)
);

CREATE TABLE picture_book_sources (
  id VARCHAR(100) PRIMARY KEY,
  label VARCHAR(160) NOT NULL,
  url TEXT NOT NULL,
  source_quality VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE picture_book_entries (
  id VARCHAR(20) PRIMARY KEY,
  volume_no SMALLINT NOT NULL CHECK (volume_no > 0),
  edition picture_book_edition NOT NULL DEFAULT 'STANDARD',
  detective_id UUID REFERENCES detectives(id) ON DELETE SET NULL,
  name_zh VARCHAR(160) NOT NULL,
  name_original VARCHAR(200),
  name_en VARCHAR(200),
  release_date DATE,
  identity_verification verification_status NOT NULL DEFAULT 'SOURCE_CAPTURED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (volume_no, edition)
);

CREATE TABLE picture_book_entry_sources (
  entry_id VARCHAR(20) NOT NULL REFERENCES picture_book_entries(id) ON DELETE CASCADE,
  source_id VARCHAR(100) NOT NULL REFERENCES picture_book_sources(id) ON DELETE RESTRICT,
  source_url TEXT NOT NULL,
  PRIMARY KEY (entry_id, source_id, source_url)
);

CREATE TABLE works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(120) NOT NULL UNIQUE,
  title_zh VARCHAR(200) NOT NULL,
  title_original VARCHAR(240),
  media_type media_type NOT NULL,
  release_year SMALLINT CHECK (release_year BETWEEN 1000 AND 2200),
  summary TEXT,
  cover_url TEXT,
  source_note TEXT,
  status content_status NOT NULL DEFAULT 'DRAFT',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE detective_featured_works
  ADD CONSTRAINT detective_featured_works_work_id_fkey
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL;

CREATE TABLE picture_book_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id VARCHAR(20) NOT NULL REFERENCES picture_book_entries(id) ON DELETE CASCADE,
  work_id UUID REFERENCES works(id) ON DELETE SET NULL,
  source_label VARCHAR(240) NOT NULL,
  display_order SMALLINT NOT NULL DEFAULT 0,
  verification verification_status NOT NULL DEFAULT 'SOURCE_CAPTURED',
  UNIQUE (entry_id, source_label)
);

CREATE TABLE work_creators (
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  credit_type VARCHAR(30) NOT NULL,
  PRIMARY KEY (work_id, creator_id, credit_type)
);

CREATE TABLE detective_works (
  detective_id UUID NOT NULL REFERENCES detectives(id) ON DELETE CASCADE,
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  is_recommended BOOLEAN NOT NULL DEFAULT FALSE,
  recommendation_order SMALLINT,
  PRIMARY KEY (detective_id, work_id)
);

CREATE TABLE work_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  link_type link_type NOT NULL,
  provider_name VARCHAR(100) NOT NULL,
  url TEXT NOT NULL,
  region VARCHAR(30) NOT NULL DEFAULT 'CN',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_id, provider_name, url)
);

CREATE TABLE shelf_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  status progress_status NOT NULL,
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, work_id)
);

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  review_type review_type NOT NULL,
  title VARCHAR(160),
  body TEXT NOT NULL,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  contains_spoiler BOOLEAN NOT NULL DEFAULT FALSE,
  status content_status NOT NULL DEFAULT 'PENDING_REVIEW',
  published_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (review_type = 'SHORT' OR title IS NOT NULL)
);

CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parent_id UUID REFERENCES comments(id) ON DELETE SET NULL,
  body VARCHAR(1000) NOT NULL,
  contains_spoiler BOOLEAN NOT NULL DEFAULT FALSE,
  status content_status NOT NULL DEFAULT 'PENDING_REVIEW',
  published_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE review_likes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, review_id)
);

CREATE TABLE comment_likes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, comment_id)
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  reason_code VARCHAR(40) NOT NULL,
  description VARCHAR(500),
  status report_status NOT NULL DEFAULT 'OPEN',
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  resolution_note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE moderation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moderator_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  action moderation_action NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ai_creation_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title VARCHAR(160) NOT NULL,
  prompt_summary TEXT NOT NULL,
  model_provider VARCHAR(60),
  model_name VARCHAR(100),
  status ai_task_status NOT NULL DEFAULT 'DRAFT',
  output_url TEXT,
  error_code VARCHAR(80),
  cost_minor_units INTEGER CHECK (cost_minor_units >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID,
  request_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_detectives_status_published ON detectives (status, published_at DESC);
CREATE INDEX idx_detectives_collection ON detectives (catalog_collection, status, published_at DESC);
CREATE INDEX idx_works_status_type ON works (status, media_type, published_at DESC);
CREATE INDEX idx_picture_book_volume ON picture_book_entries (volume_no, edition);
CREATE INDEX idx_work_links_active ON work_links (work_id, is_active);
CREATE INDEX idx_shelf_user_status ON shelf_items (user_id, status, updated_at DESC);
CREATE INDEX idx_reviews_work_public ON reviews (work_id, status, published_at DESC);
CREATE INDEX idx_comments_review_public ON comments (review_id, status, published_at ASC);
CREATE INDEX idx_reports_queue ON reports (status, created_at ASC);
CREATE INDEX idx_ai_tasks_user_status ON ai_creation_tasks (user_id, status, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource_type, resource_id, created_at DESC);

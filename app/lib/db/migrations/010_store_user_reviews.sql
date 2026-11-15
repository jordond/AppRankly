-- Migration 010: User reviews read from the store APIs (App Store Connect, Google Play)

-- Google Play only returns reviews from the last 7 days, so each poll is stored here and
-- history accumulates. Separate from the scraper-based review tables.
CREATE TABLE IF NOT EXISTS store_user_reviews (
  platform TEXT NOT NULL,          -- 'apple' | 'google'
  app_id TEXT NOT NULL,            -- Apple numeric app ID or Android package name
  review_id TEXT NOT NULL,
  rating INTEGER,
  title TEXT,
  body TEXT,
  author TEXT,
  territory TEXT,                  -- Apple territory code or Play reviewer language
  version TEXT,                    -- app version the review was written for, when known
  created_at TEXT,                 -- written or last edited by the user (ISO 8601)
  reply_body TEXT,
  reply_at TEXT,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (platform, review_id)
);

CREATE INDEX IF NOT EXISTS idx_store_user_reviews_app ON store_user_reviews(platform, app_id, created_at DESC);

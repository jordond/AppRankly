-- Migration 009: Store status (review and release state per app, per store)

-- Latest fetched status per app and kind. Doubles as the TTL cache for the store APIs.
CREATE TABLE IF NOT EXISTS store_status_snapshot (
  platform TEXT NOT NULL,          -- 'apple' | 'google'
  app_id TEXT NOT NULL,            -- Apple numeric app ID or Android package name
  kind TEXT NOT NULL,              -- 'release' today; later 'builds', 'vitals'
  payload_json TEXT,               -- last successful result, kept when a later fetch fails
  fetched_at TEXT,                 -- when payload_json was fetched (ISO 8601)
  error_json TEXT,                 -- last fetch error, NULL after a success
  checked_at TEXT NOT NULL,        -- last attempt, successful or not (ISO 8601)
  PRIMARY KEY (platform, app_id, kind)
);

-- State transitions detected by the poller; one row per change, used to notify once.
CREATE TABLE IF NOT EXISTS store_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  app_id TEXT NOT NULL,
  app_name TEXT,
  subject TEXT NOT NULL,           -- what changed, e.g. 'version 1.3.0'
  from_state TEXT,
  to_state TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_store_status_events_app ON store_status_events(platform, app_id, detected_at DESC);

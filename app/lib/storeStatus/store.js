/**
 * Snapshot storage for store status. SQLite when available, otherwise an in-memory map
 * (Node < 22.5 has no node:sqlite), so the page works either way.
 */
const { db } = require('../db');

const memory = new Map();
const keyOf = (platform, appId, kind) => `${platform}\u0000${appId}\u0000${kind}`;

const parse = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

function getSnapshot(platform, appId, kind) {
  if (!db) return memory.get(keyOf(platform, appId, kind)) || null;
  const row = db.prepare(
    'SELECT payload_json, fetched_at, error_json, checked_at FROM store_status_snapshot WHERE platform = ? AND app_id = ? AND kind = ?'
  ).get(platform, String(appId), kind);
  if (!row) return null;
  return {
    payload: parse(row.payload_json),
    fetchedAt: row.fetched_at || null,
    error: parse(row.error_json),
    checkedAt: row.checked_at
  };
}

function write(platform, appId, kind, snapshot) {
  if (!db) {
    memory.set(keyOf(platform, appId, kind), snapshot);
    return snapshot;
  }
  db.prepare(`
    INSERT INTO store_status_snapshot (platform, app_id, kind, payload_json, fetched_at, error_json, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, app_id, kind) DO UPDATE SET
      payload_json = excluded.payload_json,
      fetched_at = excluded.fetched_at,
      error_json = excluded.error_json,
      checked_at = excluded.checked_at
  `).run(
    platform, String(appId), kind,
    snapshot.payload ? JSON.stringify(snapshot.payload) : null,
    snapshot.fetchedAt,
    snapshot.error ? JSON.stringify(snapshot.error) : null,
    snapshot.checkedAt
  );
  return snapshot;
}

function saveSuccess(platform, appId, kind, payload, now = new Date()) {
  const iso = now.toISOString();
  return write(platform, appId, kind, { payload, fetchedAt: iso, error: null, checkedAt: iso });
}

/** A failed fetch keeps the last good payload and records the error next to it. */
function saveFailure(platform, appId, kind, error, now = new Date()) {
  const previous = getSnapshot(platform, appId, kind);
  return write(platform, appId, kind, {
    payload: previous?.payload || null,
    fetchedAt: previous?.fetchedAt || null,
    error,
    checkedAt: now.toISOString()
  });
}

function isFresh(snapshot, ttlMs, now = new Date()) {
  if (!snapshot || !snapshot.checkedAt) return false;
  const age = now.getTime() - Date.parse(snapshot.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

module.exports = { getSnapshot, saveSuccess, saveFailure, isFresh };

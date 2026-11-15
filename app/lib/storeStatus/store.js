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

// --- Transition events -------------------------------------------------------

const memoryEvents = [];
let memoryEventId = 0;

/**
 * Store detected transitions. An event flagged `silent` is kept for the history list but
 * is stored as already announced, so it never produces an alert.
 */
function recordEvents(platform, appId, appName, events = [], now = new Date()) {
  if (events.length === 0) return;
  const detectedAt = now.toISOString();
  if (!db) {
    events.forEach(e => memoryEvents.push({
      id: ++memoryEventId, platform, app_id: String(appId), app_name: appName || null,
      subject: e.subject, from_state: e.fromState || null, to_state: e.toState, detected_at: detectedAt,
      notified_at: e.silent ? detectedAt : null
    }));
    return;
  }
  const insert = db.prepare(`
    INSERT INTO store_status_events (platform, app_id, app_name, subject, from_state, to_state, detected_at, notified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  events.forEach(e => insert.run(
    platform, String(appId), appName || null, e.subject, e.fromState || null, e.toState, detectedAt, e.silent ? detectedAt : null
  ));
}

/** Events not yet announced, oldest first. */
function getPendingEvents() {
  if (!db) return memoryEvents.filter(e => !e.notified_at);
  return db.prepare('SELECT * FROM store_status_events WHERE notified_at IS NULL ORDER BY id ASC').all();
}

function markEventsNotified(ids = [], now = new Date()) {
  if (ids.length === 0) return;
  const iso = now.toISOString();
  if (!db) {
    memoryEvents.forEach(e => { if (ids.includes(e.id)) e.notified_at = iso; });
    return;
  }
  const update = db.prepare('UPDATE store_status_events SET notified_at = ? WHERE id = ?');
  ids.forEach(id => update.run(iso, id));
}

function getRecentEvents(limit = 20) {
  if (!db) return memoryEvents.slice(-limit).reverse();
  return db.prepare('SELECT * FROM store_status_events ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  getSnapshot, saveSuccess, saveFailure, isFresh,
  recordEvents, getPendingEvents, markEventsNotified, getRecentEvents
};

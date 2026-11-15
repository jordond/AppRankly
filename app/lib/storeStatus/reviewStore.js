/**
 * User reviews read from the store APIs. SQLite when available, otherwise in memory.
 */
const { db } = require('../db');

const memory = new Map(); // "<platform>\0<reviewId>" -> row

const toRow = (platform, appId, r, firstSeenAt) => ({
  platform,
  app_id: String(appId),
  review_id: String(r.reviewId),
  rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : null,
  title: r.title || null,
  body: r.body || null,
  author: r.author || null,
  territory: r.territory || null,
  version: r.version || null,
  created_at: r.createdAt || null,
  reply_body: r.replyBody || null,
  reply_at: r.replyAt || null,
  first_seen_at: firstSeenAt
});

/** Insert new reviews and update edited ones; `first_seen_at` is kept. */
function upsertReviews(platform, appId, reviews = [], now = new Date()) {
  const usable = reviews.filter(r => r && r.reviewId);
  if (usable.length === 0) return 0;
  const seenAt = now.toISOString();
  if (!db) {
    usable.forEach(r => {
      const key = `${platform}\u0000${r.reviewId}`;
      const existing = memory.get(key);
      memory.set(key, toRow(platform, appId, r, existing?.first_seen_at || seenAt));
    });
    return usable.length;
  }
  const upsert = db.prepare(`
    INSERT INTO store_user_reviews
      (platform, app_id, review_id, rating, title, body, author, territory, version, created_at, reply_body, reply_at, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, review_id) DO UPDATE SET
      rating = excluded.rating, title = excluded.title, body = excluded.body, author = excluded.author,
      territory = excluded.territory, version = excluded.version, created_at = excluded.created_at,
      reply_body = excluded.reply_body, reply_at = excluded.reply_at
  `);
  usable.forEach(r => {
    const row = toRow(platform, appId, r, seenAt);
    upsert.run(row.platform, row.app_id, row.review_id, row.rating, row.title, row.body, row.author,
      row.territory, row.version, row.created_at, row.reply_body, row.reply_at, row.first_seen_at);
  });
  return usable.length;
}

const toReview = (row) => ({
  reviewId: row.review_id,
  rating: row.rating,
  title: row.title,
  body: row.body,
  author: row.author,
  territory: row.territory,
  version: row.version,
  createdAt: row.created_at,
  replied: Boolean(row.reply_body),
  replyAt: row.reply_at
});

/** Stored reviews of one app: how many, their average rating, and the newest few. */
function getReviewSummary(platform, appId, limit = 3) {
  const id = String(appId);
  if (!db) {
    const rows = Array.from(memory.values())
      .filter(r => r.platform === platform && r.app_id === id)
      .sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
    const rated = rows.filter(r => r.rating != null);
    return {
      total: rows.length,
      average: rated.length > 0 ? rated.reduce((sum, r) => sum + r.rating, 0) / rated.length : null,
      recent: rows.slice(0, limit).map(toReview)
    };
  }
  const stats = db.prepare(
    'SELECT COUNT(*) AS total, AVG(rating) AS average FROM store_user_reviews WHERE platform = ? AND app_id = ?'
  ).get(platform, id);
  const recent = db.prepare(
    'SELECT * FROM store_user_reviews WHERE platform = ? AND app_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(platform, id, limit);
  return { total: Number(stats?.total) || 0, average: stats?.average ?? null, recent: recent.map(toReview) };
}

module.exports = { upsertReviews, getReviewSummary };

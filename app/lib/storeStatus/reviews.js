/**
 * Read-only user reviews from both store APIs, normalized to one shape:
 * { reviewId, rating, title, body, author, territory, version, createdAt, replyBody, replyAt }
 */
const { PUBLISHER_BASE } = require('./googleStatus');

const APPLE_PAGE_SIZE = 50;
const GOOGLE_PAGE_SIZE = 100;
// Play allows 200 review GETs per hour; three pages per app per fetch stays far below it.
const GOOGLE_MAX_PAGES = 3;
const MAX_TEXT = 4000;

const clip = (text) => (typeof text === 'string' && text ? text.slice(0, MAX_TEXT) : null);

function parseAppleReviews(response) {
  const includedById = new Map((response?.included || []).map(i => [`${i.type}:${i.id}`, i]));
  return (response?.data || []).map(item => {
    const a = item.attributes || {};
    const ref = item.relationships?.response?.data;
    const reply = ref ? includedById.get(`${ref.type}:${ref.id}`) : null;
    return {
      reviewId: item.id,
      rating: a.rating,
      title: clip(a.title),
      body: clip(a.body),
      author: clip(a.reviewerNickname),
      territory: a.territory || null,
      version: null,
      createdAt: a.createdDate || null,
      replyBody: clip(reply?.attributes?.responseBody),
      replyAt: reply?.attributes?.lastModifiedDate || null
    };
  });
}

/** The newest page of reviews, newest first. One GET per app. */
async function fetchAppleReviews(client, appleAppId) {
  const response = await client.get(`/v1/apps/${encodeURIComponent(String(appleAppId))}/customerReviews`, {
    sort: '-createdDate',
    limit: APPLE_PAGE_SIZE,
    include: 'response',
    'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory,response',
    'fields[customerReviewResponses]': 'responseBody,lastModifiedDate,state'
  });
  return parseAppleReviews(response);
}

// Play timestamps are { seconds: "1700000000", nanos: 0 }.
const fromPlayTimestamp = (ts) => {
  const seconds = Number(ts?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
};

function parseGoogleReviews(response) {
  return (response && Array.isArray(response.reviews) ? response.reviews : []).map(item => {
    const comments = Array.isArray(item.comments) ? item.comments : [];
    const user = comments.find(c => c.userComment)?.userComment || {};
    const developer = comments.find(c => c.developerComment)?.developerComment || null;
    // Title and body arrive in one field, separated by a tab; most reviews have no title.
    const text = typeof user.text === 'string' ? user.text : '';
    const tab = text.indexOf('\t');
    const title = tab > 0 ? text.slice(0, tab).trim() : '';
    const body = (tab >= 0 ? text.slice(tab + 1) : text).trim();
    return {
      reviewId: item.reviewId,
      rating: user.starRating,
      title: clip(title),
      body: clip(body),
      author: clip(item.authorName),
      territory: user.reviewerLanguage || null,
      version: user.appVersionName || (user.appVersionCode != null ? String(user.appVersionCode) : null),
      createdAt: fromPlayTimestamp(user.lastModified),
      replyBody: clip(developer?.text),
      replyAt: fromPlayTimestamp(developer?.lastModified)
    };
  });
}

/** Reviews written or edited in the last 7 days (all the API offers). */
async function fetchGoogleReviews(client, packageName) {
  const url = `${PUBLISHER_BASE}${encodeURIComponent(String(packageName))}/reviews`;
  const reviews = [];
  let token = null;
  for (let page = 0; page < GOOGLE_MAX_PAGES; page++) {
    const body = await client.get(url, token ? { maxResults: GOOGLE_PAGE_SIZE, token } : { maxResults: GOOGLE_PAGE_SIZE });
    reviews.push(...parseGoogleReviews(body));
    token = body?.tokenPagination?.nextPageToken || null;
    if (!token) break;
  }
  return reviews;
}

module.exports = { parseAppleReviews, fetchAppleReviews, parseGoogleReviews, fetchGoogleReviews, GOOGLE_MAX_PAGES };

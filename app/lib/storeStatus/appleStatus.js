/**
 * Read-only App Store Connect status: live version, in-flight version, review
 * submission and phased release for one app.
 */
const axios = require('axios');
const { STATE, normalizeAppleVersionState } = require('./states');

const API_BASE = 'https://api.appstoreconnect.apple.com';

// Apple's published phased-release schedule: share of users with automatic updates, by day.
const PHASED_PERCENT_BY_DAY = [1, 2, 5, 10, 20, 50, 100];

/**
 * The only way this feature talks to App Store Connect. It can issue GET and nothing
 * else, whatever role the configured key has.
 * @param {() => string} getToken returns a signed JWT
 */
function createAppleClient(getToken) {
  return {
    async get(path, params = {}) {
      if (typeof path !== 'string' || !path.startsWith('/v1/')) {
        throw new Error('Apple status client only reads /v1/ paths');
      }
      const res = await axios.request({
        method: 'GET',
        url: `${API_BASE}${path}`,
        params,
        headers: { Authorization: `Bearer ${getToken()}` },
        timeout: 15000
      });
      return res.data;
    }
  };
}

function phasedReleaseSummary(attrs) {
  if (!attrs) return null;
  const state = attrs.phasedReleaseState || null;
  const day = Number(attrs.currentDayNumber) || 0;
  let percent = null;
  // A release finished early reports COMPLETE with a day below 7, so the state decides.
  if (state === 'COMPLETE') percent = 100;
  else if ((state === 'ACTIVE' || state === 'PAUSED') && day >= 1) {
    percent = PHASED_PERCENT_BY_DAY[Math.min(day, PHASED_PERCENT_BY_DAY.length) - 1];
  } else if (state === 'INACTIVE') percent = 0;
  return { state, day, percent, startDate: attrs.startDate || null };
}

function toVersion(item, includedById) {
  const a = item.attributes || {};
  const phasedRef = item.relationships?.appStoreVersionPhasedRelease?.data;
  const buildRef = item.relationships?.build?.data;
  const phased = phasedRef ? includedById.get(`${phasedRef.type}:${phasedRef.id}`) : null;
  const build = buildRef ? includedById.get(`${buildRef.type}:${buildRef.id}`) : null;
  return {
    id: item.id,
    version: a.versionString || null,
    platform: a.platform || null,
    rawState: a.appVersionState || null,
    state: normalizeAppleVersionState(a.appVersionState),
    releaseType: a.releaseType || null,
    earliestReleaseDate: a.earliestReleaseDate || null,
    createdDate: a.createdDate || null,
    buildNumber: build?.attributes?.version || null,
    phasedRelease: phasedReleaseSummary(phased?.attributes)
  };
}

/**
 * Pick the live and the in-flight version for each platform from an unordered list.
 * Superseded versions keep READY_FOR_DISTRIBUTION, so "live" is the newest one in that
 * state; "in flight" is the newest version created after it that is not live.
 */
function summarizeVersions(response) {
  const includedById = new Map((response?.included || []).map(i => [`${i.type}:${i.id}`, i]));
  const versions = (response?.data || [])
    .map(item => toVersion(item, includedById))
    .sort((x, y) => String(y.createdDate || '').localeCompare(String(x.createdDate || '')));

  const byPlatform = new Map();
  versions.forEach(v => {
    const key = v.platform || 'UNKNOWN';
    if (!byPlatform.has(key)) byPlatform.set(key, []);
    byPlatform.get(key).push(v);
  });

  return Array.from(byPlatform, ([platform, list]) => {
    const liveIndex = list.findIndex(v => v.state === STATE.LIVE);
    const live = liveIndex >= 0 ? list[liveIndex] : null;
    const newer = liveIndex >= 0 ? list.slice(0, liveIndex) : list;
    const inFlight = newer.find(v => v.state !== STATE.LIVE && v.state !== STATE.SUPERSEDED) || null;
    return { platform, live, inFlight };
  });
}

function summarizeReviewSubmissions(response) {
  const items = (response?.data || [])
    .map(item => ({
      state: item.attributes?.state || null,
      platform: item.attributes?.platform || null,
      submittedDate: item.attributes?.submittedDate || null
    }))
    .sort((x, y) => String(y.submittedDate || '').localeCompare(String(x.submittedDate || '')));
  // An open submission matters more than the newest finished one.
  const open = items.find(i => i.state && i.state !== 'COMPLETE');
  const latest = open || items[0] || null;
  return latest ? { ...latest, needsAttention: latest.state === 'UNRESOLVED_ISSUES' } : null;
}

/** Two GET requests per app. */
async function fetchAppleAppStatus(client, appleAppId) {
  const id = encodeURIComponent(String(appleAppId));
  const [versions, submissions] = await Promise.all([
    client.get(`/v1/apps/${id}/appStoreVersions`, {
      include: 'appStoreVersionPhasedRelease,build',
      'fields[appStoreVersions]': 'versionString,appVersionState,platform,createdDate,releaseType,earliestReleaseDate,appStoreVersionPhasedRelease,build',
      'fields[appStoreVersionPhasedReleases]': 'phasedReleaseState,currentDayNumber,startDate',
      'fields[builds]': 'version',
      limit: 20
    }),
    client.get('/v1/reviewSubmissions', {
      'filter[app]': String(appleAppId),
      'fields[reviewSubmissions]': 'state,submittedDate,platform',
      limit: 10
    })
  ]);
  return {
    platforms: summarizeVersions(versions),
    reviewSubmission: summarizeReviewSubmissions(submissions)
  };
}

module.exports = {
  PHASED_PERCENT_BY_DAY,
  createAppleClient,
  phasedReleaseSummary,
  summarizeVersions,
  summarizeReviewSubmissions,
  fetchAppleAppStatus
};

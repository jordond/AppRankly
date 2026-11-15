/**
 * Read-only Google Play status: the releases on each track of one app, with their review
 * and publish state. Uses the edit-less `applications.tracks.releases.list` call, so no
 * edit is ever opened.
 */
const axios = require('axios');
const { STATE, normalizeGoogleReleaseState, stripGoogleStatePrefix } = require('./states');

const PUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const REPORTING_BASE = 'https://playdeveloperreporting.googleapis.com/v1beta1/apps';
const READ_PREFIXES = [PUBLISHER_BASE, REPORTING_BASE];

// The built-in track names (`qa` is not one on this endpoint: 404).
const BUILT_IN_TRACKS = ['production', 'beta', 'alpha', 'internal'];
// Each track costs one call per app against a small quota, so only production is read
// unless `storeStatus.google.tracks` asks for more.
const DEFAULT_TRACKS = ['production'];

/**
 * The only way the release-state code talks to Google Play. It can issue GET and nothing
 * else, and only against the two Play API hosts.
 * @param {() => Promise<string>} getToken resolves to an access token
 */
function createGoogleClient(getToken) {
  return {
    async get(url, params = {}) {
      if (typeof url !== 'string' || !READ_PREFIXES.some(prefix => url.startsWith(prefix))) {
        throw new Error('Google status client only reads the Play Developer APIs');
      }
      const token = await getToken();
      const res = await axios.request({
        method: 'GET',
        url,
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000
      });
      return res.data;
    }
  };
}

/** Track names to read: `storeStatus.google.tracks` when it is a usable list, else the defaults. */
function getTracks(config = {}) {
  const configured = config.storeStatus?.google?.tracks;
  if (!Array.isArray(configured)) return DEFAULT_TRACKS;
  const names = configured
    .filter(name => typeof name === 'string' && name.trim() && name.length <= 100)
    .map(name => name.trim());
  return names.length > 0 ? Array.from(new Set(names)) : DEFAULT_TRACKS;
}

function toRelease(item) {
  const versionCodes = (item?.activeArtifacts || [])
    .map(a => Number(a?.versionCode))
    .filter(Number.isFinite)
    .sort((x, y) => y - x);
  const name = typeof item?.releaseName === 'string' && item.releaseName.trim() ? item.releaseName.trim() : null;
  // Play's default release name is "<code> (<version>)"; do not repeat the code next to it.
  const nameHasCode = name && versionCodes.some(code => name.startsWith(`${code} (`) || name.endsWith(`(${code})`));
  return {
    version: name,
    versionCodes,
    buildNumber: versionCodes.length > 0 && !nameHasCode ? versionCodes.join(', ') : null,
    rawState: stripGoogleStatePrefix(item?.releaseLifecycleState),
    state: normalizeGoogleReleaseState(item?.releaseLifecycleState)
  };
}

const newestFirst = (x, y) => (y.versionCodes[0] || 0) - (x.versionCodes[0] || 0);

/**
 * Pick the live and the in-flight release of one track. The API does not order releases
 * and a staged rollout leaves two published ones, so the highest version code wins.
 * @param {string} track
 * @param {Object|string|null} response body of releases.list; empty for a track with no releases
 */
function summarizeTrack(track, response) {
  const releases = (response && Array.isArray(response.releases) ? response.releases : []).map(toRelease);
  const published = releases.filter(r => r.state === STATE.LIVE).sort(newestFirst);
  const pending = releases.filter(r => r.state !== STATE.LIVE).sort(newestFirst);
  const live = published[0] || null;
  // A pending release older than the live one is a leftover, not something on its way out.
  const inFlight = pending.find(r => !live || r.versionCodes.length === 0 || r.versionCodes[0] > live.versionCodes[0]) || null;
  return { track, live, inFlight, publishedCount: published.length };
}

const isTrackNotFound = (err) =>
  err?.response?.status === 404 && /track not found/i.test(String(err.response.data?.error?.message || ''));

/** One GET per track. Tracks the app does not have, and tracks with no releases, are left out. */
async function fetchGoogleAppStatus(client, packageName, tracks = DEFAULT_TRACKS) {
  const pkg = encodeURIComponent(String(packageName));
  const results = await Promise.all(tracks.map(async (track) => {
    try {
      const body = await client.get(`${PUBLISHER_BASE}${pkg}/tracks/${encodeURIComponent(track)}/releases`);
      return summarizeTrack(track, body);
    } catch (err) {
      if (isTrackNotFound(err)) return null;
      throw err;
    }
  }));
  return { tracks: results.filter(t => t && (t.live || t.inFlight)) };
}

module.exports = {
  PUBLISHER_BASE,
  REPORTING_BASE,
  BUILT_IN_TRACKS,
  DEFAULT_TRACKS,
  createGoogleClient,
  getTracks,
  summarizeTrack,
  fetchGoogleAppStatus
};

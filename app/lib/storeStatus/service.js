/**
 * Store status for the app list: serves from the snapshot cache and refetches from the
 * store APIs when a snapshot is older than the TTL.
 */
const { buildAppleViewer } = require('../viewerFactory');
const { createAppleClient, fetchAppleAppStatus } = require('./appleStatus');
const { createGoogleClient, fetchGoogleAppStatus, getTracks } = require('./googleStatus');
const { loadGoogleCredentials, getGoogleTokenProvider } = require('./googleAuth');
const { classifyAppleError, classifyGoogleError } = require('./errors');
const { diffAppleStatus, diffGoogleStatus } = require('./changes');
const store = require('./store');

const KIND_RELEASE = 'release';
const DEFAULT_POLL_MINUTES = 15;

function getTtlMs(config = {}) {
  const minutes = Number(config.storeStatus?.pollMinutes);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_POLL_MINUTES) * 60 * 1000;
}

function isAppleConfigured(config = {}) {
  return Boolean(config.keyFilePath_apple && config.appleIssuerId && config.appleKeyId);
}

/** @returns {{ client: Object|null, error: Object|null }} */
function getAppleClient(config) {
  if (!isAppleConfigured(config)) {
    return { client: null, error: classifyAppleError({ code: 'APPLE_NOT_CONFIGURED' }) };
  }
  try {
    const viewer = buildAppleViewer(config);
    return { client: createAppleClient(() => viewer.generateToken()), error: null };
  } catch {
    // Key file missing or unreadable. The underlying message can contain a file path.
    return { client: null, error: classifyAppleError({ code: 'APPLE_NOT_CONFIGURED' }) };
  }
}

/** @returns {{ client: Object|null, error: Object|null }} */
function getGoogleClient(config) {
  const credentials = loadGoogleCredentials(config);
  if (!credentials) return { client: null, error: classifyGoogleError({ code: 'GOOGLE_NOT_CONFIGURED' }) };
  return { client: createGoogleClient(getGoogleTokenProvider(credentials)), error: null };
}

/**
 * Tracks whose changes produce an alert: `storeStatus.google.notifyTracks`, or every
 * track except `internal`, where each CI upload publishes at once and would be noise.
 */
function isNotifyTrack(config, track) {
  const configured = config?.storeStatus?.google?.notifyTracks;
  if (Array.isArray(configured)) return configured.includes(track);
  return track !== 'internal';
}

const toView = (snapshot) => ({
  status: snapshot?.payload || null,
  fetchedAt: snapshot?.fetchedAt || null,
  checkedAt: snapshot?.checkedAt || null,
  error: snapshot?.error || null
});

/**
 * Cache-or-fetch for one app on one store.
 * @param {Object} source { platform, appId, appName, client, clientError, fetch, classify, diff }
 */
async function getStoreStatus(source, { ttlMs, fresh = false, now = new Date() }) {
  const { platform, appId, appName = null, client, clientError, fetch, classify, diff } = source;
  if (!appId) return toView(null);
  const cached = store.getSnapshot(platform, appId, KIND_RELEASE);
  if (!fresh && store.isFresh(cached, ttlMs, now)) return toView(cached);
  if (!client) return { ...toView(cached), error: clientError };
  try {
    const payload = await fetch(client);
    // Every successful fetch is compared with the last one, whether it came from the
    // poller or from someone opening the page, so no transition is missed or seen twice.
    store.recordEvents(platform, appId, appName, diff(cached?.payload || null, payload), now);
    return toView(store.saveSuccess(platform, appId, KIND_RELEASE, payload, now));
  } catch (err) {
    return toView(store.saveFailure(platform, appId, KIND_RELEASE, classify(err), now));
  }
}

function getAppleStatus(appleAppId, { client, clientError, ttlMs, fresh = false, now = new Date(), appName = null }) {
  return getStoreStatus({
    platform: 'apple', appId: appleAppId, appName, client, clientError,
    fetch: (c) => fetchAppleAppStatus(c, appleAppId),
    classify: classifyAppleError,
    diff: diffAppleStatus
  }, { ttlMs, fresh, now });
}

function getGoogleStatus(packageName, { client, clientError, ttlMs, fresh = false, now = new Date(), appName = null, config = {} }) {
  const tracks = getTracks(config);
  return getStoreStatus({
    platform: 'google', appId: packageName, appName, client, clientError,
    fetch: (c) => fetchGoogleAppStatus(c, packageName, tracks),
    classify: classifyGoogleError,
    diff: (previous, next) => diffGoogleStatus(previous, next)
      .map(event => ({ ...event, silent: !isNotifyTrack(config, event.track) }))
  }, { ttlMs, fresh, now });
}

/**
 * @param {Object} config
 * @param {Array} apps from listStoreApps
 * @returns {Promise<Object>} map of app id -> { apple, google }
 */
async function getStatusForApps(config, apps, { fresh = false, now = new Date(), appleClient, googleClient } = {}) {
  const ttlMs = getTtlMs(config);
  const needsApple = apps.some(app => app.apple);
  const needsGoogle = apps.some(app => app.google);
  const none = { client: null, error: null };
  const apple = appleClient ? { client: appleClient, error: null } : (needsApple ? getAppleClient(config) : none);
  const google = googleClient ? { client: googleClient, error: null } : (needsGoogle ? getGoogleClient(config) : none);
  const entries = await Promise.all(apps.map(async (app) => {
    const [appleStatus, googleStatus] = await Promise.all([
      app.apple
        ? getAppleStatus(app.apple.appId, { client: apple.client, clientError: apple.error, ttlMs, fresh, now, appName: app.name })
        : null,
      app.google
        ? getGoogleStatus(app.google.packageName, { client: google.client, clientError: google.error, ttlMs, fresh, now, appName: app.name, config })
        : null
    ]);
    return [app.id, { apple: appleStatus, google: googleStatus }];
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  KIND_RELEASE, getTtlMs, isAppleConfigured, isNotifyTrack,
  getAppleStatus, getGoogleStatus, getStatusForApps
};

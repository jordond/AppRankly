/**
 * Store status for the app list: serves from the snapshot cache and refetches from the
 * store APIs when a snapshot is older than the TTL.
 */
const { buildAppleViewer } = require('../viewerFactory');
const { createAppleClient, fetchAppleAppStatus } = require('./appleStatus');
const { classifyAppleError } = require('./errors');
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

const toView = (snapshot) => ({
  status: snapshot?.payload || null,
  fetchedAt: snapshot?.fetchedAt || null,
  checkedAt: snapshot?.checkedAt || null,
  error: snapshot?.error || null
});

async function getAppleStatus(appleAppId, { client, clientError, ttlMs, fresh = false, now = new Date() }) {
  if (!appleAppId) return toView(null);
  const cached = store.getSnapshot('apple', appleAppId, KIND_RELEASE);
  if (!fresh && store.isFresh(cached, ttlMs, now)) return toView(cached);
  if (!client) return { ...toView(cached), error: clientError };
  try {
    const payload = await fetchAppleAppStatus(client, appleAppId);
    return toView(store.saveSuccess('apple', appleAppId, KIND_RELEASE, payload, now));
  } catch (err) {
    return toView(store.saveFailure('apple', appleAppId, KIND_RELEASE, classifyAppleError(err), now));
  }
}

/**
 * @param {Object} config
 * @param {Array} apps from listStoreApps
 * @returns {Promise<Object>} map of app id -> { apple, google }
 */
async function getStatusForApps(config, apps, { fresh = false, now = new Date(), appleClient } = {}) {
  const ttlMs = getTtlMs(config);
  const apple = appleClient ? { client: appleClient, error: null } : getAppleClient(config);
  const entries = await Promise.all(apps.map(async (app) => {
    const appleStatus = app.apple
      ? await getAppleStatus(app.apple.appId, { client: apple.client, clientError: apple.error, ttlMs, fresh, now })
      : null;
    return [app.id, { apple: appleStatus, google: null }];
  }));
  return Object.fromEntries(entries);
}

module.exports = { KIND_RELEASE, getTtlMs, isAppleConfigured, getAppleStatus, getStatusForApps };

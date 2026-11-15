/**
 * Store status for the app list: serves from the snapshot cache and refetches from the
 * store APIs when a snapshot is older than the TTL.
 */
const { buildAppleViewer } = require('../viewerFactory');
const { createAppleClient, fetchAppleAppStatus } = require('./appleStatus');
const { fetchAppleBuilds } = require('./appleBuilds');
const { createGoogleClient, fetchGoogleAppStatus, getTracks } = require('./googleStatus');
const { loadGoogleCredentials, getGoogleTokenProvider } = require('./googleAuth');
const { classifyAppleError, classifyGoogleError } = require('./errors');
const { diffAppleStatus, diffGoogleStatus } = require('./changes');
const { fetchAppleReviews, fetchGoogleReviews } = require('./reviews');
const { createReportingClient, fetchGoogleVitals } = require('./googleVitals');
const { createEditsReader, fetchGoogleRollout } = require('./googleRollout');
const reviewStore = require('./reviewStore');
const store = require('./store');

const KIND_RELEASE = 'release';
const KIND_BUILDS = 'builds';
const KIND_REVIEWS = 'reviews';
const KIND_VITALS = 'vitals';
const KIND_ROLLOUT = 'rollout';
const DEFAULT_POLL_MINUTES = 15;

// Kinds that change slowly or have a tight quota are refetched no more often than this,
// whatever the poll interval. Kinds not listed follow the poll interval.
const SLOW_KIND_TTL_MS = {
  [KIND_REVIEWS]: 60 * 60 * 1000,     // Play allows 200 review reads per hour
  [KIND_VITALS]: 6 * 60 * 60 * 1000,  // Play publishes vitals once a day
  [KIND_ROLLOUT]: 60 * 60 * 1000      // each read opens and deletes an edit
};

function getTtlMs(config = {}) {
  const minutes = Number(config.storeStatus?.pollMinutes);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_POLL_MINUTES) * 60 * 1000;
}

// Play's releases.list has a small, undocumented quota: about 120 calls within 20 minutes
// were enough to exhaust it. One call is needed per track per app, so Play release state
// is read hourly by default (`storeStatus.google.pollMinutes`) instead of on every poll.
const GOOGLE_RELEASE_DEFAULT_MINUTES = 60;
// A poll that lands a few seconds early still counts as due.
const POLL_TOLERANCE_MS = 60 * 1000;

function getGoogleReleaseTtlMs(config = {}) {
  const minutes = Number(config.storeStatus?.google?.pollMinutes);
  const own = (Number.isFinite(minutes) && minutes >= 1 ? minutes : GOOGLE_RELEASE_DEFAULT_MINUTES) * 60 * 1000;
  return Math.max(getTtlMs(config), own);
}

const isSlowKind = (kind) => kind in SLOW_KIND_TTL_MS;
const getKindTtlMs = (config, kind) => Math.max(getTtlMs(config), SLOW_KIND_TTL_MS[kind] || 0);

/** Optional sections of the page (`storeStatus.sections.<name>`), all on unless set to false. */
const isSectionEnabled = (config, name) => config?.storeStatus?.sections?.[name] !== false;

function isAppleConfigured(config = {}) {
  return Boolean(config.keyFilePath_apple && config.appleIssuerId && config.appleKeyId);
}

/**
 * Store status can use its own App Store Connect key (`storeStatus.apple`), so the
 * analytics key can stay at the Sales and Reports role. Without it the analytics key is used.
 */
function hasAppleStatusKey(config = {}) {
  const key = config.storeStatus?.apple;
  return Boolean(key && key.keyFilePath && key.keyId && key.issuerId);
}

function withAppleStatusKey(config = {}) {
  if (!hasAppleStatusKey(config)) return config;
  const key = config.storeStatus.apple;
  return { ...config, keyFilePath_apple: key.keyFilePath, appleKeyId: key.keyId, appleIssuerId: key.issuerId };
}

/** @returns {{ client: Object|null, error: Object|null }} */
function getAppleClient(baseConfig) {
  const config = withAppleStatusKey(baseConfig);
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

/** Rollout percentage needs the edits API, so it is read only when explicitly switched on. */
const isRolloutEnabled = (config) => config?.storeStatus?.google?.readRolloutViaEdits === true;

/** @returns {{ client: Object|null, reporting: Object|null, edits: Object|null, error: Object|null }} */
function getGoogleClient(config) {
  const credentials = loadGoogleCredentials(config);
  if (!credentials) return { client: null, reporting: null, edits: null, error: classifyGoogleError({ code: 'GOOGLE_NOT_CONFIGURED' }) };
  const getToken = getGoogleTokenProvider(credentials);
  return {
    client: createGoogleClient(getToken),
    reporting: createReportingClient(getToken),
    edits: isRolloutEnabled(config) ? createEditsReader(getToken) : null,
    error: null
  };
}

function classifyRolloutError(err) {
  const error = classifyGoogleError(err);
  if (error.code !== 'GOOGLE_FORBIDDEN') return error;
  return {
    ...error,
    message: 'The service account is not allowed to open an edit, so rollout percentage is unavailable.',
    hint: 'Reading rollout percentage needs a release permission in Play Console. Grant one to a service account used only by this dashboard, or set storeStatus.google.readRolloutViaEdits to false.'
  };
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
 * Cache-or-fetch for one kind of status of one app on one store.
 * @param {Object} source { platform, appId, kind, appName, client, clientError, fetch, classify, diff?, ttlMs? }
 *   `ttlMs` gives the source its own refresh interval; it is then not refetched on every poll.
 * @param {Object} options
 * @param {Object} options.config
 * @param {boolean} [options.fresh] refetch everything (the page's Refresh button)
 * @param {boolean} [options.poll]  refetch the kinds that follow the poll interval (the poller)
 */
async function getStoreStatus(source, { config = {}, fresh = false, poll = false, now = new Date() }) {
  const { platform, appId, kind = KIND_RELEASE, appName = null, client, clientError, fetch, classify, diff } = source;
  if (!appId) return toView(null);
  const cached = store.getSnapshot(platform, appId, kind);
  const slow = source.ttlMs !== undefined || isSlowKind(kind);
  const ttlMs = (source.ttlMs !== undefined ? source.ttlMs : getKindTtlMs(config, kind)) - (poll ? POLL_TOLERANCE_MS : 0);
  const force = fresh || (poll && !slow);
  if (!force && store.isFresh(cached, ttlMs, now)) return toView(cached);
  if (!client) return { ...toView(cached), error: clientError };
  try {
    const payload = await fetch(client);
    // Every successful fetch is compared with the last one, whether it came from the
    // poller or from someone opening the page, so no transition is missed or seen twice.
    if (diff) store.recordEvents(platform, appId, appName, diff(cached?.payload || null, payload), now);
    return toView(store.saveSuccess(platform, appId, kind, payload, now));
  } catch (err) {
    return toView(store.saveFailure(platform, appId, kind, classify(err), now));
  }
}

/**
 * Reviews are stored row by row; the snapshot only records when they were last fetched.
 * The view carries what is in the table, so history outlives Play's 7-day window.
 */
async function getReviews(base, fetchReviews, options) {
  const view = await getStoreStatus({
    ...base,
    kind: KIND_REVIEWS,
    fetch: async (c) => {
      const reviews = await fetchReviews(c);
      reviewStore.upsertReviews(base.platform, base.appId, reviews, options.now);
      return { fetched: reviews.length };
    }
  }, options);
  return { ...view, status: base.appId ? reviewStore.getReviewSummary(base.platform, base.appId) : null };
}

/** Everything shown for one app on the App Store: release state plus the optional sections. */
async function getAppleStatus(appleAppId, { client, clientError, appName = null, ...options }) {
  const config = options.config || {};
  const base = { platform: 'apple', appId: appleAppId, appName, client, clientError, classify: classifyAppleError };
  const [release, builds, reviews] = await Promise.all([
    getStoreStatus({ ...base, kind: KIND_RELEASE, fetch: (c) => fetchAppleAppStatus(c, appleAppId), diff: diffAppleStatus }, options),
    isSectionEnabled(config, 'testflight')
      ? getStoreStatus({ ...base, kind: KIND_BUILDS, fetch: (c) => fetchAppleBuilds(c, appleAppId) }, options)
      : null,
    isSectionEnabled(config, 'reviews')
      ? getReviews(base, (c) => fetchAppleReviews(c, appleAppId), options)
      : null
  ]);
  return { ...release, ...(builds ? { builds } : {}), ...(reviews ? { reviews } : {}) };
}

/** Everything shown for one app on Google Play. */
async function getGoogleStatus(packageName, { client, reporting = null, edits = null, clientError, appName = null, ...options }) {
  const config = options.config || {};
  const tracks = getTracks(config);
  const base = { platform: 'google', appId: packageName, appName, client, clientError, classify: classifyGoogleError };
  const [release, reviews, vitals, rollout] = await Promise.all([
    getStoreStatus({
      ...base,
      kind: KIND_RELEASE,
      ttlMs: getGoogleReleaseTtlMs(config),
      fetch: (c) => fetchGoogleAppStatus(c, packageName, tracks),
      diff: (previous, next) => diffGoogleStatus(previous, next)
        .map(event => ({ ...event, silent: !isNotifyTrack(config, event.track) }))
    }, options),
    isSectionEnabled(config, 'reviews')
      ? getReviews(base, (c) => fetchGoogleReviews(c, packageName), options)
      : null,
    isSectionEnabled(config, 'vitals')
      ? getStoreStatus({ ...base, client: reporting, kind: KIND_VITALS, fetch: (c) => fetchGoogleVitals(c, packageName) }, options)
      : null,
    isRolloutEnabled(config) && edits
      ? getStoreStatus({ ...base, client: edits, kind: KIND_ROLLOUT, classify: classifyRolloutError, fetch: (c) => fetchGoogleRollout(c, packageName) }, options)
      : null
  ]);
  return { ...release, ...(reviews ? { reviews } : {}), ...(vitals ? { vitals } : {}), ...(rollout ? { rollout } : {}) };
}

/**
 * @param {Object} config
 * @param {Array} apps from listStoreApps
 * @returns {Promise<Object>} map of app id -> { apple, google }
 */
async function getStatusForApps(config, apps, { fresh = false, poll = false, now = new Date(), appleClient, googleClient, reportingClient, editsReader } = {}) {
  const options = { config, fresh, poll, now };
  const needsApple = apps.some(app => app.apple);
  const needsGoogle = apps.some(app => app.google);
  const none = { client: null, error: null };
  const apple = appleClient ? { client: appleClient, error: null } : (needsApple ? getAppleClient(config) : none);
  const google = googleClient
    ? { client: googleClient, reporting: reportingClient || null, edits: editsReader || null, error: null }
    : (needsGoogle ? getGoogleClient(config) : { ...none, reporting: null, edits: null });
  const entries = await Promise.all(apps.map(async (app) => {
    const [appleStatus, googleStatus] = await Promise.all([
      app.apple
        ? getAppleStatus(app.apple.appId, { client: apple.client, clientError: apple.error, appName: app.name, ...options })
        : null,
      app.google
        ? getGoogleStatus(app.google.packageName, { client: google.client, reporting: google.reporting, edits: google.edits, clientError: google.error, appName: app.name, ...options })
        : null
    ]);
    return [app.id, { apple: appleStatus, google: googleStatus }];
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  KIND_RELEASE, KIND_BUILDS, KIND_REVIEWS, KIND_VITALS, KIND_ROLLOUT, SLOW_KIND_TTL_MS, getTtlMs, getKindTtlMs, getGoogleReleaseTtlMs, isSectionEnabled, isRolloutEnabled,
  hasAppleStatusKey, withAppleStatusKey, getAppleClient, getGoogleClient, isAppleConfigured, isNotifyTrack,
  getAppleStatus, getGoogleStatus, getStatusForApps
};

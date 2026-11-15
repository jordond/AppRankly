/**
 * Access check for the setup guide: tries each kind of read once, against one app per
 * store, and reports which ones the configured keys are allowed to make. Read-only; it
 * never opens a Play edit, so the opt-in rollout read is reported but not exercised.
 */
const { fetchAppleAppStatus } = require('./appleStatus');
const { fetchAppleBuilds } = require('./appleBuilds');
const { fetchAppleReviews, fetchGoogleReviews } = require('./reviews');
const { fetchGoogleAppStatus } = require('./googleStatus');
const { fetchGoogleVitals } = require('./googleVitals');
const { classifyAppleError, classifyGoogleError } = require('./errors');
const { getAppleClient, getGoogleClient, hasAppleStatusKey, isRolloutEnabled } = require('./service');

const APPLE_CHECKS = [
  { id: 'release', label: 'Versions and review state', run: (clients, id) => fetchAppleAppStatus(clients.client, id) },
  { id: 'testflight', label: 'TestFlight builds', run: (clients, id) => fetchAppleBuilds(clients.client, id) },
  { id: 'reviews', label: 'Customer reviews', run: (clients, id) => fetchAppleReviews(clients.client, id) }
];

const GOOGLE_CHECKS = [
  { id: 'release', label: 'Track releases and review state', run: (clients, id) => fetchGoogleAppStatus(clients.client, id, ['production']) },
  { id: 'reviews', label: 'User reviews', run: (clients, id) => fetchGoogleReviews(clients.client, id) },
  { id: 'vitals', label: 'Android vitals', run: (clients, id) => fetchGoogleVitals(clients.reporting, id) }
];

async function runChecks(checks, clients, appId, classify) {
  return Promise.all(checks.map(async ({ id, label, run }) => {
    try {
      await run(clients, appId);
      return { id, label, ok: true, error: null };
    } catch (err) {
      return { id, label, ok: false, error: classify(err) };
    }
  }));
}

/**
 * @param {Object} config
 * @param {Array} apps from listStoreApps
 * @param {Object} [clients] { apple, google } overrides, for tests
 */
async function probeCapabilities(config, apps, clients = {}) {
  const appleApp = apps.find(app => app.apple && app.apple.appId);
  const googleApp = apps.find(app => app.google && app.google.packageName);
  const apple = clients.apple || getAppleClient(config);
  const google = clients.google || getGoogleClient(config);

  const [appleChecks, googleChecks] = await Promise.all([
    apple.client && appleApp ? runChecks(APPLE_CHECKS, apple, appleApp.apple.appId, classifyAppleError) : [],
    google.client && googleApp ? runChecks(GOOGLE_CHECKS, google, googleApp.google.packageName, classifyGoogleError) : []
  ]);

  return {
    apple: {
      configured: Boolean(apple.client),
      error: apple.error || null,
      dedicatedKey: hasAppleStatusKey(config),
      testedWith: apple.client && appleApp ? appleApp.name : null,
      checks: appleChecks
    },
    google: {
      configured: Boolean(google.client),
      error: google.error || null,
      dedicatedKey: Boolean(config?.storeStatus?.google?.keyFilePath),
      testedWith: google.client && googleApp ? googleApp.name : null,
      checks: googleChecks,
      // Not exercised here: checking it would open an edit.
      rolloutViaEdits: isRolloutEnabled(config)
    }
  };
}

module.exports = { probeCapabilities };

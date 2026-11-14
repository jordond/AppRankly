/**
 * The list of apps the store-status feature works on: one entry per product, with its
 * App Store and Play Store identities side by side.
 */
const fs = require('fs');
const { resolveKeyFilePath } = require('../config');
const { fetchPackagesByPlatform, getIgnoredSet, isIgnored } = require('../viewerFactory');
const { matchAndPairApps, getNormalizedPairings } = require('../metrics');

const prettyName = (packageName) => String(packageName).split('.').pop();

/**
 * Android packages named in config (pairings and appMetadata). The Play package list is
 * read from the reports bucket, which can be empty or unreadable while the store APIs
 * work fine, so config is a second source.
 */
function configuredGooglePackages(config = {}) {
  const names = new Map();
  getNormalizedPairings(config).forEach(pair => {
    if (pair.ignore || !pair.googlePackageName) return;
    names.set(pair.googlePackageName, pair.name || prettyName(pair.googlePackageName));
  });
  Object.keys(config.appMetadata || {}).forEach(pkg => {
    // example.config.json keys are real package names; iOS-only bundle IDs are not expected here.
    if (!names.has(pkg)) names.set(pkg, prettyName(pkg));
  });
  return Array.from(names, ([packageName, name]) => ({ packageName, name, platform: 'google' }));
}

/**
 * Pure merge + pairing step.
 * @returns {Array<{ id, name, apple: Object|null, google: Object|null }>}
 */
function buildAppList({ config = {}, googleApps = [], appleApps = [] } = {}) {
  const ignoredSet = getIgnoredSet(config);
  const known = new Set(googleApps.map(g => g.packageName));
  const extraGoogle = configuredGooglePackages(config)
    .filter(g => !known.has(g.packageName) && !isIgnored(g, ignoredSet));
  const allGoogle = [...googleApps, ...extraGoogle];

  const { paired, unpairedGoogle, unpairedApple } = matchAndPairApps(allGoogle, appleApps, config);

  const toApple = (a) => a ? { appId: a.appId || null, bundleId: a.bundleId || a.packageName, name: a.name } : null;
  const toGoogle = (g, consoleAppId) => g ? { packageName: g.packageName, name: g.name, consoleAppId: consoleAppId || g.consoleAppId || null } : null;

  const apps = [
    ...paired.map(p => ({ id: p.id, name: p.name, apple: toApple(p.appleApp), google: toGoogle(p.googleApp, p.consoleAppId) })),
    ...unpairedApple.map(a => ({ id: `apple-${a.bundleId || a.packageName}`, name: a.name, apple: toApple(a), google: null })),
    ...unpairedGoogle.map(g => ({ id: `google-${g.packageName}`, name: g.name, apple: null, google: toGoogle(g) }))
  ];
  return apps.sort((a, b) => {
    // Products on both stores first, then alphabetical.
    const both = (x) => (x.apple && x.google ? 0 : 1);
    return both(a) - both(b) || String(a.name).localeCompare(String(b.name));
  });
}

async function listStoreApps(config) {
  const all = await fetchPackagesByPlatform('all', config);
  return buildAppList({
    config,
    googleApps: all.filter(p => p.platform === 'google'),
    appleApps: all.filter(p => p.platform === 'apple')
  });
}

/** Cloud project of the configured Google service account. Reads only `project_id`. */
function getGcpProjectId(config = {}) {
  try {
    if (config.keyJson) {
      const parsed = typeof config.keyJson === 'string' ? JSON.parse(config.keyJson) : config.keyJson;
      if (parsed?.project_id) return String(parsed.project_id);
    }
    const keyPath = resolveKeyFilePath(config.keyFilePath);
    if (keyPath) {
      const projectId = JSON.parse(fs.readFileSync(keyPath, 'utf8')).project_id;
      if (projectId) return String(projectId);
    }
  } catch {
    // Unreadable or malformed key: the links that need the project simply stay disabled.
  }
  return null;
}

module.exports = {
  configuredGooglePackages,
  buildAppList,
  listStoreApps,
  getGcpProjectId
};

/**
 * Store console deep links.
 *
 * Neither store documents its console URLs and both change them without notice, so every
 * template lives in this one table. A broken link is fixed here, or without a code change
 * through `storeStatus.linkOverrides` in config.json ({ "<link id>": "<template>" }).
 *
 * Placeholders:
 *   {appleAppId}    numeric App Store Connect app ID (from /v1/apps)
 *   {packageName}   Android package name
 *   {playBase}      Play Console developer root, taken from `PlaystoreConsoleUrl`
 *   {consoleAppId}  Play Console app ID, from `appMetadata.<package>.consoleAppId`
 *   {gcpProjectId}  Cloud project of the configured service account
 */

const ASC = 'https://appstoreconnect.apple.com';
const PLAY_APP = '{playBase}/app/{consoleAppId}';
const CLOUD = 'https://console.cloud.google.com';

const LINK_TEMPLATES = [
  // Apple, per app
  { id: 'apple.app', store: 'apple', scope: 'app', label: 'App Store Connect', template: `${ASC}/apps/{appleAppId}/distribution` },
  { id: 'apple.testflight', store: 'apple', scope: 'app', label: 'TestFlight', template: `${ASC}/apps/{appleAppId}/testflight/ios` },
  { id: 'apple.analytics', store: 'apple', scope: 'app', label: 'Analytics', template: `${ASC}/apps/{appleAppId}/analytics` },
  { id: 'apple.listing', store: 'apple', scope: 'app', label: 'App Store listing', template: 'https://apps.apple.com/app/id{appleAppId}' },

  // Google, per app
  { id: 'google.dashboard', store: 'google', scope: 'app', label: 'Play Console', template: `${PLAY_APP}/app-dashboard` },
  { id: 'google.releases', store: 'google', scope: 'app', label: 'Releases', template: `${PLAY_APP}/releases/overview` },
  { id: 'google.production', store: 'google', scope: 'app', label: 'Production', template: `${PLAY_APP}/tracks/production` },
  { id: 'google.publishing', store: 'google', scope: 'app', label: 'Publishing overview', template: `${PLAY_APP}/publishing` },
  { id: 'google.policy', store: 'google', scope: 'app', label: 'Policy status', template: `${PLAY_APP}/policy-center` },
  { id: 'google.reviews', store: 'google', scope: 'app', label: 'Reviews', template: `${PLAY_APP}/user-feedback/reviews` },
  { id: 'google.vitals', store: 'google', scope: 'app', label: 'Vitals', template: `${PLAY_APP}/vitals/metrics/overview` },
  { id: 'google.listing', store: 'google', scope: 'app', label: 'Play Store listing', template: 'https://play.google.com/store/apps/details?id={packageName}' },

  // Apple, account
  { id: 'apple.apps', store: 'apple', scope: 'account', label: 'Apps', template: `${ASC}/apps` },
  { id: 'apple.integrations', store: 'apple', scope: 'account', label: 'Integrations (API keys)', template: `${ASC}/access/integrations/api` },
  { id: 'apple.users', store: 'apple', scope: 'account', label: 'Users and Access', template: `${ASC}/access/users` },
  { id: 'apple.agreements', store: 'apple', scope: 'account', label: 'Agreements', template: `${ASC}/agreements/#/` },
  { id: 'apple.business', store: 'apple', scope: 'account', label: 'Business (tax and banking)', template: `${ASC}/business` },
  { id: 'apple.trends', store: 'apple', scope: 'account', label: 'Sales and Trends', template: `${ASC}/trends` },
  { id: 'apple.payments', store: 'apple', scope: 'account', label: 'Payments and Financial Reports', template: `${ASC}/itc/payments_and_financial_reports` },
  { id: 'apple.certificates', store: 'apple', scope: 'account', label: 'Certificates, IDs and Profiles', template: 'https://developer.apple.com/account/resources/certificates/list' },

  // Google, account
  { id: 'google.apps', store: 'google', scope: 'account', label: 'All apps', template: '{playBase}/app-list' },
  { id: 'google.users', store: 'google', scope: 'account', label: 'Users and permissions', template: '{playBase}/users-and-permissions' },
  { id: 'google.apiAccess', store: 'google', scope: 'account', label: 'API access', template: '{playBase}/api-access' },
  { id: 'google.reports', store: 'google', scope: 'account', label: 'Download reports', template: '{playBase}/download-reports' },
  { id: 'google.payments', store: 'google', scope: 'account', label: 'Payments profile', template: '{playBase}/payments-profile' },
  { id: 'google.serviceAccounts', store: 'google', scope: 'account', label: 'Cloud service accounts', template: `${CLOUD}/iam-admin/serviceaccounts?project={gcpProjectId}` },
  { id: 'google.enablePublisherApi', store: 'google', scope: 'account', label: 'Android Developer API', template: `${CLOUD}/apis/library/androidpublisher.googleapis.com?project={gcpProjectId}` },
  { id: 'google.enableReportingApi', store: 'google', scope: 'account', label: 'Developer Reporting API', template: `${CLOUD}/apis/library/playdeveloperreporting.googleapis.com?project={gcpProjectId}` }
];

// What to tell the user when a placeholder has no value.
const MISSING_HINTS = {
  appleAppId: 'Apple app ID unknown: the App Store Connect key could not list this app.',
  packageName: 'Android package name unknown.',
  playBase: 'Set PlaystoreConsoleUrl to your Play Console URL including /developers/<id>.',
  consoleAppId: 'Set appMetadata.<package>.consoleAppId (the ID in the Play Console URL after /app/).',
  gcpProjectId: 'Google Cloud project unknown: no service account key configured.'
};

const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;

/** Play Console developer root (keeps the /u/N/ account segment), or null when the ID is absent. */
function parsePlayBase(playstoreConsoleUrl) {
  if (typeof playstoreConsoleUrl !== 'string') return null;
  const match = playstoreConsoleUrl.trim().match(/^https:\/\/play\.google\.com\/console\/(u\/\d+\/)?developers\/(\d+)/);
  return match ? `https://play.google.com/console/${match[1] || ''}developers/${match[2]}` : null;
}

function isSafeHttpsUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fill one template. Values are URL-encoded, except {playBase}, which is a URL prefix
 * produced by parsePlayBase.
 * @returns {{ url: string|null, missing: string[] }}
 */
function expandTemplate(template, vars = {}) {
  const missing = [];
  const url = template.replace(PLACEHOLDER_RE, (whole, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return name === 'playBase' ? String(value) : encodeURIComponent(String(value));
  });
  if (missing.length > 0) return { url: null, missing };
  return isSafeHttpsUrl(url) ? { url, missing } : { url: null, missing };
}

function buildLinks(store, scope, vars, overrides = {}) {
  return LINK_TEMPLATES
    .filter(link => link.store === store && link.scope === scope)
    .map(link => {
      const override = overrides[link.id];
      const template = typeof override === 'string' && override.trim() ? override.trim() : link.template;
      const { url, missing } = expandTemplate(template, vars);
      const entry = { id: link.id, label: link.label, url };
      if (!url) {
        entry.reason = missing.length > 0
          ? missing.map(name => MISSING_HINTS[name] || `Missing ${name}.`).join(' ')
          : 'Link template does not produce an https URL.';
      }
      return entry;
    });
}

/** User-defined links from `storeStatus.customLinks`; anything that is not https is dropped. */
function normalizeCustomLinks(customLinks) {
  if (!Array.isArray(customLinks)) return [];
  return customLinks
    .filter(link => link && typeof link.label === 'string' && link.label.trim() && isSafeHttpsUrl(link.url))
    .map((link, index) => ({
      id: `custom.${index}`,
      label: link.label.trim().slice(0, 80),
      url: link.url,
      group: typeof link.group === 'string' && link.group.trim() ? link.group.trim().slice(0, 40) : 'Custom'
    }));
}

function lookupConsoleAppId(config, packageName, fallback) {
  const fromMetadata = config?.appMetadata?.[packageName]?.consoleAppId;
  const value = fromMetadata || fallback;
  // example.config.json ships placeholder text in this field; only a bare numeric ID is usable.
  return value && /^\d+$/.test(String(value).trim()) ? String(value).trim() : null;
}

/**
 * @param {Object} input
 * @param {Object} input.config            base config
 * @param {Array}  input.apps              [{ id, name, apple: { appId, bundleId, name } | null, google: { packageName, name, consoleAppId? } | null }]
 * @param {string} [input.gcpProjectId]
 */
function buildStoreLinks({ config = {}, apps = [], gcpProjectId = null } = {}) {
  const overrides = (config.storeStatus && typeof config.storeStatus.linkOverrides === 'object' && config.storeStatus.linkOverrides) || {};
  const playBase = parsePlayBase(config.PlaystoreConsoleUrl);

  const appLinks = apps.map(app => {
    const entry = { id: app.id, name: app.name, apple: null, google: null };
    if (app.apple) {
      entry.apple = {
        appId: app.apple.appId || null,
        bundleId: app.apple.bundleId || null,
        name: app.apple.name || app.name,
        links: buildLinks('apple', 'app', { appleAppId: app.apple.appId }, overrides)
      };
    }
    if (app.google) {
      const consoleAppId = lookupConsoleAppId(config, app.google.packageName, app.google.consoleAppId);
      entry.google = {
        packageName: app.google.packageName,
        name: app.google.name || app.name,
        consoleAppId,
        links: buildLinks('google', 'app', { playBase, consoleAppId, packageName: app.google.packageName }, overrides)
      };
    }
    return entry;
  });

  return {
    apps: appLinks,
    common: {
      apple: buildLinks('apple', 'account', {}, overrides),
      google: buildLinks('google', 'account', { playBase, gcpProjectId }, overrides),
      custom: normalizeCustomLinks(config.storeStatus?.customLinks)
    }
  };
}

module.exports = {
  LINK_TEMPLATES,
  parsePlayBase,
  isSafeHttpsUrl,
  expandTemplate,
  buildLinks,
  normalizeCustomLinks,
  lookupConsoleAppId,
  buildStoreLinks
};

const express = require('express');
const router = express.Router();
const { getBaseConfig } = require('../lib/config');
const { buildStoreLinks } = require('../lib/storeStatus/links');
const { listStoreApps, getGcpProjectId } = require('../lib/storeStatus/apps');
const { getStatusForApps } = require('../lib/storeStatus/service');
const { isEnabled, getStoreStatusPollerStatus } = require('../lib/storeStatus/poller');
const store = require('../lib/storeStatus/store');

// GET /api/store-status/links
// Console and store-listing links for every app, plus account-level links.
router.get('/links', async (req, res) => {
  const config = getBaseConfig();
  if (!config) return res.json({ apps: [], common: { apple: [], google: [], custom: [] } });
  try {
    const apps = await listStoreApps(config);
    res.json(buildStoreLinks({ config, apps, gcpProjectId: getGcpProjectId(config) }));
  } catch (err) {
    console.error('[StoreStatus] Failed to build links:', err.message);
    res.status(500).json({ error: 'Failed to build store links' });
  }
});

// GET /api/store-status[?fresh=1]
// Links plus review and release state for every app. Served from the snapshot cache;
// `fresh=1` bypasses the cache.
router.get('/', async (req, res) => {
  const config = getBaseConfig();
  if (!config) return res.json({ apps: [], common: { apple: [], google: [], custom: [] } });
  try {
    const apps = await listStoreApps(config);
    const links = buildStoreLinks({ config, apps, gcpProjectId: getGcpProjectId(config) });
    const status = await getStatusForApps(config, apps, { fresh: req.query.fresh === '1' });
    links.apps.forEach(app => {
      if (app.apple) Object.assign(app.apple, status[app.id]?.apple || {});
      if (app.google) Object.assign(app.google, status[app.id]?.google || {});
    });
    links.polling = { enabled: isEnabled(config), ...getStoreStatusPollerStatus() };
    links.recentChanges = store.getRecentEvents(10).map(e => ({
      platform: e.platform, appName: e.app_name || e.app_id, subject: e.subject,
      fromState: e.from_state, toState: e.to_state, detectedAt: e.detected_at
    }));
    res.json(links);
  } catch (err) {
    console.error('[StoreStatus] Failed to load status:', err.message);
    res.status(500).json({ error: 'Failed to load store status' });
  }
});

module.exports = router;

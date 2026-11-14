const express = require('express');
const router = express.Router();
const { getBaseConfig } = require('../lib/config');
const { buildStoreLinks } = require('../lib/storeStatus/links');
const { listStoreApps, getGcpProjectId } = require('../lib/storeStatus/apps');

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

module.exports = router;

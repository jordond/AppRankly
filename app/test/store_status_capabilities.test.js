const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/db opens DB_PATH at load time: use a throwaway database for this test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-store-caps-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.DATA_DIR = tmpDir;

const { probeCapabilities } = require('../lib/storeStatus/capabilities');
const { hasAppleStatusKey, withAppleStatusKey, isAppleConfigured } = require('../lib/storeStatus/service');

function testAppleStatusKey() {
  const analytics = { keyFilePath_apple: 'keys/sales.p8', appleKeyId: 'SALESKEY', appleIssuerId: 'issuer-1', appleVendorId: '8500' };
  assert.strictEqual(hasAppleStatusKey(analytics), false);
  assert.strictEqual(withAppleStatusKey(analytics), analytics, 'without a status key the analytics key is used as is');

  const withStatus = { ...analytics, storeStatus: { apple: { keyFilePath: 'keys/status.p8', keyId: 'STATUSKEY', issuerId: 'issuer-1' } } };
  assert.strictEqual(hasAppleStatusKey(withStatus), true);
  const merged = withAppleStatusKey(withStatus);
  assert.strictEqual(merged.keyFilePath_apple, 'keys/status.p8');
  assert.strictEqual(merged.appleKeyId, 'STATUSKEY');
  assert.strictEqual(merged.appleVendorId, '8500', 'everything else is kept');
  assert.strictEqual(withStatus.keyFilePath_apple, 'keys/sales.p8', 'the config itself is not modified');

  // An incomplete status key is ignored rather than half-applied.
  const partial = { ...analytics, storeStatus: { apple: { keyFilePath: 'keys/status.p8' } } };
  assert.strictEqual(hasAppleStatusKey(partial), false);
  assert.strictEqual(withAppleStatusKey(partial).appleKeyId, 'SALESKEY');

  // A status key alone is enough for store status, with no analytics key at all.
  assert.strictEqual(isAppleConfigured(withAppleStatusKey({ storeStatus: withStatus.storeStatus })), true);
  console.log('✓ optional App Store Connect status key');
}

async function testProbe() {
  const apps = [
    { id: 'google-only', name: 'Android Only', apple: null, google: { packageName: 'com.example.android' } },
    { id: 'pair', name: 'Paired', apple: { appId: '111' }, google: { packageName: 'com.example.pair' } }
  ];
  const calls = [];
  const forbidden = { response: { status: 403, data: { errors: [{ title: 'Forbidden', detail: 'The API key in use does not allow this request' }] } } };
  const apple = {
    error: null,
    client: {
      async get(pathname) {
        calls.push(`apple ${pathname}`);
        if (pathname.includes('customerReviews')) throw forbidden;
        return { data: [] };
      }
    }
  };
  const google = {
    error: null,
    client: { async get(url) { calls.push(`google ${url}`); return ''; } },
    reporting: {
      async get(url) {
        calls.push(`reporting ${url}`);
        throw { response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', message: 'x', details: [{ reason: 'SERVICE_DISABLED', metadata: { service: 'playdeveloperreporting.googleapis.com' } }] } } } };
      },
      async query() { throw new Error('not reached'); }
    },
    edits: { async readTracks() { throw new Error('the access check must never open an edit'); } }
  };

  const out = await probeCapabilities({ storeStatus: { google: { readRolloutViaEdits: true } } }, apps, { apple, google });
  assert.strictEqual(out.apple.configured, true);
  assert.strictEqual(out.apple.testedWith, 'Paired', 'the first app that exists on the store is used');
  assert.deepStrictEqual(out.apple.checks.map(c => [c.id, c.ok]), [['release', true], ['testflight', true], ['reviews', false]]);
  assert.strictEqual(out.apple.checks[2].error.code, 'APPLE_FORBIDDEN');
  assert.strictEqual(out.google.testedWith, 'Android Only');
  assert.deepStrictEqual(out.google.checks.map(c => [c.id, c.ok]), [['release', true], ['reviews', true], ['vitals', false]]);
  assert.strictEqual(out.google.checks[2].error.code, 'GOOGLE_API_DISABLED');
  assert(out.google.checks[2].error.message.startsWith('Google Play Developer Reporting API'));
  assert.strictEqual(out.google.rolloutViaEdits, true, 'reported, not exercised');
  assert(calls.every(c => !c.includes('/edits')), 'no edit is opened');
  assert.strictEqual(calls.filter(c => c.startsWith('google ') && c.includes('/tracks/')).length, 1, 'one track is enough to prove access');

  // Nothing configured: no calls, and each store says why.
  const none = await probeCapabilities({}, apps);
  assert.strictEqual(none.apple.configured, false);
  assert.strictEqual(none.apple.error.code, 'APPLE_NOT_CONFIGURED');
  assert.deepStrictEqual(none.apple.checks, []);
  assert.strictEqual(none.google.error.code, 'GOOGLE_NOT_CONFIGURED');
  assert.strictEqual(none.google.rolloutViaEdits, false);

  // Keys configured but no app on that store: nothing to test with.
  const noApps = await probeCapabilities({}, [], { apple, google });
  assert.strictEqual(noApps.apple.testedWith, null);
  assert.deepStrictEqual(noApps.google.checks, []);
  console.log('✓ access check reports each read separately');
}

(async () => {
  try {
    testAppleStatusKey();
    await testProbe();
    console.log('All store status capability tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();

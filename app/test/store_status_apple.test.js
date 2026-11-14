const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/db opens DB_PATH at load time: use a throwaway database for this test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-store-status-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');

const axios = require('axios');
const { STATE, APPLE_VERSION_STATE, normalizeAppleVersionState } = require('../lib/storeStatus/states');
const {
  createAppleClient, phasedReleaseSummary, summarizeVersions, summarizeReviewSubmissions, fetchAppleAppStatus
} = require('../lib/storeStatus/appleStatus');
const { classifyAppleError } = require('../lib/storeStatus/errors');
const store = require('../lib/storeStatus/store');
const { getStatusForApps, getTtlMs } = require('../lib/storeStatus/service');

const version = (id, versionString, appVersionState, createdDate, extra = {}) => ({
  type: 'appStoreVersions',
  id,
  attributes: { versionString, appVersionState, platform: extra.platform || 'IOS', createdDate, releaseType: 'MANUAL' },
  relationships: {
    appStoreVersionPhasedRelease: { data: extra.phased ? { type: 'appStoreVersionPhasedReleases', id: extra.phased } : null },
    build: { data: extra.build ? { type: 'builds', id: extra.build } : null }
  }
});

function testStateMapping() {
  const all = ['ACCEPTED', 'DEVELOPER_REJECTED', 'IN_REVIEW', 'INVALID_BINARY', 'METADATA_REJECTED', 'PENDING_APPLE_RELEASE',
    'PENDING_DEVELOPER_RELEASE', 'PREPARE_FOR_SUBMISSION', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION',
    'READY_FOR_REVIEW', 'REJECTED', 'REPLACED_WITH_NEW_VERSION', 'WAITING_FOR_EXPORT_COMPLIANCE', 'WAITING_FOR_REVIEW'];
  all.forEach(raw => assert(APPLE_VERSION_STATE[raw], `appVersionState ${raw} must be mapped`));
  assert.strictEqual(Object.keys(APPLE_VERSION_STATE).length, all.length, 'no stray states in the mapping');
  assert.strictEqual(normalizeAppleVersionState('READY_FOR_DISTRIBUTION'), STATE.LIVE);
  assert.strictEqual(normalizeAppleVersionState('PENDING_DEVELOPER_RELEASE'), STATE.APPROVED_PENDING_RELEASE);
  assert.strictEqual(normalizeAppleVersionState('METADATA_REJECTED'), STATE.REJECTED);
  assert.strictEqual(normalizeAppleVersionState('READY_FOR_SALE'), STATE.OTHER, 'deprecated appStoreState values are not mapped');
  assert.strictEqual(normalizeAppleVersionState(undefined), STATE.OTHER);
  console.log('✓ every appVersionState maps to a normalized state');
}

function testPhasedRelease() {
  assert.strictEqual(phasedReleaseSummary(null), null);
  assert.deepStrictEqual(phasedReleaseSummary({ phasedReleaseState: 'INACTIVE', currentDayNumber: 0 }), { state: 'INACTIVE', day: 0, percent: 0, startDate: null });
  assert.strictEqual(phasedReleaseSummary({ phasedReleaseState: 'ACTIVE', currentDayNumber: 1 }).percent, 1);
  assert.strictEqual(phasedReleaseSummary({ phasedReleaseState: 'ACTIVE', currentDayNumber: 4 }).percent, 10);
  assert.strictEqual(phasedReleaseSummary({ phasedReleaseState: 'PAUSED', currentDayNumber: 6 }).percent, 50);
  assert.strictEqual(phasedReleaseSummary({ phasedReleaseState: 'ACTIVE', currentDayNumber: 9 }).percent, 100, 'day past the schedule clamps');
  assert.strictEqual(phasedReleaseSummary({ phasedReleaseState: 'COMPLETE', currentDayNumber: 4 }).percent, 100, 'released to all early');
  assert.strictEqual(phasedReleaseSummary({ phasedReleaseState: 'ACTIVE', currentDayNumber: 0 }).percent, null);
  console.log('✓ phased release percentage');
}

function testSummarizeVersions() {
  // Deliberately out of order; older versions keep READY_FOR_DISTRIBUTION.
  const response = {
    data: [
      version('v2', '1.2.0', 'READY_FOR_DISTRIBUTION', '2026-11-01T00:00:00Z', { build: 'b35' }),
      version('v0', '1.0.0', 'READY_FOR_DISTRIBUTION', '2026-07-21T00:00:00Z'),
      version('v3', '1.3.0', 'PENDING_DEVELOPER_RELEASE', '2026-11-11T00:00:00Z', { phased: 'p3', build: 'b36' }),
      version('v1', '1.1.0', 'READY_FOR_DISTRIBUTION', '2026-10-12T00:00:00Z'),
      version('m1', '1.0', 'IN_REVIEW', '2026-11-05T00:00:00Z', { platform: 'MAC_OS' })
    ],
    included: [
      { type: 'appStoreVersionPhasedReleases', id: 'p3', attributes: { phasedReleaseState: 'INACTIVE', currentDayNumber: 0, startDate: null } },
      { type: 'builds', id: 'b36', attributes: { version: '36' } },
      { type: 'builds', id: 'b35', attributes: { version: '35' } }
    ]
  };
  const platforms = summarizeVersions(response);
  const ios = platforms.find(p => p.platform === 'IOS');
  assert.strictEqual(ios.live.version, '1.2.0', 'live is the newest READY_FOR_DISTRIBUTION');
  assert.strictEqual(ios.live.buildNumber, '35');
  assert.strictEqual(ios.inFlight.version, '1.3.0');
  assert.strictEqual(ios.inFlight.state, STATE.APPROVED_PENDING_RELEASE);
  assert.strictEqual(ios.inFlight.rawState, 'PENDING_DEVELOPER_RELEASE');
  assert.strictEqual(ios.inFlight.buildNumber, '36');
  assert.strictEqual(ios.inFlight.phasedRelease.state, 'INACTIVE');

  const mac = platforms.find(p => p.platform === 'MAC_OS');
  assert.strictEqual(mac.live, null, 'platforms are summarized separately');
  assert.strictEqual(mac.inFlight.state, STATE.IN_REVIEW);

  // Nothing newer than live: no in-flight version, even though older versions exist.
  const settled = summarizeVersions({ data: response.data.filter(v => v.id !== 'v3' && v.id !== 'm1') })[0];
  assert.strictEqual(settled.live.version, '1.2.0');
  assert.strictEqual(settled.inFlight, null);

  // Never released: rejected first version.
  const rejected = summarizeVersions({ data: [version('r1', '1.0', 'REJECTED', '2025-06-06T00:00:00Z')] })[0];
  assert.strictEqual(rejected.live, null);
  assert.strictEqual(rejected.inFlight.state, STATE.REJECTED);

  // An old draft below the live version is not in flight.
  const stale = summarizeVersions({ data: [
    version('a', '2.0', 'READY_FOR_DISTRIBUTION', '2026-05-01T00:00:00Z'),
    version('b', '1.9', 'DEVELOPER_REJECTED', '2026-04-01T00:00:00Z')
  ] })[0];
  assert.strictEqual(stale.inFlight, null);

  assert.deepStrictEqual(summarizeVersions({ data: [] }), []);
  assert.deepStrictEqual(summarizeVersions(undefined), []);
  console.log('✓ summarizeVersions picks live and in-flight per platform');
}

function testReviewSubmissions() {
  const sub = (state, submittedDate) => ({ attributes: { state, submittedDate, platform: 'IOS' } });
  assert.strictEqual(summarizeReviewSubmissions({ data: [] }), null);

  const done = summarizeReviewSubmissions({ data: [sub('COMPLETE', '2026-10-12T00:00:00Z'), sub('COMPLETE', '2026-11-11T00:00:00Z')] });
  assert.strictEqual(done.submittedDate, '2026-11-11T00:00:00Z', 'newest finished submission');
  assert.strictEqual(done.needsAttention, false);

  const open = summarizeReviewSubmissions({ data: [sub('COMPLETE', '2026-11-11T00:00:00Z'), sub('UNRESOLVED_ISSUES', '2026-03-18T00:00:00Z')] });
  assert.strictEqual(open.state, 'UNRESOLVED_ISSUES', 'an open submission wins over a newer finished one');
  assert.strictEqual(open.needsAttention, true);
  console.log('✓ summarizeReviewSubmissions');
}

function testClassifyAppleError() {
  const withStatus = (status, errors) => ({ response: { status, data: { errors } }, config: { headers: { Authorization: 'Bearer SECRET-TOKEN' } } });
  const forbidden = classifyAppleError(withStatus(403, [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'This request is forbidden for security reasons', detail: 'The API key in use does not allow this request' }]));
  assert.strictEqual(forbidden.code, 'APPLE_FORBIDDEN');
  assert(/role/i.test(forbidden.hint), 'hint names the missing role');
  assert(/does not allow this request/.test(forbidden.detail));
  assert(!JSON.stringify(forbidden).includes('SECRET-TOKEN'), 'never echoes the request token');

  assert.strictEqual(classifyAppleError(withStatus(401, [])).code, 'APPLE_UNAUTHORIZED');
  assert.strictEqual(classifyAppleError(withStatus(404, [])).code, 'APPLE_NOT_FOUND');
  assert.strictEqual(classifyAppleError(withStatus(429, [])).code, 'APPLE_RATE_LIMITED');
  assert.strictEqual(classifyAppleError(withStatus(503, [])).code, 'APPLE_UNAVAILABLE');
  assert.strictEqual(classifyAppleError({ code: 'ECONNRESET', message: 'socket hang up' }).code, 'NETWORK');
  assert.strictEqual(classifyAppleError({ code: 'APPLE_NOT_CONFIGURED' }).code, 'APPLE_NOT_CONFIGURED');
  console.log('✓ classifyAppleError');
}

async function testClientIsReadOnly() {
  const calls = [];
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    return { data: { data: [] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    const client = createAppleClient(() => 'test-token');
    assert.deepStrictEqual(Object.keys(client), ['get'], 'the client exposes GET only');
    await client.get('/v1/apps/1/appStoreVersions', { limit: 5 });
    assert.strictEqual(calls[0].method, 'get');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer test-token');
    assert(calls[0].url.startsWith('https://api.appstoreconnect.apple.com/v1/apps/1/'));
    await assert.rejects(() => client.get('https://evil.example/v1/apps'), /only reads/);
    await assert.rejects(() => client.get('/v2/other'), /only reads/);

    calls.length = 0;
    await fetchAppleAppStatus(client, '123');
    assert.strictEqual(calls.length, 2, 'two requests per app');
    assert(calls.every(c => c.method === 'get'));
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
  console.log('✓ Apple client issues GET requests only');
}

async function testServiceCaching() {
  const apps = [{ id: 'pair-one', name: 'One', apple: { appId: '111', bundleId: 'com.example.one' }, google: null }];
  const config = { storeStatus: { pollMinutes: 10 } };
  assert.strictEqual(getTtlMs(config), 10 * 60 * 1000);
  assert.strictEqual(getTtlMs({}), 15 * 60 * 1000);
  assert.strictEqual(getTtlMs({ storeStatus: { pollMinutes: 0 } }), 15 * 60 * 1000, 'nonsense interval falls back to the default');

  let calls = 0;
  let fail = null;
  const client = {
    async get(pathname) {
      calls++;
      if (fail) throw fail;
      if (pathname.includes('appStoreVersions')) return { data: [version('v1', '1.0', 'READY_FOR_DISTRIBUTION', '2026-01-01T00:00:00Z')] };
      return { data: [] };
    }
  };
  const t0 = new Date('2026-11-14T12:00:00Z');

  let out = await getStatusForApps(config, apps, { appleClient: client, now: t0 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(out['pair-one'].apple.status.platforms[0].live.version, '1.0');
  assert.strictEqual(out['pair-one'].apple.error, null);
  assert.strictEqual(out['pair-one'].google, null);

  out = await getStatusForApps(config, apps, { appleClient: client, now: new Date(t0.getTime() + 5 * 60 * 1000) });
  assert.strictEqual(calls, 2, 'within the TTL the snapshot is served without calling Apple');

  out = await getStatusForApps(config, apps, { appleClient: client, now: new Date(t0.getTime() + 5 * 60 * 1000), fresh: true });
  assert.strictEqual(calls, 4, 'fresh bypasses the cache');

  // A failed refresh keeps the last good status and reports the error next to it.
  fail = { response: { status: 403, data: { errors: [{ title: 'Forbidden', detail: 'nope' }] } } };
  const later = new Date(t0.getTime() + 60 * 60 * 1000);
  out = await getStatusForApps(config, apps, { appleClient: client, now: later });
  assert.strictEqual(out['pair-one'].apple.error.code, 'APPLE_FORBIDDEN');
  assert.strictEqual(out['pair-one'].apple.status.platforms[0].live.version, '1.0', 'stale status survives a failed fetch');
  assert(out['pair-one'].apple.fetchedAt < out['pair-one'].apple.checkedAt, 'fetchedAt stays at the last success');

  const before = calls;
  out = await getStatusForApps(config, apps, { appleClient: client, now: new Date(later.getTime() + 60 * 1000) });
  assert.strictEqual(calls, before, 'a failure is cached for the TTL too, so a broken key is not hammered');
  assert.strictEqual(out['pair-one'].apple.error.code, 'APPLE_FORBIDDEN');

  // No Apple credentials configured.
  const none = await getStatusForApps({}, [{ id: 'x', name: 'X', apple: { appId: '999' }, google: null }], { now: t0 });
  assert.strictEqual(none.x.apple.error.code, 'APPLE_NOT_CONFIGURED');
  assert.strictEqual(none.x.apple.status, null);

  assert.strictEqual(store.getSnapshot('apple', 'never-seen', 'release'), null);
  console.log('✓ status service caches, refreshes and degrades');
}

(async () => {
  try {
    testStateMapping();
    testPhasedRelease();
    testSummarizeVersions();
    testReviewSubmissions();
    testClassifyAppleError();
    await testClientIsReadOnly();
    await testServiceCaching();
    console.log('All store status Apple tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();

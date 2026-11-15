const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/db opens DB_PATH at load time: use a throwaway database for this test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-store-rollout-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.DATA_DIR = tmpDir;

const axios = require('axios');
const { createEditsReader, summarizeRollout, fetchGoogleRollout } = require('../lib/storeStatus/googleRollout');
const { getStatusForApps, isRolloutEnabled } = require('../lib/storeStatus/service');

const EDITS = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.one/edits';
const tracksBody = {
  kind: 'androidpublisher#tracksListResponse',
  tracks: [
    { track: 'production', releases: [
      { name: '1.3.0', versionCodes: ['37'], status: 'inProgress', userFraction: 0.2 },
      { name: '1.2.0', versionCodes: ['35'], status: 'completed' }
    ] },
    { track: 'beta', releases: [{ name: '1.4.0', versionCodes: ['40', '41'], status: 'halted', userFraction: 0.5 }] },
    { track: 'alpha', releases: [] },
    { track: 'internal' }
  ]
};

/** Stub the network; `handler(config)` returns { status, data }. Returns the list of requests seen. */
async function withAdapter(handler, fn) {
  const calls = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls.push({ method: config.method, url: config.url, data: config.data });
    const { status = 200, data = {} } = await handler(config);
    const response = { data, status, statusText: String(status), headers: {}, config };
    if (status >= 200 && status < 300) return response;
    const err = new Error(`Request failed with status code ${status}`);
    err.response = response;
    throw err;
  };
  try {
    await fn(calls);
  } finally {
    axios.defaults.adapter = original;
  }
  return calls;
}

const assertNeverWrites = (calls) => {
  calls.forEach(c => {
    assert(!/:commit|:validate/.test(c.url), 'an edit is never committed or validated');
    assert(!['put', 'patch'].includes(c.method), 'nothing in an edit is ever modified');
    if (c.method === 'post') {
      assert.strictEqual(c.url, EDITS, 'the only POST opens an edit');
      assert.strictEqual(c.data, '{}', 'and it carries no content');
    }
  });
};

function testSummarize() {
  const out = summarizeRollout(tracksBody);
  assert.deepStrictEqual(Object.keys(out.tracks), ['production', 'beta'], 'tracks without releases are left out');
  assert.deepStrictEqual(out.tracks.production[0], { name: '1.3.0', versionCodes: [37], status: 'inProgress', userFraction: 0.2 });
  assert.deepStrictEqual(out.tracks.production[1], { name: '1.2.0', versionCodes: [35], status: 'completed', userFraction: null });
  assert.deepStrictEqual(out.tracks.beta[0].versionCodes, [41, 40]);
  assert.strictEqual(out.tracks.beta[0].status, 'halted');
  assert.strictEqual(summarizeRollout({ tracks: [{ track: 'x', releases: [{ status: 'weird', userFraction: 7 }] }] }).tracks.x[0].status, null);
  assert.strictEqual(summarizeRollout({ tracks: [{ track: 'x', releases: [{ status: 'inProgress', userFraction: 7 }] }] }).tracks.x[0].userFraction, null, 'nonsense fractions are dropped');
  assert.deepStrictEqual(summarizeRollout(undefined), { tracks: {} });
  console.log('✓ summarizeRollout');
}

async function testEditSequence() {
  const reader = createEditsReader(async () => 'test-token');
  assert.deepStrictEqual(Object.keys(reader), ['readTracks'], 'the reader exposes one fixed sequence and nothing else');

  // Normal run: open, read, delete.
  let calls = await withAdapter(async (config) => {
    if (config.method === 'post') return { data: { id: 'edit-1', expiryTimeSeconds: '1794800000' } };
    if (config.method === 'get') return { data: tracksBody };
    return { status: 204, data: '' };
  }, async () => {
    const out = await fetchGoogleRollout(reader, 'com.example.one');
    assert.strictEqual(out.tracks.production[0].userFraction, 0.2);
  });
  assert.deepStrictEqual(calls.map(c => `${c.method} ${c.url}`), [
    `post ${EDITS}`, `get ${EDITS}/edit-1/tracks`, `delete ${EDITS}/edit-1`
  ]);
  assertNeverWrites(calls);

  // Reading fails (for example the edit was invalidated): the edit is still deleted and the error surfaces.
  calls = await withAdapter(async (config) => {
    if (config.method === 'post') return { data: { id: 'edit-2' } };
    if (config.method === 'get') return { status: 404, data: { error: { message: 'Edit not found', status: 'NOT_FOUND' } } };
    return { status: 204, data: '' };
  }, async () => {
    const err = await reader.readTracks('com.example.one').catch(e => e);
    assert.strictEqual(err.response.status, 404);
  });
  assert.deepStrictEqual(calls.map(c => c.method), ['post', 'get', 'delete'], 'delete runs even when the read fails');
  assertNeverWrites(calls);

  // Delete fails: the tracks are still returned.
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    calls = await withAdapter(async (config) => {
      if (config.method === 'post') return { data: { id: 'edit-3' } };
      if (config.method === 'get') return { data: tracksBody };
      return { status: 500, data: {} };
    }, async () => {
      const body = await reader.readTracks('com.example.one');
      assert.strictEqual(body.tracks.length, 4);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(warnings.length, 1);
  assert(!/test-token/.test(warnings[0]));

  // Opening the edit is refused (view-only permissions): nothing else is sent.
  calls = await withAdapter(async () => ({ status: 403, data: { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } }), async () => {
    await assert.rejects(() => reader.readTracks('com.example.one'));
  });
  assert.deepStrictEqual(calls.map(c => c.method), ['post'], 'no edit, so nothing to read or delete');

  // No edit ID in the answer: nothing to read, nothing to delete.
  calls = await withAdapter(async () => ({ data: {} }), async () => {
    await assert.rejects(() => reader.readTracks('com.example.one'), /edit ID/);
  });
  assert.strictEqual(calls.length, 1);

  // IDs are encoded into the path.
  calls = await withAdapter(async (config) => (config.method === 'post' ? { data: { id: '../x' } } : { data: {} }), async () => {
    await reader.readTracks('com.example.one');
  });
  assert.strictEqual(calls[1].url, `${EDITS}/..%2Fx/tracks`);
  console.log('✓ edits are opened, read and deleted, never changed');
}

async function testOptIn() {
  assert.strictEqual(isRolloutEnabled({}), false, 'off by default');
  assert.strictEqual(isRolloutEnabled({ storeStatus: { google: {} } }), false);
  assert.strictEqual(isRolloutEnabled({ storeStatus: { google: { readRolloutViaEdits: 'true' } } }), false, 'only a real boolean true switches it on');
  assert.strictEqual(isRolloutEnabled({ storeStatus: { google: { readRolloutViaEdits: true } } }), true);

  const apps = [{ id: 'one', name: 'One', apple: null, google: { packageName: 'com.example.one' } }];
  const sections = { reviews: false, vitals: false };
  const googleClient = { async get() { return ''; } };
  let reads = 0;
  let failure = null;
  const editsReader = { async readTracks() { reads++; if (failure) throw failure; return tracksBody; } };
  const t0 = new Date('2026-11-15T12:00:00Z');
  const at = (minutes) => new Date(t0.getTime() + minutes * 60 * 1000);

  // Flag off: the reader is never used, even when one is available.
  let out = await getStatusForApps({ storeStatus: { sections } }, apps, { googleClient, editsReader, now: t0 });
  assert.strictEqual(reads, 0);
  assert.strictEqual(out.one.google.rollout, undefined);

  const on = { storeStatus: { sections, google: { readRolloutViaEdits: true } } };
  out = await getStatusForApps(on, apps, { googleClient, editsReader, now: at(1) });
  assert.strictEqual(reads, 1);
  assert.strictEqual(out.one.google.rollout.status.tracks.production[0].userFraction, 0.2);

  // Polls do not open an edit every time: at most once an hour.
  await getStatusForApps(on, apps, { googleClient, editsReader, poll: true, now: at(16) });
  await getStatusForApps(on, apps, { googleClient, editsReader, poll: true, now: at(31) });
  assert.strictEqual(reads, 1);
  await getStatusForApps(on, apps, { googleClient, editsReader, poll: true, now: at(62) });
  assert.strictEqual(reads, 2);

  // Not permitted: a specific message, release state unaffected, last good rollout kept.
  failure = { response: { status: 403, data: { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } } };
  out = await getStatusForApps(on, apps, { googleClient, editsReader, fresh: true, now: at(63) });
  assert.strictEqual(out.one.google.rollout.error.code, 'GOOGLE_FORBIDDEN');
  assert(/readRolloutViaEdits/.test(out.one.google.rollout.error.hint));
  assert.strictEqual(out.one.google.error, null);
  assert.strictEqual(out.one.google.rollout.status.tracks.beta[0].status, 'halted');
  console.log('✓ rollout via edits is opt-in, throttled and degrades alone');
}

(async () => {
  try {
    testSummarize();
    await testEditSequence();
    await testOptIn();
    console.log('All store status rollout tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();

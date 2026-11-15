const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/db opens DB_PATH at load time: use a throwaway database for this test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-store-google-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.DATA_DIR = tmpDir;

const axios = require('axios');
const jwt = require('jsonwebtoken');
const { STATE, GOOGLE_RELEASE_STATE, normalizeGoogleReleaseState, stripGoogleStatePrefix } = require('../lib/storeStatus/states');
const {
  TOKEN_URL, DEFAULT_SCOPES, loadGoogleCredentials, createGoogleTokenProvider, getGoogleTokenProvider
} = require('../lib/storeStatus/googleAuth');
const {
  PUBLISHER_BASE, DEFAULT_TRACKS, createGoogleClient, getTracks, summarizeTrack, fetchGoogleAppStatus
} = require('../lib/storeStatus/googleStatus');
const { classifyGoogleError } = require('../lib/storeStatus/errors');
const { diffGoogleStatus, describeEvent } = require('../lib/storeStatus/changes');
const store = require('../lib/storeStatus/store');
const { getStatusForApps, isNotifyTrack } = require('../lib/storeStatus/service');
const { runStoreStatusPoll } = require('../lib/storeStatus/poller');

// A throwaway key pair generated for this run; nothing here is a real credential.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const credentials = { clientEmail: 'status@example-project.iam.gserviceaccount.com', privateKey, privateKeyId: 'kid-1' };

const release = (releaseName, versionCode, state, track = 'production') => ({
  releaseName,
  activeArtifacts: versionCode ? [{ versionCode }] : undefined,
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  track
});

/** Replace the axios adapter for the duration of `fn`; `handler(config)` returns { status, data }. */
async function withAdapter(handler, fn) {
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const { status = 200, data = {} } = await handler(config);
    const response = { data, status, statusText: String(status), headers: {}, config };
    if (status >= 200 && status < 300) return response;
    const err = new Error(`Request failed with status code ${status}`);
    err.response = response;
    err.config = config;
    throw err;
  };
  try {
    return await fn();
  } finally {
    axios.defaults.adapter = original;
  }
}

function testStateMapping() {
  const all = ['DRAFT', 'NOT_SENT_FOR_REVIEW', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'NOT_APPROVED', 'PUBLISHED'];
  all.forEach(raw => assert(GOOGLE_RELEASE_STATE[raw], `releaseLifecycleState ${raw} must be mapped`));
  assert.strictEqual(Object.keys(GOOGLE_RELEASE_STATE).length, all.length, 'no stray states in the mapping');
  assert.strictEqual(normalizeGoogleReleaseState('RELEASE_LIFECYCLE_STATE_PUBLISHED'), STATE.LIVE);
  assert.strictEqual(normalizeGoogleReleaseState('RELEASE_LIFECYCLE_STATE_IN_REVIEW'), STATE.IN_REVIEW);
  assert.strictEqual(normalizeGoogleReleaseState('RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED'), STATE.APPROVED_PENDING_RELEASE);
  assert.strictEqual(normalizeGoogleReleaseState('RELEASE_LIFECYCLE_STATE_NOT_APPROVED'), STATE.REJECTED);
  assert.strictEqual(normalizeGoogleReleaseState('RELEASE_LIFECYCLE_STATE_UNSPECIFIED'), STATE.OTHER);
  assert.strictEqual(normalizeGoogleReleaseState(undefined), STATE.OTHER);
  assert.strictEqual(stripGoogleStatePrefix('RELEASE_LIFECYCLE_STATE_DRAFT'), 'DRAFT');
  assert.strictEqual(stripGoogleStatePrefix(undefined), null);
  console.log('✓ every releaseLifecycleState maps to a normalized state');
}

async function testTokenProvider() {
  const requests = [];
  let clock = Date.parse('2026-11-15T12:00:00Z');
  let issued = 0;
  await withAdapter(async (config) => {
    requests.push(config);
    return { data: { access_token: `token-${++issued}`, expires_in: 3600, token_type: 'Bearer' } };
  }, async () => {
    const getToken = createGoogleTokenProvider(credentials, { now: () => clock });

    const [a, b] = await Promise.all([getToken(), getToken()]);
    assert.strictEqual(a, 'token-1');
    assert.strictEqual(b, 'token-1');
    assert.strictEqual(requests.length, 1, 'concurrent callers share one exchange');

    const req = requests[0];
    assert.strictEqual(req.method, 'post');
    assert.strictEqual(req.url, TOKEN_URL);
    const form = new URLSearchParams(req.data);
    assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = jwt.verify(form.get('assertion'), publicKey, { algorithms: ['RS256'], clockTimestamp: clock / 1000 });
    assert.strictEqual(claims.iss, credentials.clientEmail);
    assert.strictEqual(claims.aud, TOKEN_URL);
    assert.strictEqual(claims.scope, DEFAULT_SCOPES.join(' '));
    assert.strictEqual(claims.exp - claims.iat, 3600);
    assert.strictEqual(jwt.decode(form.get('assertion'), { complete: true }).header.kid, 'kid-1');

    clock += 30 * 60 * 1000;
    assert.strictEqual(await getToken(), 'token-1', 'a live token is reused');
    assert.strictEqual(requests.length, 1);

    clock += 29.5 * 60 * 1000;
    assert.strictEqual(await getToken(), 'token-2', 'a token inside the expiry margin is replaced');
    assert.strictEqual(requests.length, 2);

    // Module-level providers are shared per key, and replaced when the key changes.
    assert.strictEqual(getGoogleTokenProvider(credentials), getGoogleTokenProvider(credentials));
    assert.notStrictEqual(getGoogleTokenProvider(credentials), getGoogleTokenProvider({ ...credentials, privateKey: `${privateKey}\n` }));
  });

  // A rejected key surfaces as an OAuth error and is retried on the next call, not cached.
  let attempts = 0;
  await withAdapter(async () => {
    attempts++;
    return { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
  }, async () => {
    const getToken = createGoogleTokenProvider(credentials);
    const first = await getToken().catch(e => e);
    assert.strictEqual(classifyGoogleError(first).code, 'GOOGLE_UNAUTHORIZED');
    await getToken().catch(() => {});
    assert.strictEqual(attempts, 2);
  });

  // A key that cannot sign never reaches the network and never leaks key text.
  await withAdapter(async () => { throw new Error('must not be called'); }, async () => {
    const getToken = createGoogleTokenProvider({ ...credentials, privateKey: 'NOT-A-KEY-secret-material' });
    const err = await getToken().catch(e => e);
    assert.strictEqual(err.code, 'GOOGLE_KEY_INVALID');
    assert(!String(err.message).includes('secret-material'));
    assert.strictEqual(classifyGoogleError(err).code, 'GOOGLE_NOT_CONFIGURED');
  });
  console.log('✓ service-account token exchange, caching and failure');
}

function testLoadCredentials() {
  const keyJson = { type: 'service_account', project_id: 'p', client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey, private_key_id: 'k', token_uri: 'https://evil.example/token' };
  const fromObject = loadGoogleCredentials({ keyJson });
  assert.deepStrictEqual(Object.keys(fromObject).sort(), ['clientEmail', 'privateKey', 'privateKeyId'], 'token_uri from the key file is ignored');
  assert.strictEqual(loadGoogleCredentials({ keyJson: JSON.stringify(keyJson) }).clientEmail, 'a@b.iam.gserviceaccount.com');
  assert.strictEqual(loadGoogleCredentials({}), null);
  assert.strictEqual(loadGoogleCredentials({ keyJson: '{not json' }), null);
  assert.strictEqual(loadGoogleCredentials({ keyJson: { client_email: 'x' } }), null, 'a key without a private key is unusable');
  assert.strictEqual(loadGoogleCredentials({ keyFilePath: 'keys/does-not-exist.json' }), null);
  // A dedicated status key that is missing does not silently fall back to the analytics key.
  assert.strictEqual(loadGoogleCredentials({ keyJson, storeStatus: { google: { keyFilePath: 'keys/does-not-exist.json' } } }), null);
  console.log('✓ loadGoogleCredentials');
}

function testSummarizeTrack() {
  // Unordered, as the API returns them: a draft listed before the published release.
  const alpha = summarizeTrack('alpha', { releases: [
    { releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_DRAFT', track: 'alpha' },
    release('10011 (1.0.11-dev)', 10011, 'PUBLISHED', 'alpha')
  ] });
  assert.strictEqual(alpha.live.version, '10011 (1.0.11-dev)');
  assert.strictEqual(alpha.live.buildNumber, null, 'the version code is not repeated when the name already carries it');
  assert.deepStrictEqual(alpha.live.versionCodes, [10011]);
  assert.strictEqual(alpha.live.state, STATE.LIVE);
  assert.strictEqual(alpha.live.rawState, 'PUBLISHED');
  assert.strictEqual(alpha.inFlight.state, STATE.DRAFT, 'an empty draft is still the in-flight release');
  assert.strictEqual(alpha.inFlight.version, null);

  const prod = summarizeTrack('production', { releases: [
    release('1.2.0', 35, 'PUBLISHED'),
    release('1.3.0', 37, 'IN_REVIEW')
  ] });
  assert.strictEqual(prod.live.version, '1.2.0');
  assert.strictEqual(prod.live.buildNumber, '35');
  assert.strictEqual(prod.inFlight.version, '1.3.0');
  assert.strictEqual(prod.inFlight.state, STATE.IN_REVIEW);

  // Staged rollout: two published releases, the newer one is "live".
  const staged = summarizeTrack('production', { releases: [release('1.2.0', 35, 'PUBLISHED'), release('1.3.0', 37, 'PUBLISHED')] });
  assert.strictEqual(staged.live.version, '1.3.0');
  assert.strictEqual(staged.inFlight, null);
  assert.strictEqual(staged.publishedCount, 2);

  // A rejected release older than what is live is a leftover.
  const leftover = summarizeTrack('production', { releases: [release('1.3.0', 37, 'PUBLISHED'), release('1.2.5', 36, 'NOT_APPROVED')] });
  assert.strictEqual(leftover.inFlight, null);

  // An empty track answers 204 with an empty body.
  ['', null, undefined, {}].forEach(body => {
    assert.deepStrictEqual(summarizeTrack('beta', body), { track: 'beta', live: null, inFlight: null, publishedCount: 0 });
  });
  console.log('✓ summarizeTrack picks live and in-flight releases');
}

function testTracksConfig() {
  assert.deepStrictEqual(getTracks({}), DEFAULT_TRACKS);
  assert.deepStrictEqual(DEFAULT_TRACKS, ['production', 'beta', 'alpha', 'internal']);
  assert.deepStrictEqual(getTracks({ storeStatus: { google: { tracks: ['production', ' wear:production ', 'production', 7, ''] } } }), ['production', 'wear:production']);
  assert.deepStrictEqual(getTracks({ storeStatus: { google: { tracks: [] } } }), DEFAULT_TRACKS);
  assert.deepStrictEqual(getTracks({ storeStatus: { google: { tracks: 'production' } } }), DEFAULT_TRACKS);

  assert.strictEqual(isNotifyTrack({}, 'production'), true);
  assert.strictEqual(isNotifyTrack({}, 'internal'), false, 'internal-track changes are quiet by default');
  assert.strictEqual(isNotifyTrack({ storeStatus: { google: { notifyTracks: ['internal'] } } }, 'internal'), true);
  assert.strictEqual(isNotifyTrack({ storeStatus: { google: { notifyTracks: ['internal'] } } }, 'production'), false);
  console.log('✓ track configuration');
}

function testClassifyGoogleError() {
  const withStatus = (status, error) => ({ response: { status, data: { error } }, config: { headers: { Authorization: 'Bearer SECRET-TOKEN' }, data: 'assertion=SECRET-ASSERTION' } });

  const forbidden = classifyGoogleError(withStatus(403, { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' }));
  assert.strictEqual(forbidden.code, 'GOOGLE_FORBIDDEN');
  assert(/View app information/.test(forbidden.hint), 'hint names the missing permission');
  assert(!/SECRET/.test(JSON.stringify(forbidden)), 'never echoes the token or the assertion');

  const disabled = classifyGoogleError(withStatus(403, {
    code: 403, status: 'PERMISSION_DENIED', message: 'Google Play Android Developer API has not been used in project 123 before or it is disabled.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { service: 'androidpublisher.googleapis.com', consumer: 'projects/123' } }]
  }));
  assert.strictEqual(disabled.code, 'GOOGLE_API_DISABLED');
  assert(disabled.message.startsWith('Google Play Android Developer API'));
  assert.strictEqual(classifyGoogleError(withStatus(403, { status: 'PERMISSION_DENIED', message: 'Some API has not been used in project 1 before or it is disabled.' })).code, 'GOOGLE_API_DISABLED', 'recognised from the message when details are missing');

  assert.strictEqual(classifyGoogleError(withStatus(401, { message: 'Invalid Credentials' })).code, 'GOOGLE_UNAUTHORIZED');
  assert.strictEqual(classifyGoogleError({ response: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } }).code, 'GOOGLE_UNAUTHORIZED');
  const notFound = classifyGoogleError(withStatus(404, { message: 'Package not found: com.example.gone.', status: 'NOT_FOUND' }));
  assert.strictEqual(notFound.code, 'GOOGLE_NOT_FOUND');
  assert(/Package not found/.test(notFound.detail));
  assert.strictEqual(classifyGoogleError(withStatus(429, {})).code, 'GOOGLE_RATE_LIMITED');
  assert.strictEqual(classifyGoogleError(withStatus(503, {})).code, 'GOOGLE_UNAVAILABLE');
  assert.strictEqual(classifyGoogleError({ code: 'ECONNRESET' }).code, 'NETWORK');
  assert.strictEqual(classifyGoogleError({ code: 'GOOGLE_NOT_CONFIGURED' }).code, 'GOOGLE_NOT_CONFIGURED');
  console.log('✓ classifyGoogleError');
}

async function testClientIsReadOnly() {
  const calls = [];
  const bodies = {
    production: { releases: [release('1.3.0', 37, 'PUBLISHED')] },
    beta: '',
    alpha: { releases: [release('1.4.0', 40, 'IN_REVIEW', 'alpha'), release('1.0.0', 18, 'PUBLISHED', 'alpha')] }
  };
  await withAdapter(async (config) => {
    calls.push(config);
    const track = decodeURIComponent(config.url.split('/tracks/')[1].split('/')[0]);
    if (config.url.includes('com.example.gone')) return { status: 404, data: { error: { code: 404, message: 'Package not found: com.example.gone.', status: 'NOT_FOUND' } } };
    if (!(track in bodies)) return { status: 404, data: { error: { code: 404, message: `Track not found: ${track}.`, status: 'NOT_FOUND' } } };
    return bodies[track] === '' ? { status: 204, data: '' } : { data: bodies[track] };
  }, async () => {
    const client = createGoogleClient(async () => 'test-token');
    assert.deepStrictEqual(Object.keys(client), ['get'], 'the client exposes GET only');
    await assert.rejects(() => client.get('https://evil.example/androidpublisher/v3/applications/x'), /only reads/);
    await assert.rejects(() => client.get('https://androidpublisher.googleapis.com.evil.example/androidpublisher/v3/applications/x'), /only reads/);
    await assert.rejects(() => client.get('/androidpublisher/v3/applications/x'), /only reads/);
    assert.strictEqual(calls.length, 0);

    const status = await fetchGoogleAppStatus(client, 'com.example.one', ['production', 'beta', 'alpha', 'internal']);
    assert.strictEqual(calls.length, 4, 'one request per track');
    assert(calls.every(c => c.method === 'get'), 'GET only');
    assert(calls.every(c => c.url.startsWith(`${PUBLISHER_BASE}com.example.one/tracks/`) && c.url.endsWith('/releases')));
    assert(calls.every(c => !c.url.includes('/edits')), 'never touches the edits API');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer test-token');
    assert.deepStrictEqual(status.tracks.map(t => t.track), ['production', 'alpha'], 'empty (204) and missing (404) tracks are left out');
    assert.strictEqual(status.tracks[1].inFlight.version, '1.4.0');
    assert.strictEqual(status.tracks[1].live.version, '1.0.0');

    // Unknown package: an error, not an empty result.
    const err = await fetchGoogleAppStatus(client, 'com.example.gone', ['production']).catch(e => e);
    assert.strictEqual(classifyGoogleError(err).code, 'GOOGLE_NOT_FOUND');

    // Odd track names are encoded into the path.
    calls.length = 0;
    await fetchGoogleAppStatus(client, 'com.example.one', ['my track/../x']);
    assert(calls[0].url.endsWith('/tracks/my%20track%2F..%2Fx/releases'));
  });
  console.log('✓ Google client issues GET requests only');
}

function testDiff() {
  const r = (version, code, rawState) => ({ version, versionCodes: code ? [code] : [], rawState, state: normalizeGoogleReleaseState(rawState) });
  const status = (...tracks) => ({ tracks });
  const track = (name, live, inFlight) => ({ track: name, live, inFlight });

  const base = status(track('production', r('1.2.0', 35, 'PUBLISHED'), r('1.3.0', 37, 'IN_REVIEW')));
  assert.deepStrictEqual(diffGoogleStatus(null, base), [], 'first sighting is a silent baseline');
  assert.deepStrictEqual(diffGoogleStatus(base, base), []);

  assert.deepStrictEqual(
    diffGoogleStatus(base, status(track('production', r('1.3.0', 37, 'PUBLISHED'), null))),
    [{ subject: 'production 1.3.0', fromState: 'IN_REVIEW', toState: 'PUBLISHED', track: 'production' }]);

  assert.deepStrictEqual(
    diffGoogleStatus(base, status(track('production', r('1.2.0', 35, 'PUBLISHED'), r('1.3.0', 37, 'NOT_APPROVED')))),
    [{ subject: 'production 1.3.0', fromState: 'IN_REVIEW', toState: 'NOT_APPROVED', track: 'production' }]);

  // Drafts are not news; sending one for review is.
  const settled = status(track('production', r('1.3.0', 37, 'PUBLISHED'), null));
  assert.deepStrictEqual(diffGoogleStatus(settled, status(track('production', r('1.3.0', 37, 'PUBLISHED'), r('1.4.0', 40, 'DRAFT')))), []);
  assert.deepStrictEqual(diffGoogleStatus(settled, status(track('production', r('1.3.0', 37, 'PUBLISHED'), r(null, 0, 'DRAFT')))), []);
  assert.deepStrictEqual(
    diffGoogleStatus(settled, status(track('production', r('1.3.0', 37, 'PUBLISHED'), r('1.4.0', 40, 'IN_REVIEW')))),
    [{ subject: 'production 1.4.0', fromState: null, toState: 'IN_REVIEW', track: 'production' }]);

  // The same release name on two tracks is two subjects, labelled the way Play Console names them.
  const promoted = diffGoogleStatus(
    status(track('beta', r('1.4.0', 40, 'PUBLISHED'), null), track('production', r('1.3.0', 37, 'PUBLISHED'), null)),
    status(track('beta', r('1.4.0', 40, 'PUBLISHED'), null), track('production', r('1.3.0', 37, 'PUBLISHED'), r('1.4.0', 40, 'APPROVED_NOT_PUBLISHED'))));
  assert.deepStrictEqual(promoted, [{ subject: 'production 1.4.0', fromState: null, toState: 'APPROVED_NOT_PUBLISHED', track: 'production' }]);
  assert.strictEqual(diffGoogleStatus(status(), status(track('alpha', r('2.0', 50, 'PUBLISHED'), null)))[0].subject, 'closed testing 2.0');

  assert.deepStrictEqual(
    describeEvent({ platform: 'google', app_name: 'One', app_id: 'com.example.one', subject: 'production 1.3.0', from_state: 'IN_REVIEW', to_state: 'PUBLISHED' }),
    { title: 'Google Play: One production 1.3.0', message: 'in review → published' });
  console.log('✓ diffGoogleStatus reports real transitions only');
}

async function testServiceAndPoller() {
  const apps = [
    { id: 'pair-one', name: 'One', apple: null, google: { packageName: 'com.example.one' } },
    { id: 'google-two', name: 'Two', apple: null, google: { packageName: 'com.example.two' } }
  ];
  const config = { storeStatus: { enabled: true, pollMinutes: 10 }, ntfyTopic: 'topic-x' };

  let calls = 0;
  let prodState = 'IN_REVIEW';
  let internalCode = 50;
  let failure = null;
  const googleClient = {
    async get(url) {
      calls++;
      if (failure) throw failure;
      if (url.includes('com.example.two')) throw { response: { status: 403, data: { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } } };
      if (url.includes('/tracks/production/')) return { releases: [release('1.2.0', 35, 'PUBLISHED'), release('1.3.0', 37, prodState)] };
      if (url.includes('/tracks/internal/')) return { releases: [release(`1.4.0-${internalCode}`, internalCode, 'PUBLISHED', 'internal')] };
      return '';
    }
  };
  const t0 = new Date('2026-11-15T12:00:00Z');

  let out = await getStatusForApps(config, apps, { googleClient, now: t0 });
  assert.strictEqual(calls, 8, 'four tracks per app');
  const one = out['pair-one'].google;
  assert.strictEqual(out['pair-one'].apple, null);
  assert.strictEqual(one.error, null);
  assert.deepStrictEqual(one.status.tracks.map(t => t.track), ['production', 'internal']);
  assert.strictEqual(one.status.tracks[0].inFlight.state, STATE.IN_REVIEW);
  assert.strictEqual(out['google-two'].google.error.code, 'GOOGLE_FORBIDDEN', 'one app failing does not affect the other');
  assert.strictEqual(out['google-two'].google.status, null);

  out = await getStatusForApps(config, apps, { googleClient, now: new Date(t0.getTime() + 5 * 60 * 1000) });
  assert.strictEqual(calls, 8, 'within the TTL nothing is fetched, including the failed app');

  // A failed refresh keeps the last good status.
  failure = { response: { status: 503, data: {} } };
  out = await getStatusForApps(config, apps, { googleClient, now: new Date(t0.getTime() + 20 * 60 * 1000) });
  assert.strictEqual(out['pair-one'].google.error.code, 'GOOGLE_UNAVAILABLE');
  assert.strictEqual(out['pair-one'].google.status.tracks[0].live.version, '1.2.0');
  failure = null;

  // No credentials configured.
  const none = await getStatusForApps({}, [{ id: 'x', name: 'X', apple: null, google: { packageName: 'com.example.none' } }], { now: t0 });
  assert.strictEqual(none.x.google.error.code, 'GOOGLE_NOT_CONFIGURED');

  // Poller: one alert per production transition; internal-track changes are recorded quietly.
  const sent = [];
  const notify = async (options) => { sent.push(options); return {}; };
  let clock = t0.getTime() + 60 * 60 * 1000;
  const poll = () => { clock += 15 * 60 * 1000; return runStoreStatusPoll(config, { apps, googleClient, notify, now: new Date(clock) }); };

  await poll();
  assert.strictEqual(sent.length, 0, 'unchanged state sends nothing');

  prodState = 'PUBLISHED';
  internalCode = 51;
  const result = await poll();
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(sent.length, 1, 'the production change alerts, the internal upload does not');
  assert.strictEqual(sent[0].title, 'Google Play: One production 1.3.0');
  assert.strictEqual(sent[0].message, 'in review → published');

  await poll();
  assert.strictEqual(sent.length, 1, 'never announced twice');
  assert.strictEqual(store.getPendingEvents().length, 0);
  const recent = store.getRecentEvents(10).filter(e => e.platform === 'google');
  assert.deepStrictEqual(recent.map(e => e.subject).sort(), ['internal testing 1.4.0-51', 'production 1.3.0'], 'both changes are in the history');
  console.log('✓ Google status is cached, degrades per app and notifies once');
}

(async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    testStateMapping();
    await testTokenProvider();
    testLoadCredentials();
    testSummarizeTrack();
    testTracksConfig();
    testClassifyGoogleError();
    await testClientIsReadOnly();
    testDiff();
    await testServiceAndPoller();
    console.log('All store status Google tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();

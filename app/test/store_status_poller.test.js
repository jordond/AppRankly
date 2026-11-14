const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-store-poller-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.DATA_DIR = tmpDir;

const { diffAppleStatus, describeEvent } = require('../lib/storeStatus/changes');
const { normalizeAppleVersionState } = require('../lib/storeStatus/states');
const store = require('../lib/storeStatus/store');
const { isEnabled, runStoreStatusPoll } = require('../lib/storeStatus/poller');

const v = (version, rawState) => ({ version, rawState, state: normalizeAppleVersionState(rawState) });
const status = (live, inFlight, submissionState = 'COMPLETE') => ({
  platforms: [{ platform: 'IOS', live, inFlight }],
  reviewSubmission: { state: submissionState }
});

function testDiff() {
  const base = status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), v('1.3.0', 'WAITING_FOR_REVIEW'));

  assert.deepStrictEqual(diffAppleStatus(null, base), [], 'first sighting is a silent baseline');
  assert.deepStrictEqual(diffAppleStatus(base, base), [], 'no change, no event');

  assert.deepStrictEqual(
    diffAppleStatus(base, status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), v('1.3.0', 'IN_REVIEW'))),
    [{ subject: 'iOS 1.3.0', fromState: 'WAITING_FOR_REVIEW', toState: 'IN_REVIEW' }]);

  // Released: the in-flight version becomes the live one; the old live version drops out quietly.
  assert.deepStrictEqual(
    diffAppleStatus(status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), v('1.3.0', 'PENDING_DEVELOPER_RELEASE')), status(v('1.3.0', 'READY_FOR_DISTRIBUTION'), null)),
    [{ subject: 'iOS 1.3.0', fromState: 'PENDING_DEVELOPER_RELEASE', toState: 'READY_FOR_DISTRIBUTION' }]);

  // A new draft is not news; submitting it is.
  const settled = status(v('1.3.0', 'READY_FOR_DISTRIBUTION'), null);
  assert.deepStrictEqual(diffAppleStatus(settled, status(v('1.3.0', 'READY_FOR_DISTRIBUTION'), v('1.4.0', 'PREPARE_FOR_SUBMISSION'))), []);
  assert.deepStrictEqual(
    diffAppleStatus(settled, status(v('1.3.0', 'READY_FOR_DISTRIBUTION'), v('1.4.0', 'WAITING_FOR_REVIEW'))),
    [{ subject: 'iOS 1.4.0', fromState: null, toState: 'WAITING_FOR_REVIEW' }]);

  // Rejection: one event, not a second one for the submission.
  const rejected = diffAppleStatus(
    status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), v('1.3.0', 'IN_REVIEW'), 'IN_REVIEW'),
    status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), v('1.3.0', 'REJECTED'), 'UNRESOLVED_ISSUES'));
  assert.deepStrictEqual(rejected, [{ subject: 'iOS 1.3.0', fromState: 'IN_REVIEW', toState: 'REJECTED' }]);

  // Unresolved issues without a version state change (for example an in-app purchase item).
  const unresolved = diffAppleStatus(status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), null, 'IN_REVIEW'), status(v('1.2.0', 'READY_FOR_DISTRIBUTION'), null, 'UNRESOLVED_ISSUES'));
  assert.deepStrictEqual(unresolved, [{ subject: 'review submission', fromState: 'IN_REVIEW', toState: 'UNRESOLVED_ISSUES' }]);

  assert.deepStrictEqual(
    describeEvent({ platform: 'apple', app_name: 'One', app_id: '111', subject: 'iOS 1.3.0', from_state: 'IN_REVIEW', to_state: 'PENDING_DEVELOPER_RELEASE' }),
    { title: 'App Store: One iOS 1.3.0', message: 'in review → pending developer release' });
  assert.strictEqual(describeEvent({ platform: 'apple', app_id: '111', subject: 'iOS 1.4.0', from_state: null, to_state: 'WAITING_FOR_REVIEW' }).message, 'waiting for review');
  console.log('✓ diffAppleStatus reports real transitions only');
}

async function testPoll() {
  assert.strictEqual(isEnabled({}), false, 'polling is off without a storeStatus block');
  assert.strictEqual(isEnabled({ storeStatus: {} }), false);
  assert.strictEqual(isEnabled({ storeStatus: { enabled: true } }), true);

  const apps = [{ id: 'pair-one', name: 'One', apple: { appId: '111', bundleId: 'com.example.one' }, google: null }];
  const config = { storeStatus: { enabled: true }, ntfyTopic: 'topic-x' };

  let inFlightState = 'WAITING_FOR_REVIEW';
  let failing = false;
  const appleClient = {
    async get(pathname) {
      if (failing) throw { response: { status: 503, data: {} } };
      if (!pathname.includes('appStoreVersions')) return { data: [] };
      const item = (id, versionString, appVersionState, createdDate) => ({ type: 'appStoreVersions', id, attributes: { versionString, appVersionState, platform: 'IOS', createdDate }, relationships: {} });
      return { data: [item('a', '1.2.0', 'READY_FOR_DISTRIBUTION', '2026-11-01T00:00:00Z'), item('b', '1.3.0', inFlightState, '2026-11-11T00:00:00Z')] };
    }
  };
  const sent = [];
  const notify = async (options) => { sent.push(options); return {}; };
  let clock = new Date('2026-11-14T12:00:00Z').getTime();
  const poll = () => { clock += 15 * 60 * 1000; return runStoreStatusPoll(config, { apps, appleClient, notify, now: new Date(clock) }); };

  let result = await poll();
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(sent.length, 0, 'first poll seeds the baseline without notifying');

  await poll();
  assert.strictEqual(sent.length, 0, 'unchanged state sends nothing');

  inFlightState = 'IN_REVIEW';
  result = await poll();
  assert.strictEqual(sent.length, 1, 'one transition, one notification');
  assert.strictEqual(result.notificationsSent, 1);
  assert.strictEqual(sent[0].title, 'App Store: One iOS 1.3.0');
  assert.strictEqual(sent[0].message, 'waiting for review → in review');
  assert.strictEqual(sent[0].topic, 'topic-x');

  await poll();
  assert.strictEqual(sent.length, 1, 'the same transition is never announced twice');
  assert.strictEqual(store.getPendingEvents().length, 0);

  // An outage between two identical states is not a transition.
  failing = true;
  await poll();
  failing = false;
  await poll();
  assert.strictEqual(sent.length, 1, 'a failed fetch followed by the same state sends nothing');

  // Notifications switched off: the change is recorded but not sent, and not replayed later.
  inFlightState = 'PENDING_DEVELOPER_RELEASE';
  config.storeStatus.notifyOnChange = false;
  await poll();
  assert.strictEqual(sent.length, 1);
  config.storeStatus.notifyOnChange = true;
  await poll();
  assert.strictEqual(sent.length, 1, 'changes seen while notifications were off are not replayed');

  // A notifier that throws does not break the poll or cause a resend.
  inFlightState = 'READY_FOR_DISTRIBUTION';
  result = await runStoreStatusPoll(config, { apps, appleClient, notify: async () => { throw new Error('channel down'); }, now: new Date(clock += 15 * 60 * 1000) });
  assert.strictEqual(result.status, 'ok');
  await poll();
  assert.strictEqual(sent.length, 1);

  const recent = store.getRecentEvents(10);
  assert.strictEqual(recent.length, 3, 'every transition is kept in the history');
  assert.strictEqual(recent[0].to_state, 'READY_FOR_DISTRIBUTION', 'newest first');
  console.log('✓ poller notifies once per transition');
}

(async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    testDiff();
    await testPoll();
    console.log('All store status poller tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();

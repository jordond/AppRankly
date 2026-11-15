const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/db opens DB_PATH at load time: use a throwaway database for this test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-store-depth-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.DATA_DIR = tmpDir;

const axios = require('axios');
const { summarizeBuilds, betaSummary, fetchAppleBuilds } = require('../lib/storeStatus/appleBuilds');
const { parseAppleReviews, parseGoogleReviews, fetchGoogleReviews, GOOGLE_MAX_PAGES } = require('../lib/storeStatus/reviews');
const reviewStore = require('../lib/storeStatus/reviewStore');
const {
  createReportingClient, previousDay, summarizeMetricRow, fetchGoogleVitals, METRIC_SETS
} = require('../lib/storeStatus/googleVitals');
const { REPORTING_BASE } = require('../lib/storeStatus/googleStatus');
const { getStatusForApps, getKindTtlMs, isSectionEnabled, SLOW_KIND_TTL_MS } = require('../lib/storeStatus/service');

const build = (id, version, uploadedDate, extra = {}) => ({
  type: 'builds',
  id,
  attributes: { version, uploadedDate, expirationDate: extra.expirationDate || null, expired: extra.expired === true, processingState: extra.processingState || 'VALID' },
  relationships: {
    buildBetaDetail: { data: { type: 'buildBetaDetails', id: `beta-${id}` } },
    preReleaseVersion: { data: extra.pre ? { type: 'preReleaseVersions', id: extra.pre } : null }
  }
});
const betaDetail = (id, internalBuildState, externalBuildState) => ({ type: 'buildBetaDetails', id: `beta-${id}`, attributes: { internalBuildState, externalBuildState } });

function testBuilds() {
  const response = {
    // Upload dates carry different UTC offsets; b1 is the newest instant although its string sorts lower.
    data: [
      build('b1', '35', '2026-11-02T17:24:38-08:00', { pre: 'pre13' }),
      build('b2', '36', '2026-11-03T00:30:00+00:00', { pre: 'pre13' }),
      build('b0', '30', '2026-08-01T10:00:00-07:00', { pre: 'pre12', expired: true })
    ],
    included: [
      betaDetail('b1', 'IN_BETA_TESTING', 'IN_BETA_TESTING'),
      betaDetail('b2', 'IN_BETA_TESTING', 'READY_FOR_BETA_SUBMISSION'),
      betaDetail('b0', 'EXPIRED', 'EXPIRED'),
      { type: 'preReleaseVersions', id: 'pre13', attributes: { version: '1.3.0', platform: 'IOS' } },
      { type: 'preReleaseVersions', id: 'pre12', attributes: { version: '1.2.0', platform: 'IOS' } }
    ],
    meta: { paging: { total: 36, limit: 5 } }
  };
  const out = summarizeBuilds(response);
  assert.strictEqual(out.total, 36);
  assert.deepStrictEqual(out.builds.map(b => b.buildNumber), ['35', '36', '30'], 'sorted by upload instant, newest first');
  assert.strictEqual(out.builds[0].appVersion, '1.3.0');
  assert.strictEqual(out.builds[0].summaryState, 'IN_BETA_TESTING');
  assert.strictEqual(out.builds[1].summaryState, 'IN_BETA_TESTING', 'not submitted to external testing: the internal state is what matters');
  assert.strictEqual(out.builds[2].summaryState, 'EXPIRED');

  assert.strictEqual(betaSummary({ processingState: 'PROCESSING', internalState: 'PROCESSING', externalState: 'PROCESSING' }), 'PROCESSING');
  assert.strictEqual(betaSummary({ processingState: 'FAILED' }), 'FAILED');
  assert.strictEqual(betaSummary({ processingState: 'VALID', internalState: 'IN_BETA_TESTING', externalState: 'WAITING_FOR_BETA_REVIEW' }), 'WAITING_FOR_BETA_REVIEW');
  assert.strictEqual(betaSummary({ processingState: 'VALID', internalState: 'IN_BETA_TESTING', externalState: 'BETA_REJECTED' }), 'BETA_REJECTED');
  assert.strictEqual(betaSummary({ processingState: 'VALID', internalState: 'MISSING_EXPORT_COMPLIANCE', externalState: 'NOT_APPLICABLE' }), 'MISSING_EXPORT_COMPLIANCE');

  assert.deepStrictEqual(summarizeBuilds({ data: [] }), { builds: [], total: 0 });
  assert.deepStrictEqual(summarizeBuilds(undefined), { builds: [], total: 0 });
  console.log('✓ TestFlight builds are summarized');
}

function testReviewParsing() {
  const apple = parseAppleReviews({
    data: [
      { type: 'customerReviews', id: 'r1', attributes: { rating: 5, title: 'Great', body: 'Love it', reviewerNickname: 'sam', createdDate: '2026-09-27T10:00:00-07:00', territory: 'CAN' }, relationships: { response: { data: { type: 'customerReviewResponses', id: 'resp1' } } } },
      { type: 'customerReviews', id: 'r2', attributes: { rating: 2, title: 'Meh', body: 'x'.repeat(5000), reviewerNickname: 'lee', createdDate: '2026-09-20T10:00:00-07:00', territory: 'USA' }, relationships: { response: { data: null } } }
    ],
    included: [{ type: 'customerReviewResponses', id: 'resp1', attributes: { responseBody: 'Thanks!', lastModifiedDate: '2026-09-28T10:00:00-07:00', state: 'PUBLISHED' } }]
  });
  assert.strictEqual(apple.length, 2);
  assert.deepStrictEqual(apple[0], {
    reviewId: 'r1', rating: 5, title: 'Great', body: 'Love it', author: 'sam', territory: 'CAN', version: null,
    createdAt: '2026-09-27T10:00:00-07:00', replyBody: 'Thanks!', replyAt: '2026-09-28T10:00:00-07:00'
  });
  assert.strictEqual(apple[1].replyBody, null);
  assert.strictEqual(apple[1].body.length, 4000, 'very long review text is clipped');
  assert.deepStrictEqual(parseAppleReviews({}), []);

  const google = parseGoogleReviews({
    reviews: [
      {
        reviewId: 'gp:1', authorName: 'Pat',
        comments: [
          { userComment: { text: 'Nice\tWorks well', lastModified: { seconds: '1794700800', nanos: 0 }, starRating: 4, reviewerLanguage: 'en_CA', appVersionName: '1.3.0', appVersionCode: 37 } },
          { developerComment: { text: 'Thank you', lastModified: { seconds: '1794787200' } } }
        ]
      },
      { reviewId: 'gp:2', authorName: '', comments: [{ userComment: { text: '\tNo title here', lastModified: { seconds: '1794700000' }, starRating: 1, appVersionCode: 30 } }] }
    ]
  });
  assert.deepStrictEqual(google[0], {
    reviewId: 'gp:1', rating: 4, title: 'Nice', body: 'Works well', author: 'Pat', territory: 'en_CA', version: '1.3.0',
    createdAt: new Date(1794700800 * 1000).toISOString(), replyBody: 'Thank you', replyAt: new Date(1794787200 * 1000).toISOString()
  });
  assert.strictEqual(google[1].title, null);
  assert.strictEqual(google[1].body, 'No title here');
  assert.strictEqual(google[1].version, '30', 'falls back to the version code');
  assert.strictEqual(google[1].replyBody, null);
  // No reviews in the 7-day window: the API answers with an empty object.
  assert.deepStrictEqual(parseGoogleReviews({}), []);
  assert.deepStrictEqual(parseGoogleReviews(''), []);
  console.log('✓ reviews from both stores parse to one shape');
}

async function testGoogleReviewPaging() {
  const calls = [];
  const client = {
    async get(url, params) {
      calls.push({ url, params });
      const n = calls.length;
      // Never-ending pagination: the reader must stop on its own.
      return { reviews: [{ reviewId: `gp:${n}`, comments: [{ userComment: { text: 'ok', starRating: 3 } }] }], tokenPagination: { nextPageToken: `page-${n + 1}` } };
    }
  };
  const reviews = await fetchGoogleReviews(client, 'com.example.one');
  assert.strictEqual(calls.length, GOOGLE_MAX_PAGES, 'page count is capped');
  assert.strictEqual(reviews.length, GOOGLE_MAX_PAGES);
  assert.strictEqual(calls[0].params.token, undefined);
  assert.strictEqual(calls[1].params.token, 'page-2');
  assert(calls[0].url.endsWith('/applications/com.example.one/reviews'));
  console.log('✓ Play review paging is bounded');
}

function testReviewStore() {
  const t0 = new Date('2026-11-15T12:00:00Z');
  const review = (reviewId, rating, createdAt, extra = {}) => ({ reviewId, rating, title: null, body: `body ${reviewId}`, author: 'a', createdAt, ...extra });
  assert.deepStrictEqual(reviewStore.getReviewSummary('google', 'com.example.one'), { total: 0, average: null, recent: [] });

  reviewStore.upsertReviews('google', 'com.example.one', [
    review('a', 5, '2026-11-10T00:00:00.000Z'), review('b', 1, '2026-11-12T00:00:00.000Z'), { rating: 3 }
  ], t0);
  reviewStore.upsertReviews('google', 'com.example.two', [review('z', 2, '2026-11-13T00:00:00.000Z')], t0);
  let summary = reviewStore.getReviewSummary('google', 'com.example.one');
  assert.strictEqual(summary.total, 2, 'a review without an ID is dropped; other apps are not counted');
  assert.strictEqual(summary.average, 3);
  assert.deepStrictEqual(summary.recent.map(r => r.reviewId), ['b', 'a'], 'newest first');
  assert.strictEqual(summary.recent[0].replied, false);

  // A later poll: one new review, one edited and answered. History accumulates.
  reviewStore.upsertReviews('google', 'com.example.one', [
    review('b', 4, '2026-11-14T00:00:00.000Z', { replyBody: 'Sorry about that', replyAt: '2026-11-14T06:00:00.000Z' }),
    review('c', 3, '2026-11-13T00:00:00.000Z')
  ], new Date(t0.getTime() + 3600000));
  summary = reviewStore.getReviewSummary('google', 'com.example.one', 2);
  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.average, 4);
  assert.deepStrictEqual(summary.recent.map(r => r.reviewId), ['b', 'c']);
  assert.strictEqual(summary.recent[0].replied, true);
  assert.strictEqual(summary.recent[0].rating, 4);
  assert.strictEqual(summary.recent[0].replyBody, undefined, 'reply text is not sent to the page');
  // The same review ID on the other store is a different review.
  assert.strictEqual(reviewStore.getReviewSummary('apple', 'com.example.one').total, 0);
  console.log('✓ review store accumulates and updates');
}

const metricRow = (date, values) => ({
  aggregationPeriod: 'DAILY',
  startTime: { ...date, timeZone: { id: 'America/Los_Angeles' } },
  metrics: Object.entries(values).map(([metric, value]) => ({ metric, decimalValue: { value } }))
});

async function testVitals() {
  const la = { id: 'America/Los_Angeles' };
  assert.deepStrictEqual(previousDay({ year: 2026, month: 11, day: 14, timeZone: la }), { year: 2026, month: 11, day: 13, timeZone: la });
  assert.deepStrictEqual(previousDay({ year: 2026, month: 3, day: 1, timeZone: la }), { year: 2026, month: 2, day: 28, timeZone: la });
  assert.deepStrictEqual(previousDay({ year: 2027, month: 1, day: 1, timeZone: la }), { year: 2026, month: 12, day: 31, timeZone: la });

  const row = metricRow({ year: 2026, month: 11, day: 13 }, { userPerceivedCrashRate7dUserWeighted: '0.0123', crashRate7dUserWeighted: '0.0200', distinctUsers: '1500' });
  assert.deepStrictEqual(summarizeMetricRow(row, METRIC_SETS.crash.metrics), { userPerceived: 0.0123, overall: 0.02, distinctUsers: 1500, date: '2026-11-13' });
  assert.strictEqual(summarizeMetricRow(undefined, METRIC_SETS.crash.metrics), null);
  assert.strictEqual(summarizeMetricRow({ metrics: [], startTime: null }, METRIC_SETS.crash.metrics).userPerceived, null);

  const calls = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    if (config.method === 'get') {
      // The ANR set has no daily data yet.
      const hasDaily = config.url.includes('crashRateMetricSet');
      return ok({ freshnessInfo: { freshnesses: [
        { aggregationPeriod: 'HOURLY', latestEndTime: { year: 2026, month: 11, day: 15, hours: 14, timeZone: { id: 'UTC' } } },
        ...(hasDaily ? [{ aggregationPeriod: 'DAILY', latestEndTime: { year: 2026, month: 11, day: 14, timeZone: la } }] : [])
      ] } });
    }
    return ok({ rows: [row] });
  };
  try {
    const client = createReportingClient(async () => 'test-token');
    assert.deepStrictEqual(Object.keys(client).sort(), ['get', 'query']);
    await assert.rejects(() => client.get('https://evil.example/v1beta1/apps/x/crashRateMetricSet'), /only reads/);
    await assert.rejects(() => client.query('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/x/edits', {}), /only reads/);
    await assert.rejects(() => client.query(`${REPORTING_BASE}/com.example.one/anomalies`, {}), /only posts metric-set queries/);
    assert.strictEqual(calls.length, 0);

    const vitals = await fetchGoogleVitals(client, 'com.example.one');
    assert.deepStrictEqual(vitals.crash, { userPerceived: 0.0123, overall: 0.02, distinctUsers: 1500, date: '2026-11-13' });
    assert.strictEqual(vitals.anr, null, 'no daily freshness: nothing to query');
    assert.strictEqual(calls.length, 3, 'two reads for the crash set, one for the ANR set');
    const posts = calls.filter(c => c.method === 'post');
    assert.strictEqual(posts.length, 1);
    assert(posts[0].url.endsWith('/com.example.one/crashRateMetricSet:query'), 'the only POST is a metric-set query');
    const body = JSON.parse(posts[0].data);
    assert.deepStrictEqual(body.timelineSpec, {
      aggregationPeriod: 'DAILY',
      startTime: { year: 2026, month: 11, day: 13, timeZone: la },
      endTime: { year: 2026, month: 11, day: 14, timeZone: la }
    }, 'queries the newest full day and never past latestEndTime');
    assert.deepStrictEqual(body.metrics, ['crashRate', 'userPerceivedCrashRate', 'userPerceivedCrashRate7dUserWeighted', 'crashRate7dUserWeighted', 'distinctUsers'],
      'daily rates are requested too: without them the API returned no rows');
  } finally {
    axios.defaults.adapter = original;
  }
  console.log('✓ vitals read freshness, then query one day');
}

async function testServiceSections() {
  assert.strictEqual(isSectionEnabled({}, 'reviews'), true, 'sections are on by default');
  assert.strictEqual(isSectionEnabled({ storeStatus: { sections: { reviews: false } } }, 'reviews'), false);
  const config = { storeStatus: { pollMinutes: 15 } };
  assert.strictEqual(getKindTtlMs(config, 'release'), 15 * 60 * 1000);
  assert.strictEqual(getKindTtlMs(config, 'builds'), 15 * 60 * 1000);
  assert.strictEqual(getKindTtlMs(config, 'reviews'), SLOW_KIND_TTL_MS.reviews);
  assert.strictEqual(getKindTtlMs({ storeStatus: { pollMinutes: 600 } }, 'reviews'), 600 * 60 * 1000, 'never more often than the poll interval');

  const apps = [{ id: 'pair-one', name: 'One', apple: { appId: '111' }, google: { packageName: 'com.example.svc' } }];
  const counts = { versions: 0, submissions: 0, builds: 0, appleReviews: 0, tracks: 0, googleReviews: 0, vitalsGet: 0, vitalsQuery: 0 };
  let buildsFail = false;
  const appleClient = {
    async get(pathname) {
      if (pathname.includes('appStoreVersions')) { counts.versions++; return { data: [] }; }
      if (pathname.includes('reviewSubmissions')) { counts.submissions++; return { data: [] }; }
      if (pathname === '/v1/builds') {
        counts.builds++;
        if (buildsFail) throw { response: { status: 403, data: { errors: [{ title: 'Forbidden', detail: 'nope' }] } } };
        return { data: [build('b1', '36', '2026-11-11T11:02:13-08:00')], included: [betaDetail('b1', 'IN_BETA_TESTING', 'READY_FOR_BETA_SUBMISSION')], meta: { paging: { total: 1 } } };
      }
      if (pathname.includes('customerReviews')) {
        counts.appleReviews++;
        return { data: [{ id: 'ar1', attributes: { rating: 5, title: 'Great', body: 'Love it', createdDate: '2026-09-27T10:00:00-07:00' }, relationships: {} }] };
      }
      throw new Error(`unexpected Apple path ${pathname}`);
    }
  };
  const googleClient = {
    async get(url) {
      if (url.endsWith('/reviews')) {
        counts.googleReviews++;
        return { reviews: [{ reviewId: 'gr1', comments: [{ userComment: { text: 'Good', starRating: 4, lastModified: { seconds: '1794700800' } } }] }] };
      }
      counts.tracks++;
      return '';
    }
  };
  const reportingClient = {
    async get() {
      counts.vitalsGet++;
      return { freshnessInfo: { freshnesses: [{ aggregationPeriod: 'DAILY', latestEndTime: { year: 2026, month: 11, day: 14, timeZone: { id: 'America/Los_Angeles' } } }] } };
    },
    async query(url) {
      counts.vitalsQuery++;
      const names = url.includes('crashRate') ? METRIC_SETS.crash.metrics : METRIC_SETS.anr.metrics;
      return { rows: [metricRow({ year: 2026, month: 11, day: 13 }, { [names.userPerceived]: '0.0050', [names.overall]: '0.0100', distinctUsers: '200' })] };
    }
  };
  const clients = { appleClient, googleClient, reportingClient };
  const t0 = new Date('2026-11-15T12:00:00Z');
  const at = (minutes) => new Date(t0.getTime() + minutes * 60 * 1000);

  let out = await getStatusForApps(config, apps, { ...clients, now: t0 });
  assert.deepStrictEqual(counts, { versions: 1, submissions: 1, builds: 1, appleReviews: 1, tracks: 4, googleReviews: 1, vitalsGet: 2, vitalsQuery: 2 });
  const { apple, google } = out['pair-one'];
  assert.strictEqual(apple.builds.status.builds[0].buildNumber, '36');
  assert.strictEqual(apple.builds.error, null);
  assert.strictEqual(apple.reviews.status.total, 1);
  assert.strictEqual(apple.reviews.status.recent[0].title, 'Great');
  assert.strictEqual(google.reviews.status.recent[0].body, 'Good');
  assert.strictEqual(google.vitals.status.crash.userPerceived, 0.005);
  assert.strictEqual(google.vitals.status.anr.distinctUsers, 200);
  assert.deepStrictEqual(google.status.tracks, [], 'release state is still there next to the sections');

  // A poll refetches release state and builds, but leaves reviews and vitals to their own, longer TTL.
  await getStatusForApps(config, apps, { ...clients, poll: true, now: at(15) });
  assert.deepStrictEqual(counts, { versions: 2, submissions: 2, builds: 2, appleReviews: 1, tracks: 8, googleReviews: 1, vitalsGet: 2, vitalsQuery: 2 });

  // After an hour reviews are due; vitals are not.
  await getStatusForApps(config, apps, { ...clients, poll: true, now: at(61) });
  assert.strictEqual(counts.appleReviews, 2);
  assert.strictEqual(counts.googleReviews, 2);
  assert.strictEqual(counts.vitalsGet, 2);

  // The Refresh button refetches everything.
  await getStatusForApps(config, apps, { ...clients, fresh: true, now: at(62) });
  assert.strictEqual(counts.vitalsGet, 4);
  assert.strictEqual(counts.googleReviews, 3);

  // One section failing leaves release state and the other sections alone.
  buildsFail = true;
  out = await getStatusForApps(config, apps, { ...clients, fresh: true, now: at(63) });
  assert.strictEqual(out['pair-one'].apple.builds.error.code, 'APPLE_FORBIDDEN');
  assert.strictEqual(out['pair-one'].apple.builds.status.builds[0].buildNumber, '36', 'last good builds are kept');
  assert.strictEqual(out['pair-one'].apple.error, null);
  assert.strictEqual(out['pair-one'].apple.reviews.error, null);
  buildsFail = false;

  // Sections switched off: no calls, no keys in the result.
  const before = { ...counts };
  const off = { storeStatus: { sections: { testflight: false, reviews: false, vitals: false } } };
  out = await getStatusForApps(off, apps, { ...clients, fresh: true, now: at(64) });
  assert.strictEqual(counts.builds, before.builds);
  assert.strictEqual(counts.appleReviews, before.appleReviews);
  assert.strictEqual(counts.googleReviews, before.googleReviews);
  assert.strictEqual(counts.vitalsGet, before.vitalsGet);
  assert.strictEqual(out['pair-one'].apple.builds, undefined);
  assert.strictEqual(out['pair-one'].google.vitals, undefined);
  assert.strictEqual(out['pair-one'].google.reviews, undefined);

  // Every Apple call in this file went through GET-shaped clients; check the real one stays that way.
  const seen = [];
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (cfg) => { seen.push(cfg); return { data: { data: [] }, status: 200, statusText: 'OK', headers: {}, config: cfg }; };
  try {
    const { createAppleClient } = require('../lib/storeStatus/appleStatus');
    await fetchAppleBuilds(createAppleClient(() => 't'), '111');
    assert.strictEqual(seen.length, 1, 'one request per app for builds');
    assert.strictEqual(seen[0].method, 'get');
    assert.strictEqual(seen[0].params['filter[app]'], '111');
  } finally {
    axios.defaults.adapter = original;
  }
  console.log('✓ optional sections follow their own TTL and fail independently');
}

(async () => {
  try {
    testBuilds();
    testReviewParsing();
    await testGoogleReviewPaging();
    testReviewStore();
    await testVitals();
    await testServiceSections();
    console.log('All store status depth tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();

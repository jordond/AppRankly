/**
 * Read-only Android vitals from the Play Developer Reporting API: 7-day user-weighted
 * crash and ANR rates for one app.
 *
 * The API has no GET that returns metric values. `:query` is an HTTP POST, but it is a
 * read: it runs a query and changes nothing. It is the only POST this client can send.
 */
const axios = require('axios');
const { REPORTING_BASE } = require('./googleStatus');

// Checked against real apps: a query naming only the 7-day metrics (or only one or two
// metrics) came back with no rows, while the same query with the daily rates added
// returned data. So the daily rates are always requested, although only the 7-day
// values are shown.
const METRIC_SETS = {
  crash: {
    set: 'crashRateMetricSet',
    metrics: { userPerceived: 'userPerceivedCrashRate7dUserWeighted', overall: 'crashRate7dUserWeighted', users: 'distinctUsers' },
    also: ['crashRate', 'userPerceivedCrashRate']
  },
  anr: {
    set: 'anrRateMetricSet',
    metrics: { userPerceived: 'userPerceivedAnrRate7dUserWeighted', overall: 'anrRate7dUserWeighted', users: 'distinctUsers' },
    also: ['anrRate', 'userPerceivedAnrRate']
  }
};

/** @param {() => Promise<string>} getToken */
function createReportingClient(getToken) {
  const request = async (method, url, data) => {
    const token = await getToken();
    const res = await axios.request({ method, url, data, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return res.data;
  };
  const check = (url) => {
    if (typeof url !== 'string' || !url.startsWith(`${REPORTING_BASE}/`)) {
      throw new Error('Reporting client only reads the Play Developer Reporting API');
    }
  };
  return {
    async get(url) {
      check(url);
      return request('GET', url);
    },
    async query(url, body) {
      check(url);
      if (!url.endsWith('MetricSet:query')) throw new Error('Reporting client only posts metric-set queries');
      return request('POST', url, body);
    }
  };
}

const toNumber = (decimal) => {
  const value = Number(decimal?.value);
  return decimal && decimal.value !== undefined && Number.isFinite(value) ? value : null;
};

/** The day before a { year, month, day } date, keeping its time zone. */
function previousDay(date) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) - 24 * 60 * 60 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), timeZone: date.timeZone };
}

const toIsoDate = (date) => date
  ? `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
  : null;

function summarizeMetricRow(row, metrics) {
  if (!row) return null;
  const byName = new Map((row.metrics || []).map(m => [m.metric, toNumber(m.decimalValue)]));
  return {
    userPerceived: byName.get(metrics.userPerceived) ?? null,
    overall: byName.get(metrics.overall) ?? null,
    distinctUsers: byName.get(metrics.users) ?? null,
    date: toIsoDate(row.startTime)
  };
}

/** One metric set: read how fresh its daily data is, then query the newest day. Two requests. */
async function fetchMetricSet(client, packageName, { set, metrics, also = [] }) {
  const base = `${REPORTING_BASE}/${encodeURIComponent(String(packageName))}/${set}`;
  const info = await client.get(base);
  const daily = (info?.freshnessInfo?.freshnesses || []).find(f => f.aggregationPeriod === 'DAILY');
  const end = daily?.latestEndTime;
  if (!end || !end.year) return null;
  // endTime is exclusive and must not pass latestEndTime, so the newest full day is [end - 1, end).
  const result = await client.query(`${base}:query`, {
    timelineSpec: { aggregationPeriod: 'DAILY', startTime: previousDay(end), endTime: end },
    metrics: [...also, ...Object.values(metrics)],
    pageSize: 1
  });
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return summarizeMetricRow(rows[rows.length - 1], metrics);
}

/**
 * @returns {Promise<{ crash: Object|null, anr: Object|null }>} rates are fractions of users
 * (0.0123 = 1.23 %); a set is null when Play has too little data to report.
 */
async function fetchGoogleVitals(client, packageName) {
  const [crash, anr] = await Promise.all([
    fetchMetricSet(client, packageName, METRIC_SETS.crash),
    fetchMetricSet(client, packageName, METRIC_SETS.anr)
  ]);
  return { crash, anr };
}

module.exports = { METRIC_SETS, createReportingClient, previousDay, summarizeMetricRow, fetchMetricSet, fetchGoogleVitals };

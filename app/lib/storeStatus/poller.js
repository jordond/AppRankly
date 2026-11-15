/**
 * Background poll of store status. Refreshes every app's snapshot and announces state
 * transitions through the existing notification channels.
 *
 * Off unless `storeStatus.enabled` is true in config.json.
 */
const { DATA_DIR } = require('../config');
const { broadcastAlert } = require('../notifier');
const { listStoreApps } = require('./apps');
const { getStatusForApps, getTtlMs } = require('./service');
const { describeEvent } = require('./changes');
const store = require('./store');

const DISABLED_RECHECK_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 45 * 1000;
// Events older than this are not announced (for example after notifications were off for a while).
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

let timer = null;
let running = false;
let lastRun = { status: 'idle', lastRun: null };

const isEnabled = (config) => Boolean(config && config.storeStatus && config.storeStatus.enabled === true);
const shouldNotify = (config) => config?.storeStatus?.notifyOnChange !== false;

/** Send each pending transition once. Returns the number of alerts sent. */
async function announcePendingEvents(config, { notify = broadcastAlert, now = new Date() } = {}) {
  const pending = store.getPendingEvents();
  if (pending.length === 0) return 0;

  let sent = 0;
  for (const event of pending) {
    const age = now.getTime() - Date.parse(event.detected_at);
    if (shouldNotify(config) && Number.isFinite(age) && age <= MAX_EVENT_AGE_MS) {
      const { title, message } = describeEvent(event);
      try {
        await notify({
          title,
          message,
          priority: 'high',
          tags: 'rocket',
          topic: (config.ntfyTopic !== undefined ? config.ntfyTopic : process.env.NTFY_TOPIC) || '',
          dataDir: DATA_DIR,
          webhookUrl: config.webhookUrl || process.env.WEBHOOK_URL || '',
          slackWebhookUrl: config.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL,
          telegram: config.telegram
        });
        sent++;
      } catch (err) {
        console.warn('[StoreStatus] Notification failed:', err.message);
      }
    }
    // Marked either way: an event is announced at most once and never queued up for later.
    store.markEventsNotified([event.id], now);
  }
  return sent;
}

async function runStoreStatusPoll(config, options = {}) {
  if (running) return { status: 'busy' };
  running = true;
  const now = options.now || new Date();
  try {
    const apps = options.apps || await listStoreApps(config);
    await getStatusForApps(config, apps, { poll: true, now, appleClient: options.appleClient, googleClient: options.googleClient, reportingClient: options.reportingClient, editsReader: options.editsReader });
    const notificationsSent = await announcePendingEvents(config, { notify: options.notify, now });
    lastRun = { status: 'ok', lastRun: now.toISOString(), appsChecked: apps.length, notificationsSent };
  } catch (err) {
    console.error('[StoreStatus] Poll failed:', err.message);
    lastRun = { status: 'error', lastRun: now.toISOString(), error: err.message };
  } finally {
    running = false;
  }
  return lastRun;
}

/** Re-reads config on every tick, so enabling or changing the interval needs no restart. */
function startStoreStatusPoller(getBaseConfig) {
  if (timer) clearTimeout(timer);
  const tick = async () => {
    let delay = DISABLED_RECHECK_MS;
    try {
      const config = getBaseConfig();
      if (isEnabled(config)) {
        await runStoreStatusPoll(config);
        delay = getTtlMs(config);
      }
    } catch (err) {
      console.error('[StoreStatus] Poller tick failed:', err.message);
    }
    timer = setTimeout(tick, delay);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(tick, FIRST_RUN_DELAY_MS);
  if (timer.unref) timer.unref();
}

const getStoreStatusPollerStatus = () => lastRun;

module.exports = { isEnabled, announcePendingEvents, runStoreStatusPoll, startStoreStatusPoller, getStoreStatusPollerStatus };

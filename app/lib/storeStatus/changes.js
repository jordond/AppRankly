/**
 * Detects release-state transitions between two status payloads of the same app.
 */
const { STATE } = require('./states');

const PLATFORM_LABEL = { IOS: 'iOS', MAC_OS: 'macOS', TV_OS: 'tvOS', VISION_OS: 'visionOS' };

// Tracked versions keyed by "<platform> <version>", so a version is followed across
// its move from in-flight to live.
function trackedVersions(status) {
  const map = new Map();
  (status?.platforms || []).forEach(p => {
    [p.inFlight, p.live].forEach(v => {
      if (!v || !v.version) return;
      const label = PLATFORM_LABEL[p.platform] || p.platform;
      map.set(`${label} ${v.version}`, v);
    });
  });
  return map;
}

/**
 * @param {Object|null} previous last stored status, or null when the app has never been seen
 * @param {Object} next freshly fetched status
 * @returns {Array<{ subject: string, fromState: string|null, toState: string }>}
 */
function diffAppleStatus(previous, next) {
  // First sighting is the baseline: nothing to announce.
  if (!previous || !next) return [];

  const before = trackedVersions(previous);
  const events = [];
  trackedVersions(next).forEach((version, subject) => {
    const old = before.get(subject);
    if (old && old.rawState === version.rawState) return;
    // Creating or editing a draft is not news; neither is history.
    if (version.state === STATE.DRAFT || version.state === STATE.SUPERSEDED) return;
    events.push({ subject, fromState: old?.rawState || null, toState: version.rawState });
  });

  const wasUnresolved = previous.reviewSubmission?.state === 'UNRESOLVED_ISSUES';
  const isUnresolved = next.reviewSubmission?.state === 'UNRESOLVED_ISSUES';
  const alreadyReported = events.some(e => /REJECTED|INVALID_BINARY/.test(e.toState));
  if (isUnresolved && !wasUnresolved && !alreadyReported) {
    events.push({ subject: 'review submission', fromState: previous.reviewSubmission?.state || null, toState: 'UNRESOLVED_ISSUES' });
  }
  return events;
}

const humanize = (raw) => String(raw || '').toLowerCase().replace(/_/g, ' ');

const STORE_LABEL = { apple: 'App Store', google: 'Google Play' };

/** Notification text for one stored event row. */
function describeEvent(event) {
  const store = STORE_LABEL[event.platform] || event.platform;
  const title = `${store}: ${event.app_name || event.app_id} ${event.subject}`;
  const message = event.from_state
    ? `${humanize(event.from_state)} → ${humanize(event.to_state)}`
    : humanize(event.to_state);
  return { title, message };
}

module.exports = { diffAppleStatus, describeEvent, humanize };

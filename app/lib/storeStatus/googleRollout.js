/**
 * Staged-rollout percentage and halted state for Google Play.
 *
 * OPT-IN (`storeStatus.google.readRolloutViaEdits`), off by default. Google only exposes
 * `userFraction` through the edits API, so this is the one part of store status that is
 * not a plain read: it opens an edit, reads the tracks, and deletes the edit again.
 * Nothing is changed in the edit and it is never validated or committed.
 *
 * Why it is opt-in: Google allows one open edit per user, and opening a new one
 * invalidates that user's previous edit. If the dashboard shares its service account
 * with a CI job that uploads builds, this read can break an upload in progress. Use a
 * service account that nothing else uses.
 */
const axios = require('axios');
const { PUBLISHER_BASE } = require('./googleStatus');

/**
 * The reader exposes one fixed sequence and no way to send any other request, so no
 * code path can modify or commit an edit.
 * @param {() => Promise<string>} getToken
 */
function createEditsReader(getToken) {
  const send = async (method, url, data) => {
    const token = await getToken();
    const res = await axios.request({ method, url, data, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return res.data;
  };
  return {
    /** @returns {Promise<Object>} the raw edits.tracks.list response */
    async readTracks(packageName) {
      const edits = `${PUBLISHER_BASE}${encodeURIComponent(String(packageName))}/edits`;
      const edit = await send('POST', edits, {});
      const editId = edit && edit.id ? encodeURIComponent(String(edit.id)) : null;
      if (!editId) throw new Error('Google Play did not return an edit ID');
      try {
        return await send('GET', `${edits}/${editId}/tracks`);
      } finally {
        // Always abandon the edit. A failed delete is harmless: the edit expires on its own.
        try {
          await send('DELETE', `${edits}/${editId}`);
        } catch (err) {
          console.warn('[StoreStatus] Could not delete the read-only Play edit; it will expire by itself.');
        }
      }
    }
  };
}

const ROLLOUT_STATUSES = new Set(['draft', 'inProgress', 'halted', 'completed']);

/**
 * @param {Object} response edits.tracks.list body
 * @returns {{ tracks: Object<string, Array<{ name, versionCodes, status, userFraction }>> }}
 */
function summarizeRollout(response) {
  const tracks = {};
  (response && Array.isArray(response.tracks) ? response.tracks : []).forEach(t => {
    if (!t || typeof t.track !== 'string') return;
    const releases = (Array.isArray(t.releases) ? t.releases : []).map(r => {
      const fraction = Number(r.userFraction);
      return {
        name: typeof r.name === 'string' && r.name ? r.name : null,
        versionCodes: (r.versionCodes || []).map(Number).filter(Number.isFinite).sort((x, y) => y - x),
        status: ROLLOUT_STATUSES.has(r.status) ? r.status : null,
        // Only staged (inProgress) and halted releases carry a fraction; completed means everyone.
        userFraction: Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? fraction : null
      };
    });
    if (releases.length > 0) tracks[t.track] = releases;
  });
  return { tracks };
}

async function fetchGoogleRollout(reader, packageName) {
  return summarizeRollout(await reader.readTracks(packageName));
}

module.exports = { createEditsReader, summarizeRollout, fetchGoogleRollout };

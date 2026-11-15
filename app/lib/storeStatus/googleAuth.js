/**
 * Access tokens for the Google Play APIs from a service-account key, without a Google
 * client library: sign an RS256 assertion and exchange it at Google's token endpoint.
 */
const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { resolveKeyFilePath } = require('../config');

// Fixed on purpose: the `token_uri` inside a key file is not trusted, so a tampered key
// file cannot redirect the signed assertion somewhere else.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE_PUBLISHER = 'https://www.googleapis.com/auth/androidpublisher';
const SCOPE_REPORTING = 'https://www.googleapis.com/auth/playdeveloperreporting';
const DEFAULT_SCOPES = [SCOPE_PUBLISHER, SCOPE_REPORTING];

const ASSERTION_LIFETIME_S = 3600;
// Refresh a little before expiry so a token never expires mid-request.
const EXPIRY_MARGIN_MS = 60 * 1000;

function pickCredentials(parsed) {
  if (!parsed || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') return null;
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    privateKeyId: typeof parsed.private_key_id === 'string' ? parsed.private_key_id : null
  };
}

/**
 * Service-account credentials for store status: `storeStatus.google.keyFilePath` when
 * set, otherwise the analytics key (`keyJson` or `keyFilePath`).
 * @returns {{ clientEmail: string, privateKey: string, privateKeyId: string|null }|null}
 */
function loadGoogleCredentials(config = {}) {
  try {
    const statusKeyPath = config.storeStatus?.google?.keyFilePath;
    if (statusKeyPath) {
      const resolved = resolveKeyFilePath(statusKeyPath);
      return resolved ? pickCredentials(JSON.parse(fs.readFileSync(resolved, 'utf8'))) : null;
    }
    if (config.keyJson) {
      return pickCredentials(typeof config.keyJson === 'string' ? JSON.parse(config.keyJson) : config.keyJson);
    }
    const resolved = resolveKeyFilePath(config.keyFilePath);
    return resolved ? pickCredentials(JSON.parse(fs.readFileSync(resolved, 'utf8'))) : null;
  } catch {
    // Unreadable or malformed key. The underlying message can contain a file path.
    return null;
  }
}

function signAssertion(credentials, scopes, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  try {
    return jwt.sign(
      { iss: credentials.clientEmail, scope: scopes.join(' '), aud: TOKEN_URL, iat, exp: iat + ASSERTION_LIFETIME_S },
      credentials.privateKey,
      { algorithm: 'RS256', ...(credentials.privateKeyId ? { keyid: credentials.privateKeyId } : {}) }
    );
  } catch {
    // jsonwebtoken errors can quote key text; replace them with a code the caller can classify.
    const err = new Error('The Google service account key could not be used to sign a request.');
    err.code = 'GOOGLE_KEY_INVALID';
    throw err;
  }
}

/**
 * @param {Object} credentials from loadGoogleCredentials
 * @param {Object} [options]
 * @param {string[]} [options.scopes]
 * @param {() => number} [options.now] clock, for tests
 * @returns {() => Promise<string>} resolves to an access token, cached until shortly before it expires
 */
function createGoogleTokenProvider(credentials, { scopes = DEFAULT_SCOPES, now = Date.now } = {}) {
  let cached = null; // { token, expiresAt }
  let pending = null;

  const exchange = async () => {
    const assertion = signAssertion(credentials, scopes, now());
    const res = await axios.request({
      method: 'POST',
      url: TOKEN_URL,
      data: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    const token = res.data?.access_token;
    if (!token) {
      const err = new Error('Google token endpoint returned no access token.');
      err.code = 'GOOGLE_TOKEN_EMPTY';
      throw err;
    }
    const lifetimeMs = (Number(res.data.expires_in) || ASSERTION_LIFETIME_S) * 1000;
    cached = { token, expiresAt: now() + lifetimeMs };
    return token;
  };

  return async function getToken() {
    if (cached && now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.token;
    // Concurrent callers share one exchange.
    if (!pending) pending = exchange().finally(() => { pending = null; });
    return pending;
  };
}

// One provider per key and scope set, so tokens survive across requests and polls.
const providers = new Map();

function getGoogleTokenProvider(credentials, scopes = DEFAULT_SCOPES) {
  const id = `${credentials.clientEmail}\u0000${credentials.privateKeyId || ''}\u0000${scopes.join(' ')}`;
  const existing = providers.get(id);
  // A rotated key under the same ID gets a new provider.
  if (existing && existing.privateKey === credentials.privateKey) return existing.getToken;
  const getToken = createGoogleTokenProvider(credentials, { scopes });
  providers.set(id, { privateKey: credentials.privateKey, getToken });
  return getToken;
}

module.exports = {
  TOKEN_URL,
  SCOPE_PUBLISHER,
  SCOPE_REPORTING,
  DEFAULT_SCOPES,
  loadGoogleCredentials,
  createGoogleTokenProvider,
  getGoogleTokenProvider
};

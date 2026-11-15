/**
 * Turns a failed store API call into something the status page can show: a stable code,
 * a short message, and what to change. Never includes request headers or tokens.
 */

function appleErrorDetail(err) {
  const first = err?.response?.data?.errors?.[0];
  if (!first) return null;
  return [first.title, first.detail].filter(Boolean).join(': ').slice(0, 300) || null;
}

function classifyAppleError(err) {
  if (err && err.code === 'APPLE_NOT_CONFIGURED') {
    return {
      code: 'APPLE_NOT_CONFIGURED',
      message: 'App Store Connect API key is not configured.',
      hint: 'Set keyFilePath_apple, appleKeyId and appleIssuerId in config.json.'
    };
  }
  const status = err?.response?.status;
  const detail = appleErrorDetail(err);
  if (status === 401) {
    return {
      code: 'APPLE_UNAUTHORIZED',
      message: 'App Store Connect rejected the API key.',
      hint: 'Check that appleKeyId and appleIssuerId match the .p8 file and that the key has not been revoked.',
      detail
    };
  }
  if (status === 403) {
    return {
      code: 'APPLE_FORBIDDEN',
      message: 'The App Store Connect API key is not allowed to read app versions.',
      hint: 'Keys with only the Sales or Finance role cannot read version and review state. Create a team key that also has an app role (Developer, App Manager or Admin), and check that all agreements are accepted in App Store Connect.',
      detail
    };
  }
  if (status === 404) {
    return { code: 'APPLE_NOT_FOUND', message: 'App Store Connect does not know this app ID.', hint: null, detail };
  }
  if (status === 429) {
    return { code: 'APPLE_RATE_LIMITED', message: 'App Store Connect rate limit reached.', hint: 'Status will refresh on the next poll.', detail };
  }
  if (status >= 500) {
    return { code: 'APPLE_UNAVAILABLE', message: `App Store Connect returned HTTP ${status}.`, hint: null, detail };
  }
  if (!err?.response) {
    return { code: 'NETWORK', message: 'Could not reach App Store Connect.', hint: null, detail: err?.code || null };
  }
  return { code: 'APPLE_ERROR', message: `App Store Connect returned HTTP ${status}.`, hint: null, detail };
}

const GOOGLE_SERVICE_NAMES = {
  'androidpublisher.googleapis.com': 'Google Play Android Developer API',
  'playdeveloperreporting.googleapis.com': 'Google Play Developer Reporting API'
};

function googleErrorDetail(err) {
  const message = err?.response?.data?.error?.message;
  return typeof message === 'string' && message ? message.slice(0, 300) : null;
}

/** The API a SERVICE_DISABLED error names, or null when the 403 is about something else. */
function googleDisabledService(err) {
  const details = err?.response?.data?.error?.details;
  const disabled = Array.isArray(details) ? details.find(d => d && d.reason === 'SERVICE_DISABLED') : null;
  if (disabled) return GOOGLE_SERVICE_NAMES[disabled.metadata?.service] || 'A required Google API';
  return /has not been used in project|it is disabled/i.test(googleErrorDetail(err) || '') ? 'A required Google API' : null;
}

function classifyGoogleError(err) {
  if (err && (err.code === 'GOOGLE_NOT_CONFIGURED' || err.code === 'GOOGLE_KEY_INVALID')) {
    return {
      code: 'GOOGLE_NOT_CONFIGURED',
      message: err.code === 'GOOGLE_KEY_INVALID'
        ? 'The Google service account key could not be read.'
        : 'Google service account key is not configured.',
      hint: 'Set keyFilePath (or keyJson) in config.json to a service account JSON key.'
    };
  }
  const status = err?.response?.status;
  const detail = googleErrorDetail(err);
  // The token endpoint answers in OAuth form: { error: "invalid_grant", error_description }.
  const oauthError = typeof err?.response?.data?.error === 'string' ? err.response.data.error : null;
  if (oauthError || status === 401) {
    return {
      code: 'GOOGLE_UNAUTHORIZED',
      message: 'Google rejected the service account key.',
      hint: 'Check that the key has not been deleted or disabled in Google Cloud, and that the server clock is correct.',
      detail: oauthError || detail
    };
  }
  if (status === 403) {
    const service = googleDisabledService(err);
    if (service) {
      return {
        code: 'GOOGLE_API_DISABLED',
        message: `${service} is not enabled for the service account's Cloud project.`,
        hint: 'Enable it in Google Cloud (see the account links below), then wait a few minutes.',
        detail
      };
    }
    return {
      code: 'GOOGLE_FORBIDDEN',
      message: 'The service account is not allowed to read this app in Google Play.',
      hint: 'In Play Console, Users and permissions, give the service account "View app information (read-only)" and "View app quality information (read-only)". New permissions can take 24 to 48 hours to apply.',
      detail
    };
  }
  if (status === 404) {
    return {
      code: 'GOOGLE_NOT_FOUND',
      message: 'Google Play does not know this package.',
      hint: 'The app needs at least one uploaded build, and the service account needs access to it.',
      detail
    };
  }
  if (status === 429) {
    return { code: 'GOOGLE_RATE_LIMITED', message: 'Google Play API quota reached.', hint: 'Status will refresh on the next poll.', detail };
  }
  if (status >= 500) {
    return { code: 'GOOGLE_UNAVAILABLE', message: `Google Play returned HTTP ${status}.`, hint: null, detail };
  }
  if (!err?.response) {
    return { code: 'NETWORK', message: 'Could not reach Google Play.', hint: null, detail: err?.code || null };
  }
  return { code: 'GOOGLE_ERROR', message: `Google Play returned HTTP ${status}.`, hint: null, detail };
}

module.exports = { classifyAppleError, classifyGoogleError };

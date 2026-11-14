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

module.exports = { classifyAppleError };

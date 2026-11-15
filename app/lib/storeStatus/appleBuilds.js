/**
 * Read-only TestFlight state: the most recent builds of one app with their processing
 * and beta-testing state. One GET per app.
 */

const MAX_BUILDS = 5;

// What to show first for a build, most urgent first.
function betaSummary(build) {
  if (build.processingState && build.processingState !== 'VALID') return build.processingState; // PROCESSING, FAILED, INVALID
  if (build.expired) return 'EXPIRED';
  const external = build.externalState;
  if (external && external !== 'NOT_APPLICABLE' && external !== 'READY_FOR_BETA_SUBMISSION') return external;
  return build.internalState || external || null;
}

function summarizeBuilds(response) {
  const includedById = new Map((response?.included || []).map(i => [`${i.type}:${i.id}`, i]));
  const lookup = (ref) => (ref ? includedById.get(`${ref.type}:${ref.id}`) : null);
  const builds = (response?.data || [])
    .map(item => {
      const a = item.attributes || {};
      const beta = lookup(item.relationships?.buildBetaDetail?.data);
      const pre = lookup(item.relationships?.preReleaseVersion?.data);
      const build = {
        buildNumber: a.version || null,
        appVersion: pre?.attributes?.version || null,
        platform: pre?.attributes?.platform || null,
        uploadedDate: a.uploadedDate || null,
        expirationDate: a.expirationDate || null,
        expired: a.expired === true,
        processingState: a.processingState || null,
        internalState: beta?.attributes?.internalBuildState || null,
        externalState: beta?.attributes?.externalBuildState || null
      };
      return { ...build, summaryState: betaSummary(build) };
    })
    // Upload dates carry differing UTC offsets, so compare instants, not strings.
    .sort((x, y) => (Date.parse(y.uploadedDate) || 0) - (Date.parse(x.uploadedDate) || 0));
  const total = Number(response?.meta?.paging?.total);
  return { builds, total: Number.isFinite(total) ? total : builds.length };
}

async function fetchAppleBuilds(client, appleAppId) {
  const response = await client.get('/v1/builds', {
    'filter[app]': String(appleAppId),
    sort: '-uploadedDate',
    limit: MAX_BUILDS,
    include: 'buildBetaDetail,preReleaseVersion',
    'fields[builds]': 'version,uploadedDate,expirationDate,expired,processingState,buildBetaDetail,preReleaseVersion',
    'fields[buildBetaDetails]': 'internalBuildState,externalBuildState',
    'fields[preReleaseVersions]': 'version,platform'
  });
  return summarizeBuilds(response);
}

module.exports = { MAX_BUILDS, betaSummary, summarizeBuilds, fetchAppleBuilds };

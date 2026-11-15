// Sample data for the Store Status page in demo and static builds, where there is no backend.
const appleLinks = (id) => [
  { id: 'apple.app', label: 'App Store Connect', url: `https://appstoreconnect.apple.com/apps/${id}/distribution` },
  { id: 'apple.testflight', label: 'TestFlight', url: `https://appstoreconnect.apple.com/apps/${id}/testflight/ios` },
  { id: 'apple.listing', label: 'App Store listing', url: `https://apps.apple.com/app/id${id}` }
];

const googleLinks = (pkg, consoleAppId) => {
  const base = 'https://play.google.com/console/developers/0000000000000000000';
  const reason = 'Set appMetadata.<package>.consoleAppId (the ID in the Play Console URL after /app/).';
  const consoleLink = (id, label, path) => consoleAppId
    ? { id, label, url: `${base}/app/${consoleAppId}/${path}` }
    : { id, label, url: null, reason };
  return [
    consoleLink('google.dashboard', 'Play Console', 'app-dashboard'),
    consoleLink('google.releases', 'Releases', 'releases/overview'),
    { id: 'google.listing', label: 'Play Store listing', url: `https://play.google.com/store/apps/details?id=${pkg}` }
  ];
};

export const MOCK_STORE_STATUS = {
  apps: [
    {
      id: 'pair-alpha',
      name: 'App Alpha',
      apple: {
        appId: '1000000001', bundleId: 'com.demo.alpha', name: 'App Alpha', links: appleLinks('1000000001'),
        fetchedAt: new Date().toISOString(),
        error: null,
        status: {
          platforms: [{
            platform: 'IOS',
            live: { version: '2.4.0', buildNumber: '118', state: 'LIVE', rawState: 'READY_FOR_DISTRIBUTION', phasedRelease: { state: 'ACTIVE', day: 3, percent: 5 } },
            inFlight: { version: '2.5.0', buildNumber: '121', state: 'IN_REVIEW', rawState: 'IN_REVIEW', phasedRelease: null }
          }],
          reviewSubmission: { state: 'IN_REVIEW', needsAttention: false }
        },
        builds: {
          error: null,
          status: {
            total: 121,
            builds: [
              { appVersion: '2.5.0', buildNumber: '121', processingState: 'VALID', internalState: 'IN_BETA_TESTING', externalState: 'IN_BETA_TESTING', summaryState: 'IN_BETA_TESTING', uploadedDate: new Date(Date.now() - 2 * 86400000).toISOString() },
              { appVersion: '2.4.0', buildNumber: '118', processingState: 'VALID', internalState: 'IN_BETA_TESTING', externalState: 'READY_FOR_BETA_SUBMISSION', summaryState: 'IN_BETA_TESTING', uploadedDate: new Date(Date.now() - 20 * 86400000).toISOString() }
            ]
          }
        },
        reviews: {
          error: null,
          status: {
            total: 42, average: 4.4,
            recent: [{ reviewId: 'demo-1', rating: 5, title: 'Does what it says', body: 'Fast and simple. Exactly what I needed.', territory: 'USA', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), replied: true }]
          }
        }
      },
      google: {
        packageName: 'com.demo.alpha', name: 'App Alpha', consoleAppId: '4970000000000000001', links: googleLinks('com.demo.alpha', '4970000000000000001'),
        fetchedAt: new Date().toISOString(),
        error: null,
        status: {
          tracks: [
            {
              track: 'production',
              live: { version: '2.4.0', buildNumber: '240', versionCodes: [240], state: 'LIVE', rawState: 'PUBLISHED' },
              inFlight: { version: '2.5.0', buildNumber: '250', state: 'IN_REVIEW', rawState: 'IN_REVIEW' }
            },
            { track: 'internal', live: { version: '2.5.0', buildNumber: '250', state: 'LIVE', rawState: 'PUBLISHED' }, inFlight: null }
          ]
        },
        rollout: { error: null, status: { tracks: { production: [{ name: '2.4.0', versionCodes: [240], status: 'inProgress', userFraction: 0.2 }] } } },
        vitals: {
          error: null,
          status: {
            crash: { userPerceived: 0.0042, overall: 0.0071, distinctUsers: 5400, date: '2026-11-13' },
            anr: { userPerceived: 0.0011, overall: 0.0019, distinctUsers: 5400, date: '2026-11-13' }
          }
        },
        reviews: {
          error: null,
          status: {
            total: 17, average: 3.9,
            recent: [{ reviewId: 'demo-2', rating: 3, title: null, body: 'Good, but the widget sometimes stops updating.', version: '2.4.0', territory: 'en_GB', createdAt: new Date(Date.now() - 86400000).toISOString(), replied: false }]
          }
        }
      }
    },
    {
      id: 'google-com.demo.beta',
      name: 'App Beta',
      apple: null,
      google: { packageName: 'com.demo.beta', name: 'App Beta', consoleAppId: null, links: googleLinks('com.demo.beta', null) }
    }
  ],
  common: {
    apple: [
      { id: 'apple.integrations', label: 'Integrations (API keys)', url: 'https://appstoreconnect.apple.com/access/integrations/api' },
      { id: 'apple.users', label: 'Users and Access', url: 'https://appstoreconnect.apple.com/access/users' }
    ],
    google: [
      { id: 'google.users', label: 'Users and permissions', url: 'https://play.google.com/console/developers/0000000000000000000/users-and-permissions' }
    ],
    custom: []
  }
};

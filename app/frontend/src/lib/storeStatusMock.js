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
        }
      },
      google: { packageName: 'com.demo.alpha', name: 'App Alpha', consoleAppId: '4970000000000000001', links: googleLinks('com.demo.alpha', '4970000000000000001') }
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

const assert = require('assert');
const {
  LINK_TEMPLATES, parsePlayBase, isSafeHttpsUrl, expandTemplate, normalizeCustomLinks, lookupConsoleAppId, buildStoreLinks
} = require('../lib/storeStatus/links');
const { buildAppList, configuredGooglePackages } = require('../lib/storeStatus/apps');

const byId = (links, id) => links.find(l => l.id === id);

function testParsePlayBase() {
  assert.strictEqual(
    parsePlayBase('https://play.google.com/console/u/0/developers/1234567890123456789'),
    'https://play.google.com/console/u/0/developers/1234567890123456789');
  assert.strictEqual(
    parsePlayBase('https://play.google.com/console/u/2/developers/42/app/99/app-dashboard?x=1'),
    'https://play.google.com/console/u/2/developers/42', 'trailing path is dropped, account index kept');
  assert.strictEqual(
    parsePlayBase(' https://play.google.com/console/developers/42 '),
    'https://play.google.com/console/developers/42', 'works without the /u/N/ segment');
  assert.strictEqual(parsePlayBase('https://play.google.com/console'), null, 'default value has no developer ID');
  assert.strictEqual(parsePlayBase('https://evil.example/console/u/0/developers/42'), null, 'only play.google.com is accepted');
  assert.strictEqual(parsePlayBase('https://play.google.com/console/u/0/developers/YOUR_DEVELOPER_ID'), null, 'placeholder text is rejected');
  assert.strictEqual(parsePlayBase(undefined), null);
  console.log('✓ parsePlayBase extracts the developer root');
}

function testExpandTemplate() {
  assert.deepStrictEqual(
    expandTemplate('https://example.com/apps/{appleAppId}/x', { appleAppId: '123' }),
    { url: 'https://example.com/apps/123/x', missing: [] });
  assert.deepStrictEqual(
    expandTemplate('{playBase}/app/{consoleAppId}/x', { playBase: 'https://play.google.com/console/developers/1' }),
    { url: null, missing: ['consoleAppId'] }, 'missing values are reported, not left in the URL');
  assert.strictEqual(
    expandTemplate('https://example.com/?id={packageName}', { packageName: 'a.b&c=d/../e' }).url,
    'https://example.com/?id=a.b%26c%3Dd%2F..%2Fe', 'values are URL-encoded');
  assert.strictEqual(expandTemplate('http://example.com/{a}', { a: '1' }).url, null, 'non-https result is refused');
  assert.strictEqual(expandTemplate('javascript:alert({a})', { a: '1' }).url, null, 'script URLs are refused');
  console.log('✓ expandTemplate fills, encodes and validates');
}

function testCustomLinks() {
  const links = normalizeCustomLinks([
    { label: 'Status page', url: 'https://status.example.com', group: 'Ops' },
    { label: 'No group', url: 'https://example.com/a' },
    { label: 'Insecure', url: 'http://example.com' },
    { label: 'Script', url: 'javascript:alert(1)' },
    { label: '', url: 'https://example.com' },
    { url: 'https://example.com' },
    null
  ]);
  assert.strictEqual(links.length, 2, 'only https links with a label survive');
  assert.strictEqual(links[0].group, 'Ops');
  assert.strictEqual(links[1].group, 'Custom');
  assert.deepStrictEqual(normalizeCustomLinks('nope'), []);
  assert.strictEqual(isSafeHttpsUrl('not a url'), false);
  console.log('✓ custom links are validated');
}

function testConsoleAppId() {
  const config = { appMetadata: { 'com.a': { consoleAppId: '4970000000000000001' }, 'com.b': { consoleAppId: 'YOUR_CONSOLE_APP_ID_1 (Found in ...)' } } };
  assert.strictEqual(lookupConsoleAppId(config, 'com.a'), '4970000000000000001');
  assert.strictEqual(lookupConsoleAppId(config, 'com.b'), null, 'placeholder text from example.config.json is not an ID');
  assert.strictEqual(lookupConsoleAppId(config, 'com.c', '77'), '77', 'falls back to the pairing value');
  assert.strictEqual(lookupConsoleAppId({}, 'com.c'), null);
  console.log('✓ consoleAppId lookup');
}

function testBuildStoreLinks() {
  const config = {
    PlaystoreConsoleUrl: 'https://play.google.com/console/u/0/developers/42',
    appMetadata: { 'com.example.one': { consoleAppId: '900' } },
    storeStatus: {
      linkOverrides: { 'apple.testflight': 'https://appstoreconnect.apple.com/apps/{appleAppId}/testflight' },
      customLinks: [{ label: 'Runbook', url: 'https://example.com/runbook' }]
    }
  };
  const apps = [
    { id: 'pair-one', name: 'One', apple: { appId: '111', bundleId: 'com.example.one', name: 'One' }, google: { packageName: 'com.example.one', name: 'One' } },
    { id: 'google-com.example.two', name: 'Two', apple: null, google: { packageName: 'com.example.two', name: 'Two' } }
  ];
  const out = buildStoreLinks({ config, apps, gcpProjectId: 'proj-1' });

  const one = out.apps[0];
  assert.strictEqual(byId(one.apple.links, 'apple.app').url, 'https://appstoreconnect.apple.com/apps/111/distribution');
  assert.strictEqual(byId(one.apple.links, 'apple.testflight').url, 'https://appstoreconnect.apple.com/apps/111/testflight', 'override template wins');
  assert.strictEqual(byId(one.apple.links, 'apple.listing').url, 'https://apps.apple.com/app/id111');
  assert.strictEqual(byId(one.google.links, 'google.dashboard').url, 'https://play.google.com/console/u/0/developers/42/app/900/app-dashboard');
  assert.strictEqual(byId(one.google.links, 'google.listing').url, 'https://play.google.com/store/apps/details?id=com.example.one');

  const two = out.apps[1];
  assert.strictEqual(two.apple, null);
  const dash = byId(two.google.links, 'google.dashboard');
  assert.strictEqual(dash.url, null, 'no consoleAppId: console link is disabled');
  assert(/consoleAppId/.test(dash.reason), 'and says which setting is missing');
  assert.strictEqual(byId(two.google.links, 'google.listing').url, 'https://play.google.com/store/apps/details?id=com.example.two', 'public listing needs no console IDs');

  assert.strictEqual(byId(out.common.google, 'google.users').url, 'https://play.google.com/console/u/0/developers/42/users-and-permissions');
  assert.strictEqual(byId(out.common.google, 'google.serviceAccounts').url, 'https://console.cloud.google.com/iam-admin/serviceaccounts?project=proj-1');
  assert.strictEqual(byId(out.common.apple, 'apple.integrations').url, 'https://appstoreconnect.apple.com/access/integrations/api');
  assert.strictEqual(out.common.custom.length, 1);

  // Degraded config: nothing set.
  const bare = buildStoreLinks({ config: {}, apps, gcpProjectId: null });
  assert.strictEqual(byId(bare.common.google, 'google.users').url, null);
  assert(/PlaystoreConsoleUrl/.test(byId(bare.common.google, 'google.users').reason));
  assert.strictEqual(byId(bare.common.google, 'google.serviceAccounts').url, null);
  assert(bare.common.apple.every(l => l.url), 'Apple account links need no IDs');

  // Every link that is produced is https, and ids are unique.
  const all = [...out.common.apple, ...out.common.google, ...out.apps.flatMap(a => [...(a.apple?.links || []), ...(a.google?.links || [])])];
  assert(all.filter(l => l.url).every(l => l.url.startsWith('https://')));
  assert.strictEqual(new Set(LINK_TEMPLATES.map(l => l.id)).size, LINK_TEMPLATES.length, 'link ids are unique');
  console.log('✓ buildStoreLinks builds per-app and account links and degrades per link');
}

function testBuildAppList() {
  const config = {
    appPairings: [{ name: 'One', android: 'com.example.one', ios: 'com.example.one' }, { name: 'Gone', android: 'com.example.gone', ios: 'com.example.gone', ignore: true }],
    appMetadata: { 'com.example.extra': { consoleAppId: '5' } },
    ignoredPackages: ['com.example.hidden']
  };
  assert.deepStrictEqual(
    configuredGooglePackages(config).map(g => g.packageName).sort(),
    ['com.example.extra', 'com.example.one']);

  // Bucket listing returned nothing (for example while Play permissions propagate).
  const appleApps = [
    { name: 'One for iOS', appId: '111', bundleId: 'com.example.one', packageName: 'com.example.one', platform: 'apple' },
    { name: 'Solo', appId: '222', bundleId: 'com.example.solo', packageName: 'com.example.solo', platform: 'apple' }
  ];
  const apps = buildAppList({ config, googleApps: [], appleApps });
  const one = apps.find(a => a.name === 'One');
  assert(one && one.apple && one.google, 'configured pairing joins both stores even without a bucket listing');
  assert.strictEqual(one.apple.appId, '111');
  assert.strictEqual(one.google.packageName, 'com.example.one');
  assert.strictEqual(apps[0].name, 'One', 'apps on both stores sort first');
  assert(apps.some(a => a.apple?.bundleId === 'com.example.solo' && a.google === null));
  assert(apps.some(a => a.google?.packageName === 'com.example.extra' && a.apple === null));
  assert(!apps.some(a => a.google?.packageName === 'com.example.gone'), 'ignored pairing is skipped');

  // A package from the bucket is not duplicated by its config entry.
  const withBucket = buildAppList({ config, googleApps: [{ name: 'One', packageName: 'com.example.one', platform: 'google' }], appleApps });
  assert.strictEqual(withBucket.filter(a => a.google?.packageName === 'com.example.one').length, 1);
  console.log('✓ buildAppList merges store listings with configured packages');
}

testParsePlayBase();
testExpandTemplate();
testCustomLinks();
testConsoleAppId();
testBuildStoreLinks();
testBuildAppList();
console.log('All store status link tests passed!');

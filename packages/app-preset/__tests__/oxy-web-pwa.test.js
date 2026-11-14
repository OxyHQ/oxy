const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { PwaError, makeInstallable, validateManifest } = require('../web/pwa');

const BIN = join(__dirname, '..', 'bin', 'oxy-web-pwa.js');

// Expo's default `single` template: what alia.onl served, with no manifest link.
const SPA_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>App</title>
  <link rel="stylesheet" href="/_expo/static/css/global-1.css"></head>
  <body><div id="root"></div><script src="/_expo/static/js/web/index-1.js" defer></script></body>
</html>
`;

const MANIFEST = {
  name: 'Example by Oxy',
  short_name: 'Example',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#0c0e11',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

function exportDir({ manifest = MANIFEST, pages = { 'index.html': SPA_PAGE }, files = {} } = {}) {
  const dist = mkdtempSync(join(tmpdir(), 'oxy-web-pwa-'));
  const all = {
    'icon-192.png': 'png',
    'icon-512.png': 'png',
    '_expo/static/js/web/index-1.js': '/* bundle */',
    ...pages,
    ...files,
  };
  if (manifest !== null) all['manifest.json'] = JSON.stringify(manifest);
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const read = (dist, path) => readFileSync(join(dist, path), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('a single-output page gets the manifest link, Apple tags, theme colour and worker registration', (t) => {
  const dist = exportDir({ files: { 'apple-touch-icon.png': 'png' } });
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const result = makeInstallable(dist);
  const html = read(dist, 'index.html');
  assert.deepEqual(result.updated, ['index.html']);
  assert.match(html, /<link rel="manifest" href="\/manifest.json" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png" \/>/);
  assert.match(html, /<meta name="theme-color" content="#0c0e11" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Example" \/>/);
  assert.match(html, /<script src="\/oxy-sw-register.js" defer><\/script>/);
  assert.ok(html.indexOf('rel="manifest"') < html.indexOf('</head>'), 'the tags go in the head');
});

test('the step is idempotent', (t) => {
  const dist = exportDir();
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  makeInstallable(dist);
  const first = read(dist, 'index.html');
  const again = makeInstallable(dist);
  assert.deepEqual(again.updated, []);
  assert.equal(read(dist, 'index.html'), first);
  assert.equal(count(first, 'rel="manifest"'), 1);
});

test('static pages keep the tags they already have and every page is covered', (t) => {
  const own = SPA_PAGE.replace(
    '<title>App</title>',
    '<title>App</title><link rel="manifest" href="/manifest.json" /><meta name="theme-color" content="#f3f3f7" media="(prefers-color-scheme: light)" />',
  );
  const dist = exportDir({
    pages: { 'index.html': own, 'settings/index.html': SPA_PAGE, '+not-found.html': SPA_PAGE },
    files: { '_expo/static/ignored.html': '<p>not a page</p>' },
  });
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const result = makeInstallable(dist);
  assert.equal(result.pages, 3);
  const index = read(dist, 'index.html');
  assert.equal(count(index, 'rel="manifest"'), 1);
  assert.equal(count(index, 'name="theme-color"'), 1);
  assert.match(index, /oxy-sw-register.js/);
  assert.match(read(dist, 'settings/index.html'), /rel="manifest"/);
  assert.equal(read(dist, '_expo/static/ignored.html'), '<p>not a page</p>');
});

test('an export with no manifest, or one browsers will not install, fails', (t) => {
  const cases = [
    [{ manifest: null }, /no web app manifest/],
    [{ manifest: { ...MANIFEST, display: 'browser' } }, /"display" is "browser"/],
    [{ manifest: { ...MANIFEST, icons: [MANIFEST.icons[0]] } }, /no 512x512 icon/],
    [{ manifest: { ...MANIFEST, start_url: undefined } }, /no "start_url"/],
    [
      { manifest: { ...MANIFEST, prefer_related_applications: true } },
      /prefer_related_applications/,
    ],
  ];
  for (const [options, message] of cases) {
    const dist = exportDir(options);
    t.after(() => rmSync(dist, { recursive: true, force: true }));
    assert.throws(
      () => makeInstallable(dist),
      (error) => error instanceof PwaError && message.test(error.message),
    );
    assert.doesNotMatch(
      read(dist, 'index.html'),
      /rel="manifest"/,
      'nothing is written on failure',
    );
  }
});

test('an icon the export does not contain fails; a missing maskable icon only warns', (t) => {
  const dist = exportDir();
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  rmSync(join(dist, 'icon-512.png'));
  assert.throws(() => makeInstallable(dist), /icon \/icon-512.png is not in the export/);
  const complete = exportDir();
  t.after(() => rmSync(complete, { recursive: true, force: true }));
  const anyPurpose = MANIFEST.icons.map((icon) => ({ ...icon, purpose: 'any' }));
  const { errors, warnings } = validateManifest({ ...MANIFEST, icons: anyPurpose }, complete);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /maskable/.test(w)));
});

test('an app without sw.js gets the base worker; its own sw.js is never overwritten', (t) => {
  const bare = exportDir();
  const withPush = exportDir({ files: { 'sw.js': "self.addEventListener('push', () => {});\n" } });
  t.after(() => {
    for (const dir of [bare, withPush]) rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(makeInstallable(bare).worker, 'base');
  assert.match(read(bare, 'sw.js'), /importScripts\('\/oxy-sw-base.js'\)/);
  assert.ok(existsSync(join(bare, 'oxy-sw-register.js')));
  assert.doesNotMatch(read(bare, 'oxy-sw-base.js'), /__OXY_SW_VERSION__/);

  const result = makeInstallable(withPush);
  assert.equal(read(withPush, 'sw.js'), "self.addEventListener('push', () => {});\n");
  assert.ok(result.warnings.some((w) => /does not import \/oxy-sw-base.js/.test(w)));
});

test('the worker version changes with the export', (t) => {
  const a = exportDir();
  const b = exportDir({ pages: { 'index.html': SPA_PAGE.replace('index-1.js', 'index-2.js') } });
  t.after(() => {
    for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true });
  });
  makeInstallable(a);
  makeInstallable(b);
  assert.notEqual(read(a, 'oxy-sw-base.js'), read(b, 'oxy-sw-base.js'));
});

test('--no-sw ships no worker and links no registration', (t) => {
  const dist = exportDir();
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  execFileSync(process.execPath, [BIN, dist, '--no-sw']);
  assert.ok(!existsSync(join(dist, 'sw.js')));
  assert.ok(!existsSync(join(dist, 'oxy-sw-base.js')));
  assert.doesNotMatch(read(dist, 'index.html'), /oxy-sw-register/);
  assert.match(read(dist, 'index.html'), /rel="manifest"/);
});

test('the CLI exits 1 on an uninstallable export', (t) => {
  const dist = exportDir({ manifest: null });
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  assert.throws(
    () => execFileSync(process.execPath, [BIN, dist], { stdio: 'pipe' }),
    (error) => error.status === 1 && /no web app manifest/.test(String(error.stderr)),
  );
});

// ─── The base worker ────────────────────────────────────────────────

function loadWorker() {
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener() {},
    clients: { claim() {} },
    skipWaiting() {},
  };
  vm.runInNewContext(read(join(__dirname, '..', 'web'), 'oxy-sw-base.js'), { self, URL });
  return self.__oxySwBaseInternals;
}

function request(
  url,
  { method = 'GET', mode = 'cors', headers = {}, credentials = 'same-origin' } = {},
) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url,
    method,
    mode,
    credentials,
    headers: { has: (name) => name.toLowerCase() in lower },
  };
}

test('the base worker never handles private, cross-origin or mutating requests', () => {
  const { strategyFor } = loadWorker();
  const origin = 'https://app.example';
  assert.equal(strategyFor(request('https://api.oxy.so/users/me')), null);
  assert.equal(
    strategyFor(request(`${origin}/_expo/static/js/web/index.js`, { method: 'POST' })),
    null,
  );
  assert.equal(strategyFor(request(`${origin}/api/session`)), null);
  assert.equal(
    strategyFor(request(`${origin}/assets/a.png`, { headers: { Authorization: 'Bearer x' } })),
    null,
  );
  assert.equal(strategyFor(request(`${origin}/assets/a.png`, { credentials: 'include' })), null);
  assert.equal(
    strategyFor(request(`${origin}/video.mp4`, { headers: { Range: 'bytes=0-' } })),
    null,
  );
  assert.equal(strategyFor(request(`${origin}/data.json`)), null);
});

test('the base worker serves navigations and same-origin static files', () => {
  const { strategyFor } = loadWorker();
  const origin = 'https://app.example';
  assert.equal(strategyFor(request(`${origin}/inbox/42`, { mode: 'navigate' })), 'navigation');
  assert.equal(strategyFor(request(`${origin}/_expo/static/js/web/index-1.js`)), 'static');
  assert.equal(strategyFor(request(`${origin}/icon-192.png`)), 'static');
});

test('the base worker stores only complete, public, same-origin responses', () => {
  const { cacheable } = loadWorker();
  const response = (status, type, control = '') => ({
    ok: status >= 200 && status < 300,
    status,
    type,
    headers: { get: (name) => (name === 'cache-control' ? control : null) },
  });
  assert.equal(cacheable(response(200, 'basic')), true);
  assert.equal(cacheable(response(200, 'opaque')), false);
  assert.equal(cacheable(response(206, 'basic')), false);
  assert.equal(cacheable(response(200, 'basic', 'private, max-age=60')), false);
  assert.equal(cacheable(response(200, 'basic', 'no-store')), false);
});

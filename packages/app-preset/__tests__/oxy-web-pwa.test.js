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
  // New bytes make the browser install the new worker; the cache name stays, so
  // the previous deploy's chunks remain available to a tab still running it.
  assert.notEqual(read(a, 'oxy-sw-base.js'), read(b, 'oxy-sw-base.js'));
  const cacheName = (dist) =>
    read(dist, 'oxy-sw-base.js').match(/CACHE_NAME = `\$\{CACHE_PREFIX\}(\w+)`/)[1];
  assert.equal(cacheName(a), cacheName(b));
});

test('--remove-sw ships a worker that retires the old one and links no registration', (t) => {
  const dist = exportDir();
  const withPush = exportDir({ files: { 'sw.js': "self.addEventListener('push', () => {});\n" } });
  t.after(() => {
    for (const dir of [dist, withPush]) rmSync(dir, { recursive: true, force: true });
  });
  execFileSync(process.execPath, [BIN, dist, '--remove-sw']);
  const worker = read(dist, 'sw.js');
  assert.match(worker, /registration\.unregister\(\)/);
  assert.match(worker, /caches\.delete/);
  assert.doesNotMatch(worker, /addEventListener\('fetch'/);
  assert.ok(!existsSync(join(dist, 'oxy-sw-base.js')));
  assert.doesNotMatch(read(dist, 'index.html'), /oxy-sw-register/);
  assert.match(read(dist, 'index.html'), /rel="manifest"/);

  assert.throws(
    () => makeInstallable(withPush, { removeServiceWorker: true }),
    /ships its own public\/sw.js/,
  );
  assert.throws(
    () => makeInstallable(dist, { removeServiceWorker: true, serviceWorker: false }),
    /cannot be combined/,
  );
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

test('--theme-color writes a light/dark pair instead of the manifest colour', (t) => {
  const dist = exportDir();
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  execFileSync(process.execPath, [BIN, dist, '--theme-color=#f9f2f6,#100d11']);
  const html = read(dist, 'index.html');
  assert.match(
    html,
    /<meta name="theme-color" content="#f9f2f6" media="\(prefers-color-scheme: light\)" \/>/,
  );
  assert.match(
    html,
    /<meta name="theme-color" content="#100d11" media="\(prefers-color-scheme: dark\)" \/>/,
  );
  assert.doesNotMatch(html, /#0c0e11/);
  assert.deepEqual(makeInstallable(dist, { themeColors: ['#f9f2f6', '#100d11'] }).updated, []);
});

test('--theme-color refuses anything but one or two colours', (t) => {
  const dist = exportDir();
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  for (const themeColors of [[], ['#fff', '#000', '#111'], ['"><script>']])
    assert.throws(() => makeInstallable(dist, { themeColors }), /--theme-color takes/);
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

function fakeCaches(names) {
  const stores = new Map(names.map((name) => [name, []]));
  return {
    stores,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, []);
      const entries = stores.get(name);
      return {
        keys: async () => entries.map((url) => ({ url })),
        delete: async (key) => {
          entries.splice(entries.indexOf(key.url), 1);
        },
      };
    },
  };
}

function loadWorker(file = 'oxy-sw-base.js', caches = fakeCaches([]), fetch = undefined) {
  const listeners = {};
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    clients: { claim() {} },
    registration: {
      unregistered: false,
      unregister: async () => (self.registration.unregistered = true),
    },
    skipWaiting() {},
  };
  vm.runInNewContext(read(join(__dirname, '..', 'web'), file), {
    self,
    URL,
    caches,
    fetch,
    Response,
  });
  const fire = async (type, data) => {
    const pending = [];
    listeners[type]({ data, waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  return { ...self.__oxySwBaseInternals, self, fire };
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
  assert.equal(
    strategyFor(request(`${origin}/video.mp4`, { headers: { Range: 'bytes=0-' } })),
    null,
  );
  assert.equal(strategyFor(request(`${origin}/data.json`)), null);
});

test('the base worker serves navigations and same-origin static files', () => {
  const { strategyFor } = loadWorker();
  const origin = 'https://app.example';
  // A navigation's credentials mode is always `include`; it must still get the offline shell.
  assert.equal(
    strategyFor(request(`${origin}/inbox/42`, { mode: 'navigate', credentials: 'include' })),
    'navigation',
  );
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

test('activating the base worker drops older Oxy caches and nothing else', async () => {
  const caches = fakeCaches(['oxy-sw-v1', 'oxy-sw-0123456789abcdef', 'inbox-v3']);
  const { fire, CACHE_NAME } = loadWorker('oxy-sw-base.js', caches);
  assert.equal(CACHE_NAME, 'oxy-sw-v1');
  await fire('activate');
  assert.deepEqual([...caches.stores.keys()], ['oxy-sw-v1', 'inbox-v3']);
});

test('the base cache drops its oldest entries past the bound, never the shell', async () => {
  const caches = fakeCaches([]);
  const { trim, MAX_ENTRIES, SHELL_KEY } = loadWorker('oxy-sw-base.js', caches);
  const cache = await caches.open('oxy-sw-v1');
  const store = caches.stores.get('oxy-sw-v1');
  store.push(`https://app.example${SHELL_KEY}`);
  for (let i = 0; i < MAX_ENTRIES + 5; i++) store.push(`https://app.example/_expo/${i}.js`);
  await trim(cache);
  assert.equal(store.length, MAX_ENTRIES);
  assert.equal(store[0], `https://app.example${SHELL_KEY}`);
  assert.equal(store[1], 'https://app.example/_expo/6.js');
});

test('the removal worker deletes the Oxy caches and unregisters', async () => {
  const caches = fakeCaches(['oxy-sw-v1', 'other-app-cache']);
  const { fire, self } = loadWorker('oxy-sw-remove.js', caches);
  await fire('activate');
  assert.deepEqual([...caches.stores.keys()], ['other-app-cache']);
  assert.equal(self.registration.unregistered, true);
});

test('the registration skips the HTTP cache and re-checks a foregrounded app hourly', async () => {
  let now = 0;
  const calls = { register: [], update: 0 };
  const docListeners = {};
  const registration = { update: async () => calls.update++ };
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener: (type, listener) => {
      docListeners[type] = listener;
    },
  };
  const navigator = {
    serviceWorker: {
      controller: null,
      addEventListener() {},
      register: async (...args) => {
        calls.register.push(args);
        return registration;
      },
    },
  };
  const window = { isSecureContext: true, addEventListener() {} };
  const FakeDate = { now: () => now };
  vm.runInNewContext(read(join(__dirname, '..', 'web'), 'oxy-sw-register.js'), {
    navigator,
    document,
    window,
    Date: FakeDate,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    JSON.stringify(calls.register),
    JSON.stringify([['/sw.js', { updateViaCache: 'none' }]]),
  );
  now = 10 * 60 * 1000;
  docListeners.visibilitychange();
  assert.equal(calls.update, 0);
  now = 61 * 60 * 1000;
  docListeners.visibilitychange();
  assert.equal(calls.update, 1);
});

/** A cache store keyed by path that keeps real Response objects. */
function responseCache() {
  const entries = new Map();
  const key = (request) =>
    new URL(typeof request === 'string' ? request : request.url, 'https://app.example').pathname;
  const cache = {
    put: async (request, response) => {
      entries.set(key(request), response);
    },
    match: async (request) => entries.get(key(request)),
    keys: async () => [...entries.keys()].map((path) => ({ url: `https://app.example${path}` })),
    delete: async (request) => entries.delete(key(request)),
  };
  return {
    entries,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
  };
}

/** What fetch() returns after following Cloudflare's 307 from /index.html to /. */
function redirectedHtml(body) {
  const response = new Response(body, { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'redirected', { value: true });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

test('the stored shell never went through a redirect, and the bundles it loads are stored with it', async () => {
  const { entries, caches } = responseCache();
  const requested = [];
  const shellHtml =
    '<html><head><link rel="stylesheet" href="/_expo/static/css/global-1.css">' +
    '<script src="https://cdn.example/x.js"></script></head>' +
    '<body><script src="/_expo/static/js/web/entry-1.js" defer></script></body></html>';
  const asset = (body) => {
    const response = new Response(body);
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  };
  const { storeShell, SHELL_KEY } = loadWorker('oxy-sw-base.js', caches, async (url, init) => {
    requested.push(String(url));
    if (url === '/') {
      assert.equal(init.cache, 'reload');
      return redirectedHtml(shellHtml);
    }
    return asset(`/* ${url} */`);
  });
  await storeShell();
  const shell = entries.get(SHELL_KEY);
  assert.equal(shell.redirected, false);
  assert.equal(await shell.text(), shellHtml);
  assert.deepEqual(
    [...entries.keys()].sort(),
    ['/_expo/static/css/global-1.css', '/_expo/static/js/web/entry-1.js', SHELL_KEY].sort(),
  );
  assert.ok(!requested.some((url) => url.includes('cdn.example')));
});

test('offline, a navigation gets the shell as a plain response, even one stored redirected', async () => {
  const { entries, caches } = responseCache();
  const { navigation, SHELL_KEY } = loadWorker('oxy-sw-base.js', caches, async () => {
    throw new TypeError('Failed to fetch');
  });
  entries.set(SHELL_KEY, redirectedHtml('<html>old shell</html>'));
  const response = await navigation({ url: 'https://app.example/inbox/42' });
  assert.equal(response.redirected, false);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>old shell</html>');

  entries.clear();
  assert.equal((await navigation({ url: 'https://app.example/' })).status, 503);
});

test('a page sends the worker the files it loaded before the worker controlled it', async () => {
  const posted = [];
  let onControllerChange;
  const navigator = {
    serviceWorker: {
      controller: null,
      addEventListener: (type, listener) => {
        if (type === 'controllerchange') onControllerChange = listener;
      },
      register: async () => ({ update: async () => {} }),
    },
  };
  const performance = {
    getEntriesByType: () => [
      { name: 'https://app.example/_expo/static/js/web/_layout-1.js' },
      { name: 'https://api.oxy.so/users/me' },
    ],
  };
  vm.runInNewContext(read(join(__dirname, '..', 'web'), 'oxy-sw-register.js'), {
    navigator,
    performance,
    location: { origin: 'https://app.example' },
    document: { readyState: 'complete', addEventListener() {} },
    window: { isSecureContext: true, addEventListener() {} },
    Date,
  });
  navigator.serviceWorker.controller = { postMessage: (message) => posted.push(message) };
  onControllerChange();
  assert.equal(
    JSON.stringify(posted),
    JSON.stringify([
      { type: 'OXY_SW_STORE', urls: ['https://app.example/_expo/static/js/web/_layout-1.js'] },
    ]),
  );
});

test('the worker stores only the static same-origin files a page sends it', async () => {
  const { entries, caches } = responseCache();
  const fetched = [];
  const { fire } = loadWorker('oxy-sw-base.js', caches, async (url) => {
    fetched.push(url);
    const response = new Response('x');
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  });
  await fire('message', {
    type: 'OXY_SW_STORE',
    urls: [
      'https://app.example/_expo/static/js/web/_layout-1.js',
      'https://app.example/assets/font.ttf',
      'https://app.example/api/session',
      'https://app.example/data.json',
      'https://cdn.example/x.js',
      'not a url ::',
    ],
  });
  assert.deepEqual([...entries.keys()].sort(), [
    '/_expo/static/js/web/_layout-1.js',
    '/assets/font.ttf',
  ]);
  assert.equal(fetched.length, 2);
});

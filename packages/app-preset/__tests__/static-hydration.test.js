const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { JSDOM } = require('jsdom');
const { renderHydratableDocument } = require('../metro/static-hydration/render-document');
const h = React.createElement;
function Document({ children, head = [], body = [] }) {
  return h('html', { lang: 'en' }, h('head', null, head), h('body', null, children, body));
}
function documentWithApp(html, props) {
  return h(Document, props, h('div', { id: 'root', dangerouslySetInnerHTML: { __html: html } }));
}
async function hydrate(html, app, inspect = () => {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.querySelector('[data-workspace]');
  const serverIds = [...document.querySelectorAll('input')].map((input) => input.id);
  const errors = [];
  let root;
  try {
    await React.act(async () => {
      root = require('react-dom/client').hydrateRoot(document.querySelector('#root'), app, {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    assert.equal(document.querySelector('[data-workspace]'), node);
    assert.deepEqual(
      [...document.querySelectorAll('input')].map((input) => input.id),
      serverIds,
    );
    assert.equal(new Set(serverIds).size, serverIds.length);
    assert.deepEqual(errors, []);
    inspect(document);
  } finally {
    if (root) await React.act(async () => root.unmount());
    global.window = previousWindow;
    global.document = previousDocument;
    delete global.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}
function Field() {
  const id = React.useId();
  return h(
    React.Fragment,
    null,
    h('style', null, `[data-field="${id}"]{display:block}`),
    h('label', { htmlFor: id }, 'Email'),
    h('input', { id, 'data-field': id }),
  );
}
test('document siblings do not change app useId or replace hydrated DOM', async () => {
  const app = h('main', { 'data-workspace': true }, h(Field), h(Field));
  await hydrate(await renderHydratableDocument(app, documentWithApp), app);
});
test('awaits Suspense before collecting resources and preserves hydration', async () => {
  let ready = false;
  let release;
  const suspended = new Promise((resolve) => {
    release = resolve;
  });
  const resources = [];
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  function Content() {
    if (!ready) {
      notifyStarted();
      throw suspended;
    }
    if (!resources.length)
      resources.push(h('style', { key: 'late-style', id: 'late-style' }, '.late{}'));
    return h('main', { 'data-workspace': true }, h(Field), 'message '.repeat(14000));
  }
  const app = h(React.Suspense, { fallback: h('div', null, 'Pending') }, h(Content));
  let documentRendered = false;
  const promise = renderHydratableDocument(app, (html) => {
    documentRendered = true;
    assert.equal(ready, true);
    return documentWithApp(html, { head: resources });
  });
  await started;
  // Give a streaming renderer time to flush its fallback: allReady alone is
  // not enough to prevent hidden segments from being queued after the root.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentRendered, false);
  ready = true;
  release();
  const html = await promise;
  assert.equal((html.match(/id="late-style"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Pending|<!--\$\?-->|id="[BS]:|\$RC\(/);
  const staticDocument = new JSDOM(html).window.document;
  assert.ok(staticDocument.querySelector('#root main'));
  assert.equal(staticDocument.querySelector('[hidden]'), null);
  await hydrate(html, app);
});
test('emits bootstrap and ordered document scripts once, with metadata outside root', async () => {
  const html = await renderHydratableDocument(
    h('main', { 'data-workspace': true }, h(Field)),
    (appHtml) =>
      documentWithApp(appHtml, {
        head: [
          h('title', { key: 'title' }, 'Inbox'),
          h('link', { key: 'css', rel: 'stylesheet', href: '/app.css' }),
        ],
        body: [
          h('script', { key: 'one', defer: true, src: '/runtime.js' }),
          h('script', { key: 'two', defer: true, src: '/app.js' }),
        ],
      }),
    { bootstrapScriptContent: 'globalThis.__EXPO_ROUTER_HYDRATE__=true;' },
  );
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.head.querySelector('title').textContent, 'Inbox');
  assert.equal(dom.window.document.head.querySelector('link').getAttribute('href'), '/app.css');
  assert.equal(dom.window.document.querySelector('#root script'), null);
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('script[src]')].map((script) =>
      script.getAttribute('src'),
    ),
    ['/runtime.js', '/app.js'],
  );
  assert.equal((html.match(/__EXPO_ROUTER_HYDRATE__/g) ?? []).length, 1);
  dom.window.close();
});
test('does not turn server render errors into successful static fallback pages', async () => {
  const failure = new Error('Static render failed');
  function Broken() {
    throw failure;
  }
  await assert.rejects(
    renderHydratableDocument(
      h(React.Suspense, { fallback: 'Fallback' }, h(Broken)),
      documentWithApp,
    ),
    failure,
  );
});
test('forwards an aborted request to React', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Request aborted'));
  await assert.rejects(
    renderHydratableDocument(h(Field), documentWithApp, { signal: controller.signal }),
    /Request aborted/,
  );
});

test('keeps React 19 hoisted metadata and preload resources in head through hydration', async () => {
  const app = h(
    'main',
    { 'data-workspace': true },
    h('title', null, 'App title'),
    h('meta', { name: 'description', content: 'Description > plain text' }),
    h('link', { rel: 'preload', href: '/resource.js', as: 'script' }),
    h(Field),
  );
  const html = await renderHydratableDocument(app, documentWithApp);
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelectorAll('title').length, 1);
  assert.equal(dom.window.document.head.querySelector('title').textContent, 'App title');
  assert.equal(dom.window.document.head.querySelector('meta').content, 'Description > plain text');
  assert.equal(dom.window.document.querySelector('#root title, #root meta, #root link'), null);
  dom.window.close();
  await hydrate(html, app, (document) => {
    assert.equal(document.querySelectorAll('title').length, 1);
    assert.equal(document.head.querySelector('title').textContent, 'App title');
    assert.equal(document.querySelectorAll('meta[name=description]').length, 1);
    assert.equal(document.querySelectorAll('link[rel=preload]').length, 1);
    assert.equal(document.querySelector('#root title, #root meta, #root link'), null);
  });
});

test('resource extraction preserves app styles, Suspense markers and raw HTML bytes', () => {
  const { extractDocumentResources } = require('../metro/static-hydration/document-resources');
  const app =
    '<!--$--><main><style>[data-id="_R_6_"]{}</style><div>A &amp; B</div></main><!--/$-->';
  const resource = '<link rel="preload" href="/x?a=1&amp;b=2" as="script"/>';
  assert.deepEqual(extractDocumentResources(`${resource}<div id="root">${app}</div>`), {
    appHtml: app,
    resources: resource,
  });
});

test('keeps root-level stylesheet and event-handler links inside the hydrated app', async () => {
  for (const props of [
    { rel: 'stylesheet', href: '/plain.css' },
    { rel: 'preload', href: '/script.js', as: 'script', onLoad: () => {} },
  ]) {
    const app = h(
      React.Fragment,
      null,
      h('link', props),
      h('main', { 'data-workspace': true }, h(Field)),
    );
    const html = await renderHydratableDocument(app, documentWithApp);
    await hydrate(html, app, (document) => {
      assert.equal(document.querySelectorAll('#root link').length, 1);
      assert.equal(document.head.querySelectorAll('link').length, 0);
    });
  }
});

test('rejects hidden streaming segments and recovery scripts outside the static root', () => {
  const { extractDocumentResources } = require('../metro/static-hydration/document-resources');
  for (const tail of [
    '<div hidden id="S:0">Late content</div>',
    '<script>$RC("B:0","S:0")</script>',
  ]) {
    assert.throws(
      () => extractDocumentResources(`<div id="root">Pending</div>${tail}`),
      /outside #root/,
    );
  }
});

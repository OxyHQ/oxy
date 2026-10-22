const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { JSDOM } = require('jsdom');
const { Helmet, HelmetProvider } = require(
  path.join(
    path.dirname(require.resolve('expo-router/package.json')),
    'vendor/react-helmet-async/lib',
  ),
);
const h = React.createElement;
const DocumentContext = React.createContext(null);
const LoaderContext = React.createContext(null);
let rendered = false;
let title = 'Route title';
let registeredProps;
let observedLoader;
const delegations = [];
const original = {
  getStreamingContent: (...args) => {
    delegations.push(args);
    return 'original-stream';
  },
  resolveMetadata: () => 'metadata',
};
function App() {
  rendered = true;
  observedLoader = React.useContext(LoaderContext);
  return h(
    React.Fragment,
    null,
    h(
      Helmet,
      title ? { title } : {},
      h('meta', { name: 'description', content: 'Route description' }),
    ),
    h('main', { id: 'mail' }, React.useId()),
  );
}
function Document({ children, pathname, params }) {
  const data = React.useContext(DocumentContext);
  assert.equal(pathname, '/inbox');
  assert.deepEqual(params, { folder: 'inbox' });
  return h(
    'html',
    { lang: 'en' },
    h('head', null, h('title', null, 'Document title'), data.headNodes),
    h('body', null, children, data.bodyNodes),
  );
}
const mocks = {
  'expo-font/build/server': {
    withServerContext: (fn) => fn(),
    getServerResourceDescriptors: () => {
      assert.equal(rendered, true);
      return [{ type: 'style', id: 'fonts', css: '@font-face{font-family:test}' }];
    },
  },
  'expo-router': { ExpoRoot: App },
  'expo-router/_ctx': { ctx: {} },
  'expo-router/head': { default: { Provider: HelmetProvider } },
  'expo-router/internal/server': {
    ServerDocument: ({ data, children }) => h(DocumentContext.Provider, { value: data }, children),
  },
  'expo-router/internal/static': {
    InnerRoot: ({ loadedData, children }) =>
      h(LoaderContext.Provider, { value: loadedData }, children),
    getRouteInfoForLocation: () => ({ pathname: '/inbox', params: { folder: 'inbox' } }),
    registerStaticRootComponent: (Component, props) => {
      registeredProps = props;
      return {
        element: h(Component, props),
        getStyleElement: (props) => {
          assert.equal(rendered, true);
          return h('style', { ...props, id: 'rnw' }, '.mail{}');
        },
      };
    },
  },
  'expo-server/private': { normalizeCssAssets: (assets) => assets?.css ?? [] },
  '@expo/router-server/build/static/getRootComponent': { getRootComponent: () => Document },
  '@expo/router-server/build/server/renderStreamingContent': original,
};
const load = Module._load;
let renderer;
try {
  Module._load = (name, ...args) => mocks[name] ?? load(name, ...args);
  renderer = require('../metro/static-hydration/renderer');
} finally {
  Module._load = load;
}

test('static adapter preserves real Helmet route metadata, loaders and resources after app rendering', async () => {
  rendered = false;
  title = 'Route title';
  const location = new URL('https://example.test/inbox?q=one');
  const html = await renderer.getStreamingContent(location, {
    output: 'static',
    loader: { key: '/inbox', data: { value: '</script><script>bad()</script>' } },
    metadata: {
      headNodes: [h('meta', { key: 'generated', name: 'generated', content: 'Generated' })],
    },
    assets: {
      css: [{ type: 'css', href: '/app.css' }],
      js: ['/runtime.js', '/app.js'],
      favicon: '/icon.ico',
    },
  });
  assert.equal(registeredProps.wrapper, undefined);
  assert.equal(registeredProps.location, location);
  assert.deepEqual(observedLoader, {
    '/inbox?q=one': { value: '</script><script>bad()</script>' },
  });
  const document = new JSDOM(html).window.document;
  assert.equal(document.head.querySelector('title[data-rh]').textContent, 'Route title');
  assert.equal(document.head.querySelector('meta[name=description]').content, 'Route description');
  assert.equal(document.head.querySelector('meta[name=generated]').content, 'Generated');
  assert.equal(document.querySelectorAll('#rnw').length, 1);
  assert.equal(document.querySelectorAll('#fonts').length, 1);
  assert.equal(document.querySelector('#root #mail').textContent, '_R_0_');
  assert.deepEqual(
    [...document.querySelectorAll('script[src]')].map((script) => script.getAttribute('src')),
    ['/runtime.js', '/app.js'],
  );
  assert.equal((html.match(/__EXPO_ROUTER_HYDRATE__/g) ?? []).length, 1);
  assert.equal((html.match(/__EXPO_ROUTER_LOADER_DATA__/g) ?? []).length, 1);
  assert.equal(document.querySelectorAll('script').length, 3);
});
test('the default empty Helmet title never overrides the literal document title', async () => {
  title = null;
  const html = await renderer.getStreamingContent(new URL('https://example.test/inbox'), {
    output: 'static',
  });
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll('title').length, 1);
  assert.equal(document.title, 'Document title');
  assert.equal(document.head.querySelector('meta[name=description]').content, 'Route description');
});
test('nonstatic requests and metadata resolution retain the original Expo API', () => {
  const location = new URL('https://example.test/inbox');
  const options = { output: 'server' };
  assert.equal(renderer.getStreamingContent(location, options), 'original-stream');
  assert.deepEqual(delegations, [[location, options]]);
  assert.equal(renderer.resolveMetadata, original.resolveMetadata);
});

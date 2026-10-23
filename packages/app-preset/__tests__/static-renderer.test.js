const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const React = require('react');
// Load React DOM under the same environment as React before varying only the
// adapter's branch below. Mixing React's development/prod runtimes is invalid.
require('../metro/static-hydration/render-document');
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

// Exercise Expo's real web wrapper and loading view. Node does not perform
// Metro's platform-extension resolution or transpile Expo's published ESM.
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const expoRequire = Module.createRequire(path.join(expoRoot, 'package.json'));
const babel = expoRequire('@babel/core');
const commonjs = expoRequire.resolve('@babel/plugin-transform-modules-commonjs');
const expoModules = new Map();
function loadExpoWeb(filename) {
  if (expoModules.has(filename)) return expoModules.get(filename).exports;
  const mod = new Module(filename, module);
  expoModules.set(filename, mod);
  mod.filename = filename;
  mod.require = (name) => {
    if (!name.startsWith('.')) return require(name);
    const resolved = path.resolve(path.dirname(filename), name);
    const web = `${resolved}.web.js`;
    return loadExpoWeb(fs.existsSync(web) ? web : `${resolved}.js`);
  };
  const transformed = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    configFile: false,
    babelrc: false,
    plugins: [commonjs],
  });
  mod._compile(transformed.code, filename);
  return mod.exports;
}
const { withDevTools } = loadExpoWeb(path.join(expoRoot, 'build/launch/withDevTools.web.js'));
function loadRenderer(environment) {
  const previous = process.env.NODE_ENV;
  const rendererPath = require.resolve('../metro/static-hydration/renderer');
  delete require.cache[rendererPath];
  try {
    process.env.NODE_ENV = environment;
    Module._load = (name, ...args) =>
      name === 'expo/build/launch/withDevTools.web'
        ? { withDevTools }
        : (mocks[name] ?? load(name, ...args));
    return require(rendererPath);
  } finally {
    Module._load = load;
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}
const renderer = loadRenderer('production');

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

for (const environment of ['development', 'production']) {
  test(`${environment} app boundary hydrates through the actual Expo wrapper without replacing nodes`, async () => {
    const adapter = loadRenderer(environment);
    title = null;
    const html = await adapter.getStreamingContent(new URL('https://example.test/inbox'), {
      output: 'static',
      hydrate: true,
    });
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    const previousWindow = global.window;
    const previousDocument = global.document;
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const before = document.querySelector('#mail');
    const serverId = before.textContent;
    const errors = [];
    let root;
    function ClientApp() {
      return h(
        HelmetProvider,
        null,
        h(mocks['expo-router/internal/static'].InnerRoot, null, h(App)),
      );
    }
    const ClientRoot = environment === 'development' ? withDevTools(ClientApp) : ClientApp;
    try {
      await React.act(async () => {
        root = require('react-dom/client').hydrateRoot(
          document.querySelector('#root'),
          h(ClientRoot),
          {
            onRecoverableError: (error) => errors.push(error),
          },
        );
      });
      assert.deepEqual(errors, []);
      assert.equal(document.querySelector('#mail'), before);
      assert.equal(before.textContent, serverId);
      // The real development wrapper contributes a sibling fork even though
      // its refresh indicator is absent from the server's DOM.
      assert.equal(serverId, environment === 'development' ? '_R_1_' : '_R_0_');
    } finally {
      if (root) await React.act(async () => root.unmount());
      global.window = previousWindow;
      global.document = previousDocument;
      delete global.IS_REACT_ACT_ENVIRONMENT;
      dom.window.close();
    }
  });
}

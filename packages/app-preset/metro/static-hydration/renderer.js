/*
 * Adapted from @expo/router-server 58.0.14 / 58.0.16 renderStreamingContent.
 * Copyright © 2026 650 Industries. MIT license: ./EXPO-LICENSE.
 * Static output only. Keep Expo's live streaming renderer unchanged.
 */
const React = require('react');
const fonts = require('expo-font/build/server');
const { ExpoRoot } = require('expo-router');
const { ctx } = require('expo-router/_ctx');
const Head = require('expo-router/head').default;
const { ServerDocument } = require('expo-router/internal/server');
const {
  InnerRoot,
  getRouteInfoForLocation,
  registerStaticRootComponent,
} = require('expo-router/internal/static');
const { normalizeCssAssets } = require('expo-server/private');
const { getRootComponent } = require('@expo/router-server/build/static/getRootComponent');
const assets = require('@expo/router-server/build/utils/react');
const { serializeHelmetToHtml } = require('@expo/router-server/build/utils/html');
const original = require('@expo/router-server/build/server/renderStreamingContent');
const { renderHydratableDocument } = require('./render-document');

const h = React.createElement;

function StaticApp({ headContext, loadedData, element }) {
  return h(Head.Provider, { context: headContext }, h(InnerRoot, { loadedData }, element));
}

// Expo's web entry wraps the entire qualified app in development. Its sibling
// DevLoadingView participates in React's useId tree even while it renders null.
// Use the real wrapper on the server too, rather than compensating for its IDs.
const StaticAppRoot =
  process.env.NODE_ENV !== 'production'
    ? require('expo/build/launch/withDevTools.web').withDevTools(StaticApp)
    : StaticApp;

function getStreamingContent(location, options) {
  if (options?.output !== 'static') return original.getStreamingContent(location, options);
  return fonts.withServerContext(async () => {
    const headContext = {};
    const Document = getRootComponent();
    const route = getRouteInfoForLocation(ctx, location);
    // No document wrapper here: this is exactly the boundary hydrated in #root.
    const { element, getStyleElement } = registerStaticRootComponent(ExpoRoot, {
      location,
      context: ctx,
    });
    // Match Expo's per-page reset; React Navigation caches named contexts globally.
    globalThis.__react_navigation__elements_contexts = new Map();
    const loaderKey = options.loader ? options.loader.key + location.search : null;
    const loadedData = loaderKey ? { [loaderKey]: options.loader.data ?? null } : null;
    const app = h(StaticAppRoot, { headContext, loadedData, element });

    const html = await renderHydratableDocument(
      app,
      (appHtml) => {
        const css = assets.createInjectedCssAsNodes(normalizeCssAssets(options.assets));
        const scripts = assets.createInjectedScriptAsNodes(options.assets?.js ?? []);
        const data = {
          headNodes: [
            ...(options.metadata?.headNodes ?? []),
            options.assets?.favicon ? assets.createFaviconAsNode(options.assets.favicon) : null,
            getStyleElement({ key: 'rnw-style-element' }),
            ...(css.headNodes ?? []),
            ...(scripts.headNodes ?? []),
            ...assets.createInjectedFontsAsNodes(fonts.getServerResourceDescriptors()),
          ].filter(Boolean),
          bodyNodes: scripts.bodyNodes,
        };
        return h(
          ServerDocument,
          { data },
          h(
            Document,
            route,
            h('div', { id: 'root', dangerouslySetInnerHTML: { __html: appHtml } }),
          ),
        );
      },
      {
        progressiveChunkSize: Number.MAX_SAFE_INTEGER,
        bootstrapScriptContent:
          assets.getBootstrapContents({
            hydrate: options.hydrate ?? true,
            loadedData,
          }) || undefined,
        signal: options.request?.signal,
      },
    );
    // Preserve Expo's legacy Head API alongside the metadata nodes above.
    const routeHead = headContext.helmet;
    // Helmet initializes an empty title even if no route set one. It must not
    // override the document's own title in apps using only generateMetadata.
    const hasTitle = routeHead?.title?.toComponent().some((node) => node.props.children !== '');
    const helmet = serializeHelmetToHtml(
      routeHead ? { ...routeHead, title: hasTitle ? routeHead.title : undefined } : undefined,
    );
    return html
      .replace('<head>', () => `<head>${helmet.headTags}`)
      .replace('<html ', () => `<html ${helmet.htmlAttributes} `)
      .replace('<body', () => `<body${helmet.bodyAttributes ? ` ${helmet.bodyAttributes}` : ''}`);
  });
}

module.exports = { getStreamingContent, resolveMetadata: original.resolveMetadata };

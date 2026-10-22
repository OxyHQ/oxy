const { createElement } = require('react');
const { prerender } = require('react-dom/static');
const { extractDocumentResources } = require('./document-resources');

async function renderToHtml(element, options = {}) {
  const errors = [];
  const { prelude, postponed } = await prerender(element, {
    // Even completed boundaries can otherwise be outlined into hidden segments
    // once they exceed React's default progressive chunk size.
    progressiveChunkSize: Number.MAX_SAFE_INTEGER,
    ...options,
    onError(error) {
      errors.push(error);
    },
  });
  if (errors.length) throw errors[0];
  if (postponed) throw new Error('The static app render did not complete.');
  return new Response(prelude).text();
}

/**
 * The browser hydrates #root, not +html. Give the app its own React render root
 * on the server as well: document siblings must not enter its useId tree path.
 * Only markup produced by React is passed to createDocument, never user HTML.
 */
async function renderHydratableDocument(app, createDocument, options = {}) {
  // A single-child host container adds no useId fork; it separates resources
  // hoisted by React from ordinary app nodes, including root-level links.
  const rendered = await renderToHtml(createElement('div', { id: 'root' }, app), {
    signal: options.signal,
  });
  const { appHtml, resources } = extractDocumentResources(rendered);
  // Static prerender with the unlimited progressive chunk size waits for
  // Suspense without hidden segments. Its styles and fonts now exist too.
  const documentHtml = await renderToHtml(createDocument(appHtml), options);
  return documentHtml.replace('</head>', () => `${resources}</head>`);
}

module.exports = { renderHydratableDocument };

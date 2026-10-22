const { createElement } = require('react');
const { renderToReadableStream } = require('react-dom/server');
const { extractDocumentResources } = require('./document-resources');

async function renderToHtml(element, options = {}) {
  const errors = [];
  const stream = await renderToReadableStream(element, {
    ...options,
    onError(error) {
      errors.push(error);
    },
  });
  await stream.allReady;
  if (errors.length) throw errors[0];
  return new Response(stream).text();
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
  // Styles and fonts registered by suspended app content now exist too.
  const documentHtml = await renderToHtml(createDocument(appHtml), options);
  return documentHtml.replace('</head>', () => `${resources}</head>`);
}

module.exports = { renderHydratableDocument };

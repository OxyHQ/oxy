const { parseFragment } = require('parse5');

/**
 * React hoists resources outside the root container. Read those exact segments
 * instead of guessing from tag names: a link with a handler belongs to the app,
 * while an otherwise identical link without a handler may belong to the head.
 */
function extractDocumentResources(html) {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const root = fragment.childNodes.find(
    (node) =>
      node.tagName === 'div' &&
      node.attrs.some(({ name, value }) => name === 'id' && value === 'root'),
  );
  for (const node of fragment.childNodes) {
    if (node === root || node.nodeName === '#comment') continue;
    if (node.nodeName === '#text' && !node.value.trim()) continue;
    const attrs = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
    const resource =
      ['title', 'meta', 'base', 'link', 'style'].includes(node.tagName) ||
      (node.tagName === 'script' && attrs.has('async') && attrs.has('src'));
    if (!resource) {
      throw new Error(
        'Static rendering emitted content outside #root instead of a completed document resource.',
      );
    }
  }
  const location = root?.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) {
    throw new Error('The static app renderer did not produce its #root container.');
  }
  return {
    appHtml: html.slice(location.startTag.endOffset, location.endTag.startOffset),
    resources: html.slice(0, location.startOffset) + html.slice(location.endOffset),
  };
}

module.exports = { extractDocumentResources };

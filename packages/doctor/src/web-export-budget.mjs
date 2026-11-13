import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Size budgets for an Expo web export (`expo export --platform web`).
 *
 * Every `.js` file counts, on-demand chunks included, with one exception: Bloom's agent-avatar
 * catalogue, which is hundreds of lazy chunks fetched only when an avatar is drawn and never by the
 * first page. It has its own line (`avatarCatalog*`) so the app's own lines measure the code it
 * loads, and a catalogue chunk the first page loads fails the check.
 */

/**
 * A catalogue payload: one module, `exports = { encoding: "json", data: "..." }`, Bloom's packed
 * asset format (`@oxy.so/bloom/agent-avatar`, `vector-assets/`).
 */
const AVATAR_PAYLOAD = /^__d\(function\([\w$,]+\)\{[\w$]+\.exports=\{encoding:"json",data:"/;
/**
 * A catalogue wrapper (`@oxy.so/bloom/agent-avatar/catalog/<kind>-<id>`): one module whose
 * default export is `packedVectorAsset(() => import(asset), { [hash]: () => import(payload) })`.
 * Only a chunk holding that one module counts: a chunk that bundles it with anything else stays on
 * the app's lines, where its growth shows.
 */
const AVATAR_WRAPPER = /\.packedVectorAsset\)\(\(\)=>/;

/** Whether a web-export chunk's source is part of Bloom's agent-avatar catalogue. */
export function isAvatarCatalogueChunk(source) {
  if (AVATAR_PAYLOAD.test(source.slice(0, 200))) return true;
  const modules = source.match(/__d\(function\(/g)?.length ?? 0;
  return modules === 1 && source.startsWith('__d(function(') && AVATAR_WRAPPER.test(source);
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Measures `dist`: the metrics the budget lines name, and catalogue chunks the first page loads. */
export function measureWebExport(dist) {
  const firstPage = new Set(
    [...readFileSync(resolve(dist, 'index.html'), 'utf8').matchAll(/src="\/([^"]+\.js)"/g)].map(
      (match) => match[1],
    ),
  );
  const metrics = {
    totalBytes: 0,
    javaScriptGzipBytes: 0,
    fontBytes: 0,
    avatarCatalogBytes: 0,
    avatarCatalogGzipBytes: 0,
  };
  const avatarChunksOnFirstPage = [];
  for (const file of files(dist)) {
    const size = statSync(file).size;
    if (file.endsWith('.js')) {
      const source = readFileSync(file);
      const gzipBytes = gzipSync(source).length;
      if (isAvatarCatalogueChunk(source.toString('utf8'))) {
        metrics.avatarCatalogBytes += size;
        metrics.avatarCatalogGzipBytes += gzipBytes;
        if (firstPage.has(relative(dist, file))) avatarChunksOnFirstPage.push(relative(dist, file));
        continue;
      }
      metrics.javaScriptGzipBytes += gzipBytes;
    }
    metrics.totalBytes += size;
    if (/\.(?:otf|ttf|woff2?)$/.test(file)) metrics.fontBytes += size;
  }
  return { metrics, avatarChunksOnFirstPage };
}

/** Each metric and the budget key that limits it. */
export const WEB_EXPORT_BUDGETS = [
  ['totalBytes', 'maxTotalBytes'],
  ['javaScriptGzipBytes', 'maxJavaScriptGzipBytes'],
  ['fontBytes', 'maxFontBytes'],
  ['avatarCatalogBytes', 'maxAvatarCatalogBytes'],
  ['avatarCatalogGzipBytes', 'maxAvatarCatalogGzipBytes'],
];

/** The metrics over their limit. A limit the budget does not set is a failure, not a pass. */
export function overBudget(metrics, budget) {
  return WEB_EXPORT_BUDGETS.filter(
    ([metric, limit]) => typeof budget[limit] !== 'number' || metrics[metric] > budget[limit],
  );
}

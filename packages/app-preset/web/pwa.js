/**
 * Makes an Expo web export installable: the work behind `oxy-web-pwa`.
 *
 * Why it exists: with `web.output: 'single'` Expo ignores `app/+html.tsx` and
 * serves its default SPA template, so a `<link rel="manifest">` written there
 * never reaches the browser and the app cannot be installed (alia.onl served a
 * valid manifest and worker that no page linked). This step works on the
 * exported HTML itself, so it is the same for `single` and `static` output.
 *
 * It validates the manifest against what browsers require to install, adds the
 * missing head tags to every exported page (never touching one that is already
 * there), and ships the Oxy base service worker.
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const { parse } = require('parse5');

const MANIFEST_NAMES = ['manifest.json', 'manifest.webmanifest', 'site.webmanifest'];
const INSTALLABLE_DISPLAYS = new Set([
  'standalone',
  'fullscreen',
  'minimal-ui',
  'window-controls-overlay',
]);
const REQUIRED_ICON_SIZES = ['192x192', '512x512'];
const SKIPPED_DIRS = new Set(['_expo', 'assets', 'node_modules']);
const SW_BASE = 'oxy-sw-base.js';
const SW_REGISTER = 'oxy-sw-register.js';
const SW_REMOVE = 'oxy-sw-remove.js';
const WEB_DIR = __dirname;

class PwaError extends Error {}

function findManifest(dist) {
  return MANIFEST_NAMES.find((name) => existsSync(join(dist, name))) ?? null;
}

/** Problems that stop a browser from offering to install the app; warnings do not. */
function validateManifest(manifest, dist) {
  const errors = [];
  const warnings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['the manifest is not a JSON object'], warnings };
  }
  if (!manifest.name && !manifest.short_name) errors.push('it has neither "name" nor "short_name"');
  if (!manifest.start_url) errors.push('it has no "start_url"');
  if (!INSTALLABLE_DISPLAYS.has(manifest.display))
    errors.push(
      `"display" is ${JSON.stringify(manifest.display)}; it must be one of ${[...INSTALLABLE_DISPLAYS].join(', ')}`,
    );
  if (manifest.prefer_related_applications === true)
    errors.push(
      '"prefer_related_applications" is true, which tells browsers not to offer the web app',
    );

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const sizes = new Set(icons.flatMap((icon) => String(icon.sizes ?? '').split(/\s+/)));
  for (const size of REQUIRED_ICON_SIZES)
    if (!sizes.has(size)) errors.push(`it has no ${size} icon`);
  for (const icon of icons) {
    if (typeof icon.src !== 'string' || !icon.src) {
      errors.push('an icon has no "src"');
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(icon.src) || icon.src.startsWith('//')) continue;
    const file = join(dist, decodeURIComponent(icon.src.split(/[?#]/)[0]).replace(/^\/+/, ''));
    if (!existsSync(file)) errors.push(`icon ${icon.src} is not in the export`);
  }
  if (
    !icons.some((icon) =>
      String(icon.purpose ?? '')
        .split(/\s+/)
        .includes('maskable'),
    )
  )
    warnings.push('it has no "maskable" icon, so Android shows the icon on a white disc');
  if (!manifest.theme_color) warnings.push('it has no "theme_color"');
  if (!manifest.background_color)
    warnings.push('it has no "background_color" for the splash screen');
  return { errors, warnings };
}

function htmlFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === root && SKIPPED_DIRS.has(entry.name)) continue;
      files.push(...htmlFiles(path, root));
    } else if (entry.isFile() && entry.name.endsWith('.html')) files.push(path);
  }
  return files.sort();
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function attrs(node) {
  return Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
}

const escapeAttribute = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The tags `html` is missing, rendered as one string. */
function missingTags(document, wanted) {
  const rels = new Set();
  const metas = new Set();
  const scripts = new Set();
  walk(document, (node) => {
    const a = attrs(node);
    if (node.tagName === 'link' && a.rel)
      for (const rel of a.rel.toLowerCase().split(/\s+/)) rels.add(rel);
    if (node.tagName === 'meta' && a.name) metas.add(a.name.toLowerCase());
    if (node.tagName === 'script' && a.src) scripts.add(a.src.split(/[?#]/)[0]);
  });
  const out = [];
  for (const tag of wanted) {
    if (tag.kind === 'link' && rels.has(tag.rel)) continue;
    if (tag.kind === 'meta' && metas.has(tag.name)) continue;
    if (tag.kind === 'script' && scripts.has(tag.src)) continue;
    if (tag.kind === 'link')
      out.push(`<link rel="${tag.rel}" href="${escapeAttribute(tag.href)}" />`);
    if (tag.kind === 'meta') {
      const media = tag.media ? ` media="${escapeAttribute(tag.media)}"` : '';
      out.push(`<meta name="${tag.name}" content="${escapeAttribute(tag.content)}"${media} />`);
    }
    if (tag.kind === 'script')
      out.push(`<script src="${escapeAttribute(tag.src)}" defer></script>`);
  }
  return out;
}

/** Adds the missing tags before `</head>`; returns the new HTML, or null when nothing was missing. */
function injectHead(html, wanted) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const tags = missingTags(document, wanted);
  if (tags.length === 0) return null;
  let head = null;
  walk(document, (node) => {
    if (!head && node.tagName === 'head') head = node;
  });
  const end = head?.sourceCodeLocation?.endTag?.startOffset;
  if (end === undefined) throw new PwaError('the page has no </head>');
  const block = `<!-- oxy-web-pwa -->${tags.join('')}`;
  return `${html.slice(0, end)}${block}${html.slice(end)}`;
}

/**
 * The startup `theme-color` tags: `--theme-color=<light>,<dark>` gives a pair
 * scoped by `prefers-color-scheme` (what Bloom adopts and then owns at
 * runtime); one colour, or none (the manifest's `theme_color`), gives one tag.
 */
function themeColorTags(manifest, themeColors) {
  const colors = themeColors?.length ? themeColors : [manifest.theme_color].filter(Boolean);
  if (colors.length === 2)
    return [
      {
        kind: 'meta',
        name: 'theme-color',
        content: colors[0],
        media: '(prefers-color-scheme: light)',
      },
      {
        kind: 'meta',
        name: 'theme-color',
        content: colors[1],
        media: '(prefers-color-scheme: dark)',
      },
    ];
  return colors.map((content) => ({ kind: 'meta', name: 'theme-color', content }));
}

function wantedTags(manifestName, manifest, dist, { serviceWorker, themeColors }) {
  const wanted = [{ kind: 'link', rel: 'manifest', href: `/${manifestName}` }];
  if (existsSync(join(dist, 'apple-touch-icon.png')))
    wanted.push({ kind: 'link', rel: 'apple-touch-icon', href: '/apple-touch-icon.png' });
  wanted.push(...themeColorTags(manifest, themeColors));
  wanted.push({ kind: 'meta', name: 'mobile-web-app-capable', content: 'yes' });
  wanted.push({ kind: 'meta', name: 'apple-mobile-web-app-capable', content: 'yes' });
  const title = manifest.short_name || manifest.name;
  if (title) wanted.push({ kind: 'meta', name: 'apple-mobile-web-app-title', content: title });
  if (serviceWorker) wanted.push({ kind: 'script', src: `/${SW_REGISTER}` });
  return wanted;
}

/** A hash of the export's pages, which name every content-hashed bundle: it changes on each deploy. */
function exportVersion(pages) {
  const hash = createHash('sha256');
  for (const page of pages) hash.update(readFileSync(page));
  return hash.digest('hex').slice(0, 16);
}

const OWN_WORKER = `// Written by oxy-web-pwa (@oxy.so/app-preset): this app has no public/sw.js,
// so its worker is the Oxy base worker alone. Add public/sw.js to extend it.
importScripts('/${SW_BASE}');
`;

/**
 * Runs the whole step on `dist`. Throws PwaError on anything that leaves the
 * app uninstallable; returns what it did and any warnings.
 */
function makeInstallable(
  dist,
  { serviceWorker = true, removeServiceWorker = false, themeColors } = {},
) {
  if (removeServiceWorker && !serviceWorker)
    throw new PwaError(
      '--remove-sw and --no-sw cannot be combined; --remove-sw ships no worker either',
    );
  if (removeServiceWorker) serviceWorker = false;
  if (themeColors !== undefined) {
    const valid = /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([^"<>]*\))$/i;
    if (
      themeColors.length < 1 ||
      themeColors.length > 2 ||
      !themeColors.every((c) => valid.test(c))
    )
      throw new PwaError(
        `--theme-color takes one colour or <light>,<dark>; got ${JSON.stringify(themeColors.join(','))}`,
      );
  }
  if (!existsSync(dist) || !statSync(dist).isDirectory())
    throw new PwaError(`${dist} is not a directory; run expo export first`);
  const manifestName = findManifest(dist);
  if (!manifestName)
    throw new PwaError(
      `${dist} has no web app manifest (${MANIFEST_NAMES.join(', ')}); add public/manifest.json`,
    );
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dist, manifestName), 'utf8'));
  } catch (error) {
    throw new PwaError(`${manifestName} is not valid JSON: ${error.message}`);
  }
  const { errors, warnings } = validateManifest(manifest, dist);
  if (errors.length > 0)
    throw new PwaError(`${manifestName} cannot make the app installable: ${errors.join('; ')}`);

  const pages = htmlFiles(dist);
  if (pages.length === 0) throw new PwaError(`${dist} has no HTML page`);
  const wanted = wantedTags(manifestName, manifest, dist, { serviceWorker, themeColors });
  const updated = [];
  for (const page of pages) {
    let next;
    try {
      next = injectHead(readFileSync(page, 'utf8'), wanted);
    } catch (error) {
      throw new PwaError(`${relative(dist, page)}: ${error.message}`);
    }
    if (next !== null) {
      writeFileSync(page, next);
      updated.push(relative(dist, page));
    }
  }

  let worker = null;
  if (removeServiceWorker) {
    if (existsSync(join(dist, 'sw.js')))
      throw new PwaError(
        '--remove-sw replaces /sw.js, but the app ships its own public/sw.js; drop its importScripts line instead',
      );
    writeFileSync(join(dist, 'sw.js'), readFileSync(join(WEB_DIR, SW_REMOVE)));
    worker = 'removal (retires the worker and its caches)';
  } else if (serviceWorker) {
    const version = exportVersion(pages);
    const base = readFileSync(join(WEB_DIR, SW_BASE), 'utf8').replace(
      /__OXY_SW_VERSION__/g,
      version,
    );
    writeFileSync(join(dist, SW_BASE), base);
    writeFileSync(join(dist, SW_REGISTER), readFileSync(join(WEB_DIR, SW_REGISTER)));
    if (existsSync(join(dist, 'sw.js'))) {
      const own = readFileSync(join(dist, 'sw.js'), 'utf8');
      worker = own.includes(SW_BASE) ? 'app (imports the base)' : 'app (does not import the base)';
      if (!own.includes(SW_BASE))
        warnings.push(
          `sw.js does not import /${SW_BASE}, so it has no offline shell; add importScripts('/${SW_BASE}') unless it caches on its own`,
        );
    } else {
      writeFileSync(join(dist, 'sw.js'), OWN_WORKER);
      worker = 'base';
    }
  }
  return { manifest: manifestName, pages: pages.length, updated, worker, warnings };
}

module.exports = {
  PwaError,
  makeInstallable,
  validateManifest,
  injectHead,
  wantedTags,
  SW_BASE,
  SW_REGISTER,
  SW_REMOVE,
};

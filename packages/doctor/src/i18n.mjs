import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

/**
 * Translation catalogs across the Oxy ecosystem follow ONE key convention
 * (oxy `docs/adr/0055-translation-keys.md`):
 *
 *  - A key is a PATH of short identifier segments (`compose.toolbar.addImage`),
 *    stored as NESTED JSON objects, never as a flat dotted string and never as
 *    the English sentence itself.
 *  - In a single-file catalog (`locales/en.json`) every top-level entry is a
 *    namespace object; a per-namespace catalog (`locales/en/compose.json`) is
 *    that namespace's file.
 *  - A translation holds only keys the source locale has, with the same shape.
 *
 * Missing translations are warnings: i18next renders the source text, and a
 * translation pass is ordinary product work, not a broken build.
 */

export const DEFAULT_SOURCE_LOCALE = 'en';

/** One key segment: an identifier, or a data value such as `picked_up` or `us-east-1`. */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LOCALE_NAME = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const PLACEHOLDER = /\{\{\s*([^}\s,]+)[^}]*\}\}/g;

/** Never walked, with every dot-directory (`.git`, `.worktrees`, `.claude`, …). */
const IGNORED_DIRECTORIES = new Set(['build', 'coverage', 'dist', 'node_modules']);

/**
 * Every `locales` directory under `root` that holds a catalog for
 * `sourceLocale`: either `locales/<source>.json` (single file) or
 * `locales/<source>/*.json` (one file per namespace).
 */
export async function findCatalogDirectories(root, sourceLocale = DEFAULT_SOURCE_LOCALE) {
  const found = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (basename(directory) === 'locales') {
      const hasSource = entries.some(
        (entry) =>
          (entry.isFile() && entry.name === `${sourceLocale}.json`) ||
          (entry.isDirectory() && entry.name === sourceLocale),
      );
      if (hasSource) {
        found.push(directory);
        return;
      }
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !IGNORED_DIRECTORIES.has(entry.name)
      ) {
        await walk(join(directory, entry.name));
      }
    }
  }
  await walk(root);
  return found.sort();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load a catalog directory as `{ layout, locales: Map<locale, tree> }`, where a
 * per-namespace catalog's tree is `{ <namespace>: <file contents> }` so both
 * layouts are checked as one nested tree.
 */
export async function loadCatalogs(directory, sourceLocale = DEFAULT_SOURCE_LOCALE) {
  const entries = await readdir(directory, { withFileTypes: true });
  const perNamespace = entries.some((entry) => entry.isDirectory() && entry.name === sourceLocale);
  const locales = new Map();
  for (const entry of entries) {
    if (perNamespace && entry.isDirectory() && LOCALE_NAME.test(entry.name)) {
      const tree = {};
      const files = await readdir(join(directory, entry.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.json')) {
          tree[file.name.slice(0, -'.json'.length)] = await readJson(
            join(directory, entry.name, file.name),
          );
        }
      }
      locales.set(entry.name, tree);
    } else if (!perNamespace && entry.isFile() && entry.name.endsWith('.json')) {
      const locale = entry.name.slice(0, -'.json'.length);
      if (LOCALE_NAME.test(locale)) {
        locales.set(locale, await readJson(join(directory, entry.name)));
      }
    }
  }
  return { layout: perNamespace ? 'per-namespace' : 'single-file', locales };
}

const isTree = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string, or a list of strings (read with i18next's `returnObjects`). */
const isLeaf = (value) =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every((item) => typeof item === 'string'));

const SINGULAR_PLURAL = /_(?:zero|one|two)$/;

/**
 * The placeholders a string interpolates. A singular plural form may spell its
 * number out ("un elemento"), so `count` is not required there.
 */
function placeholders(text, key) {
  const names = [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
  return [...new Set(SINGULAR_PLURAL.test(key) ? names.filter((name) => name !== 'count') : names)]
    .sort()
    .join(',');
}

/**
 * Check one loaded catalog directory. Returns `{ errors, warnings }`, each a
 * list of `{ rule, locale, key, message }`.
 */
export function checkCatalogs({ locales }, sourceLocale = DEFAULT_SOURCE_LOCALE) {
  const errors = [];
  const warnings = [];
  const source = locales.get(sourceLocale);
  if (!isTree(source)) {
    errors.push({
      rule: 'missing-source',
      locale: sourceLocale,
      key: '',
      message: `no ${sourceLocale} catalog`,
    });
    return { errors, warnings };
  }

  // Key shape, on every locale: a translation can introduce a bad key too.
  for (const [locale, tree] of locales) {
    for (const [key, value] of Object.entries(isTree(tree) ? tree : {})) {
      if (!isTree(value) && !key.includes('.')) {
        errors.push({
          rule: 'top-level-string',
          locale,
          key,
          message: 'a top-level entry must be a namespace object',
        });
      }
    }
    (function walk(node, path) {
      for (const [segment, value] of Object.entries(node)) {
        const key = path ? `${path}.${segment}` : segment;
        if (segment.includes('.')) {
          errors.push({
            rule: 'flat-key',
            locale,
            key,
            message: 'a dotted key must be nested objects, not one flat string',
          });
        } else if (!KEY_SEGMENT.test(segment)) {
          errors.push({
            rule: 'text-key',
            locale,
            key,
            message: 'a key segment is an identifier, never the text itself',
          });
        }
        if (isTree(value)) walk(value, key);
        else if (!isLeaf(value)) {
          errors.push({
            rule: 'non-string',
            locale,
            key,
            message: 'a leaf must be a string or a list of strings',
          });
        }
      }
    })(isTree(tree) ? tree : {}, '');
  }

  // Translations against the source.
  for (const [locale, tree] of locales) {
    if (locale === sourceLocale) continue;
    (function compare(sourceNode, node, path) {
      for (const [segment, value] of Object.entries(node)) {
        const key = path ? `${path}.${segment}` : segment;
        if (!(segment in sourceNode)) {
          errors.push({
            rule: 'stray-key',
            locale,
            key,
            message: `not in ${sourceLocale}; delete it or add it to ${sourceLocale}`,
          });
        } else if (isTree(value) !== isTree(sourceNode[segment])) {
          errors.push({
            rule: 'shape-mismatch',
            locale,
            key,
            message: `a ${isTree(value) ? 'namespace' : 'string'} here, the other in ${sourceLocale}`,
          });
        } else if (isTree(value)) {
          compare(sourceNode[segment], value, key);
        } else if (typeof value === 'string' && typeof sourceNode[segment] === 'string') {
          const expected = placeholders(sourceNode[segment], key);
          if (placeholders(value, key) !== expected) {
            warnings.push({
              rule: 'placeholder-mismatch',
              locale,
              key,
              message: `placeholders differ from ${sourceLocale} ({{${expected}}})`,
            });
          }
        }
      }
      for (const segment of Object.keys(sourceNode)) {
        if (!(segment in node)) {
          const key = path ? `${path}.${segment}` : segment;
          warnings.push({
            rule: 'missing-translation',
            locale,
            key,
            message: `renders the ${sourceLocale} text`,
          });
        }
      }
    })(source, isTree(tree) ? tree : {}, '');
  }

  return { errors, warnings };
}

/** Find and check every catalog under `root`. */
export async function inspectTranslations(root, sourceLocale = DEFAULT_SOURCE_LOCALE) {
  const catalogs = [];
  for (const directory of await findCatalogDirectories(root, sourceLocale)) {
    const loaded = await loadCatalogs(directory, sourceLocale);
    catalogs.push({
      directory: relative(root, directory) || '.',
      layout: loaded.layout,
      locales: [...loaded.locales.keys()].sort(),
      ...checkCatalogs(loaded, sourceLocale),
    });
  }
  return catalogs;
}

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Tiny hand-rolled template engine for scaffolding.
 *
 * Three conventions:
 *  - `{{token}}`            → substituted from `ctx.tokens` (unknown token → throw).
 *  - `{{#flag}}…{{/flag}}`  → kept when `ctx.flags.flag` is truthy, else removed.
 *    `{{^flag}}…{{/flag}}`  → the inverse (kept when the flag is falsy).
 *  - filename `.tpl` suffix → stripped from the output name (marks a file that is
 *    a template so the scaffolder's own repo does not treat template `package.json`
 *    files as workspace members).
 *  - filename/dir `DOT_` prefix → rewritten to `.` (npm mangles real dotfiles like
 *    `.gitignore` inside published tarballs, so templates ship them as `DOT_…`).
 */
export interface RenderContext {
  tokens: Record<string, string>;
  flags: Record<string, boolean>;
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.bmp',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.pdf',
  '.zip',
]);

const SECTION_RE = /\{\{([#^])([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/;
// A template token is `{{name}}` NOT preceded by `$` — the negative lookbehind
// leaves GitHub Actions `${{ … }}` expressions untouched in workflow templates.
const TOKEN_RE = /(?<!\$)\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function applySections(content: string, flags: Record<string, boolean>): string {
  let out = content;
  let match = SECTION_RE.exec(out);
  while (match !== null) {
    const [full, kind, key, inner] = match;
    const on = Boolean(flags[key]);
    const include = kind === '#' ? on : !on;
    out = out.slice(0, match.index) + (include ? inner : '') + out.slice(match.index + full.length);
    match = SECTION_RE.exec(out);
  }
  return out;
}

function applyTokens(content: string, tokens: Record<string, string>, sourceLabel: string): string {
  return content.replace(TOKEN_RE, (_full, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) {
      throw new Error(`Unknown template token "{{${key}}}" in ${sourceLabel}`);
    }
    return tokens[key];
  });
}

/** Renders a single template string: sections first, then token substitution. */
export function renderString(
  content: string,
  ctx: RenderContext,
  sourceLabel = '<string>',
): string {
  return applyTokens(applySections(content, ctx.flags), ctx.tokens, sourceLabel);
}

/** Maps a source path segment to its output name (`DOT_` → `.`, strip `.tpl`). */
export function targetSegment(segment: string, isFile: boolean): string {
  let name = segment;
  if (name.startsWith('DOT_')) {
    name = `.${name.slice('DOT_'.length)}`;
  }
  if (isFile && name.endsWith('.tpl')) {
    name = name.slice(0, -'.tpl'.length);
  }
  return name;
}

function isBinary(fileName: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/**
 * Renders one template directory tree into `destDir`, applying the conventions
 * above. Returns the list of written output file paths (absolute).
 */
export async function renderTree(
  srcDir: string,
  destDir: string,
  ctx: RenderContext,
): Promise<string[]> {
  const written: string[] = [];
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);

    if (entry.isDirectory()) {
      const outName = targetSegment(entry.name, false);
      const destSub = path.join(destDir, outName);
      await fs.mkdir(destSub, { recursive: true });
      written.push(...(await renderTree(srcPath, destSub, ctx)));
      continue;
    }

    const outName = targetSegment(entry.name, true);
    const destPath = path.join(destDir, outName);
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    if (isBinary(entry.name)) {
      await fs.copyFile(srcPath, destPath);
    } else {
      const raw = await fs.readFile(srcPath, 'utf8');
      const rendered = renderString(raw, ctx, path.relative(srcDir, srcPath) || entry.name);
      await fs.writeFile(destPath, rendered, 'utf8');
    }
    written.push(destPath);
  }

  return written;
}

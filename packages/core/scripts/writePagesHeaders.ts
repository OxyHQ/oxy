#!/usr/bin/env bun
/**
 * Write a Cloudflare Pages `_headers` file for an Oxy HTML app.
 *
 * Runs AFTER the app's build, against the directory that is about to be
 * deployed, because the CSP it writes is DERIVED from the HTML in that
 * directory: any inline `<script>` the build emits is allowed by hash. Running
 * it before the build (against `public/`) cannot see that HTML, so the app
 * ships a policy that forbids its own generated script — which is exactly how
 * `accounts.oxy.so` lost hydration: Expo's `web.output: 'static'` emits
 * `globalThis.__EXPO_ROUTER_HYDRATE__=true;` inline, CSP blocked it, and the
 * client threw away the server-rendered markup on every visit with nothing but
 * a console error to show for it.
 *
 * Per-app CSP extensions still come from `oxy.pages-headers.json` in the caller
 * package (cwd). Hashes are never written there by hand — see
 * {@link buildOxyPagesHeaders}.
 *
 * Usage (from an app package, after the build):
 *   bun ../core/scripts/writePagesHeaders.ts dist
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildOxyPagesHeaders,
  type OxyCspExtensions,
  type OxyPagesHeadersOptions,
} from '../src/server/securityHeaders.ts';

interface PagesHeadersConfig {
  csp?: OxyCspExtensions;
  hsts?: boolean;
}

function loadConfig(): OxyPagesHeadersOptions {
  const configPath = resolve(process.cwd(), 'oxy.pages-headers.json');
  if (!existsSync(configPath)) return {};
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as PagesHeadersConfig;
  return { csp: raw.csp, hsts: raw.hsts };
}

/**
 * Every `.html` file under the deploy directory, at any depth: a static Expo
 * export writes one per route, and a route that is not scanned is a route whose
 * inline script is not allowed.
 */
function findHtmlFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...findHtmlFiles(path));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      found.push(path);
    }
  }
  return found;
}

const outputDir = resolve(process.cwd(), process.argv[2] ?? 'dist');

// Vacuity floor. Both of these look identical to a clean run otherwise: pointed
// at a directory the build does not write, this would happily create it, write
// a `_headers` nobody serves, and exit 0 — leaving the deployed origin with NO
// security headers at all. "Scanned nothing, found nothing to allow" must be a
// failure, not a pass.
if (!existsSync(outputDir)) {
  process.stderr.write(
    `writePagesHeaders: ${outputDir} does not exist. Run this AFTER the build, ` +
      'pointed at the directory being deployed.\n',
  );
  process.exit(1);
}

const htmlFiles = findHtmlFiles(outputDir);
if (htmlFiles.length === 0) {
  process.stderr.write(
    `writePagesHeaders: no .html found under ${outputDir}. Either the build produced ` +
      'no HTML or this is not the deploy directory; refusing to write a policy derived ' +
      'from nothing.\n',
  );
  process.exit(1);
}

const outputPath = join(outputDir, '_headers');
writeFileSync(
  outputPath,
  buildOxyPagesHeaders({
    ...loadConfig(),
    html: htmlFiles.map((file) => readFileSync(file, 'utf8')),
  }),
  'utf8',
);
process.stdout.write(`Wrote ${outputPath} (scanned ${htmlFiles.length} HTML file(s))\n`);

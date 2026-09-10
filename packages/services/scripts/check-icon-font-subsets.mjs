#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = join(PACKAGE_ROOT, 'src', 'ui');
const GENERATED_ROOT = join(SOURCE_ROOT, 'icons');
const manifestPath = join(PACKAGE_ROOT, 'src', 'assets', 'fonts', 'icons', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sourcePackageVersion = require('@expo/vector-icons/package.json').version;
const sourceNames = new Set();
const violations = [];

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (resolve(path) !== resolve(GENERATED_ROOT)) scan(path);
    } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) {
      const source = readFileSync(path, 'utf8');
      if (/from\s+['"]@expo\/vector-icons\/(?:Ionicons|MaterialCommunityIcons)['"]/.test(source)) violations.push(path);
      for (const match of source.matchAll(/(['"`])([A-Za-z0-9][A-Za-z0-9-]*)\1/g)) sourceNames.add(match[2]);
    }
  }
}
scan(SOURCE_ROOT);
if (violations.length > 0) throw new Error(`Full icon-font imports remain:\n${violations.join('\n')}`);
if (manifest.sourcePackageVersion !== sourcePackageVersion) {
  throw new Error(`Icon subsets were generated from @expo/vector-icons ${manifest.sourcePackageVersion}, installed ${sourcePackageVersion}.`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

for (const [key, family] of Object.entries(manifest.families)) {
  const sourceName = key === 'ionicons' ? 'Ionicons' : 'MaterialCommunityIcons';
  const fullMap = require(`@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/${sourceName}.json`);
  const expectedNames = Object.keys(fullMap).filter((name) => sourceNames.has(name)).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(family.names)) {
    throw new Error(`${family.fontFamily} source names changed; run bun run generate:icon-fonts.`);
  }
  const fontPath = join(PACKAGE_ROOT, family.file);
  if (statSync(fontPath).size !== family.bytes || sha256(fontPath) !== family.sha256) {
    throw new Error(`${family.file} does not match its manifest; run bun run generate:icon-fonts.`);
  }
}
const mapsPath = join(PACKAGE_ROOT, manifest.glyphMapsFile);
if (sha256(mapsPath) !== manifest.glyphMapsSha256) throw new Error('subsetGlyphMaps.ts does not match its manifest.');
console.log('Services icon subsets match source usage, package version and recorded hashes.');

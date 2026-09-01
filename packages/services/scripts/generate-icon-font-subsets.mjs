#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = join(PACKAGE_ROOT, 'src', 'ui');
const GENERATED_ROOT = join(SOURCE_ROOT, 'icons');
const FONT_ROOT = join(PACKAGE_ROOT, 'src', 'assets', 'fonts', 'icons');
const SOURCE_EXTENSIONS = /\.(?:js|jsx|ts|tsx)$/;

const families = [
  {
    key: 'ionicons',
    sourceName: 'Ionicons',
    fontFamily: 'OxyServicesIonicons',
    maxBytes: 150_000,
  },
  {
    key: 'materialCommunityIcons',
    sourceName: 'MaterialCommunityIcons',
    fontFamily: 'OxyServicesMaterialCommunityIcons',
    maxBytes: 250_000,
  },
];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return resolve(path) === resolve(GENERATED_ROOT) ? [] : sourceFiles(path);
    return SOURCE_EXTENSIONS.test(entry.name) ? [path] : [];
  });
}

function quotedStrings() {
  const values = new Set();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(['"`])([A-Za-z0-9][A-Za-z0-9-]*)\1/g)) values.add(match[2]);
  }
  return values;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${result.stdout}${result.stderr}`);
  }
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function renameFont(path, family) {
  const python = String.raw`
from fontTools.ttLib import TTFont
import sys
font_path, family = sys.argv[1], sys.argv[2]
font = TTFont(font_path)
values = {
    1: family,
    2: 'Regular',
    3: family + ';Regular',
    4: family,
    6: family,
    16: family,
    17: 'Regular',
}
for record in font['name'].names:
    value = values.get(record.nameID)
    if value is not None:
        record.string = value.encode(record.getEncoding(), errors='replace')
font.save(font_path, reorderTables=True)
`;
  run('python3', ['-c', python, path, family]);
}

mkdirSync(GENERATED_ROOT, { recursive: true });
mkdirSync(FONT_ROOT, { recursive: true });
const strings = quotedStrings();
const manifest = {
  sourcePackage: '@expo/vector-icons',
  sourcePackageVersion: require('@expo/vector-icons/package.json').version,
  families: {},
};
const generatedMaps = [];

for (const family of families) {
  const glyphMap = require(`@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/${family.sourceName}.json`);
  const names = Object.keys(glyphMap).filter((name) => strings.has(name)).sort();
  const subsetMap = Object.fromEntries(names.map((name) => [name, glyphMap[name]]));
  const sourceFont = require.resolve(`@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/${family.sourceName}.ttf`);
  const outputFont = join(FONT_ROOT, `${family.fontFamily}.ttf`);
  const unicodes = [...new Set(Object.values(subsetMap))].sort((a, b) => a - b).map((value) => `U+${value.toString(16)}`).join(',');

  run('pyftsubset', [
    sourceFont,
    `--output-file=${outputFont}`,
    `--unicodes=${unicodes}`,
    '--glyph-names',
    '--symbol-cmap',
    '--legacy-cmap',
    '--notdef-glyph',
    '--notdef-outline',
    '--recommended-glyphs',
    '--name-IDs=*',
    '--name-legacy',
    '--name-languages=*',
  ]);
  renameFont(outputFont, family.fontFamily);

  const bytes = statSync(outputFont).size;
  if (!existsSync(outputFont) || bytes > family.maxBytes) {
    throw new Error(`${relative(PACKAGE_ROOT, outputFont)} is ${bytes} bytes; expected <= ${family.maxBytes}`);
  }
  manifest.families[family.key] = {
    fontFamily: family.fontFamily,
    file: relative(PACKAGE_ROOT, outputFont),
    bytes,
    sha256: hash(outputFont),
    names,
  };
  generatedMaps.push(`export const ${family.key}GlyphMap = ${JSON.stringify(subsetMap, null, 2)} as const;`);
}

const mapsPath = join(GENERATED_ROOT, 'subsetGlyphMaps.ts');
writeFileSync(mapsPath, `${generatedMaps.join('\n\n')}\n`);
manifest.glyphMapsFile = relative(PACKAGE_ROOT, mapsPath);
manifest.glyphMapsSha256 = hash(mapsPath);
writeFileSync(join(FONT_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated exact-shape icon subsets: ${Object.values(manifest.families).map((value) => `${value.fontFamily} ${value.bytes} B`).join(', ')}`);

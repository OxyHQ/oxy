import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LocaleNode } from '../types';
import en from '../locales/en';
import es from '../locales/es';

function flatten(node: LocaleNode, prefix = '', out = new Map<string, string>()) {
  if (typeof node === 'string') {
    out.set(prefix, node);
  } else if (Array.isArray(node)) {
    node.forEach((child, index) => flatten(child, `${prefix}.${index}`, out));
  } else {
    for (const [key, child] of Object.entries(node)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const english = flatten(en);
const spanish = flatten(es);
const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

function sources(dir: string, found: Array<string> = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'locales') continue;
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe('console locales', () => {
  it('es has exactly the keys of en', () => {
    expect([...english.keys()].filter((key) => !spanish.has(key))).toEqual([]);
    expect([...spanish.keys()].filter((key) => !english.has(key))).toEqual([]);
  });

  it('es keeps every interpolation variable of en', () => {
    const drift = [...english].filter(
      ([key, value]) =>
        spanish.has(key) && placeholders(value) !== placeholders(spanish.get(key) ?? ''),
    );
    expect(drift.map(([key]) => key)).toEqual([]);
  });

  it('every literal t() key used in the code exists', () => {
    const root = join(__dirname, '..', '..', '..');
    const missing = new Set<string>();
    for (const dir of ['app', 'components', 'hooks', 'lib']) {
      for (const file of sources(join(root, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z][\w]*(?:\.[\w]+)+)'/g)) {
          const key = match[1];
          if (!(english.has(key) || english.has(`${key}_one`) || english.has(`${key}_other`))) {
            missing.add(`${file}: ${key}`);
          }
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});

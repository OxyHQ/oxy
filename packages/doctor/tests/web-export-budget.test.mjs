import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAvatarCatalogueChunk } from '../src/web-export-budget.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/web-budget-cli.mjs');
const node = Bun.which('node');
if (!node) throw new Error('Node is required to test the published CLI');

// The shapes Metro emits for Bloom's catalogue (minified, as `expo export` writes them).
const PAYLOAD = '__d(function(e,o,a,c,l,r,f){l.exports={encoding:"json",data:"{}"}},1,[]);\n';
const WRAPPER =
  '__d(function(g,r,i,a,m,e,d){"use strict";Object.defineProperty(e,"default",{get:function(){return t}});' +
  'var t=(0,r(d[0]).packedVectorAsset)(()=>r(d[2])(d[1],d.paths),{ab12:()=>r(d[2])(d[3],d.paths)})},2,[3,4,5,6]);\n';
const budget = {
  maxTotalBytes: 256,
  maxJavaScriptGzipBytes: 128,
  maxFontBytes: 32,
  maxAvatarCatalogBytes: 1024,
  maxAvatarCatalogGzipBytes: 1024,
};

let work;
let dist;
let budgets;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'oxy-web-budget-'));
  dist = join(work, 'dist');
  budgets = join(work, 'budgets.json');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<script src="/entry.js"></script>\n');
  writeFileSync(join(dist, 'entry.js'), 'export const value = 1;\n');
  writeFileSync(join(dist, 'icons.ttf'), Buffer.alloc(16));
  writeFileSync(join(dist, 'avatar.js'), PAYLOAD);
  writeFileSync(join(dist, 'shape-circle.js'), WRAPPER);
  setBudget(budget);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function setBudget(frontendWeb) {
  writeFileSync(budgets, JSON.stringify({ frontendWeb }));
}
function run() {
  return spawnSync(node, [cli, `--dist=${dist}`, `--budgets=${budgets}`], { encoding: 'utf8' });
}

describe('oxy-doctor-web-budget', () => {
  test('measures the avatar catalogue, payloads and wrappers, on its own line', () => {
    const result = run();
    expect(result.status).toBe(0);
    const { metrics } = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1));
    expect(metrics.avatarCatalogBytes).toBe(PAYLOAD.length + WRAPPER.length);
    expect(metrics.totalBytes).toBe(
      'export const value = 1;\n'.length + 16 + '<script src="/entry.js"></script>\n'.length,
    );
  });

  test('fails an oversized font', () => {
    setBudget({ ...budget, maxFontBytes: 8 });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fontBytes');
  });

  test('fails an oversized avatar catalogue', () => {
    setBudget({ ...budget, maxAvatarCatalogBytes: 8 });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('avatarCatalogBytes');
  });

  test('fails a budget file that leaves a line unset', () => {
    const { maxFontBytes, ...rest } = budget;
    setBudget(rest);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('maxFontBytes');
  });

  test('fails a catalogue payload or wrapper the first page loads', () => {
    for (const chunk of ['avatar.js', 'shape-circle.js']) {
      writeFileSync(join(dist, 'index.html'), `<script src="/${chunk}"></script>\n`);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${chunk} is an avatar catalogue chunk loaded by the first page`,
      );
    }
  });
});

describe('isAvatarCatalogueChunk', () => {
  test('a wrapper bundled with other modules stays on the app lines', () => {
    expect(isAvatarCatalogueChunk(WRAPPER)).toBe(true);
    expect(isAvatarCatalogueChunk(WRAPPER + WRAPPER.replace(',2,', ',7,'))).toBe(false);
    expect(isAvatarCatalogueChunk('__d(function(g,r){r(0)},9,[]);\n')).toBe(false);
  });
});

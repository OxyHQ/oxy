#!/usr/bin/env node
/**
 * The source stamp: a digest of a workspace package's `src/`, written into its
 * build output by its build, and checked by the Metro guard
 * (`fresh-workspace-builds.js`) before a release bundle uses that output.
 *
 * Content, not mtimes: a `git checkout` there and back gives the sources new
 * mtimes without changing them, and turbo then (correctly) replays its cache
 * without rewriting the output, so an mtime comparison would refuse a build
 * that is fine and name a command (`build:all`) that cannot fix it.
 *
 * A package opts in with `"oxySourceStamp": "<output dir>"` in its
 * package.json and, last in its `build` (cwd = the package), calls
 * `writeStamp(process.cwd())` from this file when the file is there:
 *
 *   node -e "const p='../app-preset/metro/source-stamp.js';require('node:fs').existsSync(p)&&require(p).writeStamp(process.cwd())"
 *
 * The guard is for builds that never reach Metro: the API and node Docker
 * images copy only the packages they build, not app-preset, and a missing
 * stamp only matters to a Metro release bundle, which then refuses it. The
 * stamp is `<output dir>/.oxy-source-digest`.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STAMP_FILE = '.oxy-source-digest';

/** Not part of what a build compiles: tests, mocks, docs. */
const IGNORED =
  /(?:^|[/\\])(?:__tests__|__mocks__)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.md$/;

function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (IGNORED.test(full)) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** sha256 over every source file's relative path and bytes, in a stable order. */
function sourceDigest(packageDir) {
  const srcDir = path.join(packageDir, 'src');
  const files = listFiles(srcDir)
    .map((file) => path.relative(srcDir, file).split(path.sep).join('/'))
    .sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(srcDir, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The output directory a package stamps, or `null` when it does not opt in. */
function stampedOutputDir(packageDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return typeof manifest.oxySourceStamp === 'string' ? manifest.oxySourceStamp : null;
  } catch {
    return null;
  }
}

function readStamp(packageDir, outputDir) {
  try {
    return fs.readFileSync(path.join(packageDir, outputDir, STAMP_FILE), 'utf8').trim();
  } catch {
    return null;
  }
}

function writeStamp(packageDir) {
  const outputDir = stampedOutputDir(packageDir);
  if (!outputDir) {
    throw new Error(`${packageDir}/package.json declares no "oxySourceStamp" output directory`);
  }
  fs.mkdirSync(path.join(packageDir, outputDir), { recursive: true });
  fs.writeFileSync(path.join(packageDir, outputDir, STAMP_FILE), `${sourceDigest(packageDir)}\n`);
}

if (require.main === module) {
  writeStamp(process.cwd());
}

module.exports = { STAMP_FILE, sourceDigest, stampedOutputDir, readStamp, writeStamp };

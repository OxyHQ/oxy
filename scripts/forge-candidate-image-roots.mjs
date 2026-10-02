/** Read-only candidate diagnostic: every installed root and physical node-forge copy in a filesystem. Grants nothing. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const FILES = ['lib/rsa.js', 'dist/forge.min.js', 'dist/forge.min.js.map', 'dist/forge.all.min.js', 'dist/forge.all.min.js.map'];
// Files only a Forge build carries; their presence makes a directory Forge-shaped.
export const FORGE_MARKERS = ['lib/forge.js', 'dist/forge.min.js', 'dist/forge.all.min.js'];
// Only kernel virtual filesystems and the exact read-only bind mount of the proof scripts; the rest of
// /proof (if the image has one) is physical image content and is scanned.
export const EXCLUDED = ['/dev', '/proc', '/proof/scripts', '/sys'];
// Physical walk (symlinks are never followed): each physical directory is visited exactly once,
// so a copy reachable only through a symlink is still found at its real location. Errors throw.
export function scanRoots(root = '/', excluded = EXCLUDED) {
  root = resolve(root);
  const skip = new Set(excluded.map(path => join(root, path)));
  const installRoots = new Set(), forgeCopies = [];
  // Package-manager-managed layout: a project root's node_modules (one with package.json beside it),
  // its @scope dirs, and Bun's store (.bun/<entry>/node_modules). Every package slot there must carry
  // a real name/version manifest. Fixture trees packages ship inside themselves are not slots, but
  // Forge-shaped content is caught anywhere by FORGE_MARKERS.
  function visit(dir, insideNodeModules, packageSlot, kind) {
    const entries = readdirSync(dir, { withFileTypes: true });
    const hasManifest = entries.some(entry => entry.name === 'package.json' && entry.isFile());
    // A directory that looks like Forge by location or content must identify as exactly node-forge:
    // renaming manifest.name, dropping version or corrupting JSON never hides a copy.
    const forgeShaped = basename(dir) === 'node-forge' || FORGE_MARKERS.some(marker => existsSync(join(dir, marker)));
    let manifest = null;
    if (hasManifest) {
      try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
      catch (error) { if (packageSlot || forgeShaped || !(error instanceof SyntaxError)) throw new Error(`Unreadable package manifest at ${dir}: ${error.message}`); }
    }
    if (packageSlot && (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string')) throw new Error(`Installed package at ${dir} lacks a string name/version`);
    if (forgeShaped && (manifest?.name !== 'node-forge' || typeof manifest?.version !== 'string')) throw new Error(`Forge-shaped directory ${dir} does not identify as node-forge`);
    if (manifest?.name === 'node-forge') forgeCopies.push({ path: dir, version: manifest.version,
      files: Object.fromEntries(FILES.map(name => [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')])) });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (skip.has(child)) continue;
      if (entry.name === 'node_modules' && !insideNodeModules) installRoots.add(dir);
      const isModules = entry.name === 'node_modules', dot = entry.name.startsWith('.');
      let childKind = null, slot = false;
      if (kind === 'modules') { if (entry.name === '.bun') childKind = 'store'; else if (entry.name.startsWith('@')) childKind = 'scope'; else slot = !dot; }
      else if (kind === 'scope') slot = !dot;
      else if (kind === 'store') childKind = dot ? null : 'storeEntry';
      else if (isModules && (kind === 'storeEntry' || (!insideNodeModules && hasManifest))) childKind = 'modules';
      visit(child, insideNodeModules || isModules, slot, childKind);
    }
  }
  visit(root, false, false, null);
  return { diagnosticOnly: true, approval: false, root, excluded, installRoots: [...installRoots].sort(), forgeCopies: forgeCopies.sort((a, b) => a.path.localeCompare(b.path)) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3) throw new Error('Usage: node diagnostic ROOT'); console.log(JSON.stringify(scanRoots(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

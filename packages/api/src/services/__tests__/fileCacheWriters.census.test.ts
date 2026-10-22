/**
 * Every write to `files` reaches the cross-task cache invalidation (ADR 0043
 * stage 4b) — a census over the source, so a NEW writer fails the build until
 * somebody decides how it invalidates.
 *
 * Why a census: each API task keeps file records for five minutes
 * (`utils/fileCache.ts`). A write that changes a file's status, visibility or
 * keys and does not end in `fileCache.invalidate` / `invalidateMany` (which
 * also publishes to every other task) leaves the other tasks serving the old
 * record — a blocked or trashed file streamed for five more minutes. Every
 * writer below names the post-commit point that invalidates for it. Adding a
 * writer: make sure its committed change reaches `fileCache.invalidate*`
 * (directly, or through `AssetService.cacheFile` / `enterServing` /
 * `leaveServing` / `tombstoneAndOwePurge`), then list it here with that path.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');

/** `file#function` → the post-commit invalidation that covers its writes. */
const WRITERS: Record<string, string> = {
  'services/accountStorageDeletion.service.ts#recordAccountStorageDeletion':
    "callers invalidate the recorded fileIds after commit (account.service archive, accountDeletion's hard delete and archive: fileCache.invalidateMany)",
  'services/assetService.ts#relocateAllForVisibility': 'cacheFile after its transaction',
  'services/fileRepository.ts#updateFile': 'itself, after its own transaction',
  'services/fileRepository.ts#upsertVariantSet': 'itself, after its own transaction',
  'services/fileRepository.ts#addFileReferences':
    'itself after its own transaction; in a caller transaction the caller enterServing()s each restored file (linkFile, reconciliation)',
  'services/fileRepository.ts#reactivateTrashedFile': 'itself, after its own transaction',
  'services/fileRepository.ts#markFileLostRow':
    'AssetService.markFileLost: fileCache.invalidate after its transaction commits',
  'services/fileRepository.ts#trashAccountFile':
    'itself, after its own transaction (and leaveServing)',
  'services/fileRepository.ts#trashUnreferencedApplicationFile':
    'itself, after its own transaction (and leaveServing)',
  'services/fileRepository.ts#tombstoneFile': 'AssetService.tombstoneAndOwePurge, after commit',
  'services/fileRepository.ts#tombstoneFileIfDue':
    'AssetService.tombstoneAndOwePurge, after commit',
  'services/fileRepository.ts#tombstoneApplicationFile':
    'AssetService.tombstoneAndOwePurge, after commit',
  'services/fileRepository.ts#tombstoneFederatedFileForApp':
    'AssetService.tombstoneAndOwePurge, after commit',
  'services/fileRepository.ts#tombstoneApplicationFiles':
    'invalidateDeletedApplicationFiles after the deletion commits (applications route, account deletion and archive)',
  'services/fileRepository.ts#refreshUnreferencedSince':
    'unreferenced_since only — no status, visibility or key change (called by the reference writers, each covered above or re-cached by linkFile / unlinkFile)',
  'services/contentClaims/contentClaim.service.ts#blockClaimTargets':
    'assetService.leaveServing for every blocked row, after commit',
  'services/contentClaims/contentClaim.service.ts#reinstateContentClaim':
    'assetService.enterServing for every unblocked row, after commit',
};

const WRITE = [
  /\.(?:update|delete)\(\s*(?:files|filesTable)\s*\)/,
  /\b(?:update|delete\s+from)\s+"?files"?\s/i,
  /\b(?:update|delete\s+from)\s+\$\{\s*(?:files|filesTable)\s*\}/i,
];

const DECLARATION = [
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/,
  /^ {2}(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?(\w+)\s*[(<]/,
];
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts'))
      out.push(path);
  }
  return out;
}

function enclosingFunction(lines: string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    for (const pattern of DECLARATION) {
      const match = pattern.exec(lines[i]);
      if (match && !NOT_A_NAME.has(match[1])) return match[1];
    }
  }
  return '(module)';
}

function census(): string[] {
  const found = new Set<string>();
  for (const path of sourceFiles(SRC)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (WRITE.some((pattern) => pattern.test(line))) {
        found.add(`${relative(SRC, path)}#${enclosingFunction(lines, index)}`);
      }
    });
  }
  return [...found].sort();
}

/** The body of an `AssetService` method, by name. */
function assetServiceMethod(name: string): string {
  const source = readFileSync(join(SRC, 'services/assetService.ts'), 'utf8');
  const declaration = new RegExp(`\\n {2}(?:private )?(?:async )?${name}\\(`);
  const match = declaration.exec(source);
  if (!match) throw new Error(`AssetService.${name} not found`);
  return source.slice(match.index, source.indexOf('\n  }\n', match.index));
}

describe('every write to `files` is covered by the cross-task cache invalidation', () => {
  it('finds exactly the reviewed writers', () => {
    const found = census();
    const unlisted = found.filter((writer) => !(writer in WRITERS));
    const gone = Object.keys(WRITERS).filter((writer) => !found.includes(writer));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  it('the shared entry points really invalidate', () => {
    expect(assetServiceMethod('cacheFile')).toContain('fileCache.invalidate(');
    expect(assetServiceMethod('leaveServing')).toContain('fileCache.invalidate(');
    expect(assetServiceMethod('enterServing')).toContain('this.cacheFile(');
    expect(assetServiceMethod('tombstoneAndOwePurge')).toContain('fileCache.invalidate(');
  });
});

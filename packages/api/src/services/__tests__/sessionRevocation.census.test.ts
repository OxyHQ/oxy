/**
 * Every write that can end a session goes through
 * `services/sessionRevocation.service.ts`, which announces it to every cache
 * that holds the session — this task's and every other task's `sessionCache`,
 * and every Oxy backend's validation cache (`@oxy.so/core/server` caches a
 * validation ONLY while it hears these announcements).
 *
 * A census over the source, so a NEW writer fails the build until somebody
 * decides how it announces. Two populations:
 *
 * - writes to `sessions`. Each is either the choke point itself, or a write
 *   that provably never ends a session (it rotates, slides, renames or binds a
 *   LIVE session) — which is asserted, not just claimed: its body may not set
 *   `isActive`/`is_active` false;
 * - deletions and archives of a `users` row, which end that account's sessions
 *   by cascade or by status. Each names the announcement that covers it, and the
 *   test checks the named call is really in its body.
 *
 * Adding a writer: route a deactivation through `deactivateSessionRows` (inside a
 * transaction: announce after commit) or `revokeSessions`, then list it here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');
const CHOKE_POINT = 'services/sessionRevocation.service.ts';

/** `file#function` → why it cannot end a session without an announcement. */
const SESSION_WRITERS: Record<string, string> = {
  [`${CHOKE_POINT}#deactivateSessionRows`]: 'the choke point',
  'services/session.service.ts#updateLastActivity': 'last_active_at only',
  'services/session.service.ts#createSession':
    'reuses a live session: re-mints its tokens and binding',
  'services/session.service.ts#refreshTokens': 'rotates a live session’s tokens',
  'services/session.service.ts#getAccessToken': 'slides a live session’s expiry',
  'services/deviceSession.service.ts#bindSessionToContext': 'binds a live session to its context',
  'controllers/session.controller.ts#updateDeviceName': 'renames the device',
};

/** `file#function` → the call in its body that announces the account's sessions ended. */
const USER_ENDERS: Record<string, string> = {
  // The hard delete cascades every session of the account (and every one it
  // operated); `deactivateAllUserSessions` announces the account first.
  'services/accountDeletion.service.ts#deleteAccount': 'sessionService.deactivateAllUserSessions(',
  // Archive: revokes the account's sessions in the same transaction.
  'services/accountFinancialHolds.service.ts#establishAccountClosureFence':
    'announceUserSessionsRevoked(',
  // Federated accounts: remote actors that never sign in to Oxy, so they hold no
  // session. Each statement is restricted to a federated row.
  'services/user.service.ts#deleteFederatedActor': "eq(users.type, 'federated')",
  'services/federation/blockedDomainPurge.service.ts#purgeBlockedDomain':
    "eq(users.type, 'federated')",
  'routes/federation.ts#POST /actor-gone': "eq(users.type, 'federated')",
};

const SESSION_WRITE = [
  /\.(?:update|delete)\(\s*sessions\s*\)/,
  /\b(?:update|delete\s+from)\s+"?sessions"?\s/i,
  /\b(?:update|delete\s+from)\s+\$\{\s*sessions\s*\}/i,
];
const USER_END = [
  /\.delete\(\s*users\s*\)/,
  /\bdelete\s+from\s+"?users"?\s/i,
  /accountStatus:\s*'archived'/,
  /account_status\s*=\s*'archived'/i,
];

const DECLARATION = [
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/,
  // A class method; a statement (ending `;` or `,`) at that indent is a call.
  /^ {2}(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?(\w+)\s*[(<](?!.*[;,]$)/,
];
/** `router.post(` — named by its method and the path on the same or the next line. */
const ROUTE_HANDLER = /^router\.(get|post|put|patch|delete)\(\s*(?:'([^']*)')?/;
const NOT_A_NAME = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'await',
  'asyncHandler',
]);

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

/** Comments describe writes; they do not perform them. */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function enclosingFunction(lines: string[], index: number): { name: string; start: number } {
  for (let i = index; i >= 0; i--) {
    const route = ROUTE_HANDLER.exec(lines[i]);
    if (route) {
      const path = route[2] ?? /^\s*'([^']*)'/.exec(lines[i + 1] ?? '')?.[1] ?? '?';
      return { name: `${route[1].toUpperCase()} ${path}`, start: i };
    }
    for (const pattern of DECLARATION) {
      const match = pattern.exec(lines[i]);
      if (match && !NOT_A_NAME.has(match[1])) return { name: match[1], start: i };
    }
  }
  return { name: '(module)', start: 0 };
}

/** The text of a census entry's enclosing function, from its declaration to its end. */
function bodyOf(file: string, start: number): string {
  const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
  const indent = /^\s*/.exec(lines[start])?.[0] ?? '';
  const end = lines.findIndex(
    (line, index) => index > start && (line === `${indent}}` || line === `${indent});`),
  );
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n');
}

function census(patterns: RegExp[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (isComment(line) || !patterns.some((pattern) => pattern.test(line))) return;
      const { name, start } = enclosingFunction(lines, index);
      const key = `${file}#${name}`;
      if (!found.has(key)) found.set(key, bodyOf(file, start));
    });
  }
  return found;
}

describe('every write that can end a session announces it', () => {
  const sessionWriters = census(SESSION_WRITE);
  const userEnders = census(USER_END);

  it('finds exactly the reviewed writers to `sessions`', () => {
    const found = [...sessionWriters.keys()].sort();
    const unlisted = found.filter((writer) => !(writer in SESSION_WRITERS));
    const gone = Object.keys(SESSION_WRITERS).filter((writer) => !found.includes(writer));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  it('only the choke point sets `is_active` false', () => {
    const touching = [...sessionWriters]
      .filter(([writer]) => !writer.startsWith(`${CHOKE_POINT}#`))
      .filter(([, body]) => /\bisActive\s*:\s*false|\bis_active\s*=\s*false/i.test(body))
      .map(([writer]) => writer);
    expect(touching).toEqual([]);
  });

  it('finds exactly the reviewed deletions and archives of a `users` row', () => {
    const found = [...userEnders.keys()].sort();
    const unlisted = found.filter((writer) => !(writer in USER_ENDERS));
    const gone = Object.keys(USER_ENDERS).filter((writer) => !found.includes(writer));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  it('each of them really carries the announcement it names', () => {
    const missing = Object.entries(USER_ENDERS)
      .filter(([writer, call]) => !userEnders.get(writer)?.includes(call))
      .map(([writer]) => writer);
    expect(missing).toEqual([]);
  });

  it('the choke point announces, and the session service ends sessions only through it', () => {
    const chokePoint = readFileSync(join(SRC, CHOKE_POINT), 'utf8');
    expect(chokePoint).toContain('publishSessionRevocation({ sessionId, userId, at })');
    expect(chokePoint).toContain('publishSessionRevocation({ userId, at: Date.now() })');

    // Every importer of the transaction-scoped write also announces.
    const unannounced = sourceFiles(SRC)
      .map((path) => [relative(SRC, path), readFileSync(path, 'utf8')] as const)
      .filter(([file]) => file !== CHOKE_POINT)
      .filter(([, source]) => /\bdeactivateSessionRows\(/.test(source))
      .filter(
        ([, source]) => !/\bannounce(?:SessionRevocations|UserSessionsRevoked)\(/.test(source),
      )
      .map(([file]) => file);
    expect(unannounced).toEqual([]);
  });
});

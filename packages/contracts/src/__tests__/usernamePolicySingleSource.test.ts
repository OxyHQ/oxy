/**
 * A username is ONE global namespace, so it gets ONE policy.
 *
 * `users.username` carries a single unique index — `lower(btrim(username))` —
 * shared by people, bots, organizations, projects and channels. It is also the
 * routing key of `/@handle` and the local part of a webfinger `acct:`. There is
 * no per-kind namespace to hold a per-kind rule, so a second rule is not a
 * variant: it is a disagreement about who may hold a name in the same index.
 *
 * `botUsernameSchema` is not that. It only TIGHTENS — a bot's handle must also
 * end in `bot` — and it is declared in the same OWNER file, reached through the
 * one branch (`usernameSchemaForAccountKind`), so it is inside the single
 * declaration rather than beside it. What this gate hunts is a rule written
 * SOMEWHERE ELSE, whichever direction it points.
 *
 * ## Why a gate rather than a comment
 *
 * The rules did not diverge loudly. SEVEN accumulated across five packages —
 * four that validated (`@oxyhq/api`, `@oxyhq/core`, `@oxyhq/commons`, and one
 * written inline in `AccountService.resolveUniqueUsername`) and three that
 * COERCED, silently deleting the characters they disliked. The file that declared
 * itself the enforced one listed two of the six others. The one it missed was the
 * loosest AND the one governing managed-account creation, which is how three
 * `community-*` bots and an `alia-production-chat` project came to hold names a
 * person could not have been given.
 *
 * Nothing went red, because agreement between seven regexes in five packages is
 * not a property any type or test asserted. This asserts it.
 *
 * ## What it asserts
 *
 * 1. Every handle-shaped character class in EXECUTABLE code is declared in
 *    `src/username.ts`, or is allow-listed with a reason naming a DIFFERENT
 *    namespace.
 * 2. Every OpenAPI `pattern:` that documents a username quotes the policy
 *    verbatim. Those live in docblocks, which rule 1 does not read — and a
 *    published pattern that drifts is a lie told to every client generated from
 *    the spec.
 *
 * Comments are excluded from rule 1 on purpose: a comment is not a declaration,
 * and this change left several that quote the rules it deleted, which is exactly
 * the history a reader needs. Rule 2 is what keeps the exclusion from becoming a
 * blind spot.
 *
 * The scan is a filesystem walk, not `git ls-files`: an untracked new file is
 * exactly the case this must catch, and `git ls-files` cannot see one until it is
 * staged.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { USERNAME_PATTERN_SOURCE } from '../username';

/** Repo root: `packages/contracts/src/__tests__` → four levels up. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** Directories that hold build output, dependencies or platform projects. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'lib',
  'build',
  'coverage',
  '.git',
  '.next',
  '.expo',
  '.turbo',
  'android',
  'ios',
]);

/**
 * The character classes a handle rule is built from. Substrings rather than
 * parsed regex literals: a regex literal cannot be told from a division by
 * scanning, and a rule written as a string (a `new RegExp`, a SQL CHECK) is just
 * as much a declaration as one written as a literal.
 */
const HANDLE_CHARACTER_CLASSES = ['a-zA-Z0-9', 'A-Za-z0-9', 'a-z0-9', 'A-Z0-9', '[\\w'];

/** Words that make a character class a HANDLE rule rather than some other rule. */
const HANDLE_SUBJECTS = /username|handle/i;

/** Lines either side of the class that may carry the subject word. */
const SUBJECT_WINDOW = 6;

/**
 * Files allowed to contain a handle-shaped character class in CODE, and why.
 *
 * Every entry names a namespace that is not `users.username` on this server, or a
 * check that mirrors a database constraint. Adding an entry is a claim that a
 * second namespace exists; make it in the reason, not silently.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'packages/api/src/services/federation.service.ts',
    "A REMOTE fediverse handle (`user@domain`) — another server's namespace. 73,146 of the ~73,189 rows in `users` are remote actors stored in that form, and not one of them is a name claimed here.",
  ],
  [
    'packages/federation/src/__tests__/actorResolverNetworkIdentity.test.ts',
    "Rewrites bare `@handle` mentions in REMOTE post text to their origin server; the handles are other servers'.",
  ],
  [
    'packages/auth/hub/cookie.ts',
    'A browser-hub cookie handle: an opaque base64url token the API issues, checked before it is written into a `Set-Cookie`. Not a name anybody holds.',
  ],
  [
    'packages/api/src/routes/__tests__/browserHub.test.ts',
    'Asserts the shape of the browser-hub handle above.',
  ],
  [
    'packages/api/src/routes/profiles.ts',
    'A READ path, and it COERCES rather than validates — `/profiles/username/al ice` serves `alice`. Left deliberately: it must keep resolving 73k federated handles and every row written under an earlier rule, and narrowing it to the policy would 400 accounts that exist. The coercion is a real bug with its own issue; it is not this rule.',
  ],
  [
    'packages/api/src/scripts/__tests__/internalCostCenterSpecs.test.ts',
    '`internal_cost_centers_slug_check` byte for byte — a database CHECK on the SLUG, which is stricter than the username policy (lower-case only) and looser on length (63). The same file asserts every slug also satisfies `usernameSchema`, which is what keeps the two from parting.',
  ],
  [
    'packages/contracts/src/__tests__/usernamePolicySingleSource.test.ts',
    'This gate: it must name the character classes it hunts for.',
  ],
  [
    'packages/contracts/src/inference/providerConnection.ts',
    'Opaque Kaana credential operation and cross-service identity ids, not Oxy account usernames.',
  ],
]);

/** The one file that may DECLARE the policy. */
const OWNER = 'packages/contracts/src/username.ts';

interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/**
 * The file with its comments blanked out, line count preserved so a report still
 * names the right line.
 *
 * Blanked rather than removed, and by line rather than by parse: this decides
 * what a human would call a declaration, and a real parser would be a heavier
 * dependency than the question deserves. The known limitation is a `//` inside a
 * string literal, which would blank the rest of that line — no rule in this
 * repository shares a line with a URL.
 */
function withoutComments(contents: string): string[] {
  const lines = contents.split('\n');
  let inBlock = false;
  return lines.map((line) => {
    let code = line;
    if (inBlock) {
      const closes = code.indexOf('*/');
      if (closes === -1) return '';
      code = code.slice(closes + 2);
      inBlock = false;
    }
    const opens = code.indexOf('/*');
    if (opens !== -1) {
      const closes = code.indexOf('*/', opens + 2);
      if (closes === -1) {
        inBlock = true;
        code = code.slice(0, opens);
      } else {
        code = code.slice(0, opens) + code.slice(closes + 2);
      }
    }
    const lineComment = code.indexOf('//');
    return lineComment === -1 ? code : code.slice(0, lineComment);
  });
}

/** Every handle-shaped character class declared in CODE, with its subject word nearby. */
function handleRulesInCode(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const path of sourceFiles(join(REPO_ROOT, 'packages'))) {
    const contents = readFileSync(path, 'utf8');
    const code = withoutComments(contents);
    // The subject word may legitimately be in the DOC above the declaration, so
    // the window reads the original text while the match reads the code.
    const prose = contents.split('\n');
    code.forEach((text, index) => {
      if (!HANDLE_CHARACTER_CLASSES.some((klass) => text.includes(klass))) return;
      const from = Math.max(0, index - SUBJECT_WINDOW);
      if (!HANDLE_SUBJECTS.test(prose.slice(from, index + SUBJECT_WINDOW + 1).join('\n'))) return;
      found.push({
        file: relative(REPO_ROOT, path).split(sep).join('/'),
        line: index + 1,
        text: text.trim(),
      });
    });
  }
  return found;
}

/** Every OpenAPI `pattern:` in a docblock whose surroundings talk about a username. */
function documentedPatterns(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const path of sourceFiles(join(REPO_ROOT, 'packages'))) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const quoted = /pattern:\s*'([^']+)'/.exec(text);
      if (!quoted) return;
      const from = Math.max(0, index - SUBJECT_WINDOW);
      if (!HANDLE_SUBJECTS.test(lines.slice(from, index + SUBJECT_WINDOW + 1).join('\n'))) return;
      found.push({
        file: relative(REPO_ROOT, path).split(sep).join('/'),
        line: index + 1,
        text: quoted[1],
      });
    });
  }
  return found;
}

describe('the username policy is declared once', () => {
  const occurrences = handleRulesInCode();

  /**
   * A walk that finds nothing passes every assertion below. This is what makes
   * the zeros measured zeros: the scan is proven to reach a file known to carry a
   * handle rule, and the comment blanking is proven not to have eaten everything.
   */
  it('the scan reaches the repository', () => {
    expect(occurrences.length).toBeGreaterThan(0);
    expect(occurrences.map((found) => found.file)).toContain(
      'packages/api/src/services/federation.service.ts'
    );
  });

  it('declares the handle character class only in the owner or an allow-listed namespace', () => {
    const unexplained = occurrences
      .filter((found) => found.file !== OWNER && !ALLOWED.has(found.file))
      .map((found) => `${found.file}:${found.line}  ${found.text}`);

    expect(unexplained).toEqual([]);
  });

  it('every allow-list entry still names a file that carries a handle rule', () => {
    const seen = new Set(occurrences.map((found) => found.file));
    const stale = [...ALLOWED.keys()].filter((file) => !seen.has(file));

    expect(stale).toEqual([]);
  });
});

describe('every documented username pattern quotes the enforced one', () => {
  const documented = documentedPatterns();

  /** Same reasoning as above: an empty list would satisfy the assertion below. */
  it('finds the OpenAPI docblocks that publish the rule', () => {
    expect(documented.map((found) => found.file)).toEqual(
      expect.arrayContaining(['packages/api/src/routes/auth.ts', 'packages/api/src/routes/users.ts'])
    );
  });

  it('and none of them has drifted from it', () => {
    const drifted = documented
      .filter((found) => found.text !== USERNAME_PATTERN_SOURCE)
      .map((found) => `${found.file}:${found.line}  ${found.text}`);

    expect(drifted).toEqual([]);
  });
});

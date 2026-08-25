/**
 * A person's account switcher must never gate on the DELEGATED act-as predicate.
 *
 * ## The bug this exists to prevent recurring
 *
 * One predicate, `isActAsEligibleKind`, answered two different questions with one
 * answer: "what may a PERSON become?" and "what may a SERVICE act as on a
 * person's authority?". `bot` belongs only to the second. Because both paths read
 * the one predicate, the account switcher offered bots as identities to switch
 * into — and a person did switch into one: `community-maestro` held a live
 * session on a human's own device, alongside that person's personal and
 * organization sessions, on 2026-08-25.
 *
 * A bot is not something you become. It is something that operates on your
 * behalf. The distinction has no representation in a single boolean, which is
 * why there are now two.
 *
 * ## Why a gate and not a comment
 *
 * The predicates differ on exactly one kind, so a person path that reaches for
 * the delegated one still works, still passes its tests, and still returns a
 * plausible list. Nothing goes red — the list simply contains one row too many,
 * and that row is a login into a bot. That is the same shape as the original
 * defect, so a comment saying "use the other one" is not a control.
 *
 * This asserts it structurally: the modules that serve a PERSON may not name the
 * delegated predicate at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_KINDS,
  isDelegatedActAsEligibleKind,
  isOperatorSwitchTargetKind,
} from '@oxyhq/contracts';

/** Repo root: `packages/api/src/__tests__` → three levels up. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** The delegated predicate, by the name a person path would have to write. */
const DELEGATED = 'isDelegatedActAsEligibleKind';

/**
 * The file's CODE, with comment lines dropped.
 *
 * A comment that names the delegated predicate in order to warn against it is
 * exactly the prose these modules should carry — `accountSwitchTargets.ts` says
 * "it is the OPERATOR predicate, never `isDelegatedActAsEligibleKind`" — and a
 * raw substring scan reads that warning as the offence it warns about. Naming a
 * thing is not using it.
 *
 * Line-based rather than parsed: every comment line in this codebase begins with
 * `*`, `//` or `/*`, and the positive control below is what keeps this filter
 * from silently eating the whole file.
 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

/**
 * Every module that decides what ONE PERSON may switch into, and what the person
 * decides there.
 *
 * A frozen list rather than a heuristic: these are few, they are known, and a
 * heuristic that guessed at "person path" would be the thing going quietly wrong.
 * Adding a person-facing surface means adding it here — and the assertion below
 * fails if a path named here stops existing, so a rename cannot empty the list.
 */
const PERSON_PATHS: ReadonlyMap<string, string> = new Map([
  [
    'packages/api/src/routes/accounts.ts',
    '`POST /accounts/:id/switch` — a human switching the whole app into another account.',
  ],
  [
    'packages/api/src/services/deviceSession.service.ts',
    '`loadActAsAccounts` builds the device directory rows the account switcher renders. This is where the bot rows came from: the UI does not filter by kind, it renders what the server sends.',
  ],
  [
    'packages/core/src/session/accountSwitchTargets.ts',
    "The SDK's switch-target predicate, read by the Console's workspace tree and the Accounts app's managed-account rows.",
  ],
]);

describe('the two act-as questions stay two questions', () => {
  /**
   * If these ever agree on every kind, one of them has been quietly widened or
   * narrowed to match the other and the split has been undone — which is exactly
   * how the single predicate came to answer both questions in the first place.
   */
  it('disagree on `bot`, which is the whole point', () => {
    expect(isDelegatedActAsEligibleKind('bot')).toBe(true);
    expect(isOperatorSwitchTargetKind('bot')).toBe(false);
  });

  it('and agree on everything else', () => {
    const differing = ACCOUNT_KINDS.filter(
      (kind) => isDelegatedActAsEligibleKind(kind) !== isOperatorSwitchTargetKind(kind)
    );

    expect(differing).toEqual(['bot']);
  });

  /**
   * The operator predicate is the narrower one. Stated as a containment rather
   * than two lists, so it survives a kind being added to both.
   */
  it('every kind a person may become, a service may also act as', () => {
    for (const kind of ACCOUNT_KINDS) {
      if (isOperatorSwitchTargetKind(kind)) {
        expect(isDelegatedActAsEligibleKind(kind)).toBe(true);
      }
    }
  });
});

describe('no person path gates on the delegated predicate', () => {
  it.each([...PERSON_PATHS.entries()])('%s', (path, why) => {
    const code = codeOf(readFileSync(join(REPO_ROOT, path), 'utf8'));

    // The reason travels into the failure message: whoever trips this needs to
    // know which question the file is answering, not just that a name is banned.
    expect({ path, why, usesDelegated: code.includes(DELEGATED) }).toEqual({
      path,
      why,
      usesDelegated: false,
    });
  });

  /**
   * The positive control. Every assertion above passes if the file cannot be
   * read, has been renamed away, or has had its CODE eaten by `codeOf` — so this
   * proves the scan is looking at real modules that really do decide this, by
   * requiring each to CALL the operator predicate in the same filtered code the
   * assertion above searched.
   */
  it.each([...PERSON_PATHS.keys()])('%s actually asks the operator question', (path) => {
    const code = codeOf(readFileSync(join(REPO_ROOT, path), 'utf8'));

    expect(code).toContain('isOperatorSwitchTargetKind(');
  });
});

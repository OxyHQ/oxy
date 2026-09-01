/**
 * Everything the follow-graph guide tells an application to use must be
 * reachable from the package barrel.
 *
 * ## Why this exists, and why it is a gate rather than a convention
 *
 * Three symbols were documented and unexported, one after another, and each was
 * found by an application that had already written a workaround for it:
 *
 * - `isFollowedGlobally` — named in `docs/FOLLOWS.md` as the answer to "does
 *   the user follow this". Syra checked the published `.d.ts` and found it
 *   absent, and used `useFollowTarget().isFollowing` instead.
 * - `withApplicationMode` — same omission, same commit.
 * - `resolveFollowPrimaryAction` — Mention found it. This one bites hardest:
 *   the rule it encodes is that pressing a follow which is switched off HERE
 *   must re-enable it here rather than unfollow everywhere. An application
 *   drawing its own affordance either duplicates that or gets it wrong, and
 *   Mention had to duplicate it as `resolveTopicChipAction`.
 *
 * Three of one shape is a pattern, not bad luck. The barrel is written by hand,
 * so the only thing that catches an omission is somebody trying to import.
 *
 * ## What it does NOT check
 *
 * It does not demand that every symbol in those modules be public — plenty are
 * internal on purpose. It checks a written list, so adding to that list is a
 * deliberate act. The list is the claim "an application may rely on this"; the
 * test is what makes the claim true.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const barrel = readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');

/**
 * The follow-graph surface an application is told it may use. Every entry here
 * appears in `docs/FOLLOWS.md`, in a component's own doc comment, or in both.
 */
const PUBLIC_SURFACE = [
  // The button and the pieces of it an app can render itself.
  'FollowTargetButton',
  'buildFollowMenuItems',
  'resolveFollowPrimaryAction',
  'FOLLOW_ACTION_LEAVES_ACTIVE',
  // The hook that owns the optimism, the rollback and the outcome boolean.
  'useFollowTarget',
  // The store, and the two derivations a caller must not re-implement:
  // `effectiveState` is not "does the user follow this", and the mode change
  // has to be computed the same way the server computes it.
  'useFollowTargetStore',
  'UNKNOWN_FOLLOW_STATUS',
  'isFollowedGlobally',
  'withApplicationMode',
  'isCompleteFollowStatus',
  'followRecordToStatus',
  'followRecordsToStatusMap',
] as const;

describe('the follow-graph public surface is reachable from the barrel', () => {
  it('reads a barrel that is plausibly the real one', () => {
    // Vacuity floor: a mis-resolved path returning an empty string would
    // otherwise fail every assertion below for the wrong reason, or — if the
    // check were written the other way round — pass all of them.
    expect(barrel.length).toBeGreaterThan(1000);
    expect(barrel).toContain('FollowTargetButton');
  });

  it.each(PUBLIC_SURFACE)('exports %s', (symbol) => {
    // Matched as a whole word, so `useFollowTarget` cannot be satisfied by
    // `useFollowTargetStore` appearing somewhere in the file.
    expect(new RegExp(`\\b${symbol}\\b`).test(barrel)).toBe(true);
  });

  it('names each symbol on an export line rather than merely mentioning it', () => {
    // The stricter form of the check above: a symbol appearing only inside a
    // comment would satisfy a bare word match, and this file is full of
    // comments naming exactly these symbols.
    const exportedLines = barrel
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');

    const missing = PUBLIC_SURFACE.filter(
      (symbol) => !new RegExp(`\\b${symbol}\\b`).test(exportedLines)
    );
    expect(missing).toEqual([]);
  });
});

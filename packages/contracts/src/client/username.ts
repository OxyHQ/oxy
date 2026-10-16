/**
 * The username policy, without Zod. Schemas: `../username.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { AccountKind } from './accountGraph';
import { type Check, maxLength, minLength, pattern, refine, string, trim } from './check';

/** Shortest storable handle. `oxy` sets the floor. */
export const USERNAME_MIN_LENGTH = 3;

/** Longest storable handle, and the `maxLength` an input field should carry. */
export const USERNAME_MAX_LENGTH = 30;

/** The 400 / inline-validation copy for every path that rejects a handle. */
export const USERNAME_INVALID_MESSAGE =
  'Username must be 3-30 characters, use only letters, numbers, hyphens and underscores, ' +
  'start and end with a letter or number, and never repeat a separator';

/**
 * Exact-match handles nobody may newly claim, regardless of account kind.
 *
 * This is NOT a namespace tightening like the bot suffix — it is a list of
 * names withheld from `users_lower_username_key` before anybody asks for
 * them. Compared against the same normalization the unique index applies
 * (`lower(btrim(username))`), so `Admin`, ` ADMIN ` and `admin` are the one
 * name this list means.
 *
 * `oxy`, `mention`, `homiio`, `clarity`, `faircoin`, `astro` and `mercaria`
 * are deliberately NOT here: each already has an `organization`/`project`
 * row, so the unique index already refuses a second one, and `oxy` is the
 * name `USERNAME_MIN_LENGTH` is pinned against in
 * `__tests__/username.test.ts` — listing it would make
 * `usernameSchema.safeParse('oxy')` fail and falsify that comment. A brand
 * with no account of its own yet (measured 2026-09-18: Alia, Allo, TNP,
 * Kaana, Bloom) has no row to protect it, so it is listed until one exists.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Oxy product lines with no account row of their own yet.
  'alia',
  'allo',
  'tnp',
  'kaana',
  'bloom',
  // System / role words a signup impersonating staff or Oxy itself would reach for.
  'admin',
  'administrator',
  'root',
  'superadmin',
  'super',
  'superuser',
  'support',
  'staff',
  'moderator',
  'mod',
  'security',
  'system',
  'official',
  'help',
  'noreply',
  'anonymous',
  'everyone',
  'owner',
]);

/** The 400 / inline-validation copy for a handle on {@link RESERVED_USERNAMES}. */
export const RESERVED_USERNAME_MESSAGE = 'This username is reserved and cannot be registered';

/**
 * {@link RESERVED_USERNAMES}, minus `alia`, checked against each `-`/`_`
 * separated SEGMENT of a candidate rather than the whole string — so
 * `official-oxy`, `super-admin` and `team-kaana` are refused the same as the
 * bare words, without banning every word that merely CONTAINS one as a
 * substring (`superman`, `modern`, `grassroot`, `homeowner` all stay legal:
 * none of them separates the reserved word from the rest with `-` or `_`).
 *
 * `alia` is excluded because `alia-` is the live internal-cost-centre
 * namespace: `alia-production-chat` is a minted account and
 * `alia-research` / `alia-voice` / `alia-evaluations` are pinned as legal
 * slugs in `__tests__/username.test.ts` and `internalCostCenterSpecs.test.ts`.
 * Segment-matching `alia` would refuse all four. The bare word `alia` is
 * still refused — {@link RESERVED_USERNAMES} above catches it exactly.
 */
export const RESERVED_USERNAME_SEGMENTS: ReadonlySet<string> = new Set(
  [...RESERVED_USERNAMES].filter((word) => word !== 'alia'),
);

/** The 400 / inline-validation copy for a handle that is only digits. */
export const NUMERIC_USERNAME_MESSAGE = 'Username cannot be only numbers';

/**
 * Alphanumeric runs joined by single separators, as a SOURCE string.
 *
 * A string rather than a literal because the OpenAPI docblocks that publish this
 * rule (`POST /auth/register`, `PUT /users/:userId`) must quote it verbatim, and
 * `usernamePolicySingleSource.test.ts` compares them against THIS constant. A
 * published `pattern:` that drifts from the enforced rule is a lie told to every
 * client that generates from the spec, and it is exactly the kind of copy nobody
 * notices going stale.
 *
 * Deliberately NOT re-exported from the package barrel: it exists for the
 * schema below and for that one gate. Anything validating a username uses
 * {@link usernameSchema}, so there is no second way to ask the question.
 *
 * Written as an unambiguous alternation rather than a lookahead: every character
 * belongs to exactly one branch, so matching is linear and there is no
 * backtracking to bound. It also carries no `\p{…}` property escape, which
 * mobile Hermes throws on at runtime — this module is reachable from every React
 * Native consumer.
 */
export const USERNAME_PATTERN_SOURCE = '^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$';

export const USERNAME_PATTERN = new RegExp(USERNAME_PATTERN_SOURCE);

/**
 * Drop the characters the policy forbids, for an input field that filters
 * keystrokes.
 *
 * This is a TYPING aid and nothing else — the result still has to pass
 * {@link usernameSchema}, which is what decides. It does not lower-case (case is
 * preserved, see the header) and it cannot repair a name: a value that is too
 * short, edge-separated or doubly-separated comes back unchanged and fails
 * validation with a message, which is the outcome the coercing rules this
 * replaces used to hide.
 */
export function stripDisallowedUsernameCharacters(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * The label a bot's handle ends in — the ONE exception the policy carries.
 *
 * Lower-case here because it is what a generator appends; the comparison that
 * enforces it folds case, so `MyBot` satisfies it just as `mybot` does.
 *
 * Deliberately NOT re-exported from the package barrel, for the same reason
 * {@link USERNAME_PATTERN_SOURCE} is not: it exists for the schema and the
 * generator aid below. A consumer that wants to SAY the rule uses
 * {@link BOT_USERNAME_INVALID_MESSAGE}, which already quotes it, and one that
 * wants to APPLY it uses {@link applyBotUsernameSuffix} — so there is no second
 * way to spell the check.
 */
export const BOT_USERNAME_SUFFIX = 'bot';

/** The 400 / inline-validation copy for a bot handle that carries no label. */
export const BOT_USERNAME_INVALID_MESSAGE = `A bot account's username must end in "${BOT_USERNAME_SUFFIX}"`;

/**
 * Label a proposed bot handle, so a generator PROPOSES something the server will
 * accept.
 *
 * Alia builds an agent's handle from its display name; without this it would
 * propose `garden-helper` for a bot and be 400ed on submit, which is the same
 * "suggest, then refuse" defect the minimum length already caused once.
 *
 * It appends and never inserts: a separator is the caller's choice, so
 * `garden-helper` becomes `garden-helperbot` while a caller who typed
 * `garden-helper-` gets `garden-helper-bot`. It truncates to leave room rather
 * than overflowing {@link USERNAME_MAX_LENGTH}.
 *
 * Like {@link stripDisallowedUsernameCharacters} it is an aid, not a decision: it
 * cannot repair a handle the base policy refuses, and the result still has to
 * pass {@link botUsernameSchema}.
 */
export function applyBotUsernameSuffix(candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed.toLowerCase().endsWith(BOT_USERNAME_SUFFIX)) {
    return trimmed;
  }
  return trimmed.slice(0, USERNAME_MAX_LENGTH - BOT_USERNAME_SUFFIX.length) + BOT_USERNAME_SUFFIX;
}

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

/** The username policy as a check — the twin of `usernameSchema`, same messages. */
export const usernameCheck: Check<string> = refine(
  refine(
    refine(
      string(
        trim,
        minLength(USERNAME_MIN_LENGTH, USERNAME_INVALID_MESSAGE),
        maxLength(USERNAME_MAX_LENGTH, USERNAME_INVALID_MESSAGE),
        pattern(USERNAME_PATTERN, USERNAME_INVALID_MESSAGE),
      ),
      (username) => !/^[0-9]+$/.test(username),
      NUMERIC_USERNAME_MESSAGE,
    ),
    (username) => !RESERVED_USERNAMES.has(username.toLowerCase()),
    RESERVED_USERNAME_MESSAGE,
  ),
  (username) =>
    !username
      .split(/[-_]/)
      .some((segment) => RESERVED_USERNAME_SEGMENTS.has(segment.toLowerCase())),
  RESERVED_USERNAME_MESSAGE,
);

/** A bot's username: the policy plus the `bot` suffix — the twin of `botUsernameSchema`. */
export const botUsernameCheck: Check<string> = refine(
  usernameCheck,
  (username) => username.toLowerCase().endsWith(BOT_USERNAME_SUFFIX),
  BOT_USERNAME_INVALID_MESSAGE,
);

/** The twin of `usernameSchemaForAccountKind`. */
export function usernameCheckForAccountKind(kind: AccountKind | null | undefined): Check<string> {
  return kind === 'bot' ? botUsernameCheck : usernameCheck;
}

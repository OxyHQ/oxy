/**
 * Username policy — the ONE rule, for every kind of account.
 *
 * A username is a HANDLE: the routing key of a profile URL (`/@alice`), the
 * local part of a webfinger `acct:`, and a login identifier. `users.username`
 * carries a single unique index, `lower(btrim(username))`, and people, bots,
 * organizations, projects and channels all draw from it. There is no per-kind
 * NAMESPACE, so no kind may LOOSEN the rule — a bot that could reserve a name a
 * person cannot ask for is a disagreement inside one index, not a variant.
 *
 * One kind TIGHTENS it, and only in that direction: a `bot` handle must also end
 * in `bot` ({@link botUsernameSchema}, at the bottom of this file). That is a
 * label a bot wears, not a name it takes off anybody — everything it accepts,
 * {@link usernameSchema} already accepted. {@link usernameSchemaForAccountKind}
 * is the single place that branch is written.
 *
 * ## Why this file exists
 *
 * Seven rules governed this one namespace: four validators (this package's
 * predecessor in `@oxyhq/api`, `@oxyhq/core`, `@oxyhq/commons`, and one written
 * inline in `AccountService.resolveUniqueUsername`) and three that COERCED —
 * silently deleting the characters they disliked, which hands somebody an
 * account under a name they never chose. They lived in five packages and no test
 * asserted they agreed. `contracts` is where the single declaration can actually
 * live: `api`, `core`, `commons`, `services` and `auth` all already depend on it,
 * so every write path can IMPORT the rule instead of restating it.
 * `__tests__/usernamePolicySingleSource.test.ts` fails if a second one appears.
 *
 * ## The rule, and why each part of it
 *
 * ```
 * 3–30 characters
 * first and last character: [A-Za-z0-9]
 * interior: [A-Za-z0-9_-]
 * never two separators in a row
 * ```
 *
 *  - **Hyphens are admitted because the DATABASE already admits them.**
 *    `internal_cost_centers_slug_check` is a CHECK constraint —
 *    `^[a-z0-9][a-z0-9-]{0,62}$` — and `seed-internal-cost-centers` mints a
 *    `project` account whose username IS the slug; four of the five declared
 *    centres contain a hyphen. An alphanumeric-only handle rule would contradict
 *    a constraint written to permit them, and would make those centres
 *    unmintable. This is the argument, not the four hyphenated accounts that
 *    happen to exist — they are a symptom.
 *  - **Dots are NOT admitted.** A dot is the delimiter that separates handle from
 *    domain in the federated form this same column stores for remote actors
 *    (`alice@mastodon.social`), it collides with extension-style routing
 *    (`/@alice.json`), and `n.ate` beside `nate` is the strongest confusable pair
 *    an ASCII handle can produce. Only the inline account rule ever accepted one,
 *    and it accepted it by accident: its `[\w.-]` was written for a SLUG.
 *  - **A length bound, always.** The account path had none — the only ceiling was
 *    a `.max(100)` on the wire schema. 3 is the floor because `oxy`, the platform
 *    owner's own organization, is three characters. 30 is the ceiling four of the
 *    seven rules and the availability endpoint already published.
 *  - **First and last character alphanumeric, and no `--` / `__` / `-_` run.**
 *    Both are free — no account uses such a name — and they remove the
 *    confusable shapes that admitting two separators would otherwise introduce.
 *
 * ## Case, and what this schema deliberately does not do
 *
 * **Case is PRESERVED.** Uniqueness is decided by the database's
 * `lower(btrim(username))` index, so `Alice` and `alice` cannot coexist, but a
 * name that was typed with a capital keeps it. This schema therefore never
 * lower-cases: rewriting a caller's input is how `resolveUniqueUsername` used to
 * return `mybot` to somebody who asked for `MyBot`.
 *
 * **This is a WRITE-path rule.** It states what may be newly stored, not what may
 * be read. Rows that predate it — including 11 with no username at all — must go
 * on loading, resolving and rendering; validating on a read turns an existing
 * account into a 500.
 *
 * **It does not govern remote actors.** The same column holds ~73k federated
 * rows in `handle@domain` form, written by `POST /users/resolve` through its own
 * normalizer. Those are another server's namespace; this rule would reject every
 * one of them and must never be pointed at that path.
 *
 * ## Usable by a handle GENERATOR, deliberately
 *
 * Slug generators are how the eighth copy of this rule appears. Alia's
 * `suggestAgentUsername` builds one from an agent's name and re-derives a subset
 * of these rules by hand — its own docblock admits it ("A leading digit or an
 * empty slug both fail Oxy's username rules") — and, having no minimum, proposes
 * `al` for an agent called "Al", which the server then refuses.
 *
 * So this module answers a generator's three questions without dragging a server
 * dependency along. It is zod and nothing else, so it imports cleanly into a
 * React Native bundle or another repo's backend:
 *
 *   - *Does this candidate pass?* {@link isValidUsername}, or `safeParse` when the
 *     reason matters.
 *   - *How short is too short, how long is too long?* {@link USERNAME_MIN_LENGTH}
 *     and {@link USERNAME_MAX_LENGTH}, so a generator can pad or truncate instead
 *     of guessing and being 400ed.
 *   - *Which characters survive?* {@link stripDisallowedUsernameCharacters}.
 *
 * A generator PROPOSES; only `POST /accounts` decides, and a taken handle comes
 * back as a 409 for the client to retry with a fresh suggestion. Nothing here
 * knows what is taken, and it must not pretend to.
 */

import { z } from 'zod';

import type { AccountKind } from './accountGraph';

/** Shortest storable handle. `oxy` sets the floor. */
export const USERNAME_MIN_LENGTH = 3;

/** Longest storable handle, and the `maxLength` an input field should carry. */
export const USERNAME_MAX_LENGTH = 30;

/** The 400 / inline-validation copy for every path that rejects a handle. */
export const USERNAME_INVALID_MESSAGE =
  'Username must be 3-30 characters, use only letters, numbers, hyphens and underscores, ' +
  'start and end with a letter or number, and never repeat a separator';

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

const USERNAME_PATTERN = new RegExp(USERNAME_PATTERN_SOURCE);

/**
 * The one username policy, as a schema.
 *
 * `.trim()` first, so surrounding whitespace is a typo rather than a rejection —
 * but interior whitespace is NOT removed. It falls to the pattern, because
 * squashing `"al ice"` into `"alice"` would hand the user an account under a name
 * they never chose. Every write path validates through THIS object; nothing
 * re-implements it.
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH, USERNAME_INVALID_MESSAGE)
  .max(USERNAME_MAX_LENGTH, USERNAME_INVALID_MESSAGE)
  .regex(USERNAME_PATTERN, USERNAME_INVALID_MESSAGE);

/**
 * Whether a candidate handle is storable — the boolean form, for input surfaces
 * that show a message as somebody types rather than throwing.
 *
 * Answers from {@link usernameSchema}, so a client's inline check and the
 * server's 400 cannot disagree.
 */
export function isValidUsername(candidate: string): boolean {
  return usernameSchema.safeParse(candidate).success;
}

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
export const BOT_USERNAME_INVALID_MESSAGE =
  `A bot account's username must end in "${BOT_USERNAME_SUFFIX}"`;

/**
 * The username policy for an account of kind `bot`: everything above, plus a
 * handle that ends in {@link BOT_USERNAME_SUFFIX}.
 *
 * ## Why a suffix, and why THIS one
 *
 * A bot is not a person, and the handle is the only part of an account that
 * travels — into a URL, a mention, a webfinger `acct:`, a screenshot. Telegram
 * settled this question the same way for the same reason: whatever the
 * surrounding UI shows, `@somethingbot` says what it is at the point of contact.
 * Nothing else in Oxy makes the distinction visible where it is actually read.
 *
 * The form is `bot` at the END, folded for case. Each half of that is decided by
 * what THIS policy already admits, not by copying Telegram:
 *
 *  - **The bare label, not `_bot`.** Telegram's common form uses an underscore,
 *    but Oxy admits `-` and `_` as equal separators — hyphens are load-bearing
 *    (`internal_cost_centers_slug_check`, and the accounts minted from those
 *    slugs), so a rule naming one of them would refuse `garden-helper-bot` while
 *    accepting `garden_helper_bot`, a distinction no other line of this policy
 *    makes. Requiring only the label leaves the separator to whoever chooses the
 *    name: `aliabot`, `alia-bot` and `alia_bot` all conform.
 *  - **Case-INSENSITIVE.** Case is preserved but uniqueness folds it
 *    (`lower(btrim(username))`), so a case-sensitive test would accept `mybot`
 *    and refuse `MyBot` — two names the index considers the same one. A rule that
 *    disagrees with the index about identity is a rule with two answers.
 *  - **The label is all ASCII alphanumerics**, so appending it to any handle that
 *    passes {@link usernameSchema} yields another one. That is what makes
 *    {@link applyBotUsernameSuffix} safe and a generator's suggestion honest.
 *
 * It is checked LAST, after the base policy: a handle that is illegal for
 * everybody is reported as illegal rather than as a bot that forgot its label,
 * so nobody appends `bot` to `a.b` and is refused twice.
 *
 * ## What it is NOT
 *
 * **Not a namespace.** `users.username` is still one unique index. A bot must be
 * labelled; the label is not RESERVED, so `abbot` and `robot` stay available to
 * anybody — the rule says what a bot's handle must look like, not what everyone
 * else's may not.
 *
 * **Not a rule about the other four kinds.** `personal`, `organization`,
 * `project` and `channel` are governed by {@link usernameSchema}, unchanged.
 * {@link usernameSchemaForAccountKind} is the only branch, and
 * `__tests__/username.test.ts` asserts by identity that the other kinds get the
 * base schema back.
 *
 * **Not a rule about remote actors.** The same column holds ~74k federated rows
 * in `handle@domain` form, some of them bots on their own server. This schema
 * rejects every one of them and must never be pointed at that path — that
 * namespace belongs to another server.
 *
 * **A WRITE-path rule**, like everything else here. Six bot accounts exist and
 * not one of them is labelled (measured 2026-08-26: `community-guide`,
 * `community-maestro`, `community-pulse`, `garden-helper`, `luna`, `verity`).
 * They go on loading and resolving; only a NEW handle is held to this.
 */
export const botUsernameSchema = usernameSchema.refine(
  (username) => username.toLowerCase().endsWith(BOT_USERNAME_SUFFIX),
  BOT_USERNAME_INVALID_MESSAGE
);

/**
 * The policy that governs a handle, given the kind of account that will hold it.
 *
 * The ONE place the exception branches. A call site that writes
 * `kind === 'bot' ? … : …` for itself is the eighth copy of the rule arriving by
 * the usual route, so every write path — account creation, account rename, the
 * profile update — asks this instead.
 *
 * An unknown kind is the BASE policy, never the stricter one: `users.kind`
 * defaults to `personal`, rows predate the column being filled in, and a rename
 * refused because the server could not tell what it was reading is a 400 nobody
 * can act on.
 */
export function usernameSchemaForAccountKind(
  kind: AccountKind | null | undefined
): z.ZodType<string, z.ZodTypeDef, string> {
  return kind === 'bot' ? botUsernameSchema : usernameSchema;
}

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

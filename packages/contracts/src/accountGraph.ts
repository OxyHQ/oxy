/**
 * Account graph wire contracts — the account-kind vocabulary, the account
 * category taxonomy, and the create-account input.
 *
 * `accountCategories` classifies a NON-PERSONAL account — what it is about, what
 * it does — without polluting `User.kind`. See the block above
 * {@link ACCOUNT_CATEGORY_IDS} for the four rules that govern it.
 */

import { z } from 'zod';

/**
 * Account-graph classification — the ONE authority for the kind vocabulary.
 *
 * `personal` is the only kind minted by signup and the only one that carries
 * its own credentials; every other kind is a child account created under a
 * parent and operated through `account_members`. The API schema, the Drizzle
 * table and the SDK all derive from this list rather than restating it, so a
 * new kind is one edit here instead of four literals that can drift.
 */
export type AccountKind = 'personal' | 'organization' | 'project' | 'bot' | 'channel';

/**
 * The union is spelled out above and the array proves coverage BOTH ways
 * (`satisfies` here, the `Gap` alias below) — the same shape this package's
 * `ACCOUNT_CATEGORY_IDS` / `TRUST_TIERS` pairs use, and the one
 * `db/schema/users.ts` mirrors to keep the `users_kind_check` CHECK honest.
 *
 * Deriving the union from the array instead would cost nothing here and be paid
 * by consumers: `kind` travels into `@oxyhq/services` on every device-directory
 * context (`deviceContextSchema.kind` → `DeviceContext` → the switcher rows),
 * and an indexed-access type is materially more expensive to check there than a
 * literal union.
 */
export const ACCOUNT_KINDS = [
  'personal',
  'organization',
  'project',
  'bot',
  'channel',
] as const satisfies readonly AccountKind[];

/** `never` while `ACCOUNT_KINDS` covers the union. */
export type AccountKindGap = Exclude<AccountKind, (typeof ACCOUNT_KINDS)[number]>;

export const accountKindSchema = z.enum(ACCOUNT_KINDS);

/**
 * Kinds that may be CREATED as children of another account. Exactly
 * `ACCOUNT_KINDS` minus `personal`, which is always a tree root.
 */
export type ChildAccountKind = Exclude<AccountKind, 'personal'>;

export const CHILD_ACCOUNT_KINDS = [
  'organization',
  'project',
  'bot',
  'channel',
] as const satisfies readonly ChildAccountKind[];

/** `never` while `CHILD_ACCOUNT_KINDS` covers the child union. */
export type ChildAccountKindGap = Exclude<
  ChildAccountKind,
  (typeof CHILD_ACCOUNT_KINDS)[number]
>;

export const childAccountKindSchema = z.enum(CHILD_ACCOUNT_KINDS);

/**
 * Whether an operator may ACT AS an account of this kind — switch the whole app
 * into it (`POST /accounts/:id/switch`) or authorise an app to act as it
 * (an OAuth delegated subject).
 *
 * Two kinds are refused, for opposite reasons:
 *
 *  - `personal` is a human login, so assuming it would be impersonation.
 *  - `channel` is a CONTENT identity, not an operating one. A channel exists so
 *    that posts can be authored BY it; it is never a seat anybody occupies. Its
 *    operators act on it through their own membership, and an application
 *    publishes to it with its own credential. Refusing act-as is what makes
 *    "no login, ever" structural rather than incidental: no session can be
 *    minted whose subject is a channel, so no bearer exists that could add an
 *    auth method to one (every auth-method write resolves its target from the
 *    authenticated subject, never from a parameter).
 *
 * Consumers must gate on this predicate rather than testing `kind === 'personal'`,
 * which silently admits every kind added after it was written.
 */
export function isActAsEligibleKind(kind: AccountKind | null | undefined): boolean {
  return kind === 'organization' || kind === 'project' || kind === 'bot';
}

/**
 * Narrow an unknown value to an {@link AccountKind}.
 *
 * The user-DTO serializers read from structurally-permissive `unknown` sources
 * (a Drizzle row, a Mongo document, an already-formatted object), so each one
 * would otherwise hand-roll this check and they would drift on what counts.
 */
export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(value);
}

// ===========================================================================
// Account categories
//
// Four rules govern this taxonomy. Each one is here because the obvious
// alternative fails silently rather than loudly.
//
// 1. AN ID IS AN OPAQUE, IMMUTABLE SLUG — the LABEL is not stored anywhere.
//    Every value below is an identifier that no rename may ever change. The
//    human-readable label lives in each client's own translation catalogue,
//    keyed by the id. Re-labelling `agency` from "Real estate agency" to
//    "Agency" is therefore a one-line locale edit that touches no row; moving
//    the label into the column or the DTO would make the same edit a data
//    migration, and would pin every reader to the language of whoever chose it.
//
// 2. THE PRIMARY CATEGORY IS THE FIRST ELEMENT of an ordered list. Not a
//    separate flag, and not a second field: a flag admits two primaries and
//    admits none, and ordering makes both unrepresentable. The cost is that
//    ORDER IS DATA — anything that re-serializes, sorts or de-duplicates this
//    list can change which category is primary without erroring, so no layer
//    between the column and the client may reorder it.
//
// 3. THE VOCABULARY IS APPEND-ONLY. `ACCOUNT_CATEGORY_IDS` may gain ids and may
//    never lose one, because rows already carry the ids it holds. Withdrawing a
//    category means listing it in {@link RETIRED_ACCOUNT_CATEGORY_IDS}, which
//    removes it from the picker while leaving it readable and re-writable. The
//    database enforces the same asymmetry: its CHECK is re-evaluated on EVERY
//    update to a row, so narrowing the allowed set makes an unrelated write —
//    saving a bio — fail on any account that had picked the withdrawn value.
//    Measured on a real Postgres, `NOT VALID` included; it does not help.
//
// 4. THE SET IS CLOSED. An id nobody can validate is an id no client can render:
//    the label comes from a translation key derived from the id, so an invented
//    value paints as a blank or a raw slug in every app at once. Closing it also
//    costs nothing that rule 3 does not already charge — adding a category needs
//    a migration to widen the CHECK whether or not the enum exists, so an open
//    list would buy back no work, only the validation.
// ===========================================================================

/**
 * Every account category, by stable id.
 *
 * Grouped by comment for readability only; the storage, the wire and the picker
 * all treat this as one flat list. `other` is the escape hatch for an account
 * that fits nothing here.
 *
 * TO ADD ONE: append an id (lowercase ASCII, `snake_case`) here, publish
 * `@oxyhq/contracts`, then ship a migration that widens
 * `users_account_categories_check` — never edit an existing migration — and add
 * an `accounts.accountCategory.<id>` label to each client's locales.
 *
 * TO WITHDRAW ONE: leave the id here and add it to
 * {@link RETIRED_ACCOUNT_CATEGORY_IDS}. See rule 3 above.
 */
export const ACCOUNT_CATEGORY_IDS = [
  // ---- media & public information -----------------------------------------
  'news',
  'politics',

  // ---- business & economy --------------------------------------------------
  'business',
  'startup',
  'finance',
  'crypto',
  'marketplace',
  'retail',
  // The four ids the single-valued `organizationCategory` field used to hold,
  // carried forward VERBATIM. Their labels may be rewritten freely; their ids
  // may not, because live rows hold them.
  'real_estate',
  'agency',
  'landlord',
  'cooperative',
  'architecture',

  // ---- technology ----------------------------------------------------------
  'technology',
  'software',
  'ai',
  'security',
  'automation',

  // ---- knowledge -----------------------------------------------------------
  'science',
  'education',
  'books',

  // ---- health --------------------------------------------------------------
  'health',
  'fitness',

  // ---- sport & play --------------------------------------------------------
  'sports',
  'gaming',

  // ---- culture & entertainment ---------------------------------------------
  //
  // There is deliberately NO generic `entertainment` here, and re-adding one is
  // a regression rather than a gap. It is the only id this list ever carried
  // that was dominated by its own specifics — `film`, `music`, `gaming` and
  // `comedy` all exist — and a generic drawer sitting beside its four
  // concretions collects the lazy pick, which degrades the data for all four at
  // once: the accounts that would have said `film` say `entertainment` instead,
  // and `film` stops meaning what it meant.
  //
  // The other overlaps in this vocabulary are NOT the same case and must not be
  // merged on this reasoning: `sports`/`fitness`, `art`/`photography`,
  // `business`/`startup`, `finance`/`crypto`, `home_garden`/`diy` and
  // `technology`/`software`/`security` are genuinely different audiences, and
  // with a cap of four the granularity is cheap.
  'music',
  'film',
  'podcast',
  'art',
  'photography',
  'comedy',

  // ---- everyday life -------------------------------------------------------
  'food',
  'travel',
  'fashion',
  'home_garden',
  'diy',
  'automotive',
  'animals',
  'family',

  // ---- society -------------------------------------------------------------
  'nonprofit',
  'government',
  'community',
  'activism',
  'environment',
  'religion',

  // ---- fallback ------------------------------------------------------------
  'other',
] as const;

export type AccountCategoryId = (typeof ACCOUNT_CATEGORY_IDS)[number];

/**
 * Accepts EVERY id, withdrawn ones included — see rule 3.
 *
 * A schema that rejected a withdrawn id would 400 the whole request whenever a
 * client round-trips the categories it was served, so an account that had
 * picked one could no longer save its bio either. That is the same failure the
 * nullable `bio` / `avatar` fix addressed, wearing a different hat.
 */
export const accountCategoryIdSchema = z.enum(ACCOUNT_CATEGORY_IDS);

/**
 * Ids withdrawn from the picker. Empty today.
 *
 * A withdrawn id keeps working everywhere it is already stored: it validates,
 * it survives a round-trip save, it still renders from its label key, and it
 * stays PRIMARY if it was primary. Nothing rewrites a stored list — a read-time
 * or migration-time demotion would silently replace a choice its owner made,
 * which is precisely what stable ids exist to prevent. The owner drops it on
 * their next edit; until then it is honoured.
 *
 * What withdrawal changes is only this: the id leaves
 * {@link SELECTABLE_ACCOUNT_CATEGORY_IDS}, so no picker offers it, and
 * {@link newlyAddedRetiredCategories} refuses to let a write ADD it to an
 * account that did not already have it.
 */
export const RETIRED_ACCOUNT_CATEGORY_IDS: readonly AccountCategoryId[] = [];

/** Whether a category may still be OFFERED. A stored one is readable either way. */
export function isSelectableAccountCategoryId(id: AccountCategoryId): boolean {
  return !RETIRED_ACCOUNT_CATEGORY_IDS.includes(id);
}

/** The ids a picker may offer, in declaration order. */
export const SELECTABLE_ACCOUNT_CATEGORY_IDS: readonly AccountCategoryId[] =
  ACCOUNT_CATEGORY_IDS.filter(isSelectableAccountCategoryId);

/**
 * Which of `next` are withdrawn ids the account did not already carry — i.e.
 * the ones a write must be refused for.
 *
 * `retired` is a parameter rather than a module read so the rule can be
 * exercised against a non-empty set while the production one is empty; a test
 * over `RETIRED_ACCOUNT_CATEGORY_IDS` alone would pass vacuously today and stay
 * passing if the rule were deleted.
 */
export function newlyAddedRetiredCategories(
  next: readonly AccountCategoryId[],
  previous: readonly AccountCategoryId[],
  retired: readonly AccountCategoryId[]
): AccountCategoryId[] {
  return next.filter((id) => retired.includes(id) && !previous.includes(id));
}

/**
 * How many categories one account may carry.
 *
 * Four, not "as many as you like". Three reasons, in the order they bind:
 *
 *  - The primary has to MEAN something. At ten categories the first element
 *    reads as a sort artifact rather than a choice, and rule 2 above is the
 *    entire mechanism by which a primary exists.
 *  - The profile RENDERS them as a row of chips; four labels of this length is
 *    what fits a phone-width profile header before the row wraps or truncates.
 *  - Four is enough to place a genuinely compound account without a tag cloud:
 *    a housing cooperative that is also a non-profit serving a local community
 *    spends `cooperative`, `nonprofit`, `community`, `real_estate` — and is the
 *    most compound real example in the ecosystem.
 *
 * One constant, read by the wire schema, the database CHECK and the picker, so
 * changing it is one edit plus a migration.
 */
export const MAX_ACCOUNT_CATEGORIES = 4;

/**
 * An account's categories on the wire. ORDER IS MEANINGFUL — index 0 is the
 * primary (rule 2).
 *
 * A duplicate is REJECTED rather than silently collapsed. De-duplicating would
 * rewrite the caller's list, and any rewrite of this list can move which id sits
 * at index 0 — so the one repair available here is the one that would break the
 * property the list exists to carry. A duplicate only ever comes from a client
 * bug, and a 400 naming the index is how that bug gets found.
 */
export const accountCategoriesSchema = z
  .array(accountCategoryIdSchema)
  .max(MAX_ACCOUNT_CATEGORIES)
  .superRefine((ids, ctx) => {
    const seen = new Set<AccountCategoryId>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate account category "${id}"`,
          path: [index],
        });
      }
      seen.add(id);
    });
  });

/**
 * Kinds that may carry categories: every kind EXCEPT `personal`.
 *
 * A person has interests, not a sector — and their interests are not a
 * classification anybody else gets to read off their profile. Spelled out
 * positively, like {@link isActAsEligibleKind} and for the same reason: a `kind
 * !== 'personal'` test silently admits every kind invented after it was
 * written, whereas this list forces whoever adds one to decide.
 */
export const ACCOUNT_CATEGORY_KINDS = [
  'organization',
  'project',
  'bot',
  'channel',
] as const satisfies readonly AccountKind[];

export type AccountCategoryKind = (typeof ACCOUNT_CATEGORY_KINDS)[number];

/**
 * Whether an account of this kind may carry categories.
 *
 * The API refuses the write and the `users_account_categories_kind_check`
 * constraint makes it unrepresentable; both derive from
 * {@link ACCOUNT_CATEGORY_KINDS}, so they cannot disagree.
 */
export function kindAcceptsAccountCategories(
  kind: AccountKind | null | undefined
): boolean {
  return (ACCOUNT_CATEGORY_KINDS as readonly string[]).includes(kind ?? '');
}

/**
 * An account's name on the create/update wire.
 *
 * `displayName` is EXPLICIT and stored, not derived. `first`/`last` model a
 * human name, and composing a display string from them is right for a person —
 * but a non-personal account has a TITLE, not a given and family name. Without
 * this field the only way to name a channel "Notas de Nate" was to put the whole
 * title in `first`, which renders correctly by accident while recording it as
 * somebody's given name.
 *
 * When present it wins over the composed `first`/`last` (see the API's
 * `composeDisplayName`, which already preferred an explicit value — only the
 * storage for one was missing).
 */
const accountNameSchema = z
  .object({
    first: z.string().trim().max(100).optional(),
    last: z.string().trim().max(100).optional(),
    displayName: z.string().trim().max(100).optional(),
  })
  .optional();

/**
 * POST /accounts — create a non-personal account under the caller's tree.
 *
 * No cross-field refinement guards `accountCategories`, and that is not an
 * omission: `kind` here is a CHILD kind, and every child kind is in
 * {@link ACCOUNT_CATEGORY_KINDS}, so `personal` is already unrepresentable on
 * this route. The refinement the single-valued predecessor needed disappeared
 * along with the restriction that made it necessary. A child kind that does NOT
 * accept categories would break that reasoning silently, so
 * `__tests__/accountGraph.test.ts` asserts the two lists agree.
 */
export const createAccountRequestSchema = z.object({
  parentAccountId: z.string().trim().min(1).optional(),
  kind: childAccountKindSchema,
  username: z.string().trim().min(1).max(100),
  name: accountNameSchema,
  bio: z.string().trim().max(500).optional(),
  avatar: z.string().optional(),
  description: z.string().trim().max(1000).optional(),
  /**
   * A named color preset KEY (`"blue"`, `"mint"`, …), never a hex value.
   *
   * Here at CREATION for the reason `isPrivateAccount` is, in miniature: for a
   * managed account the color is a visual identity, and an account that is
   * discoverable without one and acquires it on a second request is a face that
   * changes by itself. One statement, one row, born looking like what its owner
   * chose.
   *
   * The VALUE is checked in the API rather than here. The vocabulary is
   * `USER_COLOR_PRESETS`, which is declared next to the `users_color_check` CHECK
   * that is rendered from it — pinning the list a second time in this package
   * would be a second source of truth for what the database accepts, and the two
   * would drift apart silently. What this shape does is keep an over-long or
   * non-string value from reaching the service at all.
   */
  color: z.string().trim().max(32).optional(),
  /** Ordered, PRIMARY FIRST — see rule 2 above {@link ACCOUNT_CATEGORY_IDS}. */
  accountCategories: accountCategoriesSchema.optional(),
  /**
   * Create the account already opted OUT of discovery.
   *
   * ## Why this belongs at CREATION and not only on the privacy route
   *
   * Every account is born discoverable: the column defaults to `false` and
   * nothing on the create path wrote it, so a new account appears in people
   * search the instant it exists. For a human signing themselves up that is the
   * right default and it is NOT changed here. For an account a program creates
   * on someone's behalf — an agent, an unlaunched project, an organization for
   * something not yet announced — it publishes the thing before its owner ever
   * decided to.
   *
   * The alternative is a second call right after create, which is a window in
   * which the account IS public, and a window whose closing depends on a second
   * request succeeding. A field here has neither: one statement, one row, born
   * in the state the caller asked for.
   *
   * ## It reuses the existing flag deliberately
   *
   * This is `privacy_is_private_account`, the same one `PUT /users/:id/privacy`
   * toggles — not a new "published" column. A second visibility flag would be a
   * second source of truth for one question, and the two would disagree.
   *
   * Inherited semantics, stated because reusing a flag means inheriting ALL of
   * it: the account is kept out of people search, out of the follow-graph lists
   * (`followers` / `following` / `mutuals`), out of `/similar` and out of the
   * recommendation candidate pools, and its non-public, non-unlisted media
   * becomes follower-gated. It does NOT hide the profile from someone who knows
   * the handle, and it carries NO follow-approval flow — following is immediate
   * and unilateral whatever this says, so nothing here creates a request queue
   * nobody attends.
   *
   * ## Not conditioned on `kind`, on purpose
   *
   * The same reasoning as `accountCategories` above: this object does not
   * refine on kind, and an unlaunched organization has exactly the problem an
   * unpublished agent does. The discovery predicate never reads `kind`, so the
   * remedy must not either.
   */
  isPrivateAccount: z.boolean().optional(),
});

export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

/**
 * Account graph wire contracts — the account-kind vocabulary, the account
 * category taxonomy, and the create-account input.
 *
 * `accountCategories` classifies a NON-PERSONAL account — what it is about, what
 * it does — without polluting `User.kind`. See the block above
 * {@link ACCOUNT_CATEGORY_IDS} for the four rules that govern it.
 */

import { z } from 'zod';
import { avatarCharacterSchema } from './avatarCharacter';
import { accountTitleSchema } from './accountName';
import { ACCOUNT_TITLE_MAX_LENGTH } from './client/accountName';
import { ORGANIZATION_TYPES } from './organizations';
import { usernameSchema, usernameSchemaForAccountKind } from './username';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import {
  ACCOUNT_KINDS,
  CHILD_ACCOUNT_KINDS,
  ACCOUNT_CATEGORY_IDS,
  MAX_ACCOUNT_CATEGORIES,
  ACCOUNT_CATEGORY_KINDS,
  type AccountCategoryId,
} from './client/accountGraph';
export {
  ACCOUNT_KINDS,
  CHILD_ACCOUNT_KINDS,
  isDelegatedActAsEligibleKind,
  isOperatorSwitchTargetKind,
  isMemberOperatedKind,
  isAccountKind,
  ACCOUNT_CATEGORY_IDS,
  RETIRED_ACCOUNT_CATEGORY_IDS,
  isSelectableAccountCategoryId,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  newlyAddedRetiredCategories,
  MAX_ACCOUNT_CATEGORIES,
  ACCOUNT_CATEGORY_KINDS,
  kindAcceptsAccountCategories,
} from './client/accountGraph';
export type {
  AccountKind,
  AccountKindGap,
  ChildAccountKind,
  ChildAccountKindGap,
  AccountCategoryId,
  AccountCategoryKind,
} from './client/accountGraph';

export const accountKindSchema = z.enum(ACCOUNT_KINDS);

export const childAccountKindSchema = z.enum(CHILD_ACCOUNT_KINDS);

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
export const accountNameSchema = z
  .object({
    first: z.string().trim().max(100).optional(),
    last: z.string().trim().max(100).optional(),
    displayName: z.string().trim().max(ACCOUNT_TITLE_MAX_LENGTH).optional(),
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
 * `__tests__/accountGraph.test.ts` asserts every child kind is a category kind.
 */
export const createAccountRequestSchema = z
  .object({
    parentAccountId: z.string().trim().min(1).optional(),
    kind: childAccountKindSchema,
    /**
     * The SAME policy a person's handle is held to. `users.username` is one unique
     * index, so a managed account may not reserve a name a person could not ask
     * for — and this route's predecessor (`.min(1).max(100)` here, `^[\w.-]+$`
     * with no ceiling in the service) is how a one-character or dotted or
     * 100-character handle became reachable for bots alone.
     *
     * A `bot` is held to that AND to the label its handle must end in. That half
     * cannot live on this field — it depends on `kind`, a sibling — so it is in the
     * `superRefine` below, which reports its issue against this path.
     */
    username: usernameSchema,
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
    organizationType: z.enum(ORGANIZATION_TYPES).optional(),
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
    /**
     * The 3D avatar character of a `bot` — and ONLY of a bot (the refinement
     * below). Optional on the wire: a bot created without one is given a look
     * seeded from its handle (`avatarCharacterFor`), so every bot account has a
     * character from birth and the owner customizes it afterwards.
     */
    character: avatarCharacterSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.character !== undefined && request.kind !== 'bot') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['character'],
        message: 'Only a bot account carries an avatar character',
      });
    }

    const displayName = request.name?.displayName;
    if (displayName) {
      // A child kind is never `personal`, so every child is named by the
      // title policy; the person policy's character classes live in
      // `@oxy.so/core`, which this package cannot import.
      const parsedName = accountTitleSchema.safeParse(displayName);
      if (!parsedName.success) {
        for (const issue of parsedName.error.issues) {
          ctx.addIssue({ ...issue, path: ['name', 'displayName', ...issue.path] });
        }
      }
    }
    if (request.organizationType !== undefined && request.kind !== 'organization')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['organizationType'],
        message: 'Organization type requires an organization account',
      });
    // The ONE place `kind` and `username` arrive in the same object, so it is the
    // only place a wire schema CAN apply the per-kind half of the policy: a bot's
    // handle must end in `bot`. Not a second rule — it asks
    // `usernameSchemaForAccountKind`, the same declaration the service asks.
    //
    // It is here rather than only in the API because this schema is exported for
    // CLIENTS: an agent-creation flow that validates its request and is then 400ed
    // by the server is the "propose, then refuse" defect the minimum length
    // already caused once. The service check stays regardless — it also governs
    // renames and the service-provisioned channel route, where the kind comes from
    // the stored row and never from this object.
    const parsed = usernameSchemaForAccountKind(request.kind).safeParse(request.username);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['username'],
        message: parsed.error.issues[0].message,
      });
    }
  });

export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

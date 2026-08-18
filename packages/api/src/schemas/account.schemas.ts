import { z } from 'zod';
import { accountCategoriesSchema, createAccountRequestSchema } from '@oxyhq/contracts';
import { ACCOUNT_PERMISSIONS, ACCOUNT_ROLES } from '../utils/accountRoles';

/** Route params with :id (the account id). */
export const accountIdRouteParams = z.object({
  id: z.string().trim().min(1),
});

/** Route params with :id and :memberId. */
export const accountMemberParams = z.object({
  id: z.string().trim().min(1),
  memberId: z.string().trim().min(1),
});

/** GET /accounts — optional `?tree=true` to request a nested forest. */
export const listAccountsQuerySchema = z.object({
  tree: z.enum(['true', 'false']).optional(),
});

/**
 * Mirrors the create path's name shape (`accountNameSchema` in
 * `@oxyhq/contracts`), `displayName` included — an account that can be NAMED at
 * creation but only RE-named through `first`/`last` would force a title back
 * into a given-name field on every edit.
 */
const nameSchema = z
  .object({
    first: z.string().trim().max(100).optional(),
    last: z.string().trim().max(100).optional(),
    displayName: z.string().trim().max(100).optional(),
  })
  .optional();

/**
 * POST /accounts — create an account.
 *
 * `parentAccountId` is OPTIONAL: when omitted the new account is created under
 * the caller's own (personal) account — i.e. a top-level org/project/bot the
 * caller owns. `kind` must be a non-personal kind (personal accounts are roots
 * minted at signup, not here).
 */
export const createAccountSchema = createAccountRequestSchema;

/** PATCH /accounts/:id — partial profile update. */
export const updateAccountSchema = z
  .object({
    username: z.string().trim().min(1).max(100).optional(),
    name: nameSchema,
    // `null` CLEARS, and it has to be accepted here because the SDK's
    // `UpdateAccountInput` types both as `string | null` and documents exactly
    // that. Without `.nullable()` the schema rejects the WHOLE request, so an
    // account with no bio and no picture could not save its NAME either — the
    // one field the caller did set went down with the two they left empty.
    bio: z.string().trim().max(500).nullable().optional(),
    avatar: z.string().nullable().optional(),
    description: z.string().trim().max(1000).optional(),
    color: z.string().trim().max(32).optional(),
    links: z.array(z.string()).optional(),
    /**
     * The WHOLE list, replaced — there is no add/remove verb, because the order
     * is the primary marker and a partial edit cannot express a re-ordering.
     * Ordered, primary first.
     *
     * `[]` clears. `null` is NOT accepted and does not need to be: unlike `bio`
     * and `avatar`, the empty case here has a representation of its own, so
     * offering two spellings of "none" would only create a way for them to
     * disagree.
     *
     * The vocabulary this accepts includes WITHDRAWN ids on purpose (see
     * `RETIRED_ACCOUNT_CATEGORY_IDS`). Rejecting them here would 400 a client
     * that round-trips what it was served, taking every other field in the same
     * request down with it — the failure the nullable `bio` fix above describes.
     * Whether a withdrawn id may be newly ADDED is a question about the account's
     * previous value, so the service answers it, not this schema.
     */
    accountCategories: accountCategoriesSchema.optional(),
  })
  .strict();

/** POST /accounts/:id/move — re-parent the account. */
export const moveAccountSchema = z.object({
  newParentId: z.string().trim().min(1),
});

/** Roles assignable to a member (owner is reachable only via transfer-ownership). */
const assignableRoles = ACCOUNT_ROLES.filter((role) => role !== 'owner') as Exclude<
  (typeof ACCOUNT_ROLES)[number],
  'owner'
>[];

/**
 * POST /accounts/:id/members — invite/add a member by username or email.
 * `inherit` controls whether the membership cascades to descendant accounts.
 */
export const inviteAccountMemberSchema = z.object({
  usernameOrEmail: z.string().trim().min(1),
  role: z.enum(assignableRoles as [typeof assignableRoles[number], ...typeof assignableRoles]),
  inherit: z.boolean().optional(),
});

/**
 * A per-member permission delta list.
 *
 * The vocabulary is enforced HERE, at the write boundary, and nowhere else — no
 * SQL `CHECK` lists it (see `db/schema/accountMembers.ts` for the measurement
 * that rules that out), and the read path filters rather than validates. So a
 * string outside `ACCOUNT_PERMISSIONS` is a 400 naming the offending value,
 * while a string that WAS valid when it was stored and has since been retired
 * simply stops counting.
 *
 * Capped at the size of the vocabulary itself: a longer list can only be
 * duplicates or padding, and an unbounded array on a write endpoint is a free
 * row-size amplifier.
 */
const permissionListSchema = z
  .array(z.enum(ACCOUNT_PERMISSIONS))
  .max(ACCOUNT_PERMISSIONS.length);

/**
 * PATCH /accounts/:id/members/:memberId — change a member's role, inheritance
 * and/or per-member permission deltas.
 *
 * Every field is optional and the body must name at least one: permissions are
 * editable WITHOUT restating the role, which is the whole point of the endpoint,
 * and a caller forced to re-send `role` to adjust a permission would be
 * re-asserting a value it may have read before someone else changed it.
 *
 * An empty array is a meaningful value — it CLEARS that delta list — so the
 * "at least one field" check counts keys present in the parsed object rather
 * than truthy ones.
 */
export const updateAccountMemberSchema = z
  .object({
    role: z
      .enum(assignableRoles as [typeof assignableRoles[number], ...typeof assignableRoles])
      .optional(),
    inherit: z.boolean().optional(),
    permissionGrants: permissionListSchema.optional(),
    permissionRevokes: permissionListSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message:
      'Provide at least one of: role, inherit, permissionGrants, permissionRevokes',
  });

/** POST /accounts/:id/transfer-ownership. */
export const transferAccountOwnershipSchema = z.object({
  userId: z.string().trim().min(1),
});

// ===========================================================================
// Service-scoped channel provisioning (`accounts:provision`)
//
// These are the SERVICE half of the account surface: an application acting for
// a user it names, rather than a user acting for themselves. `kind` is absent
// from the create body on purpose — the route hardcodes `channel` (see
// `routes/accounts.ts`), so the credential cannot mint an account of a kind
// anyone could later act as.
// ===========================================================================

/** POST /accounts/service/channels — mint a channel under `ownerUserId`. */
export const provisionChannelSchema = z
  .object({
    /**
     * The human whose tree the channel is created under, and who is recorded as
     * its `owner` member. Named by the service; there is no ambient caller
     * identity on a service token.
     */
    ownerUserId: z.string().trim().min(1),
    username: z.string().trim().min(1).max(100),
    name: z
      .object({
        first: z.string().trim().max(100).optional(),
        last: z.string().trim().max(100).optional(),
        displayName: z.string().trim().max(100).optional(),
      })
      .optional(),
    bio: z.string().trim().max(500).optional(),
    description: z.string().trim().max(1000).optional(),
    avatar: z.string().optional(),
  })
  .strict();

/** Route params for the service member endpoints. */
export const provisionChannelMemberParams = z.object({
  id: z.string().trim().min(1),
  memberUserId: z.string().trim().min(1),
});

/** POST /accounts/service/channels/:id/members — grant membership on a channel. */
export const provisionChannelMemberSchema = z
  .object({
    memberUserId: z.string().trim().min(1),
    role: z.enum(assignableRoles as [typeof assignableRoles[number], ...typeof assignableRoles]),
    inherit: z.boolean().optional(),
  })
  .strict();

/**
 * `GET /accounts/:id/audit` — the account-scoped audit union's query.
 *
 * PARSES ITS OWN OUTPUT, which is a requirement rather than a nicety here:
 * `middleware/validate.ts` writes the parsed query back onto `req.query` and the
 * handler parses it again, so a schema that cannot read what it produced raises
 * `invalid_type` in the handler — outside any validation boundary, i.e. a 500 on
 * a read. `z.coerce.number()` is idempotent on a number and `cursor` is carried
 * through unchanged, so this shape survives the second pass;
 * `__tests__/account.schemas.test.ts` asserts it rather than assuming it.
 *
 * The cursor is opaque and deliberately unvalidated beyond being a string: the
 * service refuses one it did not issue and reads from the start, which is what
 * passing nothing does. Rejecting a malformed cursor here would turn a stale
 * bookmark into an error page.
 */
export const accountAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * `GET /accounts/:id/billing/audit` — the customer-facing ledger trail's query.
 *
 * Same shape and the same self-parsing requirement as
 * {@link accountAuditQuerySchema}, and deliberately a SEPARATE schema rather
 * than a reuse of it: the two endpoints read different tables with different row
 * volumes, and sharing one object would make a page-size change on either of
 * them a silent change to the other.
 *
 * The bounds restate `BILLING_AUDIT_MAX_LIMIT` and `BILLING_AUDIT_DEFAULT_LIMIT`
 * from `services/accountBillingAudit.service.ts` — importing a service into a
 * schema module would invert this package's layering, so
 * `__tests__/account.schemas.test.ts` asserts the two agree instead. Without
 * that assertion the schema could admit a limit the service silently clamps,
 * which is a page size that is not the one the caller asked for and says so
 * nowhere.
 */
export const accountBillingAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

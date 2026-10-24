import { utf16MinLength } from './stringChecks';
/**
 * Wire contract for `GET /internal/accounts/:accountId/access/:userId`: Oxy
 * answers a trusted first-party service's question "may this person act FOR
 * that account, and with what?" with no session of that person in the request.
 *
 * It exists for the account Oxy never lets anybody act AS: a `channel`
 * ({@link isDelegatedActAsEligibleKind} refuses it). An app publishes to a
 * channel with ITS OWN credential, on behalf of a member Oxy vouches for here,
 * so nobody holds a bearer that speaks as the channel. A long-running import
 * (Oxy Move) has only a service token and `X-Oxy-User-Id`, which the
 * user-facing `GET /accounts/:id/members` refuses; this is its answer.
 *
 * Needs a service token whose application is platform-trusted AND holds the
 * privileged {@link ACCOUNTS_MEMBERSHIP_READ_SCOPE}. The answer is always 200:
 * `access` is `null` for no active membership, an archived account, an unknown
 * account and an unclaimed directory account alike. Callers must treat every
 * other status as a refusal (fail closed), and must not cache the answer longer
 * than the action it authorizes.
 *
 * Platform-agnostic — zod only.
 */

import { z } from '@oxy.so/zod4';
import { accountKindSchema } from './accountGraph';

/**
 * The scope the endpoint requires.
 *
 * Privileged (staff-granted). Channel membership is sensitive because a channel
 * is anonymous: its members are the people behind a voice that is published
 * without their names, and "is this person a member of that channel" is
 * exactly the fact the channel exists to withhold.
 */
export const ACCOUNTS_MEMBERSHIP_READ_SCOPE = 'accounts:membership:read' as const;

/**
 * Where the access comes from.
 *
 * - `self` — the person IS the account (a personal account asked about itself).
 * - `direct` — an active membership row on the account.
 * - `inherited` — an active, cascading membership on an ancestor account.
 */
export const ACCOUNT_ACCESS_SOURCES = ['self', 'direct', 'inherited'] as const;

export type AccountAccessSource = (typeof ACCOUNT_ACCESS_SOURCES)[number];

export const accountAccessSourceSchema = z.enum(ACCOUNT_ACCESS_SOURCES);

/**
 * One person's EFFECTIVE access over one account.
 *
 * `role` and `permissions` are strings rather than closed enums on purpose: the
 * role and permission vocabularies are the API's, they grow, and a consumer
 * pinned to an older contracts release must keep reading new ones. Gate on
 * `permissions` (the role's baseline adjusted by per-member grants and
 * revokes), never on `role`.
 */
export const accountAccessGrantSchema = z.object({
  role: z.string().check(utf16MinLength(1)),
  permissions: z.array(z.string().check(utf16MinLength(1))),
  /** Only an active membership grants access, so this is the one value. */
  status: z.literal('active'),
  source: accountAccessSourceSchema,
});

export type AccountAccessGrant = z.infer<typeof accountAccessGrantSchema>;

export const accountAccessVerdictSchema = z
  .object({
    accountId: z.string().check(utf16MinLength(1)),
    /** `null` when no such account exists. */
    kind: accountKindSchema.nullable(),
    /** `null` means: this person may not act for this account. */
    access: accountAccessGrantSchema.nullable(),
  })
  .refine((verdict) => verdict.access === null || verdict.kind !== null, {
    message: 'An account that does not exist grants no access',
    path: ['access'],
  });

export type AccountAccessVerdict = z.infer<typeof accountAccessVerdictSchema>;

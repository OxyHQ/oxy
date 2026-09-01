import { z } from 'zod';
import { isAccountIdFormat } from '../utils/validation';

/**
 * Schemas for the federation sign-on-behalf routes (`/federation/...`).
 *
 * SECURITY: these endpoints let a service credential (e.g. Mention) obtain the
 * public half of, and HTTP-Signature signatures from, a domain-scoped key whose
 * PRIVATE half never leaves Oxy. The schemas here enforce the structural
 * contract; the route enforces the trust boundary (keyId host must belong to
 * the credential's Application — see `routes/federation.ts`).
 */

/**
 * Max length of an HTTP-Signature signing string. A signing string is a handful
 * of header lines (request-target, host, date, digest, content-type); a few KB
 * is comfortably above any legitimate value and well below anything that could
 * be abused to turn the endpoint into a bulk signing oracle.
 */
export const MAX_SIGNING_STRING_LENGTH = 4096;

/** A federation `#main-key` keyId — must be an absolute https URL. */
const keyIdSchema = z
  .string()
  .trim()
  .url('keyId must be a valid URL')
  .max(2048, 'keyId is too long')
  .refine((value) => value.startsWith('https://'), {
    message: 'keyId must be an https URL',
  })
  .refine((value) => value.endsWith('#main-key'), {
    message: 'keyId must end with #main-key',
  });

// GET /federation/public-key/:username
export const publicKeyParamsSchema = z.object({
  username: z.string().trim().min(1, 'username is required').max(256),
});

// GET /federation/public-key/:username?domain=<domain>
export const publicKeyQuerySchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'domain is required')
    .max(253, 'domain is too long')
    // RFC-1123-ish hostname: labels of [a-z0-9-] separated by dots, at least
    // one dot. Rejects schemes, ports, paths, and userinfo.
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
      'domain must be a bare hostname',
    ),
});

// POST /federation/sign
export const signRequestSchema = z.object({
  keyId: keyIdSchema,
  signingString: z
    .string()
    .min(1, 'signingString is required')
    .max(MAX_SIGNING_STRING_LENGTH, `signingString must not exceed ${MAX_SIGNING_STRING_LENGTH} characters`)
    // Not a generic signing oracle: the first signed header MUST be the HTTP
    // request-target pseudo-header, i.e. this is signing an outbound AP request.
    .refine((value) => value.startsWith('(request-target):'), {
      message: 'signingString must begin with "(request-target):"',
    }),
});

/**
 * An Oxy account id, in EITHER of the two shapes that are live.
 *
 * This used to be `/^[a-f0-9]{24}$/i` — a MongoDB ObjectId, and nothing else.
 * Per `db/MIGRATION-CONTRACT.md` the pre-cutover ids are preserved verbatim but
 * every account created SINCE is given a **uuid v7** (`@oxyhq/db`'s
 * `generatedId()`), so that regex rejected the id of every new account. It ran
 * inside `validate({ body })`, i.e. BEFORE the handler, so `POST /federation/follow`,
 * `/actor-gone` and `/actor-delete` all answered 400 for a post-cutover account
 * without ever looking one up: a remote Follow could not be mirrored, and a dead
 * federated actor could not be archived or deleted.
 *
 * The validation is KEPT rather than deleted — unlike the `ObjectId.isValid`
 * guards the contract retires, a 400 here is the documented answer to a
 * malformed body on a service-to-service bridge, and `validate` is where this
 * route family reports one. What changes is only which strings are malformed:
 * {@link isAccountIdFormat} accepts both live shapes and is the single place
 * that knows what they are.
 */
const accountIdSchema = z
  .string()
  .trim()
  .refine(isAccountIdFormat, 'must be an Oxy account id');

/**
 * A ROW id used as a pagination cursor — not an account id, though it validates
 * the same way.
 *
 * `main` wrote this as `objectIdSchema`, which the port retired: after the
 * cutover a row's id is a uuid v7, so a 24-hex refinement would reject every
 * cursor the endpoint itself had just issued. `isAccountIdFormat` is the single
 * place that knows both live shapes; the separate name is so a reader does not
 * conclude this field carries an account.
 */
const entityIdSchema = z
  .string()
  .trim()
  .refine(isAccountIdFormat, 'must be a live entity id');

/**
 * POST /federation/follow
 *
 * Moves a single Oxy follow-graph edge on behalf of a FEDERATED actor: a remote
 * actor that Follows/Unfollows a local user over ActivityPub. `followerUserId`
 * is the (federated) remote actor's Oxy user id and `targetUserId` is the local
 * user being followed; the route enforces those type constraints.
 */
export const federationFollowSchema = z.object({
  followerUserId: accountIdSchema,
  targetUserId: accountIdSchema,
  action: z.enum(['follow', 'unfollow']),
});

/**
 * POST /federation/actor-gone
 *
 * Marks a dead remote fediverse identity gone. Mention is the only component
 * that talks to the remote fediverse; when it gets an HTTP 410 Gone for an
 * actor it calls this to archive the corresponding Oxy user so the identity
 * leaves discovery/search surfaces. `oxyUserId` is the (federated) actor's Oxy
 * user id; the route enforces that it resolves to a `type:'federated'` user
 * before archiving (a local/agent/automated account is never archivable here).
 */
export const federationActorGoneSchema = z.object({
  oxyUserId: accountIdSchema,
});

/**
 * POST /federation/actor-delete
 *
 * HARD-DELETES a dead remote fediverse identity and purges its Oxy follow-graph
 * edges. Mention calls this after a federated actor has been permanently removed
 * upstream (HTTP 410 Gone for a spam/deleted account) to erase the ghost
 * identity and its social-graph residue from Oxy entirely — the irreversible
 * counterpart to `actor-gone` (which only archives). `oxyUserId` is the
 * (federated) actor's Oxy user id; the route enforces that it resolves to a
 * `type:'federated'` user before any destructive write, and the delete filter
 * re-asserts `type:'federated'` atomically so a real account can never be hit.
 */
export const federationActorDeleteSchema = z.object({
  oxyUserId: accountIdSchema,
});

/**
 * POST /federation/domain-purge
 *
 * Removes what Oxy holds for a fediverse instance an app has blocked. The app
 * owns the blocklist; Oxy is handed ONE domain at a time and never stores which
 * domains are blocked (see `services/federation/blockedDomainPurge.service.ts`).
 *
 * `dryRun` DEFAULTS TO TRUE: the safe value is the one you get by omission, so
 * a caller that forgets the field plans instead of deleting. Deleting requires
 * sending `dryRun: false` explicitly AND an armed deployment.
 *
 * `domain` is a bare host — no scheme, no port, no path — because that is what
 * the federation engine's canonicaliser consumes. A value containing any of
 * those is rejected here rather than being silently canonicalised into
 * something that matches the wrong rows.
 */
export const federationDomainPurgeSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1, 'domain is required')
    .max(253, 'domain exceeds the maximum DNS name length')
    .refine((value) => !/[/:@\s]/.test(value), {
      message: 'domain must be a bare host (no scheme, port, path or whitespace)',
    }),
  dryRun: z.boolean().default(true),
  limit: z.number().int().min(1).max(1000).optional(),
  /**
   * Continuation cursor from the previous response's `nextCursor`. Progress is
   * driven by this rather than by rows disappearing, because a dry run and a
   * retained row both leave every row in place — a caller looping on "anything
   * left?" would never terminate.
   */
  afterId: entityIdSchema.optional(),
});

export type PublicKeyParams = z.infer<typeof publicKeyParamsSchema>;
export type PublicKeyQuery = z.infer<typeof publicKeyQuerySchema>;
export type SignRequestBody = z.infer<typeof signRequestSchema>;
export type FederationFollowBody = z.infer<typeof federationFollowSchema>;
export type FederationActorGoneBody = z.infer<typeof federationActorGoneSchema>;
export type FederationActorDeleteBody = z.infer<typeof federationActorDeleteSchema>;
export type FederationDomainPurgeBody = z.infer<typeof federationDomainPurgeSchema>;

import { z } from 'zod';
import { APPLICATION_SCOPES } from '../utils/applicationScopes';
import {
  APPLICATION_CREDENTIAL_TYPES,
  APPLICATION_CREDENTIAL_ENVIRONMENTS,
} from '../db/schema/applicationCredentials';

/** Route params with :appId. */
export const appIdRouteParams = z.object({
  appId: z.string().trim().min(1),
});

/** Route params with :appId and :credId. */
export const appCredentialParams = z.object({
  appId: z.string().trim().min(1),
  credId: z.string().trim().min(1),
});

/** Usage window query. */
export const periodQuerySchema = z.object({
  period: z.enum(['24h', '7d', '30d', '90d']).optional(),
});

const websiteUrlSchema = z.string().url().optional().or(z.literal(''));
/**
 * Public legal URL (privacy policy / terms of service) shown on the OAuth
 * consent screen. Must be an absolute `https://` URL. An empty string clears the
 * stored value, mirroring `websiteUrlSchema`.
 */
const legalUrlSchema = z
  .string()
  .url()
  .startsWith('https://', 'URL must use https')
  .optional()
  .or(z.literal(''));
const redirectUrisSchema = z.array(z.string().url()).optional();
const appScopesSchema = z.array(z.enum(APPLICATION_SCOPES)).optional();

/** POST /applications — create. Staff-only fields are intentionally absent. */
export const createApplicationSchema = z.object({
  /**
   * The Account that will own the new application. OPTIONAL: when omitted the
   * route defaults to the caller's OWN account (a top-level app they own). When
   * provided the caller must hold `apps:create` over that account.
   */
  ownerAccountId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  websiteUrl: websiteUrlSchema,
  privacyPolicyUrl: legalUrlSchema,
  termsUrl: legalUrlSchema,
  icon: z.string().optional(),
  redirectUris: redirectUrisSchema,
  scopes: appScopesSchema,
});

/** Optional `?ownerAccountId=` filter on GET /applications. */
export const listApplicationsQuerySchema = z.object({
  ownerAccountId: z.string().trim().min(1).optional(),
});

/**
 * PATCH /applications/:appId — partial update.
 *
 * Staff-only fields (`type`, `isOfficial`, `isInternal`, `capabilities`) are
 * accepted in the schema but only applied when the caller is platform staff;
 * the route silently drops them for non-staff callers.
 */
export const updateApplicationSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    websiteUrl: websiteUrlSchema,
    privacyPolicyUrl: legalUrlSchema,
    termsUrl: legalUrlSchema,
    icon: z.string().optional(),
    redirectUris: redirectUrisSchema,
    scopes: appScopesSchema,
    webhookUrl: z.string().url().optional().or(z.literal('')),
    devWebhookUrl: z.string().url().optional().or(z.literal('')).nullable(),
    status: z.enum(['active', 'suspended', 'pending_review']).optional(),
    type: z.enum(['first_party', 'third_party', 'internal', 'system']).optional(),
    isOfficial: z.boolean().optional(),
    isInternal: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Bounds on a `machine` credential's configured lifetime, in seconds.
 *
 * The floor keeps a key usable long enough to be worth minting; the ceiling —
 * two years — exists because "never expires" is already available by omitting
 * the field, so an explicit lifetime longer than the audit retention behind it
 * would be a number nobody could later check against its own trail.
 */
const MIN_CREDENTIAL_LIFETIME_SECONDS = 60;
const MAX_CREDENTIAL_LIFETIME_SECONDS = 730 * 24 * 60 * 60;

/**
 * Bounds on an explicitly requested rotation grace window, in seconds.
 *
 * The floor is ONE second rather than something operationally sensible, so the
 * end of a window is observable in a test without mutating a row underneath the
 * code under test. The ceiling is thirty days: a grace is a rollout window, and
 * one longer than a month is a second live credential wearing a deadline.
 */
const MIN_ROTATION_GRACE_SECONDS = 1;
const MAX_ROTATION_GRACE_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /applications/:appId/credentials — create a credential.
 *
 * `scopes` is constrained to the SAME enum as application scopes (no free-form
 * strings). The route additionally intersects the requested scopes with the
 * owning application's granted scopes, so a credential can never exceed its
 * app's authority.
 *
 * `expiresInSeconds` is `machine`-only — on every other type `expires_at` means
 * the rotation grace deadline, and letting a caller set it at creation would
 * make a brand-new credential look like a rotated one. The route rejects it for
 * those types rather than ignoring it.
 */
export const createCredentialSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(APPLICATION_CREDENTIAL_TYPES),
  environment: z.enum(APPLICATION_CREDENTIAL_ENVIRONMENTS),
  scopes: z.array(z.enum(APPLICATION_SCOPES)).optional(),
  expiresInSeconds: z
    .number()
    .int()
    .min(MIN_CREDENTIAL_LIFETIME_SECONDS)
    .max(MAX_CREDENTIAL_LIFETIME_SECONDS)
    .optional(),
});

/**
 * POST /applications/:appId/credentials/:credId/rotate — rotate a credential.
 *
 * `graceSeconds` is `machine`-only and OPT-IN. Omitting it revokes the previous
 * token the instant the replacement is minted; naming it keeps the old token
 * working for exactly that long. The OAuth/service types keep their fixed
 * seven-day grace and reject this field, so their contract is unchanged.
 */
export const rotateCredentialSchema = z
  .object({
    graceSeconds: z
      .number()
      .int()
      .min(MIN_ROTATION_GRACE_SECONDS)
      .max(MAX_ROTATION_GRACE_SECONDS)
      .optional(),
  })
  .strict();

/**
 * GET /applications/:appId/credentials/:credId/audit — the credential's trail.
 *
 * Paging is a capped `limit` and nothing else, the same shape
 * `providerConnectionAuditQuery` uses on the BYOK trail: the ceiling is what
 * stops one request pulling a whole application's history, and the two audit
 * surfaces answering the same question the same way is worth more than a cursor
 * neither caller has asked for. `z.coerce` because a query string carries the
 * value as text.
 */
export const credentialAuditQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

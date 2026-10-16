/**
 * Application roles — the wire contract for permissions an APPLICATION declares
 * about its own users, and for the grants that give them to Oxy users.
 *
 * Oxy decides who holds an app's operator powers (who may run Mercaria's
 * payments desk, moderate GoWay, administer Homiio), so no app keeps an
 * allow-list of Oxy user ids in its environment. The app declares a closed
 * vocabulary of keys, its owners grant them to people, and the app's backend
 * asks Oxy which of them the human behind a request holds
 * (`GET /applications/:appId/roles/me`, read through `@oxy.so/core/server`).
 *
 * ## Why an application key can never collide with an Oxy permission
 *
 * Every permission Oxy itself checks (`app:update`, `apps:create`,
 * `credentials:rotate`, every scope) is spelled with a COLON. An application key
 * is dot-separated lowercase segments and cannot contain one, so the two
 * vocabularies are disjoint by syntax, not by convention. They are also stored
 * apart (scoped to one application id) and no Oxy gate ever reads an
 * application key. A key means something only to the application that declared
 * it.
 *
 * The pattern is exported as a SOURCE string because the API renders the same
 * text into a Postgres CHECK; JavaScript's `RegExp` and Postgres' ARE agree on
 * everything it uses (anchors, classes, a capturing group, a bounded repeat).
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from 'zod';

/**
 * Two to four dot-separated segments, each a lowercase letter followed by
 * lowercase letters, digits or underscores: `payments.operate`,
 * `catalog.review.publish`. At least two segments so a key always names an
 * area and an action; never a colon (see the header).
 */
export const APPLICATION_PERMISSION_KEY_PATTERN_SOURCE =
  '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,3}$';

export const APPLICATION_PERMISSION_KEY_PATTERN = new RegExp(
  APPLICATION_PERMISSION_KEY_PATTERN_SOURCE,
);

export const APPLICATION_PERMISSION_KEY_MAX_LENGTH = 64;
export const APPLICATION_PERMISSION_DESCRIPTION_MAX_LENGTH = 280;
/** How many live keys one application may declare. Operator powers are few. */
export const APPLICATION_PERMISSIONS_MAX_DECLARED = 64;
export const APPLICATION_ROLE_REASON_MAX_LENGTH = 500;
export const APPLICATION_ROLE_GRANTS_PAGE_DEFAULT = 50;
export const APPLICATION_ROLE_GRANTS_PAGE_MAX = 200;

/**
 * The `error` codes the application-roles routes answer beyond the generic
 * ones (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`). Renaming one
 * is a breaking change.
 */
export const APPLICATION_ROLE_ERROR_CODES = {
  /** 403: a grant naming yourself on an application you do not own outright. */
  selfGrantForbidden: 'SELF_GRANT_FORBIDDEN',
  /** 422: the key is not a live declared permission of this application. */
  unknownPermission: 'UNKNOWN_PERMISSION',
  /** 422: the grantee is not a person (an organization, project, bot or channel). */
  granteeNotAPerson: 'GRANTEE_NOT_A_PERSON',
  /** 409: the grantee already holds the key; `details.grantId` names the live grant. */
  alreadyGranted: 'ALREADY_GRANTED',
  /** 409: the grant was already revoked. */
  alreadyRevoked: 'ALREADY_REVOKED',
  /** 403: the bearer's session belongs to a DIFFERENT application. */
  sessionApplicationMismatch: 'SESSION_APPLICATION_MISMATCH',
} as const;

export type ApplicationRoleErrorCode =
  (typeof APPLICATION_ROLE_ERROR_CODES)[keyof typeof APPLICATION_ROLE_ERROR_CODES];

/** Whether `value` is a well-formed application permission key. */
export function isApplicationPermissionKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= APPLICATION_PERMISSION_KEY_MAX_LENGTH &&
    APPLICATION_PERMISSION_KEY_PATTERN.test(value)
  );
}

export const applicationPermissionKeySchema = z
  .string()
  .max(APPLICATION_PERMISSION_KEY_MAX_LENGTH)
  .regex(
    APPLICATION_PERMISSION_KEY_PATTERN,
    'A permission key is 2-4 dot-separated lowercase segments, e.g. payments.operate',
  );

/** Plain text: no control characters other than a newline or a tab. */
function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const code = character.charCodeAt(0);
          return (code >= 32 && code !== 127) || character === '\n' || character === '\t';
        }),
      'Must be plain text',
    );
}

const id = z.string().min(1).max(128);
const isoTimestamp = z.string().min(1);
const reasonSchema = plainText(APPLICATION_ROLE_REASON_MAX_LENGTH);

/** One key as the application's owners declare it. */
export const applicationPermissionDeclarationSchema = z
  .object({
    key: applicationPermissionKeySchema,
    description: plainText(APPLICATION_PERMISSION_DESCRIPTION_MAX_LENGTH),
  })
  .strict();

/**
 * `PUT /applications/:appId/roles/permissions` — the WHOLE vocabulary.
 *
 * Declarative: a key present here and not live is added, a live key absent
 * here is retired (and every grant of it revoked), a live key present here
 * keeps its identity and takes the new description. Sending the same body twice
 * changes nothing.
 */
export const declareApplicationPermissionsRequestSchema = z
  .object({
    permissions: z
      .array(applicationPermissionDeclarationSchema)
      .max(APPLICATION_PERMISSIONS_MAX_DECLARED),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.permissions.forEach((permission, index) => {
      if (seen.has(permission.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', index, 'key'],
          message: `Duplicate permission key ${permission.key}`,
        });
      }
      seen.add(permission.key);
    });
  });

/** A declared key. Retired keys are history: they confer nothing. */
export const applicationPermissionSchema = z.object({
  key: applicationPermissionKeySchema,
  description: z.string(),
  declaredAt: isoTimestamp,
  declaredByUserId: id.nullable(),
  retiredAt: isoTimestamp.nullable(),
  retiredByUserId: id.nullable(),
});

export const applicationPermissionListSchema = z.object({
  items: z.array(applicationPermissionSchema),
});

export const declareApplicationPermissionsResponseSchema = applicationPermissionListSchema.extend({
  /** Keys that became live with this declaration. */
  added: z.array(applicationPermissionKeySchema),
  /** Keys this declaration retired. */
  retired: z.array(applicationPermissionKeySchema),
  /** Live keys whose description changed. */
  described: z.array(applicationPermissionKeySchema),
  /** Live grants revoked because their key was retired. */
  revokedGrants: z.number().int().nonnegative(),
});

/** One grant of one key to one Oxy user. Revocation is a stamp, never a delete. */
export const applicationRoleGrantSchema = z.object({
  id,
  applicationId: id,
  permission: applicationPermissionKeySchema,
  userId: id,
  /** The grantee's handle, for display. */
  username: z.string().nullable(),
  /** The HUMAN who granted it; null once that account was erased. */
  grantedByUserId: id.nullable(),
  grantedAt: isoTimestamp,
  grantReason: z.string().nullable(),
  revokedAt: isoTimestamp.nullable(),
  revokedByUserId: id.nullable(),
  revokeReason: z.string().nullable(),
});

export const applicationRoleGrantListSchema = z.object({
  items: z.array(applicationRoleGrantSchema),
  nextCursor: z.string().nullable(),
});

/** `POST /applications/:appId/roles/grants` — name the grantee by id OR handle. */
export const createApplicationRoleGrantRequestSchema = z
  .object({
    userId: id.optional(),
    username: z.string().trim().min(1).max(64).optional(),
    permission: applicationPermissionKeySchema,
    reason: reasonSchema.optional(),
  })
  .strict()
  .refine((value) => (value.userId === undefined) !== (value.username === undefined), {
    message: 'Name the grantee with exactly one of userId or username',
    path: ['userId'],
  });

/** `POST /applications/:appId/roles/grants/:grantId/revoke`. */
export const revokeApplicationRoleGrantRequestSchema = z
  .object({
    reason: reasonSchema.optional(),
  })
  .strict();

/** `GET /applications/:appId/roles/grants` query. */
export const listApplicationRoleGrantsQuerySchema = z
  .object({
    permission: applicationPermissionKeySchema.optional(),
    userId: id.optional(),
    includeRevoked: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(APPLICATION_ROLE_GRANTS_PAGE_MAX).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * `GET /applications/:appId/roles/me` — the keys the HUMAN behind the bearer
 * holds for this application, in no particular order. `userId` is that human
 * (the operator), which is NOT the account the session speaks as when a person
 * is acting as an organization.
 */
export const applicationRolesMeSchema = z.object({
  applicationId: id,
  userId: id,
  permissions: z.array(applicationPermissionKeySchema),
});

export type ApplicationPermissionDeclaration = z.infer<
  typeof applicationPermissionDeclarationSchema
>;
export type DeclareApplicationPermissionsRequest = z.infer<
  typeof declareApplicationPermissionsRequestSchema
>;
export type ApplicationPermissionDefinition = z.infer<typeof applicationPermissionSchema>;
export type ApplicationPermissionList = z.infer<typeof applicationPermissionListSchema>;
export type DeclareApplicationPermissionsResponse = z.infer<
  typeof declareApplicationPermissionsResponseSchema
>;
export type ApplicationRoleGrant = z.infer<typeof applicationRoleGrantSchema>;
export type ApplicationRoleGrantList = z.infer<typeof applicationRoleGrantListSchema>;
export type CreateApplicationRoleGrantRequest = z.infer<
  typeof createApplicationRoleGrantRequestSchema
>;
export type RevokeApplicationRoleGrantRequest = z.infer<
  typeof revokeApplicationRoleGrantRequestSchema
>;
export type ListApplicationRoleGrantsQuery = z.infer<typeof listApplicationRoleGrantsQuerySchema>;
export type ApplicationRolesMe = z.infer<typeof applicationRolesMeSchema>;

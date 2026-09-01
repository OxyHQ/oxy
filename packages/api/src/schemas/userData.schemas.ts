import { z } from 'zod';
import { APP_DATA_IDENTIFIER_PATTERN } from '../db/schema/userAppData';

/**
 * Schemas for `/users/me/app-data/...`.
 *
 * The endpoint stores small per-user JSON blobs scoped by `(namespace, key)`.
 * Validation enforces:
 *   - Both `namespace` and `key` match `[a-z0-9_-]{1,64}` (kebab/snake-case).
 *   - The serialized `value` body fits within a 64 KB cap (enforced at runtime
 *     because Zod can't measure JSON byte length declaratively).
 *
 * The model layer also enforces the identifier pattern; validating here means
 * a malformed namespace/key is rejected with a clean 400 before we touch the
 * database.
 */

/** Hard cap on the serialized JSON size of a single stored value (64 KB). */
export const APP_DATA_MAX_VALUE_BYTES = 64 * 1024;

/** Maximum number of app-data keys a user may store in one namespace. */
export const APP_DATA_MAX_NAMESPACE_KEYS = 128;

/** Maximum number of app-data keys a user may store across all namespaces. */
export const APP_DATA_MAX_USER_KEYS = 1024;

const identifierSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    APP_DATA_IDENTIFIER_PATTERN,
    'Must match [a-z0-9_-]{1,64} (lowercase letters, digits, dashes, underscores)',
  );

export const appDataNamespaceParamsSchema = z.object({
  namespace: identifierSchema,
});

export const appDataKeyParamsSchema = z.object({
  namespace: identifierSchema,
  key: identifierSchema,
});

export const appDataValueBodySchema = z
  .object({
    /**
     * The value to store. Anything JSON-serializable is allowed (object,
     * array, string, number, boolean, null). `undefined` is not — JSON
     * doesn't carry it.
     */
    value: z.unknown(),
  })
  .superRefine((body, ctx) => {
    if (!('value' in body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value is required',
      });
      return;
    }
    // Reject `undefined` explicitly — JSON.stringify would just drop it.
    if (body.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value must be a JSON-serializable type (not undefined)',
      });
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(body.value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value must be JSON-serializable',
      });
      return;
    }
    // Catches cyclic structures + functions (JSON.stringify returns undefined
    // for functions; cyclic structures throw above and exit early).
    if (typeof serialized !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value must be JSON-serializable',
      });
      return;
    }
    if (Buffer.byteLength(serialized, 'utf8') > APP_DATA_MAX_VALUE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `value exceeds the ${APP_DATA_MAX_VALUE_BYTES}-byte JSON size limit`,
      });
    }
  });

export type AppDataValueBody = z.infer<typeof appDataValueBodySchema>;

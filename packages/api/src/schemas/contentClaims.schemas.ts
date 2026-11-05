import { integerCheck, urlCheck, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
/**
 * The staff half of `/content-claims` (ADR 0043 D10). The public submission's
 * body is `contentClaimSubmissionSchema` in `@oxy.so/contracts`, shared with
 * the Oxy website's form.
 */
import { z } from 'zod';
import { CONTENT_CLAIM_KINDS, CONTENT_CLAIM_STATES } from '@oxy.so/contracts';

const NOTE_MAX = 5000;

/** A comma-separated list (`state=received,reviewing`) or a repeated parameter. */
function listOf<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((raw) =>
      (Array.isArray(raw) ? raw : [raw])
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).max(values.length));
}

export const contentClaimListQuerySchema = z
  .object({
    state: listOf(CONTENT_CLAIM_STATES).optional(),
    kind: listOf(CONTENT_CLAIM_KINDS).optional(),
    /** Only claims with a statutory deadline (erasure requests): past it, due within 7 days, or any. */
    deadline: z.enum(['overdue', 'due_soon', 'any']).optional(),
    limit: z.coerce.number().check(integerCheck()).min(1).max(100).default(50),
    cursor: z.string().check(utf16MinLength(1)).check(utf16MaxLength(512)).optional(),
  })
  .strict();

export type ContentClaimListQuery = z.output<typeof contentClaimListQuerySchema>;

export const contentClaimIdParamsSchema = z.object({
  id: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
});

export const contentClaimTargetParamsSchema = z.object({
  id: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
  targetId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
});

export const contentClaimPreviewQuerySchema = z.object({
  pt: z.string().check(utf16MinLength(1)).check(utf16MaxLength(2048)),
});

export const contentClaimAttachTargetsSchema = z
  .object({
    fileIds: z
      .array(z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)))
      .min(1)
      .max(50),
    /** The page the files were found on (an unresolved target's URL), if any. */
    url: z
      .string()
      .trim()
      .check(urlCheck())
      .check(utf16MaxLength(2048))
      .refine((value) => value.startsWith('https://'), 'Must be an https URL')
      .optional(),
  })
  .strict();

export const contentClaimBlockSchema = z
  .object({
    /** The targets to block; all the claim's unblocked file targets when absent. */
    targetIds: z
      .array(z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)))
      .min(1)
      .max(200)
      .optional(),
    note: z.string().check(utf16MaxLength(NOTE_MAX)).optional(),
  })
  .strict();

export const contentClaimRejectSchema = z
  .object({ reason: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(NOTE_MAX)) })
  .strict();

export const contentClaimRequiredNoteSchema = z
  .object({ note: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(NOTE_MAX)) })
  .strict();

export const contentClaimOptionalNoteSchema = z
  .object({ note: z.string().check(utf16MaxLength(NOTE_MAX)).optional() })
  .strict();

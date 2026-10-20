import { z } from 'zod';

/**
 * Characters a one-line name may not carry into an email: C0/C1 controls (a
 * CR/LF would be a header line in the subject), the line and paragraph
 * separators, and the bidirectional overrides and isolates that reorder what a
 * reader sees (`moc.live` displayed as `evil.com`).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is what this pattern is for
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Something a mail client would turn into a link of its own. The one link in
 * the message is the accept URL Oxy checked; a resource NAME that reads as a
 * second one is the phishing shape this route exists to refuse.
 */
const LINK_SHAPED = /:\/\/|\bwww\./i;

/** The longest resource name the subject line carries. */
export const APP_INVITATION_RESOURCE_NAME_MAX_LENGTH = 100;

/**
 * POST /apps/invitations/email
 *
 * The inviter is an Oxy user id and NOTHING about them is accepted as text: Oxy
 * reads the name and handle the email shows. The accept URL is checked against
 * the calling application's registered origins by the service, which is where
 * the application row is read.
 */
export const appInvitationEmailSchema = z
  .object({
    to: z.string().trim().toLowerCase().email().max(254),
    inviterUserId: z.string().trim().min(1).max(128),
    resourceName: z
      .string()
      .transform((value) => value.replace(/\s+/g, ' ').trim())
      .pipe(
        z
          .string()
          .min(1)
          .max(APP_INVITATION_RESOURCE_NAME_MAX_LENGTH)
          .refine((value) => !UNSAFE_TEXT.test(value), 'resourceName contains a control character')
          .refine((value) => !LINK_SHAPED.test(value), 'resourceName must not contain a link'),
      ),
    acceptUrl: z.string().trim().url().max(2048),
    /** A BCP 47 tag (`es`, `es-ES`). Its language picks the template; unknown is English. */
    locale: z
      .string()
      .trim()
      .max(35)
      .regex(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/)
      .optional(),
  })
  .strict();

export type AppInvitationEmailBody = z.infer<typeof appInvitationEmailSchema>;

/** The `Idempotency-Key` header: the application's own id for this invitation. */
export const appInvitationIdempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/);

/** What `POST /apps/invitations/email` answers: where the one email stands. */
export const appInvitationEmailResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    state: z.enum(['sending', 'retrying', 'sent', 'failed']),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    errorCode: z.string().nullable(),
    createdAt: z.string().datetime(),
    /** True when this answers an earlier request with the same `Idempotency-Key`. */
    replayed: z.boolean(),
  }),
});

import { integerCheck } from './numberChecks';
import { isoDateTime, utf16MinLength } from './stringChecks';
import { z } from '@oxy.so/zod4';

export const emailContextAddressSchema = z
  .object({
    name: z.string().optional(),
    address: z.string().email(),
  })
  .strict();

export const emailContextMailboxSchema = z
  .object({
    mailboxId: z.string().check(utf16MinLength(1)),
    name: z.string(),
    path: z.string(),
    totalMessages: z.number().check(integerCheck()).nonnegative(),
    unseenMessages: z.number().check(integerCheck()).nonnegative(),
  })
  .strict();

export const emailContextMessageSchema = z
  .object({
    messageId: z.string().check(utf16MinLength(1)),
    mailboxId: z.string().check(utf16MinLength(1)),
    from: emailContextAddressSchema,
    subject: z.string(),
    receivedAt: z.string().check(isoDateTime()),
    seen: z.boolean(),
    answered: z.boolean(),
  })
  .strict();

export const emailAgentContextSchema = z
  .object({
    accountId: z.string().check(utf16MinLength(1)),
    resourceMailboxId: z.string().check(utf16MinLength(1)).nullable(),
    generatedAt: z.string().check(isoDateTime()),
    mailboxes: z.array(emailContextMailboxSchema),
    recentUnread: z.array(emailContextMessageSchema),
    needsResponse: z.array(emailContextMessageSchema),
  })
  .strict();

export type EmailContextAddress = z.infer<typeof emailContextAddressSchema>;
export type EmailContextMailbox = z.infer<typeof emailContextMailboxSchema>;
export type EmailContextMessage = z.infer<typeof emailContextMessageSchema>;
export type EmailAgentContext = z.infer<typeof emailAgentContextSchema>;

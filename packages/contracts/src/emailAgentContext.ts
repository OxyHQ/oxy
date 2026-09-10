import { z } from 'zod';

export const emailContextAddressSchema = z.object({
    name: z.string().optional(),
    address: z.string().email(),
}).strict();

export const emailContextMailboxSchema = z.object({
    mailboxId: z.string().min(1),
    name: z.string(),
    path: z.string(),
    totalMessages: z.number().int().nonnegative(),
    unseenMessages: z.number().int().nonnegative(),
}).strict();

export const emailContextMessageSchema = z.object({
    messageId: z.string().min(1),
    mailboxId: z.string().min(1),
    from: emailContextAddressSchema,
    subject: z.string(),
    receivedAt: z.string().datetime(),
    seen: z.boolean(),
    answered: z.boolean(),
}).strict();

export const emailAgentContextSchema = z.object({
    accountId: z.string().min(1),
    resourceMailboxId: z.string().min(1).nullable(),
    generatedAt: z.string().datetime(),
    mailboxes: z.array(emailContextMailboxSchema),
    recentUnread: z.array(emailContextMessageSchema),
    needsResponse: z.array(emailContextMessageSchema),
}).strict();

export type EmailContextAddress = z.infer<typeof emailContextAddressSchema>;
export type EmailContextMailbox = z.infer<typeof emailContextMailboxSchema>;
export type EmailContextMessage = z.infer<typeof emailContextMessageSchema>;
export type EmailAgentContext = z.infer<typeof emailAgentContextSchema>;

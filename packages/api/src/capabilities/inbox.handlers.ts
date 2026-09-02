import { createHash } from 'node:crypto';
import type {
  CatalogInvocationContext,
  CatalogToolHandler,
  CatalogToolHandlers,
} from '@oxyhq/mcp';

import {
  searchMessagesForUser,
  sendMessageForUser,
  type SearchEmailCommand,
  type SendEmailCommand,
} from '../controllers/email.controller';
import { emailService } from '../services/email.service';
import {
  finalizeCapabilityEffectFor,
  reserveCapabilityEffectFor,
} from '../services/capabilityRuntimeStore.service';
import {
  ApiError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/error';
import { INBOX_CAPABILITY_CATALOG } from './inbox.catalog';

type Input = Readonly<Record<string, unknown>>;
type Result = Record<string, unknown>;

function requiredString(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError(`${key} is required`);
  }
  return value;
}

function integer(input: Input, key: string, fallback: number, maximum = 100): number {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 0), maximum)
    : fallback;
}

function sendCommand(input: Input): SendEmailCommand {
  if (!Array.isArray(input.to)) throw new BadRequestError('to is required');
  // The catalog adapter has already applied the strict JSON schema; this guard
  // keeps the direct domain boundary safe and gives TypeScript the required
  // recipient invariant without rebuilding a second schema here.
  return input as unknown as SendEmailCommand;
}

function pagination(
  result: { total: number; limit: number; offset: number; nextCursor?: string | null },
): Record<string, unknown> {
  return {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    hasMore: result.nextCursor !== undefined
      ? result.nextCursor !== null
      : result.offset + result.limit < result.total,
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  };
}

async function executeEffect(
  tool: string,
  input: Input,
  context: CatalogInvocationContext,
  execute: () => Promise<Result>,
): Promise<Result> {
  const keyHash = createHash('sha256')
    .update(requiredString(input, 'idempotencyKey'))
    .digest('hex');
  const identity = {
    effectiveAccountId: context.principal.accountId,
    appSlug: INBOX_CAPABILITY_CATALOG.appId,
    tool,
    keyHash,
  } as const;
  const reserved = await reserveCapabilityEffectFor({
    ...identity,
    authorizationId: `mcp:${context.principal.clientId}`,
  });
  if (!reserved) {
    throw new ConflictError('This idempotency key has already been used');
  }

  try {
    const result = await execute();
    await finalizeCapabilityEffectFor({ ...identity, statusCode: 200 });
    return result;
  } catch (error) {
    await finalizeCapabilityEffectFor({
      ...identity,
      statusCode: error instanceof ApiError ? error.statusCode : 500,
    });
    throw error;
  }
}

const handlers: Record<string, CatalogToolHandler> = {
  async searchEmails(input, context) {
    const result = await searchMessagesForUser(
      context.principal.accountId,
      input as SearchEmailCommand,
    );
    return { structuredContent: result };
  },

  async getUnreadEmails(input, context) {
    const result = await emailService.listMessages(
      context.principal.accountId,
      null,
      {
        limit: integer(input, 'limit', 50),
        offset: integer(input, 'offset', 0, Number.MAX_SAFE_INTEGER),
        unseenOnly: true,
      },
    );
    return {
      structuredContent: {
        data: result.data,
        pagination: pagination(result),
      },
    };
  },

  async readEmail(input, context) {
    const message = await emailService.getMessage(
      context.principal.accountId,
      requiredString(input, 'messageId'),
    );
    if (!message) throw new NotFoundError('Message not found');
    return { structuredContent: { data: message } };
  },

  async getEmailThread(input, context) {
    const thread = await emailService.getThread(
      context.principal.accountId,
      requiredString(input, 'messageId'),
    );
    return { structuredContent: { data: thread } };
  },

  async sendEmail(input, context) {
    const result = await executeEffect('sendEmail', input, context, async () => {
      const sent = await sendMessageForUser(
        context.principal.accountId,
        sendCommand(input),
        requiredString(input, 'idempotencyKey'),
      );
      return { data: sent.data };
    });
    return { structuredContent: result };
  },

  async listMailboxes(_input, context) {
    await emailService.ensureMailboxes(context.principal.accountId);
    return {
      structuredContent: {
        data: await emailService.listMailboxes(context.principal.accountId),
      },
    };
  },

  async listLabels(_input, context) {
    return {
      structuredContent: {
        data: await emailService.listLabels(context.principal.accountId),
      },
    };
  },

  async moveEmail(input, context) {
    const result = await executeEffect('moveEmail', input, context, async () => ({
      data: await emailService.moveMessage(
        context.principal.accountId,
        requiredString(input, 'messageId'),
        requiredString(input, 'mailboxId'),
      ),
    }));
    return { structuredContent: result };
  },

  async updateEmailFlags(input, context) {
    const flags = input.flags;
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
      throw new BadRequestError('flags object is required');
    }
    const result = await executeEffect('updateEmailFlags', input, context, async () => ({
      data: await emailService.updateMessageFlags(
        context.principal.accountId,
        requiredString(input, 'messageId'),
        flags as Record<string, boolean>,
      ),
    }));
    return { structuredContent: result };
  },

  async getEmailQuota(_input, context) {
    return {
      structuredContent: {
        data: await emailService.getQuotaUsage(context.principal.accountId),
      },
    };
  },
};

const publicToolNames = INBOX_CAPABILITY_CATALOG.tools
  .filter(({ exposure }) => exposure.includes('mcp'))
  .map(({ name }) => name);
const missingHandlers = publicToolNames.filter((name) => !handlers[name]);
const extraHandlers = Object.keys(handlers).filter((name) => !publicToolNames.includes(name));
if (missingHandlers.length > 0 || extraHandlers.length > 0) {
  throw new Error(
    `Inbox MCP handler mismatch: missing=${missingHandlers.join(',')} extra=${extraHandlers.join(',')}`,
  );
}

export const INBOX_MCP_HANDLERS: CatalogToolHandlers = Object.freeze(handlers);

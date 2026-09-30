import { createHash } from 'node:crypto';
import type { AppCapabilityCatalog, CatalogTool } from '@oxy.so/contracts';
import type {
  CatalogInvocationContext,
  CatalogToolHandler,
  CatalogToolHandlers,
} from '@oxy.so/mcp';

import {
  finalizeCapabilityEffectFor,
  reserveCapabilityEffectFor,
} from '../services/capabilityRuntimeStore.service';
import {
  ApiError,
  BadRequestError,
  ConflictError,
} from '../utils/error';
import { INBOX_CAPABILITY_CATALOG } from './inbox.catalog';
import { INBOX_TOOLS, type InboxToolInput, type InboxToolResult } from './inbox.tools';

/**
 * The external Inbox MCP adapter: OAuth-bound MCP calls onto the same tool
 * functions Alia's capability tickets reach (`inbox.tools.ts`).
 *
 * The one thing MCP adds is the retry key. Over HTTP it is the
 * `Idempotency-Key` header, so the catalog no longer asks the model for it; an
 * MCP tool call has no per-call headers, so for every tool that requires one
 * the MCP view of the catalog declares a REQUIRED `idempotencyKey` argument —
 * the contract external MCP clients have always had. It stays required rather
 * than derived: a key derived from the arguments would refuse a deliberate
 * second identical send forever, and a random one would protect nothing, so
 * only the client can say which calls are retries of the same action.
 */

const IDEMPOTENCY_ARGUMENT = 'idempotencyKey';
const idempotencyArgument = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  description: 'A key you generate once for this action (a UUID, for example) and reuse only when retrying '
    + 'the SAME action. A key already used is refused instead of acting twice.',
} as const;

function withIdempotencyArgument(tool: CatalogTool): CatalogTool {
  if (tool.idempotency !== 'required') return tool;
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(properties, IDEMPOTENCY_ARGUMENT)) {
    throw new Error(`Inbox tool ${tool.name} must not declare the reserved ${IDEMPOTENCY_ARGUMENT} argument`);
  }
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required as string[] : [];
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...properties, [IDEMPOTENCY_ARGUMENT]: idempotencyArgument },
      required: [...required, IDEMPOTENCY_ARGUMENT],
    },
  };
}

/** The catalog as MCP clients see it: the canonical one plus MCP's retry-key argument. */
export const INBOX_MCP_CATALOG: AppCapabilityCatalog = Object.freeze({
  ...INBOX_CAPABILITY_CATALOG,
  tools: INBOX_CAPABILITY_CATALOG.tools.map(withIdempotencyArgument),
});

async function executeEffect(
  tool: string,
  idempotencyKey: string,
  context: CatalogInvocationContext,
  execute: () => Promise<InboxToolResult>,
): Promise<InboxToolResult> {
  const identity = {
    effectiveAccountId: context.principal.activeAccountId,
    appSlug: INBOX_CAPABILITY_CATALOG.appId,
    tool,
    keyHash: createHash('sha256').update(idempotencyKey).digest('hex'),
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

function handlerFor(tool: CatalogTool): CatalogToolHandler {
  const run = INBOX_TOOLS[tool.name];
  if (!run) throw new Error(`Inbox MCP tool ${tool.name} has no implementation`);
  // An MCP connection acts as one whole account; mailbox-scoped authority
  // exists only for capability tickets.
  if (tool.idempotency !== 'required') {
    return async (input, context) => ({
      structuredContent: await run(input, { accountId: context.principal.activeAccountId }),
    });
  }
  return async (rawInput, context) => {
    const { [IDEMPOTENCY_ARGUMENT]: idempotencyKey, ...input } = rawInput;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new BadRequestError(`${IDEMPOTENCY_ARGUMENT} is required`);
    }
    const accountId = context.principal.activeAccountId;
    return {
      structuredContent: await executeEffect(tool.name, idempotencyKey, context, () => (
        run(input as InboxToolInput, { accountId, idempotencyKey })
      )),
    };
  };
}

export const INBOX_MCP_HANDLERS: CatalogToolHandlers = Object.freeze(Object.fromEntries(
  INBOX_MCP_CATALOG.tools
    .filter(({ exposure }) => exposure.includes('mcp'))
    .map((tool) => [tool.name, handlerFor(tool)]),
));

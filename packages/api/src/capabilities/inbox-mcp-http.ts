import { createCatalogMcpHttpService } from '@oxy.so/mcp';

import { introspectMcpAccessToken, resolveMcpResource } from '../services/mcpOAuth.service';
import { logger } from '../utils/logger';
import { INBOX_MCP_CATALOG, INBOX_MCP_HANDLERS } from './inbox.handlers';

/**
 * Browser origins allowed to read Inbox MCP responses over CORS. There is no built-in
 * list: MCP clients are server-side or native and need no CORS grant, and the transport
 * does not refuse unlisted origins (see `applyCorsHeaders` in `@oxy.so/mcp`).
 */
export function parseInboxMcpAllowedOrigins(configured?: string): string[] {
  return [
    ...new Set(
      (configured ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
}

export function createInboxMcpHttpService() {
  const resource = INBOX_MCP_CATALOG.externalMcp?.resource;
  if (!resource) throw new Error('Inbox catalog is missing its external MCP resource');

  let applicationId: Promise<string> | undefined;
  const registeredApplicationId = async (): Promise<string> => {
    applicationId ??= resolveMcpResource(resource)
      .then((descriptor) => descriptor.registeredByApplicationId)
      .catch((error: unknown) => {
        applicationId = undefined;
        throw error;
      });
    return applicationId;
  };

  return createCatalogMcpHttpService({
    catalog: INBOX_MCP_CATALOG,
    handlers: INBOX_MCP_HANDLERS,
    authorizationServer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    introspectToken: async (token) => {
      const result = await introspectMcpAccessToken(token, await registeredApplicationId());
      // The connection block rides along with the claims so the transport can
      // build a principal that knows which member account to serve.
      return result ? { ...result.claims, connection: result.connection } : null;
    },
    allowedOrigins: parseInboxMcpAllowedOrigins(process.env.INBOX_MCP_ALLOWED_ORIGINS),
    authorize: async (_input, context) => ({
      allowed: true,
      effectiveAccountId: context.principal.activeAccountId,
    }),
    logger: {
      error(message, error) {
        logger.error(message, error);
      },
    },
    serverName: 'inbox-mcp',
  });
}

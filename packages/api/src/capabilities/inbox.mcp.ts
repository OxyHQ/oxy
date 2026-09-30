import {
  registerCatalogWithMcp,
  type CatalogMcpRegistrationOptions,
  type CatalogToolHandlers,
} from '@oxy.so/mcp';
import { INBOX_MCP_CATALOG } from './inbox.handlers';

/**
 * External Inbox MCP registration. The transport/auth layer supplies handlers
 * bound to the OAuth-selected account; tool metadata and schemas always come
 * from the same catalog used by Alia and the permission UI, plus the MCP-only
 * retry-key argument (see `inbox.handlers.ts`).
 */
export function registerInboxMcpTools(
  server: Parameters<typeof registerCatalogWithMcp>[0],
  handlers: CatalogToolHandlers,
  options: CatalogMcpRegistrationOptions,
): void {
  registerCatalogWithMcp(server, INBOX_MCP_CATALOG, handlers, options);
}

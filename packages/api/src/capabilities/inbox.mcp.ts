import {
  registerCatalogWithMcp,
  type CatalogMcpRegistrationOptions,
  type CatalogToolHandlers,
} from '@oxyhq/mcp';
import { INBOX_CAPABILITY_CATALOG } from './inbox.catalog';

/**
 * External Inbox MCP registration. The transport/auth layer supplies handlers
 * bound to the OAuth-selected account; tool metadata and schemas always come
 * from the same catalog used by Alia and the permission UI.
 */
export function registerInboxMcpTools(
  server: Parameters<typeof registerCatalogWithMcp>[0],
  handlers: CatalogToolHandlers,
  options: CatalogMcpRegistrationOptions,
): void {
  registerCatalogWithMcp(server, INBOX_CAPABILITY_CATALOG, handlers, options);
}

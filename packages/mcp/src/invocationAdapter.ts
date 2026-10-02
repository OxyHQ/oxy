import type { AppCapabilityCatalog, CatalogTool, InvocationPrincipal } from '@oxy.so/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCatalogWithMcp,
  type CatalogInvocationContext,
  type CatalogMcpRegistrationOptions,
  type CatalogToolResult,
} from './catalogAdapter';
import { createCatalogMcpHttpService, type CatalogMcpHttpServiceOptions } from './httpTransport';

/** Opt-in context; the existing OAuth CatalogInvocationContext stays intact. */
export interface InvocationContext {
  readonly appId: string;
  readonly tool: CatalogTool;
  readonly principal: InvocationPrincipal;
  readonly request: CatalogInvocationContext['request'];
}

export type InvocationHandlers = Readonly<Record<string, (
  input: Readonly<Record<string, unknown>>, context: InvocationContext,
) => Promise<CatalogToolResult>>>;

export function oauthInvocationContext(context: CatalogInvocationContext): InvocationContext {
  const principal = context.principal;
  const scopes = [...principal.scopes];
  Object.freeze(scopes);
  return Object.freeze({ ...context, principal: Object.freeze({
    kind: 'oauth' as const,
    subject: principal.subject,
    clientId: principal.clientId,
    originAccountId: principal.accountId,
    activeAccountId: principal.activeAccountId,
    scopes,
    resource: principal.resource,
  }) });
}

/** Same canonical handlers, explicitly selected OAuth context projection. */
export function registerCatalogWithInvocationPrincipal(
  server: McpServer, catalog: AppCapabilityCatalog, handlers: InvocationHandlers,
  options: CatalogMcpRegistrationOptions,
): void {
  registerCatalogWithMcp(server, catalog, Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [
    name, (input, context) => handler(input, oauthInvocationContext(context)),
  ])), options);
}

type WithInvocationContext<T> = T extends unknown ? Omit<T, 'handlers' | 'authorize'> & {
  handlers: InvocationHandlers;
  authorize: (input: Readonly<Record<string, unknown>>, context: InvocationContext) => ReturnType<CatalogMcpRegistrationOptions['authorize']>;
} : never;
export type InvocationCatalogMcpHttpServiceOptions = WithInvocationContext<CatalogMcpHttpServiceOptions>;

/** Opt-in OAuth surface for the same discriminated handlers used internally. */
export function createCatalogMcpHttpServiceWithInvocationPrincipal(options: InvocationCatalogMcpHttpServiceOptions) {
  return createCatalogMcpHttpService({ ...options,
    handlers: Object.fromEntries(Object.entries(options.handlers).map(([name, handler]) => [
      name, (input, context) => handler(input, oauthInvocationContext(context)),
    ])),
    authorize: (input, context) => options.authorize(input, oauthInvocationContext(context)),
  });
}

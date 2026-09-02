import type { AppCapabilityCatalog, CatalogTool } from '@oxyhq/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { jsonObjectSchemaToZod } from './jsonSchema';
import {
  mcpPrincipalFromAuthInfo,
  type McpPrincipal,
  type McpTokenValidationOptions,
} from './oauth';

type McpRequestContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface CatalogInvocationContext {
  readonly appId: string;
  readonly tool: CatalogTool;
  readonly principal: McpPrincipal;
  readonly request: McpRequestContext;
}

export interface CatalogToolResult {
  structuredContent?: Record<string, unknown>;
  content?: CallToolResult['content'];
  isError?: boolean;
}

export type CatalogToolHandler = (
  input: Readonly<Record<string, unknown>>,
  context: CatalogInvocationContext,
) => Promise<CatalogToolResult>;

export type CatalogToolHandlers = Readonly<Record<string, CatalogToolHandler>>;

export interface CatalogMcpToolDefinition {
  tool: CatalogTool;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  handler: CatalogToolHandler;
}

export type CatalogMcpAuthorizationDecision =
  | Readonly<{ allowed: true; effectiveAccountId: string }>
  | Readonly<{ allowed: false; reason: string }>;

export interface CatalogMcpRegistrationOptions {
  authentication: Omit<McpTokenValidationOptions, 'accountId' | 'requiredScopes'>;
  /**
   * Performs the live app authorization and binds principal.accountId to the
   * domain resource targeted by this invocation. It must fail closed.
   */
  authorize: (
    input: Readonly<Record<string, unknown>>,
    context: CatalogInvocationContext,
  ) => Promise<CatalogMcpAuthorizationDecision>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeToolResult(
  definition: CatalogMcpToolDefinition,
  result: CatalogToolResult,
): CallToolResult {
  let structuredContent = result.structuredContent;
  if (structuredContent !== undefined && definition.outputSchema && result.isError !== true) {
    structuredContent = requireRecord(
      definition.outputSchema.parse(structuredContent),
      `${definition.tool.name} structured content`,
    );
  }

  const content = result.content
    ?? (structuredContent === undefined
      ? []
      : [{ type: 'text' as const, text: JSON.stringify(structuredContent) }]);

  return {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

export function createCatalogMcpToolDefinitions(
  catalog: AppCapabilityCatalog,
  handlers: CatalogToolHandlers,
): CatalogMcpToolDefinition[] {
  return catalog.tools
    .filter((tool) => tool.exposure.includes('mcp'))
    .map((tool) => {
      const handler = handlers[tool.name];
      if (!handler) throw new Error(`Missing MCP handler for catalog tool ${tool.name}`);
      return {
        tool,
        inputSchema: jsonObjectSchemaToZod(tool.inputSchema),
        outputSchema: tool.outputSchema
          ? jsonObjectSchemaToZod(tool.outputSchema)
          : undefined,
        handler,
      };
    });
}

export function registerCatalogWithMcp(
  server: McpServer,
  catalog: AppCapabilityCatalog,
  handlers: CatalogToolHandlers,
  options: CatalogMcpRegistrationOptions,
): void {
  for (const definition of createCatalogMcpToolDefinitions(catalog, handlers)) {
    server.registerTool(definition.tool.name, {
      description: definition.tool.description,
      inputSchema: definition.inputSchema,
      ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
      annotations: {
        readOnlyHint: definition.tool.effect === 'read',
        destructiveHint: definition.tool.effect !== 'read' && definition.tool.rollback === 'none',
        idempotentHint: definition.tool.idempotency !== 'none',
      },
      _meta: {
        'oxy/appId': catalog.appId,
        'oxy/toolVersion': definition.tool.version,
        'oxy/requiredCapabilities': definition.tool.requiredCapabilities,
        'oxy/resourceTypes': definition.tool.resourceTypes,
      },
    }, async (untrustedInput, request): Promise<CallToolResult> => {
      const input = requireRecord(definition.inputSchema.parse(untrustedInput), `${definition.tool.name} input`);
      const principal = mcpPrincipalFromAuthInfo(request.authInfo, {
        ...options.authentication,
        requiredScopes: definition.tool.requiredCapabilities,
      });
      const context = Object.freeze({
        appId: catalog.appId,
        tool: definition.tool,
        principal,
        request,
      });
      const authorization = await options.authorize(input, context);
      if (!authorization.allowed) {
        throw new Error(`MCP authorization denied: ${authorization.reason}`);
      }
      if (authorization.effectiveAccountId !== principal.accountId) {
        throw new Error('MCP authorization account binding mismatch');
      }
      return normalizeToolResult(definition, await definition.handler(input, context));
    });
  }
}

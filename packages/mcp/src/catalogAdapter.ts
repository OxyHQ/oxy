import type { AppCapabilityCatalog, CatalogTool } from '@oxyhq/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { jsonObjectSchemaToZod } from './jsonSchema';

export interface CatalogInvocationContext {
  appId: string;
  tool: CatalogTool;
}

export interface CatalogToolResult {
  structuredContent: Record<string, unknown>;
  content?: CallToolResult['content'];
}

export type CatalogToolHandler = (
  input: Record<string, unknown>,
  context: CatalogInvocationContext,
) => Promise<CatalogToolResult>;

export type CatalogToolHandlers = Readonly<Record<string, CatalogToolHandler>>;

export interface CatalogMcpToolDefinition {
  tool: CatalogTool;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema: z.ZodObject<z.ZodRawShape>;
  handler: CatalogToolHandler;
}

interface McpToolRegistrar {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: z.ZodObject<z.ZodRawShape>;
      outputSchema: z.ZodObject<z.ZodRawShape>;
      annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
      };
      _meta: Record<string, unknown>;
    },
    callback: (input: Record<string, unknown>) => Promise<CallToolResult>,
  ): unknown;
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
        outputSchema: jsonObjectSchemaToZod(tool.outputSchema),
        handler,
      };
    });
}

export function registerCatalogWithMcp(
  server: McpServer,
  catalog: AppCapabilityCatalog,
  handlers: CatalogToolHandlers,
): void {
  const registrar = server as unknown as McpToolRegistrar;
  for (const definition of createCatalogMcpToolDefinitions(catalog, handlers)) {
    registrar.registerTool(definition.tool.name, {
      description: definition.tool.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
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
    }, async (input): Promise<CallToolResult> => {
      const parsedInput = definition.inputSchema.parse(input);
      const result = await definition.handler(parsedInput, { appId: catalog.appId, tool: definition.tool });
      const structuredContent = definition.outputSchema.parse(result.structuredContent);
      return {
        content: result.content ?? [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    });
  }
}

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalCapabilityJson, idempotencyKeySchema, inputSatisfiesCapabilityLimits, appCapabilityCatalogSchema, capabilityCatalogBindingSchema, invocationPrincipalSchema, resourceRefSchema,
  type AppCapabilityCatalog, type CapabilityCatalogBinding, type CapabilityTicketClaims, type ResourceRef } from '@oxy.so/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { normalizeToolResult, requireRecord, type CatalogMcpAuthorizationDecision } from './catalogAdapter';
import { BodyTooLargeError, closeServerAfterResponse, configureCors, readJsonBody, requireResourceHost,
  sendJsonRpcError, singleHeader } from './httpTransport';
import { jsonObjectSchemaToZod } from './jsonSchema';
import type { InvocationContext, InvocationHandlers } from './invocationAdapter';

type InternalInvocationContext = Omit<InvocationContext, 'principal'> & {
  readonly principal: Extract<InvocationContext['principal'], { kind: 'capability' }>;
};

export interface InternalCatalogMcpHttpServiceOptions {
  catalog: AppCapabilityCatalog;
  binding: CapabilityCatalogBinding;
  handlers: InvocationHandlers;
  /** Private server configuration: signature validation AND live introspection. */
  verifyTicket: (ticket: string, options: { signal: AbortSignal }) => Promise<CapabilityTicketClaims>;
  /** Trusted input-to-resource contract; never a caller-supplied principal. */
  resolveResource: (input: Readonly<Record<string, unknown>>, context: InternalInvocationContext) => ResourceRef | Promise<ResourceRef>;
  authorize: (input: Readonly<Record<string, unknown>>, context: InvocationContext) => Promise<CatalogMcpAuthorizationDecision>;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Dedicated stateless internal lane. Public /mcp remains OAuth-only. */
export function createInternalCatalogMcpHttpService(options: InternalCatalogMcpHttpServiceOptions) {
  const catalog = freeze(appCapabilityCatalogSchema.parse(options.catalog));
  const binding = freeze(capabilityCatalogBindingSchema.parse(options.binding));
  if (binding.version !== catalog.version || binding.digest !== createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex')) {
    throw new Error('Internal MCP catalogue binding does not match its definition');
  }
  const host = new URL(catalog.internalBaseUrl).host.toLowerCase();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 10 * 1024 * 1024) {
    throw new Error('MCP maximum body size must be between 1 byte and 10 MiB');
  }
  const origins = new Set(options.allowedOrigins ?? []);

  return Object.freeze({
    mcpPath: '/_oxy/mcp' as const,
    async handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (!requireResourceHost(request, response, host) || !configureCors(request, response, origins)) {
        request.resume(); return;
      }
      const authorization = singleHeader(request.headers.authorization);
      const match = authorization?.match(/^Capability ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
      if (!match) { request.resume(); sendJsonRpcError(response, 401, -32001, 'Capability authentication required.'); return; }
      if (request.method !== 'POST') { request.resume(); sendJsonRpcError(response, 405, -32000, 'Method not allowed.'); return; }
      const ticket = match[1];
      const abort = new AbortController();
      const disconnected = () => { if (!response.writableEnded) abort.abort(new Error('Internal MCP request disconnected')); };
      request.once('aborted', disconnected);
      response.once('close', disconnected);
      const verify = async () => {
        abort.signal.throwIfAborted();
        const principal = invocationPrincipalSchema.parse({ kind: 'capability', claims: await options.verifyTicket(ticket, { signal: abort.signal }) });
        if (principal.kind !== 'capability') throw new Error('Capability principal required');
        const claims = principal.claims;
        if (claims.aud !== catalog.audience || claims.resource.appId !== catalog.appId || canonicalCapabilityJson(claims.catalog) !== canonicalCapabilityJson(binding)) {
          throw new Error('Capability catalogue binding mismatch');
        }
        return freeze(principal);
      };
      try {
        const principal = await verify();
        const body = await readJsonBody(request, maxBodyBytes);
        const server = new McpServer({ name: `${catalog.appId}-internal-mcp`, version: catalog.version });
        for (const tool of catalog.tools.filter((entry) => entry.name === principal.claims.tool && entry.exposure.includes('internal'))) {
          if (!tool.requiredCapabilities.every((capability) => principal.claims.capabilities.includes(capability))
            || !tool.resourceTypes.includes(principal.claims.resource.resourceType)) throw new Error('Capability tool binding mismatch');
          const handler = options.handlers[tool.name];
          if (!handler) throw new Error('Missing internal MCP handler');
          const inputSchema = jsonObjectSchemaToZod(tool.inputSchema);
          const outputSchema = tool.outputSchema ? jsonObjectSchemaToZod(tool.outputSchema) : undefined;
          server.registerTool(tool.name, { description: tool.description, inputSchema, ...(outputSchema ? { outputSchema } : {}) }, async (untrusted, extra) => {
            const input = freeze(requireRecord(inputSchema.parse(untrusted), `${tool.name} input`));
            const current = await verify();
            const key = singleHeader(request.headers['idempotency-key']);
            if ((key !== undefined && !idempotencyKeySchema.safeParse(key.trim()).success)
              || (tool.idempotency === 'required' && key === undefined)) throw new Error('Valid idempotency key required');
            const context: InternalInvocationContext = Object.freeze({ appId: catalog.appId, tool, principal: current, request: extra });
            const resource = resourceRefSchema.parse(await options.resolveResource(input, context));
            if (canonicalCapabilityJson(resource) !== canonicalCapabilityJson(current.claims.resource) || !inputSatisfiesCapabilityLimits(tool.name, input, current.claims.limits)) throw new Error('Capability resource or limits mismatch');
            const decision = await options.authorize(input, context);
            if (!decision.allowed || decision.effectiveAccountId !== resource.effectiveAccountId) throw new Error('Internal MCP authorization denied');
            // Domain authorization may await I/O: recheck live authority before its effect.
            await verify();
            return normalizeToolResult({ tool, outputSchema }, await handler(input, context));
          });
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        closeServerAfterResponse(server, response);
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        if (!response.headersSent && !response.destroyed) sendJsonRpcError(response, error instanceof BodyTooLargeError ? 413 : 403, -32000, 'Internal MCP request refused.');
      } finally {
        request.removeListener('aborted', disconnected);
        response.removeListener('close', disconnected);
      }
    },
  });
}

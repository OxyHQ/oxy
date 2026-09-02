import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  registerCatalogWithMcp,
  type CatalogMcpAuthorizationDecision,
  type CatalogInvocationContext,
  type CatalogToolHandlers,
} from './catalogAdapter';
import { extractBearerToken } from './http';
import { introspectOxyMcpAccessToken } from './introspection';
import {
  buildProtectedResourceMetadata,
  createMcpAuthInfo,
  type McpAccessTokenClaims,
  validateMcpAccessTokenClaims,
} from './oauth';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOKEN_TTL_SECONDS = 900;

interface McpHttpRequest extends IncomingMessage {
  auth?: AuthInfo;
}

export interface CatalogMcpHttpLogger {
  error(message: string, error: unknown): void;
}

export interface CatalogMcpHttpServiceOptions {
  catalog: AppCapabilityCatalog;
  handlers: CatalogToolHandlers;
  authorizationServer: string;
  getServiceToken: () => Promise<string>;
  invalidateServiceToken?: () => void | Promise<void>;
  authorize: (
    input: Readonly<Record<string, unknown>>,
    context: CatalogInvocationContext,
  ) => Promise<CatalogMcpAuthorizationDecision>;
  allowedOrigins?: readonly string[];
  introspectionEndpoint?: string;
  maxBodyBytes?: number;
  maxTokenTtlSeconds?: number;
  fetch?: typeof fetch;
  logger?: CatalogMcpHttpLogger;
  serverName?: string;
}

export interface CatalogMcpHttpService {
  readonly mcpPath: '/mcp';
  readonly protectedResourceMetadataPath: string;
  handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void>;
  handleProtectedResourceMetadata(
    request: IncomingMessage,
    response: ServerResponse,
  ): void;
}

class BodyTooLargeError extends Error {}

function normalizeHttpsOrigin(value: string, label: string): string {
  const url = new URL(value);
  const local = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS outside local development`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an origin without credentials, path, query or fragment`);
  }
  return url.origin;
}

function normalizeAllowedOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new Error(`Invalid MCP allowed origin: ${value}`);
  }
  return url.origin;
}

function metadataPath(resource: string): string {
  const pathname = new URL(resource).pathname.replace(/\/$/, '');
  return `/.well-known/oauth-protected-resource${pathname}`;
}

function setJsonHeaders(response: ServerResponse, cacheControl = 'no-store'): void {
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('Content-Type', 'application/json');
}

function sendJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  setJsonHeaders(response);
  response.statusCode = status;
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
}

function appendVary(response: ServerResponse, value: string): void {
  const current = response.getHeader('Vary');
  const entries = new Set(
    (Array.isArray(current) ? current.join(',') : String(current ?? ''))
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  entries.add(value);
  response.setHeader('Vary', [...entries].join(', '));
}

function configureCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = singleHeader(request.headers.origin);
  if (request.headers.origin !== undefined && (!origin || !allowedOrigins.has(origin))) {
    sendJsonRpcError(response, 403, -32000, 'Origin is not allowed.');
    return false;
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    appendVary(response, 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, MCP-Protocol-Version',
  );
  response.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  return true;
}

function requireResourceHost(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
): boolean {
  const host = singleHeader(request.headers.host)?.toLowerCase();
  if (host === expectedHost) return true;
  sendJsonRpcError(response, 421, -32000, 'Request was sent to the wrong resource host.');
  return false;
}

function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(singleHeader(request.headers['content-length']));
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      request.resume();
      reject(new BodyTooLargeError());
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBodyBytes) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length > 0 ? JSON.parse(raw) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function closeServerAfterResponse(server: McpServer, response: ServerResponse): void {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    void server.close().catch(() => undefined);
  };
  response.once('finish', close);
  response.once('close', close);
}

/**
 * Build one stateless Streamable HTTP endpoint from an app's canonical catalog.
 * The service owns protocol framing and live central-token introspection; the
 * app owns its domain handlers and final resource authorization.
 */
export function createCatalogMcpHttpService(
  options: CatalogMcpHttpServiceOptions,
): CatalogMcpHttpService {
  const resource = options.catalog.externalMcp?.resource;
  if (!resource) throw new Error('MCP HTTP transport requires catalog.externalMcp.resource');

  const authorizationServer = normalizeHttpsOrigin(
    options.authorizationServer,
    'MCP authorization server',
  );
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeAllowedOrigin));
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTokenTtlSeconds = options.maxTokenTtlSeconds ?? DEFAULT_MAX_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 10 * 1024 * 1024) {
    throw new Error('MCP maximum body size must be between 1 byte and 10 MiB');
  }
  if (!Number.isInteger(maxTokenTtlSeconds) || maxTokenTtlSeconds < 1 || maxTokenTtlSeconds > 3600) {
    throw new Error('MCP maximum token TTL must be between 1 and 3600 seconds');
  }

  const protectedResourceMetadataPath = metadataPath(resource);
  const resourceHost = new URL(resource).host.toLowerCase();
  const protectedResourceMetadataUrl = new URL(
    protectedResourceMetadataPath,
    resource,
  ).href;
  const requiredScopes = [...new Set(options.catalog.tools
    .filter((tool) => tool.exposure.includes('mcp'))
    .flatMap((tool) => tool.requiredCapabilities))].sort();

  const authenticate = async (request: McpHttpRequest, response: ServerResponse): Promise<boolean> => {
    const token = extractBearerToken(request.headers);
    if (!token) {
      response.setHeader(
        'WWW-Authenticate',
        `Bearer realm="${options.catalog.appId}-mcp", resource_metadata="${protectedResourceMetadataUrl}"`,
      );
      sendJsonRpcError(response, 401, -32001, 'Authentication required.');
      return false;
    }

    let claims: McpAccessTokenClaims | null;
    try {
      claims = await introspectOxyMcpAccessToken(token, {
        endpoint: options.introspectionEndpoint
          ?? `${authorizationServer}/auth/mcp/oauth/introspect`,
        getServiceToken: options.getServiceToken,
        invalidateServiceToken: options.invalidateServiceToken,
        fetch: options.fetch,
      });
    } catch (error) {
      options.logger?.error('MCP token introspection failed', error);
      sendJsonRpcError(response, 503, -32000, 'Authorization service unavailable.');
      return false;
    }
    if (!claims) {
      response.setHeader(
        'WWW-Authenticate',
        `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl}"`,
      );
      sendJsonRpcError(response, 401, -32001, 'Access token is inactive.');
      return false;
    }
    try {
      const verified = validateMcpAccessTokenClaims(claims, {
        issuer: authorizationServer,
        audience: options.catalog.audience,
        resource,
        accountId: claims.account_id,
        maxTokenTtlSeconds,
      });
      request.auth = createMcpAuthInfo(token, verified);
      return true;
    } catch (error) {
      options.logger?.error('MCP token validation failed', error);
      response.setHeader(
        'WWW-Authenticate',
        `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl}"`,
      );
      sendJsonRpcError(response, 401, -32001, 'Access token is invalid.');
      return false;
    }
  };

  const handleMcp = async (
    incoming: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const request = incoming as McpHttpRequest;
    if (!requireResourceHost(request, response, resourceHost)) {
      request.resume();
      return;
    }
    if (!configureCors(request, response, allowedOrigins)) {
      request.resume();
      return;
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (!await authenticate(request, response)) {
      request.resume();
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      response.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      sendJsonRpcError(response, 405, -32000, 'Method not allowed.');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJsonRpcError(response, 413, -32000, 'Request body is too large.');
      } else if (error instanceof SyntaxError) {
        sendJsonRpcError(response, 400, -32700, 'Invalid JSON request body.');
      } else {
        options.logger?.error('MCP request body failed', error);
        sendJsonRpcError(response, 400, -32700, 'Unable to read JSON request body.');
      }
      return;
    }

    const server = new McpServer({
      name: options.serverName ?? `${options.catalog.appId}-mcp`,
      version: options.catalog.version,
    });
    registerCatalogWithMcp(server, options.catalog, options.handlers, {
      authentication: {
        issuer: authorizationServer,
        audience: options.catalog.audience,
        resource,
        maxTokenTtlSeconds,
      },
      authorize: options.authorize,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    closeServerAfterResponse(server, response);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      options.logger?.error('MCP request failed', error);
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, -32603, 'Internal server error.');
      }
    }
  };

  return Object.freeze({
    mcpPath: '/mcp' as const,
    protectedResourceMetadataPath,
    handleMcp,
    handleProtectedResourceMetadata(
      request: IncomingMessage,
      response: ServerResponse,
    ): void {
      if (!requireResourceHost(request, response, resourceHost)) {
        request.resume();
        return;
      }
      if (!configureCors(request, response, allowedOrigins)) return;
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        sendJsonRpcError(response, 405, -32000, 'Method not allowed.');
        return;
      }
      setJsonHeaders(response, 'public, max-age=300, must-revalidate');
      response.end(JSON.stringify(buildProtectedResourceMetadata({
        resource,
        authorizationServer,
        scopes: requiredScopes,
      })));
    },
  });
}

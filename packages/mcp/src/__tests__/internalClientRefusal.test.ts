import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInternalCatalogMcpClient, InternalMcpRefusedError } from '../internalClient';

/**
 * Which failures prove the operation did NOT run. A caller turns everything
 * else into "outcome unknown", so a refusal misread as unknown tells the model
 * "do not retry, maybe it happened" for a call that never left the gate — what
 * Alia said for every Mention read while Mention's lane answered 503.
 */

const TICKET = 'aaa.bbb.ccc';
let server: Server;
let endpoint: string;
let respond: (
  request: IncomingMessage,
  body: { method?: string; id?: unknown },
  response: ServerResponse,
) => void;

beforeEach(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      respond(request, raw ? JSON.parse(raw) : {}, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_oxy/mcp`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function jsonRpc(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

/** A server that initializes, then answers `tools/call` with `status`. */
function initializeThen(status: number): void {
  respond = (_request, body, response) => {
    if (body.method === 'initialize') {
      jsonRpc(response, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1.0.0' },
        },
      });
      return;
    }
    if (body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    jsonRpc(response, status, {
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32000, message: 'no' },
    });
  };
}

async function callOnce(): Promise<unknown> {
  return createInternalCatalogMcpClient({ endpoint, timeoutMs: 2000 }).callTool(TICKET, 'read', {});
}

it('a lane that is not ready (503 at initialize) is a refusal: nothing ran', async () => {
  respond = (_request, body, response) =>
    jsonRpc(response, 503, {
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32000, message: 'Internal MCP catalogue is not registered with Oxy.' },
    });
  const failure = await callOnce().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(InternalMcpRefusedError);
  expect((failure as InternalMcpRefusedError).status).toBe(503);
});

it('an unreachable app is a refusal: the call was never sent', async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const failure = await callOnce().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(InternalMcpRefusedError);
  expect((failure as InternalMcpRefusedError).status).toBeNull();
  // Reopened so afterEach can close it.
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

it.each([401, 403, 409, 413, 503])('an HTTP %i answer to the call is a refusal', async (status) => {
  initializeThen(status);
  const failure = await callOnce().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(InternalMcpRefusedError);
  expect((failure as InternalMcpRefusedError).status).toBe(status);
});

it.each([408, 500, 502, 504])('an HTTP %i answer to the call stays unknown', async (status) => {
  initializeThen(status);
  const failure = await callOnce().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(InternalMcpRefusedError);
});

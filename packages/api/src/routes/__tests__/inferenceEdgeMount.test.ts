/**
 * Who owns which `/v1` path, asserted against the REAL `server.ts` mount table.
 *
 * ## Why this suite exists
 *
 * ADR 0010 gives `/v1/chat/completions` to the Oxy inference edge. The retired
 * `/alia` and `/v1/voice/*` proxy paths must stay absent.
 *
 * So this is a mount-ORDER gate, and it discriminates by the SHAPE of the
 * answer rather than by a status code: both routers refuse an unauthenticated
 * caller with a 401, and only the edge stamps `X-Oxy-Request-Id` on it.
 *
 * Every assertion here is about routing, so every request is deliberately
 * unauthenticated — the refusal each router produces is the signature being
 * read.
 */

// The run-wide setup replaces `socket.io` with a stub that has no `.use`, and
// importing the real `server.ts` attaches middleware to a real `Server`.
jest.unmock('socket.io');

// `server.ts` runs `validateRequiredEnvVars()` at import and `process.exit(1)`s
// when anything is missing, which would take the whole jest worker with it.
// `??=` so a real value always wins.
process.env.ACCESS_TOKEN_SECRET ??= 'edge-mount-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'edge-mount-refresh-token-secret-32-chars';
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'edge-mount';
process.env.AWS_SECRET_ACCESS_KEY ??= 'edge-mount';
process.env.AWS_S3_BUCKET ??= 'edge-mount';

import type { AddressInfo } from 'node:net';
import { closePostgres, connectPostgres } from '../../config/postgres';

const SLOW_STEP_TIMEOUT_MS = 120_000;

let server: import('http').Server;

async function call(
  method: 'GET' | 'POST',
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; requestId: string | null; body: string }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
  });
  return {
    status: response.status,
    requestId: response.headers.get('x-oxy-request-id'),
    body: await response.text(),
  };
}

beforeAll(async () => {
  await connectPostgres();
  server = (await import('../../server')).default;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
}, SLOW_STEP_TIMEOUT_MS);

describe('/v1 mount order', () => {
  it('gives POST /v1/chat/completions to the inference edge, not the Alia proxy', async () => {
    const response = await call('POST', '/v1/chat/completions');

    expect(response.status).toBe(401);
    // The edge's signature: a request id on every answer, including a rejection
    // that never reached the data plane (ADR 0010).
    expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // ...and the OpenAI error idiom, which the Alia proxy does not speak.
    expect(JSON.parse(response.body)).toEqual({
      error: {
        message: expect.any(String),
        type: 'authentication_error',
        param: null,
        code: 'authentication_failed',
      },
    });
  });

  it('gives POST /v1/responses to the inference edge', async () => {
    const response = await call('POST', '/v1/responses');

    expect(response.status).toBe(401);
    expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(response.body)).toMatchObject({
      schemaVersion: 1,
      code: 'authentication_failed',
      retryable: false,
    });
  });

  it('gives GET /v1/generations/:id to the inference edge', async () => {
    const response = await call('GET', '/v1/generations/anything');

    expect(response.status).toBe(401);
    expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves GET /v1/models from the catalogue router', async () => {
    const response = await call('GET', '/v1/models');

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { data: unknown[]; count: number };
    // Scoped to the SHAPE, not to a count: sibling suites seed catalogue rows
    // into this worker's database, so an exact number would be an assertion
    // about them rather than about this mount.
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.count).toBe('number');
  });

  it('does not expose the removed Oxy-to-Alia voice proxy', async () => {
    const response = await call('POST', '/v1/voice/token');

    expect(response.status).toBe(404);
    expect(response.requestId).toBeNull();
  });

  it('does not expose the removed /alia completion proxy', async () => {
    const response = await call('POST', '/alia/chat/completions');

    expect(response.requestId).toBeNull();
    expect(response.status).toBe(404);
  });

  it('requires a human session on Inbox point inference', async () => {
    const response = await call('POST', '/email/ai/compose', {
      Authorization: 'Bearer invalid-session-token',
      'X-Native-App': 'true',
      'X-CSRF-Token': 'valid-format-csrf-token-for-test',
    });

    expect(response.status).toBe(401);
  });
});

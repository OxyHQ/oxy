/**
 * Who owns which `/v1` path, asserted against the REAL `server.ts` mount table.
 *
 * ## Why this suite exists
 *
 * ADR 0010 gives `/v1/chat/completions` to the Oxy inference edge and leaves
 * `/v1/voice/*` with the Alia proxy. Both live under one prefix, and which one
 * answers depends ENTIRELY on the order of two `app.use('/v1', …)` calls. Swap
 * them and every inference request silently goes back to being proxied to Alia
 * on one shared upstream key with no reservation and no attribution — the exact
 * architecture the epic removes — while every unit test in
 * `inferenceEdge.test.ts` stays green, because that suite mounts the edge router
 * alone.
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

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { closePostgres, connectPostgres } from '../../config/postgres';

const SLOW_STEP_TIMEOUT_MS = 120_000;

let server: import('http').Server;

async function call(
  method: 'GET' | 'POST',
  path: string
): Promise<{ status: number; requestId: string | null; body: string }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
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

  it('leaves POST /v1/voice/token with the Alia proxy', async () => {
    const response = await call('POST', '/v1/voice/token');

    // ADR 0010: the voice routes are Alia PRODUCT endpoints that happen to live
    // under `/v1`; they are not part of the inference edge, and workstream 14
    // decides where they go. The discriminator is the ABSENCE of the edge's
    // request-id header — a 401 alone would be produced by either router.
    expect(response.requestId).toBeNull();
  });

  it('leaves POST /alia/chat/completions with the Alia proxy, so its first-party callers keep a path', async () => {
    const response = await call('POST', '/alia/chat/completions');

    expect(response.requestId).toBeNull();
    // The #981 gate's own refusal, not the edge's.
    expect(response.status).toBe(401);
  });
});

/**
 * The shared-upstream-key routes, counted AND gated (#972 workstream 2.3).
 *
 * Every route in `routes/alia.ts` forwards a caller-supplied body to Alia on the
 * one static `ALIA_API_KEY`, so it bills Oxy's shared upstream budget and no
 * `ownerAccountId` — the exception to the epic's §1 attribution invariant. That
 * makes the FILE the exception list, and an exception list with no exact count
 * grows silently: a fourth route added here would inherit the exemption without
 * anybody deciding to grant it.
 *
 * Two separate claims are asserted, because they can fail independently:
 *
 *   1. The route SET is exactly three. A new shared-key route is a new exemption.
 *   2. Every one of them is behind `requireFirstPartyInferenceCaller`. #981 gated
 *      chat and left the two voice routes on `authMiddleware` alone; workstream
 *      2.3 closed that, so the UNGATED count is now zero and must stay zero.
 *      A route added with a gate is a decision; one added without is the bug.
 *
 * Read from source rather than probed over HTTP because the question is "which
 * routes exist, and what is in front of them" — a live probe can only answer the
 * first, one guessed path at a time, and the route nobody thought to guess is
 * exactly the one this is for. It also cannot distinguish two middlewares that
 * both refuse an unauthenticated caller with a 401, which is the case here.
 *
 * Comments are stripped first. `routes/alia.ts` discusses `router.post` and
 * `authMiddleware` in prose (the #981 header, and the note on why the voice routes
 * were once exempt), so an un-anchored census over the raw text counts sentences
 * as routes.
 */
describe('shared ALIA_API_KEY routes', () => {
  const ALIA_ROUTES_PATH = join(__dirname, '..', 'alia.ts');

  /** The gate #981 introduced and workstream 2.3 extended to every route here. */
  const REQUIRED_GATE = 'requireFirstPartyInferenceCaller';

  /**
   * Exactly the three routes documented in
   * `docs/architecture/inference-responsibility-matrix.md` §3.1, each with the
   * gate it must carry. Retiring them is workstream 14; until then this is the
   * whole list.
   */
  const EXPECTED_SHARED_KEY_ROUTES = [
    `post /chat/completions -> ${REQUIRED_GATE}`,
    `post /voice/token -> ${REQUIRED_GATE}`,
    `post /voice/transcribe -> ${REQUIRED_GATE}`,
  ];

  /**
   * Two censuses over the same stripped source, deliberately NOT one.
   *
   * `all` matches a route declaration and stops at the path, so it counts a route
   * however it is written — with a named middleware, with a different middleware,
   * or with nothing but an inline `(req, res) => …` handler. `gated` is the strict
   * subset whose first argument after the path IS the gate.
   *
   * One combined regex that captured "the middleware" would MISS the inline-handler
   * form entirely rather than flag it, which is the shape that escapes a census
   * while looking like a clean pass. Measured: an earlier version of this helper
   * did exactly that.
   */
  function census(): { all: string[]; gated: string[] } {
    const source = readFileSync(ALIA_ROUTES_PATH, 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Vacuity floor on the strip itself: a regex that ate the file would leave
    // nothing to match, and an empty census is indistinguishable from a clean one.
    expect(code).toContain('const router = Router()');

    const verbs = 'get|post|put|patch|delete';
    const all = [...code.matchAll(new RegExp(`^router\\.(${verbs})\\(\\s*'([^']+)'`, 'gm'))].map(
      (match) => `${match[1]} ${match[2]}`
    );
    const gated = [
      ...code.matchAll(
        new RegExp(`^router\\.(${verbs})\\(\\s*'([^']+)'\\s*,\\s*${REQUIRED_GATE}\\b`, 'gm')
      ),
    ].map((match) => `${match[1]} ${match[2]} -> ${REQUIRED_GATE}`);

    return { all, gated };
  }

  it('declares exactly the three routes the responsibility matrix exempts, each gated', () => {
    expect(census().gated.sort()).toEqual([...EXPECTED_SHARED_KEY_ROUTES].sort());
  });

  it('leaves no shared-key route ungated', () => {
    // The complement of the assertion above, and NOT a restatement of it: this one
    // fails on a route the gated census cannot see. THIS is the property #981 left
    // false and workstream 2.3 made true. Reported as the offending routes rather
    // than a bare count, so a failure names them.
    const { all, gated } = census();
    const gatedPaths = new Set(gated.map((route) => route.slice(0, route.indexOf(' -> '))));

    expect(all.filter((route) => !gatedPaths.has(route))).toEqual([]);
  });
});

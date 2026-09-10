/**
 * Every endpoint of the public inference edge carries the gate and the three rate
 * limiters — enforced, rather than claimed in a comment (issue #972 workstream 4,
 * ADR 0010).
 *
 * ## The gap this closes
 *
 * `routes/inferenceEdge.ts` used to say the rollout check "sits HERE, in the one
 * gate all three endpoints share, so … a fourth endpoint cannot be added without
 * it". That was false: there is no `router.use(edgeGate(...))` — there cannot be,
 * because the two dialects need different error RENDERERS and a `router.use` sees
 * one chain for all of them — so `edgeGate(...)` and the three limiters are
 * hand-repeated on each route and nothing failed if a new route omitted any of
 * them. The streaming paths of #1034 made that surface grow.
 *
 * This file is the enforcement. It DISCOVERS the routes from the router's own
 * stack instead of being handed a list, so a fourth endpoint is swept in
 * automatically, and it checks two different things in two different ways:
 *
 *  - **The gate, BEHAVIOURALLY.** Every discovered route must answer the gate's
 *    own refusal. Each `edgeGate(render)` call returns a fresh closure with an
 *    empty `Function.name`, so it can be identified neither by identity nor by
 *    name — and testing the CONSEQUENCE is stronger anyway, because a gate that
 *    is present and inert would satisfy a stack-shape assertion.
 *  - **The limiters, by IDENTITY and POSITION.** `rateLimit()` returns
 *    `expressRateLimit(...)` directly, so all three have the same `Function.name`
 *    and only identity tells them apart. Position matters because each keys on
 *    state the gate sets (`req.machineCredential`, `req.edge`) and SKIPS when it
 *    is absent — a limiter mounted ahead of the gate is present, green and
 *    completely inert.
 *
 * ## The vacuity floor
 *
 * The discovered set is asserted by NAME against an explicit list. A `filter` typo
 * that discovers zero routes would otherwise report a clean pass over an empty
 * set, and adding a route should force a deliberate edit here rather than silently
 * widening the sweep.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Router } from 'express';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { EDGE_AUDIENCE_VARIABLE, MACHINE_CREDENTIAL_AUTH_VARIABLE } from '../../config/rolloutFlags';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  machineApplicationLimiter,
  machineCredentialLimiter,
} from '../../middleware/machineCredential';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createInferenceEdgeRouter, inferenceEdgeLimiter } from '../inferenceEdge';

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/*  Discovery — from the router's own stack, never from a list                */
/* -------------------------------------------------------------------------- */

/** One route the router actually registered, with its middleware chain. */
interface DiscoveredRoute {
  /** `POST` / `GET`, as `layer.route.stack[n].method` reports it. */
  readonly method: string;
  /** The literal registered path, `:params` included. */
  readonly path: string;
  /** `POST /responses` — the name the vacuity floor is asserted against. */
  readonly name: string;
  /** The handlers in REGISTRATION order. Compared by identity, never by name. */
  readonly handles: readonly unknown[];
}

/**
 * Walk `router.stack` and report every registered route.
 *
 * Express 4's shape, verified empirically against the resolved install rather
 * than recalled: a route-registering layer has a truthy `layer.route`, a
 * `router.use` layer does not, `layer.route.path` is the literal path string and
 * `layer.route.stack` is the middleware chain in registration order with a
 * `.handle` and a `.method` on each entry.
 */
function discoverRoutes(router: Router): DiscoveredRoute[] {
  const discovered: DiscoveredRoute[] = [];

  for (const layer of router.stack) {
    const route = layer.route;
    if (route === undefined) continue;

    const method = (route.stack[0]?.method ?? '').toUpperCase();
    discovered.push({
      method,
      path: route.path,
      name: `${method} ${route.path}`,
      handles: route.stack.map((entry) => entry.handle),
    });
  }

  return discovered;
}

/**
 * Every endpoint this edge is expected to serve.
 *
 * Asserted as a SET EQUALITY, not a floor. Adding an endpoint must fail here
 * first, so whoever adds it reads the two `describe`s below and confirms their
 * route is covered by both — which is the whole mechanism replacing the comment
 * that used to claim this was structurally impossible to get wrong.
 */
const EXPECTED_ROUTES = [
  'POST /responses',
  'POST /chat/completions',
  // The later modalities (#972). Both admit and hold on an EXACT ceiling
  // (`characters` = `input.length`; `images` = `n`) and both answer
  // `service_unavailable` until a data plane is configured. They are listed here
  // because the gate and all three limiters apply to them identically — a
  // modality endpoint is not a special case of the edge, it is another route on it.
  'POST /audio/speech',
  'POST /images/generations',
  'GET /generations/:id',
] as const;

/** A concrete value for every `:param`, so the path is requestable. */
function requestable(path: string): string {
  return `/v1${path.replace(/:[^/]+/g, 'probe-value')}`;
}

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * The router with NO data plane, mounted at `/v1` on a bare app.
 *
 * No kaana client, because nothing here reaches the forward step: every case is
 * refused at the gate, which is the point.
 */
async function withServer(
  run: (
    request: (
      route: DiscoveredRoute,
      headers?: Record<string, string>
    ) => Promise<RawResponse>
  ) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createInferenceEdgeRouter());

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });

  const request = (
    route: DiscoveredRoute,
    headers: Record<string, string> = {}
  ): Promise<RawResponse> => {
    const { port } = server.address() as AddressInfo;
    // A minimal well-formed body. It is never parsed — the gate answers before
    // the route handler's schema does — which is itself part of what these cases
    // assert: an unauthenticated caller is not told their body is malformed.
    const payload = JSON.stringify({ model: 'probe/probe', input: 'probe' });

    return new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: requestable(route.path),
          method: route.method,
          headers: {
            'Content-Type': 'application/json',
            ...(route.method === 'GET'
              ? {}
              : { 'Content-Length': Buffer.byteLength(payload) }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          );
        }
      );
      // A route with NO gate leaves `req.edge` undefined, and its handler's
      // `if (edge === undefined) return;` then answers NOTHING — so the honest
      // failure for a missing gate is a silent socket, and without this it would
      // surface as a generic jest timeout that names neither the route nor the
      // reason. `destroy` is what lets `server.close()` finish afterwards.
      req.setTimeout(5_000, () => {
        req.destroy();
        reject(
          new Error(
            `${route.method} ${route.path} answered nothing within 5000ms — a route whose gate is missing never writes a response`
          )
        );
      });
      req.on('error', reject);
      if (route.method !== 'GET') req.write(payload);
      req.end();
    });
  };

  try {
    await run(request);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * A valid machine credential and nothing else.
 *
 * No catalogue, no price version and no funding, deliberately: the rollout check
 * sits in the gate, BEFORE routing and reservation, so a fixture carrying any of
 * those would let a downstream refusal stand in for the one being measured.
 */
async function makeCredential(): Promise<{ token: string }> {
  const db = getDb();
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const scopes = ['inference:invoke', 'inference:usage:read'];

  const [account] = await db
    .insert(users)
    .values({ username: `gate-${tag}`, email: `gate-${tag}@example.test` })
    .returning({ id: users.id });

  const [application] = await db
    .insert(applications)
    .values({ name: `Gate ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  await db.insert(applicationCredentials).values({
    applicationId: application.id,
    name: `key-${tag}`,
    publicKey: `oxy_dk_${tag}`,
    tokenPrefix: minted.tokenPrefix,
    tokenHash: minted.tokenHash,
    type: 'machine',
    environment: 'development',
    scopes,
    status: 'active',
  });

  return { token: minted.token };
}

const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  [EDGE_AUDIENCE_VARIABLE, MACHINE_CREDENTIAL_AUTH_VARIABLE].map((key) => [
    key,
    process.env[key],
  ])
);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  The vacuity floor                                                        */
/* -------------------------------------------------------------------------- */

describe('the discovered route set', () => {
  it('is exactly the endpoints this edge serves', () => {
    const routes = discoverRoutes(createInferenceEdgeRouter());

    // Set equality, so a `filter` typo that discovers nothing is a red rather
    // than a clean pass over an empty sweep, and a new endpoint has to be
    // acknowledged here before the assertions below can claim to cover it.
    expect(routes.map((route) => route.name).sort()).toEqual([...EXPECTED_ROUTES].sort());

    // Each chain is the gate, the three limiters and the handler. An exact length
    // rather than a floor: a chain that grew or shrank is a change to the thing
    // this file measures, and it should be read here rather than absorbed.
    for (const route of routes) {
      expect(route.handles).toHaveLength(5);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Spec A — the gate, behaviourally                                          */
/* -------------------------------------------------------------------------- */

describe('every registered route runs the gate', () => {
  it('refuses an unauthenticated request with a typed, traceable 401', async () => {
    const routes = discoverRoutes(createInferenceEdgeRouter());
    expect(routes).toHaveLength(EXPECTED_ROUTES.length);

    await withServer(async (request) => {
      for (const route of routes) {
        const response = await request(route);
        const body = JSON.parse(response.body) as Record<string, unknown>;

        // Named in the failure message, so a red says WHICH route lost its gate
        // rather than reporting an anonymous 404 or hang.
        expect({ route: route.name, status: response.status }).toEqual({
          route: route.name,
          status: 401,
        });

        // ADR 0010's step 1: a request id is allocated before authentication, so
        // a refused caller can report the failure by id. A route with no gate
        // never sets it.
        expect(response.headers['x-oxy-request-id']).toMatch(/^[0-9a-f-]{36}$/);

        // One of exactly TWO typed shapes — the renderer legitimately differs per
        // dialect, and that difference is the reason the gate cannot be hoisted to
        // a `router.use`. Asserting "either of these two" rather than "a 401
        // happened" is what keeps a bare platform error envelope from passing.
        const oxyShape =
          body.code === 'authentication_failed' && body.retryable === false;
        const openAiShape =
          typeof body.error === 'object' &&
          body.error !== null &&
          (body.error as Record<string, unknown>).code === 'authentication_failed' &&
          (body.error as Record<string, unknown>).type === 'authentication_error';
        expect({ route: route.name, typed: oxyShape || openAiShape }).toEqual({
          route: route.name,
          typed: true,
        });
      }
    });
  });

  it('refuses an AUTHENTICATED request outside this deployment’s audience', async () => {
    // The sharper half. An endpoint added with authentication but no admission
    // check would pass the case above and fail here — and that is the more likely
    // mistake of the two, because an authentication failure is loud while an
    // audience that silently serves everybody is not.
    delete process.env[EDGE_AUDIENCE_VARIABLE];
    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'enabled';

    const credential = await makeCredential();
    const routes = discoverRoutes(createInferenceEdgeRouter());
    expect(routes).toHaveLength(EXPECTED_ROUTES.length);

    await withServer(async (request) => {
      for (const route of routes) {
        const response = await request(route, {
          Authorization: `Bearer ${credential.token}`,
        });
        const body = JSON.parse(response.body) as Record<string, unknown>;
        const code =
          typeof body.error === 'object' && body.error !== null
            ? (body.error as Record<string, unknown>).code
            : body.code;

        expect({ route: route.name, status: response.status, code }).toEqual({
          route: route.name,
          status: 403,
          code: 'permission_denied',
        });
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Spec B — the limiters, by identity and position                           */
/* -------------------------------------------------------------------------- */

describe('every registered route mounts all three rate limiters', () => {
  it('carries them by identity, after the gate and before the handler', () => {
    const routes = discoverRoutes(createInferenceEdgeRouter());
    expect(routes).toHaveLength(EXPECTED_ROUTES.length);

    const limiters = [
      ['machineCredentialLimiter', machineCredentialLimiter],
      ['machineApplicationLimiter', machineApplicationLimiter],
      ['inferenceEdgeLimiter', inferenceEdgeLimiter],
    ] as const;

    for (const route of routes) {
      const indexes = limiters.map(([name, limiter]) => {
        const index = route.handles.indexOf(limiter);
        // Identity, because all three come from one factory and share a
        // `Function.name`; a name-based check could not tell them apart at all.
        expect({ route: route.name, limiter: name, mounted: index !== -1 }).toEqual({
          route: route.name,
          limiter: name,
          mounted: true,
        });
        return { name, index };
      });

      for (const { name, index } of indexes) {
        // AFTER the gate. `machineCredentialLimiter` keys on
        // `req.machineCredential.credentialId` and `inferenceEdgeLimiter` on
        // `req.edge.principal.credentialId`, and both SKIP when their key is
        // absent — so one mounted at index 0 counts nothing, on every request,
        // while every other test in the repo stays green.
        expect({ route: route.name, limiter: name, afterTheGate: index > 0 }).toEqual({
          route: route.name,
          limiter: name,
          afterTheGate: true,
        });
        // …and before the handler, which is the last entry in the chain.
        expect({
          route: route.name,
          limiter: name,
          beforeTheHandler: index < route.handles.length - 1,
        }).toEqual({ route: route.name, limiter: name, beforeTheHandler: true });
      }

      // Three DISTINCT positions: `indexOf` would report the same index three
      // times if two of the limiters were ever the same object, which is exactly
      // the `ERR_ERL_DOUBLE_COUNT` shared-key mistake the prefix rule prevents.
      expect(new Set(indexes.map(({ index }) => index)).size).toBe(3);

      // Index 0 is the gate. Not asserted by identity — each `edgeGate(render)`
      // call returns a fresh closure — but it is provably not a limiter, and the
      // behavioural cases above prove it is the gate.
      expect(limiters.map(([, limiter]) => limiter)).not.toContain(route.handles[0]);
    }
  });
});

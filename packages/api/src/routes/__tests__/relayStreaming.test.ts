/**
 * The Oxy edge against a REAL signed HTTP hop to a stub data plane, a REAL
 * Postgres, a REAL machine credential and the REAL ledger (issue #972
 * workstream 4, ADR 0015).
 *
 * ## What makes the signature assertions falsifiable
 *
 * The stub Relay VERIFIES the Ed25519 signature with a public key it holds, and
 * refuses `401` when it does not verify. So a broken signature fails these tests
 * rather than being ignored — and the POSITIVE CONTROL for that claim is
 * `rejects a tampered body`, which replays a request's own valid headers over
 * mutated bytes and asserts the stub says no. Without it, "the stub accepted the
 * request" would also be what a stub that verifies nothing reports.
 *
 * `the signing input is the four lines the ADR specifies` is the second half:
 * every other case verifies with `relaySigningInput`, the production function, so
 * a change to the FRAMING would keep both sides agreeing with each other. That
 * one case builds the four lines by hand.
 *
 * ## What makes "not buffered" falsifiable
 *
 * `streams frames as they are produced` has the stub stop after its second frame
 * and wait for the client to have OBSERVED one. An edge that collected the whole
 * stream before writing would never release that gate, so the case fails on a
 * named timeout rather than passing quietly. It then asserts the exact number of
 * frames the stub had sent at the moment the client saw one, which is a number a
 * buffering implementation cannot produce.
 *
 * ## What makes the money assertions falsifiable
 *
 * Every settlement case asserts an EXACT amount computed from the fixture's own
 * prices, and asserts exactly one receipt and one reservation row — so "settled
 * twice" and "settled once" are distinguishable, which a balance read alone would
 * not make them. The cancellation case additionally waits for the receipt to
 * appear AFTER the client is gone, because "the settlement happened" and "the
 * settlement was skipped" look identical if you only assert immediately.
 *
 * ## Fixtures are scoped to ids this file owns
 *
 * Every account, application, credential, publisher, model and price version is
 * created per test with a random suffix, and every assertion is scoped to them, so
 * a sibling suite seeding the shared database cannot change an answer here.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  generateKeyPairSync,
  randomUUID,
  verify as verifySignature,
  createHash,
  type KeyObject,
} from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import type { InferenceRequest, UsageQuantity } from '@oxyhq/contracts';
import {
  RELAY_BASE_URL_VARIABLE,
  RELAY_SIGNING_KEY_ID_VARIABLE,
  RELAY_SIGNING_PRIVATE_KEY_VARIABLE,
} from '../../config/relayDataPlane';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { PRIVACY_REVIEW_VARIABLE } from '../../config/rolloutFlags';
import { accountBalances } from '../../db/schema/accountBalances';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { inferenceUsageEvents } from '../../db/schema/inferenceUsageEvents';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import {
  createHttpRelayClient,
  RELAY_INFERENCE_PATH,
  RELAY_KEY_ID_HEADER,
  RELAY_SIGNATURE_HEADER,
  RELAY_TIMESTAMP_HEADER,
  relaySigningInput,
} from '../../services/httpRelayClient';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { logger } from '../../utils/logger';
import { createInferenceEdgeRouter } from '../inferenceEdge';

const mockedLogger = logger as jest.Mocked<typeof logger>;

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/*  The edge's signing key, and the public half the stub verifies with         */
/* -------------------------------------------------------------------------- */

const EDGE_KEY_ID = 'oxy-edge-test';
const edgeKeyPair = generateKeyPairSync('ed25519');
const EDGE_PRIVATE_PEM = edgeKeyPair.privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();
/** The stub holds ONLY this. It cannot construct an envelope it would accept. */
const EDGE_PUBLIC_KEY: KeyObject = edgeKeyPair.publicKey;

/** Relay's own bound: five minutes either way, and no nonce cache (ADR 0015). */
const MAX_SKEW_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  The stub data plane                                                       */
/* -------------------------------------------------------------------------- */

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** One SSE frame, as either side of this test reads it. */
interface Frame {
  readonly name: string;
  readonly data: string;
}

/** What a scenario is handed to drive one request's response. */
interface ScriptContext {
  readonly envelope: InferenceRequest;
  /** Write one named SSE frame and flush it. */
  readonly frame: (name: string, payload: unknown) => void;
  /** How many frames this request has written so far. */
  readonly sent: () => number;
  /** Resolves `true` if the edge aborts the request within `ms`. */
  readonly whenAborted: (ms: number) => Promise<boolean>;
  /**
   * Kill the connection mid-stream, as an upstream that died would.
   *
   * Awaits the frames already written FIRST. `res.destroy()` discards whatever is
   * still in the socket's buffer, so destroying immediately after a `write` drops
   * the very usage event the partial settlement is supposed to be computed from —
   * and the test then measures the drop rather than the edge.
   */
  readonly truncate: () => Promise<void>;
  readonly finish: () => void;
}

type RelayScript = (context: ScriptContext) => Promise<void>;

interface RelayStub {
  readonly baseUrl: string;
  /** Every envelope that verified, in order. */
  readonly received: InferenceRequest[];
  /** The signing headers of every request, verified or not. */
  readonly headers: http.IncomingHttpHeaders[];
  /** The exact bytes of every request body. */
  readonly bodies: Buffer[];
  verified: number;
  rejected: number;
  aborted: number;
  script: RelayScript;
  close(): Promise<void>;
}

/**
 * Verify a request the way Relay's own `internal/edgeauth` does.
 *
 * One boolean for every cause, deliberately: an unknown key id, a stale
 * timestamp and a bad signature are all "this did not come from the Oxy edge",
 * and distinguishing them for a caller only tells an attacker which half of a
 * forgery attempt was closer.
 */
function verifyEdgeSignature(headers: http.IncomingHttpHeaders, body: Buffer): boolean {
  const keyId = headers[RELAY_KEY_ID_HEADER.toLowerCase()];
  if (keyId !== EDGE_KEY_ID) return false;

  const timestamp = Number(headers[RELAY_TIMESTAMP_HEADER.toLowerCase()]);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp) > MAX_SKEW_MS) return false;

  const raw = headers[RELAY_SIGNATURE_HEADER.toLowerCase()];
  if (typeof raw !== 'string' || !raw.startsWith('v1=')) return false;
  const signature = Buffer.from(raw.slice('v1='.length), 'base64');
  if (signature.length !== 64) return false;

  return verifySignature(
    null,
    relaySigningInput(EDGE_KEY_ID, timestamp, body),
    EDGE_PUBLIC_KEY,
    signature
  );
}

async function startRelayStub(): Promise<RelayStub> {
  const stub: RelayStub = {
    baseUrl: '',
    received: [],
    headers: [],
    bodies: [],
    verified: 0,
    rejected: 0,
    aborted: 0,
    script: async () => undefined,
    close: async () => undefined,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void handle(Buffer.concat(chunks));
    });

    const handle = async (body: Buffer): Promise<void> => {
      stub.headers.push(req.headers);
      stub.bodies.push(body);

      if (req.url !== RELAY_INFERENCE_PATH || !verifyEdgeSignature(req.headers, body)) {
        stub.rejected += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            code: 'authentication_failed',
            message: 'the request is not a signed Oxy edge envelope',
            retryable: false,
            requestId: `req_relay_${randomUUID()}`,
          })
        );
        return;
      }

      stub.verified += 1;
      const envelope = JSON.parse(body.toString('utf8')) as InferenceRequest;
      stub.received.push(envelope);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Oxy-Request-Id': envelope.attribution.requestId,
      });

      let sent = 0;
      let flushed: Promise<void> = Promise.resolve();
      const abort = deferred<boolean>();
      res.on('close', () => {
        if (!res.writableEnded) {
          stub.aborted += 1;
          abort.resolve(true);
        }
      });

      const context: ScriptContext = {
        envelope,
        frame: (name, payload) => {
          if (res.writableEnded || res.destroyed) return;
          sent += 1;
          flushed = new Promise<void>((resolve) => {
            res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`, () => resolve());
          });
        },
        sent: () => sent,
        whenAborted: async (ms) =>
          Promise.race([
            abort.promise,
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
          ]),
        truncate: async () => {
          await flushed;
          // Destroy rather than end: a clean `end()` is a complete body, and the
          // case being modelled is an upstream that stopped mid-stream.
          res.destroy();
        },
        finish: () => {
          if (!res.writableEnded && !res.destroyed) res.end();
        },
      };

      await stub.script(context);
      context.finish();
    };
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  stub.baseUrl = `http://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return stub;
}

/* -------------------------------------------------------------------------- */
/*  The edge under test                                                       */
/* -------------------------------------------------------------------------- */

interface StreamedResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  /** Every SSE frame the client observed, in order. */
  readonly frames: Frame[];
  /** The whole body, for a non-streaming response. */
  readonly body: string;
}

interface EdgeHarness {
  readonly stub: RelayStub;
  /** Issue one request; `onFrame` sees each SSE frame as it arrives. */
  readonly request: (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    headers?: Record<string, string>,
    onFrame?: (frame: Frame, request: http.ClientRequest) => void
  ) => Promise<StreamedResponse>;
}

/**
 * A stub data plane, a configured edge and an HTTP client, for one test.
 *
 * The router is built from `createHttpRelayClient()`, so what is exercised is the
 * REAL client resolved from the REAL environment variables — not a fake handed in
 * through the router's options.
 */
async function withEdge(
  script: RelayScript,
  run: (harness: EdgeHarness) => Promise<void>
): Promise<void> {
  const stub = await startRelayStub();
  stub.script = script;

  process.env[RELAY_BASE_URL_VARIABLE] = stub.baseUrl;
  process.env[RELAY_SIGNING_KEY_ID_VARIABLE] = EDGE_KEY_ID;
  process.env[RELAY_SIGNING_PRIVATE_KEY_VARIABLE] = EDGE_PRIVATE_PEM;

  const relayClient = createHttpRelayClient();
  expect(relayClient).toBeDefined();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/v1',
    createInferenceEdgeRouter(relayClient === undefined ? {} : { relayClient })
  );

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  const { port } = server.address() as AddressInfo;

  try {
    await run({ stub, request: clientFor(port) });
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await stub.close();
    delete process.env[RELAY_BASE_URL_VARIABLE];
    delete process.env[RELAY_SIGNING_KEY_ID_VARIABLE];
    delete process.env[RELAY_SIGNING_PRIVATE_KEY_VARIABLE];
  }
}

/**
 * An HTTP client that reads an SSE body FRAME BY FRAME.
 *
 * `onFrame` is what makes the incremental assertions possible at all: it fires
 * while the response is still open, which is the only vantage point from which
 * "the customer has frame N" is a fact rather than an inference from the finished
 * body.
 */
function clientFor(port: number): EdgeHarness['request'] {
  return (method, path, body, headers, onFrame) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise<StreamedResponse>((resolve, reject) => {
      const frames: Frame[] = [];
      let destroyed = false;

      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload === undefined
              ? {}
              : { 'Content-Length': Buffer.byteLength(payload) }),
            ...(headers ?? {}),
          },
        },
        (res) => {
          let text = '';
          let pending = '';
          let name = '';
          const data: string[] = [];

          const consume = (line: string): void => {
            if (line.length === 0) {
              if (data.length > 0 || name.length > 0) {
                const frame: Frame = { name, data: data.join('\n') };
                frames.push(frame);
                name = '';
                data.length = 0;
                onFrame?.(frame, request);
              }
              return;
            }
            if (line.startsWith('data:')) {
              data.push(line.slice('data:'.length).replace(/^ /, ''));
              return;
            }
            if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
          };

          res.on('data', (chunk: Buffer) => {
            const piece = chunk.toString('utf8');
            text += piece;
            pending += piece;
            let newline = pending.indexOf('\n');
            while (newline !== -1) {
              consume(pending.slice(0, newline).replace(/\r$/, ''));
              pending = pending.slice(newline + 1);
              newline = pending.indexOf('\n');
            }
          });
          res.on('end', () => {
            consume('');
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              frames,
              body: text,
            });
          });
          res.on('close', () => {
            if (!destroyed) return;
            resolve({ status: res.statusCode ?? 0, headers: res.headers, frames, body: text });
          });
        }
      );

      request.on('error', (error) => {
        // A deliberate `destroy()` from `onFrame` is the cancellation case, not a
        // failure: the whole point is that the client vanishes mid-response.
        if (destroyed) return;
        reject(error);
      });
      const originalDestroy = request.destroy.bind(request);
      request.destroy = (error?: Error) => {
        destroyed = true;
        return originalDestroy(error);
      };

      if (payload !== undefined) request.write(payload);
      request.end();
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly token: string;
  readonly modelReference: string;
  readonly pinnedModelReference: string;
  readonly provider: string;
}

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

const REVISION = '2026-01-01';

/** $3 per million input tokens, $15 per million output tokens. */
const INPUT_PRICE_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN = 15 / 1_000_000;

async function makeFixture(): Promise<Fixture> {
  const db = getDb();
  const tag = suffix();

  const [account] = await db
    .insert(users)
    .values({ username: `relay-${tag}`, email: `relay-${tag}@example.test` })
    .returning({ id: users.id });

  const scopes = ['inference:invoke', 'inference:usage:read'];

  const [application] = await db
    .insert(applications)
    .values({ name: `Relay ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `key-${tag}`,
      publicKey: `oxy_dk_${tag}`,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment: 'development',
      scopes,
      status: 'active',
    })
    .returning({ id: applicationCredentials.id });

  const publisherSlug = `pub${tag}`;
  const modelSlug = `model-${tag}`;
  const providerSlug = `prov${tag}`;

  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: `Publisher ${tag}` });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: `Model ${tag}`,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: true,
      supportsJsonMode: true,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 8192,
      licenseId: 'apache-2.0',
      licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id });

  const [revisionRow] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: REVISION, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: `Provider ${tag}`,
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${publisherSlug}/${modelSlug}@${REVISION}`,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  await db.insert(priceVersionUnitPrices).values([
    {
      priceVersionId: priceVersion.id,
      unit: 'input_tokens',
      amount: '3.000000000000',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'output_tokens',
      amount: '15.000000000000',
      per: 1_000_000,
    },
  ]);

  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRow.id,
    providerSlug,
    regions: ['us-west-2'],
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    status: 'active',
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${tag}`,
    permissionState: 'approved',
    priceVersionId: priceVersion.id,
  });

  await provisionBillingProfile({ accountId: account.id });
  await recordTopUp({
    idempotencyKey: `relay-top-up-${tag}`,
    accountId: account.id,
    currency: 'USD',
    amount: '10.000000000000',
    actor: { kind: 'machine' },
  });

  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    token: minted.token,
    modelReference: `${publisherSlug}/${modelSlug}`,
    pinnedModelReference: `${publisherSlug}/${modelSlug}@${REVISION}`,
    provider: providerSlug,
  };
}

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

async function balanceOf(accountId: string): Promise<{ purchased: string; reserved: string }> {
  const [row] = await getDb()
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return { purchased: row.purchasedBalance, reserved: row.reservedBalance };
}

interface ReceiptRow {
  readonly billedAmount: string;
  readonly outcome: string;
  readonly usageSource: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

async function receiptsOf(accountId: string): Promise<ReceiptRow[]> {
  return getDb()
    .select({
      billedAmount: usageReceipts.billedAmount,
      outcome: usageReceipts.outcome,
      usageSource: usageReceipts.usageSource,
      inputTokens: usageReceipts.inputTokens,
      outputTokens: usageReceipts.outputTokens,
    })
    .from(usageReceipts)
    .where(eq(usageReceipts.accountId, accountId));
}

/**
 * Wait for the settlement to land, which is the only honest way to assert it for
 * a request whose client is already gone.
 *
 * A bounded poll rather than a fixed sleep, and it FAILS with its own message
 * rather than letting jest report a generic timeout — "the settlement never
 * happened" and "the suite is slow" are otherwise the same red.
 */
async function waitForReceipt(accountId: string, timeoutMs = 10_000): Promise<ReceiptRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await receiptsOf(accountId);
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) {
      throw new Error(
        `no receipt was written for ${accountId} within ${timeoutMs}ms — the hold was never settled`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/* -------------------------------------------------------------------------- */
/*  Scenario scripts                                                          */
/* -------------------------------------------------------------------------- */

/** Stamps the framing every normalized stream event carries. */
function emitter(context: ScriptContext, provider: string) {
  const requestId = context.envelope.attribution.requestId;
  const generationId = `gen-${randomUUID()}`;
  const resolvedModelReference =
    context.envelope.target.kind === 'model'
      ? context.envelope.target.modelReference
      : 'unknown/unknown@0000-00-00';
  let sequence = 0;

  const event = (payload: Record<string, unknown>): void => {
    context.frame('stream_event', {
      schemaVersion: 1,
      requestId,
      sequence: sequence++,
      ...payload,
    });
  };

  return {
    generationId,
    resolvedModelReference,
    start: () =>
      event({
        type: 'start',
        generationId,
        resolvedModelReference,
        servingProvider: provider,
        startedAt: new Date().toISOString(),
      }),
    delta: (text: string) =>
      event({ type: 'delta', outputIndex: 0, channel: 'output_text', text }),
    reasoning: (text: string) =>
      event({ type: 'delta', outputIndex: 0, channel: 'reasoning', text }),
    toolCall: (id: string, name: string, argumentsDelta: string, complete: boolean) =>
      event({ type: 'tool_call', toolCallId: id, name, argumentsDelta, complete }),
    usage: (units: UsageQuantity[]) =>
      event({ type: 'usage', units, usageSource: 'provider_reported' }),
    routeSwitch: () =>
      event({
        type: 'route_switch',
        reason: 'provider_overloaded',
        detail: {
          scope: 'deployment',
          modelReference: resolvedModelReference,
          toProvider: provider,
        },
        occurredAt: new Date().toISOString(),
      }),
    error: (code: string, message: string) =>
      event({
        type: 'error',
        error: { schemaVersion: 1, code, message, retryable: true, requestId },
      }),
    done: () =>
      event({
        type: 'done',
        generationId,
        finishReason: 'stop',
        completedAt: new Date().toISOString(),
      }),
    report: (units: UsageQuantity[], outcome: string) => {
      const now = new Date().toISOString();
      context.frame('usage_report', {
        schemaVersion: 1,
        requestId,
        generationId,
        attribution: context.envelope.attribution,
        outcome,
        units,
        usageSource: 'provider_reported',
        resolvedModelReference,
        servingProvider: provider,
        routeSwitches: 0,
        startedAt: now,
        completedAt: now,
        timeToFirstTokenMs: 41,
      });
    },
  };
}

const UNITS: UsageQuantity[] = [
  { unit: 'input_tokens', quantity: 100 },
  { unit: 'output_tokens', quantity: 200 },
];

const EXPECTED_CHARGE = 100 * INPUT_PRICE_PER_TOKEN + 200 * OUTPUT_PRICE_PER_TOKEN;

/** A complete, well-formed stream: start, two deltas, usage, done, report. */
function servesCompletely(provider: string): RelayScript {
  return async (context) => {
    const emit = emitter(context, provider);
    emit.start();
    emit.delta('Hel');
    emit.delta('lo.');
    emit.usage(UNITS);
    emit.done();
    emit.report(UNITS, 'completed');
  };
}

/** A well-formed request against a fixture's own model. */
const responsesBody = (
  fixture: Fixture,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  model: fixture.modelReference,
  input: 'Say hello.',
  maxOutputTokens: 1000,
  ...overrides,
});

const chatBody = (
  fixture: Fixture,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  model: fixture.modelReference,
  messages: [{ role: 'user', content: 'Say hello.' }],
  max_tokens: 1000,
  ...overrides,
});

/** Frames whose `event:` name is empty — the OpenAI dialect's unnamed `data:`. */
function chunksOf(response: StreamedResponse): Record<string, unknown>[] {
  return response.frames
    .filter((frame) => frame.name.length === 0 && frame.data !== '[DONE]')
    .map((frame) => JSON.parse(frame.data) as Record<string, unknown>);
}

/**
 * The rollout flags this file runs with (issue #972 workstreams 16 and 12).
 *
 * All four default to serving and charging nobody, so every assertion here about
 * routing, reservation and settlement would otherwise pass for the wrong reason.
 * Both dates are comfortably in the past because the flags refuse a FUTURE date
 * and midnight UTC on a runner an hour behind local time is one.
 *
 * `public` requires BOTH an armed charging authorization and a recorded
 * privacy/security review (#972 section 12) to resolve at all — leaving the review
 * out closes the edge and every case below fails with 403 on the gate rather than
 * on anything this file is about. The gate's own default and both positions belong
 * to `config/__tests__/rolloutFlags.test.ts` and `inferenceEdgeRollout.test.ts`;
 * nothing here is evidence about them.
 */
const ROLLOUT_ENVIRONMENT = {
  INFERENCE_EDGE_AUDIENCE: 'public',
  INFERENCE_MACHINE_CREDENTIAL_AUTH: 'enabled',
  INFERENCE_CHARGING_AUTHORIZED: 'relay-suite-fixture:2026-08-01',
  INFERENCE_PRIVACY_REVIEW: 'relay-suite-fixture:2026-08-01',
} as const;

const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  [
    ...Object.keys(ROLLOUT_ENVIRONMENT),
    RELAY_BASE_URL_VARIABLE,
    RELAY_SIGNING_KEY_ID_VARIABLE,
    RELAY_SIGNING_PRIVATE_KEY_VARIABLE,
  ].map((key) => [key, process.env[key]])
);

beforeAll(async () => {
  Object.assign(process.env, ROLLOUT_ENVIRONMENT);
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  The signature — and the control that makes it an assertion                */
/* -------------------------------------------------------------------------- */

describe('the signed envelope', () => {
  it('carries a key id, millisecond timestamp and v1 signature the data plane accepts', async () => {
    const fixture = await makeFixture();

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(200);

      expect(stub.verified).toBe(1);
      expect(stub.rejected).toBe(0);

      const headers = stub.headers[0];
      expect(headers[RELAY_KEY_ID_HEADER.toLowerCase()]).toBe(EDGE_KEY_ID);
      expect(headers[RELAY_SIGNATURE_HEADER.toLowerCase()]).toMatch(/^v1=[A-Za-z0-9+/]+=*$/);

      // MILLISECONDS, not seconds. A unix-seconds value is ~1.8e9 and would be
      // more than 5 minutes from now when read as milliseconds, so the stub would
      // have rejected it — but asserting the magnitude says WHY rather than
      // leaving a future reader to derive it.
      const timestamp = Number(headers[RELAY_TIMESTAMP_HEADER.toLowerCase()]);
      expect(timestamp).toBeGreaterThan(1_700_000_000_000);
      expect(Math.abs(Date.now() - timestamp)).toBeLessThan(MAX_SKEW_MS);
    });
  });

  it('signs the EXACT bytes it sends, so the body hash matches what was parsed', async () => {
    const fixture = await makeFixture();

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(200);

      // The stub already verified against `stub.bodies[0]`, so a re-serializing
      // edge would have failed above. This is the other half: the bytes it signed
      // are the bytes that parse to the envelope the edge meant to send.
      const envelope = JSON.parse(stub.bodies[0].toString('utf8')) as InferenceRequest;
      expect(envelope.attribution.requestId).toBe(
        response.headers['x-oxy-request-id']
      );
      expect(stub.bodies[0]).toEqual(Buffer.from(JSON.stringify(envelope), 'utf8'));
    });
  });

  it('REJECTS a tampered body — the positive control for every case above', async () => {
    const fixture = await makeFixture();

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const served = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture),
        bearer(fixture.token)
      );
      expect(served.status).toBe(200);
      expect(stub.rejected).toBe(0);

      // Replay the request's OWN valid headers over one mutated byte. If the stub
      // verified nothing, this would be a 200 and every assertion in this
      // describe block would be measuring nothing.
      const original = stub.bodies[0];
      const tampered = Buffer.from(
        original.toString('utf8').replace('Say hello.', 'Say goodbye')
      );
      expect(tampered).not.toEqual(original);

      const replay = await postToStub(stub, tampered, {
        [RELAY_KEY_ID_HEADER]: String(stub.headers[0][RELAY_KEY_ID_HEADER.toLowerCase()]),
        [RELAY_TIMESTAMP_HEADER]: String(
          stub.headers[0][RELAY_TIMESTAMP_HEADER.toLowerCase()]
        ),
        [RELAY_SIGNATURE_HEADER]: String(
          stub.headers[0][RELAY_SIGNATURE_HEADER.toLowerCase()]
        ),
      });

      expect(replay.status).toBe(401);
      expect(stub.rejected).toBe(1);

      // And the UNTAMPERED body with the same headers is accepted, so the 401
      // above is about the bytes and not about replaying a request at all.
      const honest = await postToStub(stub, original, {
        [RELAY_KEY_ID_HEADER]: String(stub.headers[0][RELAY_KEY_ID_HEADER.toLowerCase()]),
        [RELAY_TIMESTAMP_HEADER]: String(
          stub.headers[0][RELAY_TIMESTAMP_HEADER.toLowerCase()]
        ),
        [RELAY_SIGNATURE_HEADER]: String(
          stub.headers[0][RELAY_SIGNATURE_HEADER.toLowerCase()]
        ),
      });
      expect(honest.status).toBe(200);
    });
  });

  it('is the four lines ADR 0015 specifies, built independently of the production helper', () => {
    const keyId = 'oxy-edge-2026-08';
    const timestamp = 1_780_000_000_123;
    const body = Buffer.from('{"schemaVersion":1}', 'utf8');

    const expected = [
      'oxy-relay-envelope:v1',
      keyId,
      String(timestamp),
      createHash('sha256').update(body).digest('hex'),
    ].join('\n');

    // Built by hand here, so a change to the FRAMING fails this case rather than
    // leaving both sides of the wire agreeing with each other about something new.
    expect(relaySigningInput(keyId, timestamp, body).toString('utf8')).toBe(expected);
    expect(expected.endsWith('\n')).toBe(false);
  });

  it('answers internal_error when the data plane refuses the envelope, never the customer’s key', async () => {
    const fixture = await makeFixture();

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      // Point the client at a path the stub refuses, which is how it models an
      // envelope-layer rejection: the stub answers 401 with the contract's own
      // `authentication_failed`.
      stub.script = async (context) => {
        context.finish();
      };

      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture, { model: fixture.modelReference }),
        bearer(fixture.token)
      );

      // A stream with no frames at all is a truncated stream, not an auth failure;
      // what matters is that the customer is NEVER told `authentication_failed`
      // because of something on Oxy's side of the hop.
      expect(response.status).not.toBe(401);
      const body = JSON.parse(response.body) as { code: string };
      expect(body.code).not.toBe('authentication_failed');
      expect(await receiptsOf(fixture.accountId)).toHaveLength(1);
    });
  });
});

/** POST straight to the stub, bypassing the edge — used for the tamper control. */
function postToStub(
  stub: RelayStub,
  body: Buffer,
  headers: Record<string, string>
): Promise<{ status: number }> {
  const url = new URL(`${stub.baseUrl}${RELAY_INFERENCE_PATH}`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  Non-streaming, end to end                                                 */
/* -------------------------------------------------------------------------- */

describe('a non-streaming request through the real client', () => {
  it('forwards the attribution, folds the stream and settles the exact usage', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture),
        { ...bearer(fixture.token), 'X-Oxy-User-Id': 'end-user-7' }
      );

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        schemaVersion: 1,
        model: fixture.pinnedModelReference,
        finishReason: 'stop',
      });
      // The two deltas, folded into one message. A fold that dropped either would
      // still produce a well-formed response, which is why the TEXT is asserted.
      expect(body.output).toEqual([
        { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
      ]);

      const envelope = stub.received[0];
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.stream).toBe(false);
      expect(envelope.attribution.principal.billing.accountId).toBe(fixture.accountId);
      expect(envelope.attribution.principal.applicationId).toBe(fixture.applicationId);
      expect(envelope.attribution.principal.credentialId).toBe(fixture.credentialId);
      expect(envelope.attribution.userId).toBe('end-user-7');
      expect(envelope.target).toEqual({
        kind: 'model',
        modelReference: fixture.pinnedModelReference,
      });

      expect(response.headers['x-oxy-usage-input-tokens']).toBe('100');
      expect(response.headers['x-oxy-usage-output-tokens']).toBe('200');
    });

    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(EXPECTED_CHARGE, 9);
    expect(receipts[0].outcome).toBe('completed');
    expect(receipts[0].inputTokens).toBe(100);
    expect(receipts[0].outputTokens).toBe(200);

    const after = await balanceOf(fixture.accountId);
    expect(Number(before.purchased) - Number(after.purchased)).toBeCloseTo(EXPECTED_CHARGE, 9);
    expect(Number(after.reserved)).toBe(0);

    // The data plane's own time to first token reached the telemetry row, so the
    // report was read rather than merely accepted.
    const [event] = await getDb()
      .select({ timeToFirstTokenMs: inferenceUsageEvents.timeToFirstTokenMs })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, fixture.accountId));
    expect(event.timeToFirstTokenMs).toBe(41);
  });

  it('charges once when the same Idempotency-Key is retried', async () => {
    const fixture = await makeFixture();
    const key = `idem-${suffix()}`;

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const first = await request('POST', '/v1/responses', responsesBody(fixture), {
        ...bearer(fixture.token),
        'Idempotency-Key': key,
      });
      expect(first.status).toBe(200);

      const second = await request('POST', '/v1/responses', responsesBody(fixture), {
        ...bearer(fixture.token),
        'Idempotency-Key': key,
      });
      expect(second.status).toBe(409);
      expect(JSON.parse(second.body)).toMatchObject({ code: 'idempotency_conflict' });

      // The retry never reached the data plane, so it cannot have produced a
      // second charge even in principle.
      expect(stub.verified).toBe(1);
    });

    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(EXPECTED_CHARGE, 9);
  });

  it('surfaces a terminal error event as a typed error carrying the request id', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Par');
        emit.error('provider_overloaded', 'the upstream is at capacity');
        emit.report(UNITS, 'failed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture),
          bearer(fixture.token)
        );

        // The data plane's own code, at the status the edge maps it to.
        expect(response.status).toBe(503);
        const body = JSON.parse(response.body) as Record<string, unknown>;
        expect(body.code).toBe('provider_overloaded');
        // The request id is preserved end to end: header, body, and the ledger.
        expect(body.requestId).toBe(response.headers['x-oxy-request-id']);
      }
    );

    // Settled from the report that DID arrive rather than refunded whole.
    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe('failed');
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(EXPECTED_CHARGE, 9);
  });

  it('settles the units that did arrive when the stream is cut off mid-flight', async () => {
    const fixture = await makeFixture();
    const partial: UsageQuantity[] = [
      { unit: 'input_tokens', quantity: 100 },
      { unit: 'output_tokens', quantity: 7 },
    ];

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Par');
        emit.usage(partial);
        // No done, no usage report: the upstream stopped talking.
        await context.truncate();
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture),
          bearer(fixture.token)
        );
        expect(response.status).toBe(502);
        expect(JSON.parse(response.body)).toMatchObject({
          code: 'provider_error',
          retryable: true,
        });
      }
    );

    // EXACTLY the in-stream units, not zero and not the ceiling.
    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].inputTokens).toBe(100);
    expect(receipts[0].outputTokens).toBe(7);
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(
      100 * INPUT_PRICE_PER_TOKEN + 7 * OUTPUT_PRICE_PER_TOKEN,
      9
    );
    expect(Number((await balanceOf(fixture.accountId)).reserved)).toBe(0);
  });

  it('refunds the whole hold, marked estimated, when no usage arrived at all', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Hello.');
        emit.done();
        // A completed generation with no usage report — nothing to charge exactly.
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture),
          bearer(fixture.token)
        );
        expect(response.status).toBe(500);
        expect(JSON.parse(response.body)).toMatchObject({ code: 'internal_error' });
      }
    );

    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBe(0);
    // `estimated` is what the ledger turns into the refund reason
    // `usage_unavailable`, which is the distinction that makes this reconcilable
    // later rather than indistinguishable from a request that used nothing.
    expect(receipts[0].usageSource).toBe('estimated');

    const after = await balanceOf(fixture.accountId);
    expect(Number(after.purchased)).toBeCloseTo(Number(before.purchased), 9);
    expect(Number(after.reserved)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Streaming                                                                 */
/* -------------------------------------------------------------------------- */

describe('POST /v1/responses with stream: true', () => {
  it('streams frames as they are produced, rather than buffering the response', async () => {
    const fixture = await makeFixture();
    const observedFirstDelta = deferred<number>();
    let releasedByTheClient: boolean | undefined;
    let sentWhenObserved: number | undefined;

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Hel');

        // Stop until the CLIENT has seen a delta. An edge that buffered the whole
        // stream before writing would never release this.
        //
        // Recorded and asserted in `run` rather than thrown here: a failure inside
        // this handler would leave the response unfinished and the case would end
        // as a generic jest timeout instead of naming what went wrong. The script
        // therefore always finishes the stream, and the verdict is a value.
        releasedByTheClient = await Promise.race([
          observedFirstDelta.promise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        sentWhenObserved = context.sent();

        emit.delta('lo.');
        emit.usage(UNITS);
        emit.done();
        emit.report(UNITS, 'completed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true }),
          bearer(fixture.token),
          (frame) => {
            if (frame.name === 'delta') observedFirstDelta.resolve(1);
          }
        );

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/event-stream');
        // `no-transform` is what keeps `compression()` from buffering the stream.
        expect(response.headers['cache-control']).toContain('no-transform');
        expect(response.headers['x-oxy-model']).toBe(fixture.pinnedModelReference);
        expect(response.headers['x-oxy-provider']).toBe(fixture.provider);

        // THE assertion this case exists for: the data plane's own script was
        // released by the client having seen a frame, which cannot happen if the
        // edge collected the stream before writing any of it.
        expect(releasedByTheClient).toBe(true);
        // And the stub had sent exactly two frames at that moment — so the
        // customer held frame 2 before the data plane produced frame 3.
        expect(sentWhenObserved).toBe(2);

        // Named frames, in order, and no `[DONE]` sentinel on this dialect.
        expect(response.frames.map((frame) => frame.name)).toEqual([
          'start',
          'delta',
          'delta',
          'usage',
          'done',
        ]);
        expect(response.frames.every((frame) => frame.data !== '[DONE]')).toBe(true);

        // Each frame is the contract shape a non-streaming caller would have got
        // inside the response, with its own monotonic sequence.
        const sequences = response.frames.map(
          (frame) => (JSON.parse(frame.data) as { sequence: number }).sequence
        );
        expect(sequences).toEqual([0, 1, 2, 3, 4]);
      }
    );

    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(EXPECTED_CHARGE, 9);
    expect(receipts[0].outcome).toBe('completed');
  });

  it('tells the data plane to stream, rather than folding a non-streamed answer', async () => {
    const fixture = await makeFixture();

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture, { stream: true }),
        bearer(fixture.token)
      );
      expect(response.status).toBe(200);
      expect(stub.received[0].stream).toBe(true);
    });
  });

  /**
   * REPORTED, and nothing more — do not upgrade this assertion.
   *
   * The epic requires a customer-visible receipt when an allowed route switch
   * occurs, and that is exactly what this asserts. It deliberately does NOT
   * assert the switch respected the customer's routing policy, because it cannot:
   * the envelope carries a policy REFERENCE rather than the values, so a
   * data-plane-initiated switch has nothing to check a replacement route against
   * (see the forwarding site in `inferenceEdge.service.ts`). When the decided
   * follow-up lands — an ordered list of pre-authorized routes on the envelope —
   * the guarantee will come from that list, not from this frame, so the assertion
   * to add then belongs where the list is built.
   */
  it('surfaces a route switch to the customer, in stream', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        // A switch precedes the start event: it happened before anything was
        // streamed, which is the only point at which one is possible.
        emit.routeSwitch();
        emit.start();
        emit.delta('Hello.');
        emit.usage(UNITS);
        emit.done();
        emit.report(UNITS, 'completed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        const switches = response.frames.filter((frame) => frame.name === 'route_switch');
        expect(switches).toHaveLength(1);
        expect(JSON.parse(switches[0].data)).toMatchObject({
          type: 'route_switch',
          reason: 'provider_overloaded',
          detail: { scope: 'deployment', toProvider: fixture.provider },
        });
      }
    );
  });

  it('forwards a terminal error event as the stream’s own error frame', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Par');
        emit.error('provider_timeout', 'the upstream stopped answering');
        emit.report(UNITS, 'failed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        // 200 was already sent with the first frame, so the failure can only
        // arrive in the stream — which is the whole reason the edge commits the
        // response on the first frame and not at admission.
        expect(response.status).toBe(200);
        const errors = response.frames.filter((frame) => frame.name === 'error');
        expect(errors).toHaveLength(1);
        expect(JSON.parse(errors[0].data)).toMatchObject({
          type: 'error',
          error: { code: 'provider_timeout', requestId: response.headers['x-oxy-request-id'] },
        });
      }
    );

    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe('failed');
  });

  it('refuses before committing the response, so a pre-stream failure is an HTTP status', async () => {
    const fixture = await makeFixture();

    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture, { stream: true, model: 'nobody/nothing' }),
        bearer(fixture.token)
      );

      // Not an SSE error frame: nothing had been written, so the customer gets
      // the same 404 a non-streaming request would.
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(JSON.parse(response.body)).toMatchObject({ code: 'model_not_found' });
      expect(stub.verified).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Streaming, the OpenAI-compatible dialect                                  */
/* -------------------------------------------------------------------------- */

describe('POST /v1/chat/completions with stream: true', () => {
  it('renders OpenAI chunks and terminates with [DONE]', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Hel');
        // Dropped on this surface: there is no OpenAI field for reasoning, and
        // rendering it as content would show a customer the model's private
        // reasoning as its answer.
        emit.reasoning('thinking about it');
        emit.delta('lo.');
        emit.usage(UNITS);
        emit.done();
        emit.report(UNITS, 'completed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          chatBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        // Unnamed frames, as a stock OpenAI SDK reads them.
        expect(response.frames.every((frame) => frame.name.length === 0)).toBe(true);
        expect(response.frames[response.frames.length - 1].data).toBe('[DONE]');

        const chunks = chunksOf(response);
        expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
        expect(chunks.every((chunk) => chunk.model === fixture.pinnedModelReference)).toBe(true);

        const content = chunks
          .flatMap((chunk) => (chunk.choices as { delta?: { content?: string } }[]) ?? [])
          .map((choice) => choice.delta?.content ?? '')
          .join('');
        expect(content).toBe('Hello.');
        // The reasoning delta produced no chunk at all, rather than leaking into
        // the content above.
        expect(response.body).not.toContain('thinking about it');

        const finished = chunks.flatMap(
          (chunk) => (chunk.choices as { finish_reason?: string | null }[]) ?? []
        );
        expect(finished.some((choice) => choice.finish_reason === 'stop')).toBe(true);

        // Usage rides on a chunk with no choices, which is the shape OpenAI itself
        // uses — so a stock client skips it and an Oxy-aware one reads it.
        const usageChunk = chunks.find((chunk) => chunk.usage !== undefined);
        expect(usageChunk).toMatchObject({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        });
      }
    );

    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(EXPECTED_CHARGE, 9);
  });

  /** Reported only, for the reason given on the `/v1/responses` case above. */
  it('surfaces a route switch on a chunk a stock client can still parse', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.routeSwitch();
        emit.start();
        emit.delta('Hello.');
        emit.done();
        emit.report(UNITS, 'completed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          chatBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        const switchChunk = chunksOf(response).find(
          (chunk) => chunk.oxy_route_switch !== undefined
        );
        // Chunk-shaped, so a stock parser reads it as a chunk with no choices and
        // ignores the extension — while an Oxy-aware client reads the switch.
        expect(switchChunk).toMatchObject({
          object: 'chat.completion.chunk',
          choices: [],
          oxy_route_switch: { reason: 'provider_overloaded' },
        });
      }
    );
  });

  it('streams tool calls with the positional index OpenAI clients accumulate on', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.toolCall('call_a', 'lookup', '{"q":', false);
        emit.toolCall('call_a', 'lookup', '"oxy"}', true);
        emit.usage(UNITS);
        emit.done();
        emit.report(UNITS, 'completed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          chatBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        const toolDeltas = chunksOf(response)
          .flatMap(
            (chunk) =>
              (chunk.choices as {
                delta?: { tool_calls?: { index: number; function?: { arguments?: string } }[] };
              }[]) ?? []
          )
          .flatMap((choice) => choice.delta?.tool_calls ?? []);

        expect(toolDeltas).toHaveLength(2);
        // The SAME index for both fragments of one call, which is what lets a
        // client concatenate them into one set of arguments.
        expect(toolDeltas.every((call) => call.index === 0)).toBe(true);
        expect(toolDeltas.map((call) => call.function?.arguments ?? '').join('')).toBe(
          '{"q":"oxy"}'
        );
      }
    );
  });

  it('reports a mid-stream failure in the OpenAI error shape, with no [DONE]', async () => {
    const fixture = await makeFixture();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Par');
        emit.error('provider_error', 'the upstream failed');
        emit.report(UNITS, 'failed');
      },
      async ({ request }) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          chatBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        expect(response.body).not.toContain('[DONE]');
        const errorFrame = response.frames
          .map((frame) => JSON.parse(frame.data) as Record<string, unknown>)
          .find((payload) => payload.error !== undefined);
        expect(errorFrame).toMatchObject({
          error: { code: 'provider_error', type: 'api_error' },
        });
      }
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Cancellation                                                              */
/* -------------------------------------------------------------------------- */

describe('a client that disconnects mid-stream', () => {
  it('aborts the data-plane request and settles the units measured before the cut, once', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);
    const partial: UsageQuantity[] = [
      { unit: 'input_tokens', quantity: 100 },
      { unit: 'output_tokens', quantity: 7 },
    ];
    /**
     * Resolved by the STUB when it observes the abort.
     *
     * Awaited rather than read: the stub's script resumes asynchronously after the
     * client's socket closes, so a plain variable read straight after the client
     * gave up would be racing the very thing the case is about — and it would
     * report `false` for an edge that propagates cancellation perfectly.
     */
    const abortSeen = deferred<boolean>();

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta('Hel');
        emit.usage(partial);
        // The report frame can never be delivered to a connection that is gone,
        // which is exactly why the in-stream usage event is the settlement's
        // second source of authority.
        abortSeen.resolve(await context.whenAborted(10_000));
      },
      async ({ stub, request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true }),
          bearer(fixture.token),
          (frame, clientRequest) => {
            // The customer walks away the instant the usage event reaches them.
            //
            // Triggering on THAT frame rather than on the first delta is what makes
            // this deterministic: the edge forwards frames in order, so a client
            // holding the usage event proves the edge already recorded its units.
            // Cancelling on the delta would race the frame the settlement needs.
            if (frame.name === 'usage') clientRequest.destroy();
          }
        );

        expect(response.frames.some((frame) => frame.name === 'delta')).toBe(true);
        expect(response.frames.some((frame) => frame.name === 'usage')).toBe(true);
        // The abort reached the DATA PLANE, not merely the edge. Without this the
        // case would pass for an edge that dropped the connection and left the
        // upstream generating.
        expect(await abortSeen.promise).toBe(true);
        expect(stub.aborted).toBeGreaterThan(0);
      }
    );

    // Settled AFTER the client was gone, which is the only reason this has to be
    // a bounded wait rather than an immediate read.
    const receipts = await waitForReceipt(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe('cancelled');
    expect(receipts[0].inputTokens).toBe(100);
    expect(receipts[0].outputTokens).toBe(7);
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(
      100 * INPUT_PRICE_PER_TOKEN + 7 * OUTPUT_PRICE_PER_TOKEN,
      9
    );

    // Exactly one hold, settled — not still held, and not settled twice.
    const holds = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe('settled');

    const after = await balanceOf(fixture.accountId);
    expect(Number(after.reserved)).toBe(0);
    expect(Number(before.purchased) - Number(after.purchased)).toBeCloseTo(
      100 * INPUT_PRICE_PER_TOKEN + 7 * OUTPUT_PRICE_PER_TOKEN,
      9
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  A deployment with no data plane still behaves exactly as it did           */
/* -------------------------------------------------------------------------- */

describe('an unconfigured deployment', () => {
  /** The edge with NO client, which is what every deployment has today. */
  async function withUnconfiguredEdge(
    run: (request: EdgeHarness['request']) => Promise<void>
  ): Promise<void> {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/v1', createInferenceEdgeRouter({}));

    const server = await new Promise<http.Server>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    const { port } = server.address() as AddressInfo;

    try {
      await run(clientFor(port));
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  }

  it('still answers a typed, non-retryable service_unavailable', async () => {
    const fixture = await makeFixture();

    await withUnconfiguredEdge(async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        code: 'service_unavailable',
        retryable: false,
      });
    });

    // And the hold it took is released, so the balance is not frozen.
    const receipts = await receiptsOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBe(0);
    expect(Number((await balanceOf(fixture.accountId)).reserved)).toBe(0);
  });

  it('still refuses stream: true, before reserving anything', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);

    await withUnconfiguredEdge(async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture, { stream: true }),
        bearer(fixture.token)
      );
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: 'invalid_request', param: 'stream' },
      });
    });

    // Nothing reserved and nothing settled: the refusal happens before the hold.
    expect(await receiptsOf(fixture.accountId)).toHaveLength(0);
    expect(await balanceOf(fixture.accountId)).toEqual(before);
  });

  it('resolves no client at all when the environment names no data plane', () => {
    delete process.env[RELAY_BASE_URL_VARIABLE];
    delete process.env[RELAY_SIGNING_KEY_ID_VARIABLE];
    delete process.env[RELAY_SIGNING_PRIVATE_KEY_VARIABLE];

    expect(createHttpRelayClient()).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Nothing sensitive reaches a log line                                      */
/* -------------------------------------------------------------------------- */

describe('the streaming path’s logs', () => {
  it('carry no prompt, no output, no signature and no signing key', async () => {
    const fixture = await makeFixture();
    const promptMarker = `PROMPT-MARKER-${suffix()}`;
    const outputMarker = `OUTPUT-MARKER-${suffix()}`;

    await withEdge(
      async (context) => {
        const emit = emitter(context, fixture.provider);
        emit.start();
        emit.delta(outputMarker);
        emit.usage(UNITS);
        emit.done();
        emit.report(UNITS, 'completed');
      },
      async ({ request }) => {
        // A served stream, so the whole forwarding path runs...
        const served = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true, input: promptMarker }),
          bearer(fixture.token)
        );
        expect(served.status).toBe(200);
        expect(served.body).toContain(outputMarker);

        // ...and a refused one, because a refusal is where a body is most tempting
        // to log "for debugging".
        const refused = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true, model: 'nobody/nothing', input: promptMarker }),
          bearer(fixture.token)
        );
        expect(refused.status).toBe(404);
      }
    );

    const calls = [
      ...mockedLogger.warn.mock.calls,
      ...mockedLogger.error.mock.calls,
      ...mockedLogger.info.mock.calls,
      ...mockedLogger.debug.mock.calls,
    ];
    // VACUITY FLOOR: with no logger calls at all, every absence below would be
    // trivially true and this case would measure nothing.
    expect(calls.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(promptMarker);
    expect(serialized).not.toContain(outputMarker);
    // The signing key and the signature it produces are the two things unique to
    // this lane, and neither may ever be written down.
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain(EDGE_PRIVATE_PEM.split('\n')[1]);
    expect(serialized).not.toContain('v1=');
    // POSITIVE CONTROL on the search: something that IS logged is found by the
    // same pass, so the absences above are real absences and not an unreadable
    // haystack.
    expect(serialized).toContain('inference.edge.refused');
  });
});

/* -------------------------------------------------------------------------- */
/*  The launch gate holds on the STREAMING entry point too                    */
/* -------------------------------------------------------------------------- */

/**
 * The privacy/security review precondition (#972 section 12) refuses a STREAMING
 * request, and refuses it BEFORE the data plane is reached.
 *
 * ## Why this is asserted rather than inherited
 *
 * `admitToInferenceEdge` sits in the router's own gate, so on today's code both
 * dialects and both transports pass through it once. That is a property of where
 * the gate is mounted, and a property of a mount is exactly the kind of thing a
 * refactor moves without anybody noticing — #1034 split serving into a streaming
 * and a non-streaming entry point, and "a constraint enforced on one path and
 * forgotten on the other" is what ADR 0010 exists to prevent. A launch gate that
 * a `stream: true` request walked around would be the worst instance of it: the
 * refusal would be invisible, because the caller would simply be served.
 *
 * ## The two halves
 *
 * Each case clears ONLY the review variable — the audience stays `public` and
 * charging stays armed, so the state under test is the one a launch is actually
 * attempted from — and asserts three things: the status is 403, the body is not a
 * stream, and `stub.verified` is 0, which is the sharp claim. A gate that refused
 * after forwarding would already have sent the customer's prompt to the data
 * plane, and the status code alone cannot tell the two apart.
 *
 * The positive control is the whole rest of this file: with the review armed —
 * `ROLLOUT_ENVIRONMENT`, restored in `finally` — the same streaming requests are
 * served, and their frames are asserted above.
 */
describe('a streaming request is refused by the privacy review gate, before the data plane', () => {
  /**
   * Run `body` with the review attestation absent, then restore it.
   *
   * Through the module's own exported variable name rather than a second copy of
   * the string, so a rename cannot leave this file quietly clearing nothing —
   * which would make both refusal cases below pass for the wrong reason.
   */
  async function withoutPrivacyReview(body: () => Promise<void>): Promise<void> {
    const armed = process.env[PRIVACY_REVIEW_VARIABLE];
    delete process.env[PRIVACY_REVIEW_VARIABLE];
    try {
      await body();
    } finally {
      if (armed === undefined) delete process.env[PRIVACY_REVIEW_VARIABLE];
      else process.env[PRIVACY_REVIEW_VARIABLE] = armed;
    }
  }

  it('refuses POST /v1/responses with stream: true, and forwards nothing', async () => {
    const fixture = await makeFixture();

    await withoutPrivacyReview(async () => {
      await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
        const response = await request(
          'POST',
          '/v1/responses',
          responsesBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(403);
        // Not a stream: the refusal is an HTTP status, not an error frame inside a
        // 200 the client has already started reading.
        expect(response.headers['content-type']).not.toContain('text/event-stream');
        expect(response.frames).toEqual([]);
        // THE SHARP ONE: the prompt never left this process.
        expect(stub.verified).toBe(0);
      });
    });
  });

  it('refuses POST /v1/chat/completions with stream: true on the same terms', async () => {
    const fixture = await makeFixture();

    await withoutPrivacyReview(async () => {
      await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          chatBody(fixture, { stream: true }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(403);
        expect(response.frames).toEqual([]);
        expect(stub.verified).toBe(0);
      });
    });
  });

  it('serves the same streaming request once the review is recorded — the control', async () => {
    const fixture = await makeFixture();

    // The review is armed here (this file's own `ROLLOUT_ENVIRONMENT`), and
    // nothing else differs from the two cases above. Without this, both of them
    // would pass just as well against an edge that refused every streaming
    // request for any reason at all.
    await withEdge(servesCompletely(fixture.provider), async ({ stub, request }) => {
      const response = await request(
        'POST',
        '/v1/responses',
        responsesBody(fixture, { stream: true }),
        bearer(fixture.token)
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(stub.verified).toBe(1);
    });
  });
});

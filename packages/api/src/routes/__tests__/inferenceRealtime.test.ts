/**
 * `GET /v1/realtime` against a FAKE Kaana WebSocket that behaves as the wire
 * spec says (OxyHQ/Kaana#90) — and a real Postgres, a real machine credential
 * and the real ledger.
 *
 * What makes each claim falsifiable:
 *
 *  - **The signature covers frame 1.** The stub verifies the upgrade's three
 *    headers over the EXACT bytes of the first text frame, with the edge's public
 *    key, and closes 1008 otherwise; every case counts verified connections. The
 *    positive control re-verifies the recorded headers over mutated bytes and
 *    asserts the check says no.
 *  - **Settlement happens exactly once.** Every case asserts ONE receipt at an
 *    exact amount from the fixture's prices, and the hold released — including
 *    the case whose report is lost, the one that sends a second report, and the
 *    resumed session that crossed two customer connections.
 *  - **Nothing is replayed.** The resume case records every command the stub
 *    received across both upstream connections and asserts each `commandId`
 *    arrived once.
 *  - **Refusals leave nothing behind.** A refused open asserts no upstream
 *    connection and no reservation.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  realtimeClientCommandSchema,
  realtimeSessionRequestSchema,
  type RealtimeClientCommand,
  type RealtimeSessionRequest,
  type UsageQuantity,
} from '@oxy.so/contracts';
import {
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
} from '../../config/kaanaDataPlane';
import { closePostgres, connectPostgres } from '../../config/postgres';
import { createHttpKaanaClient, KAANA_DEPLOYMENTS_QUERY_PATH } from '../../services/httpKaanaClient';
import { KAANA_REALTIME_PATH, createKaanaRealtimeClient } from '../../services/kaanaRealtimeClient';
import { heldRealtimeSessionCount, realtimeTimings } from '../../services/inferenceRealtime.service';
import { attachRealtimeEdge } from '../inferenceRealtime';
import { attestFixtureDeployments } from '../__fixtures__/kaanaRuntimeFixtures';
import {
  EDGE_ROLLOUT_ENVIRONMENT,
  makeAudioFixture,
  receiptsFor,
  reservationsFor,
  verifyEdgeSignature,
  waitFor,
  type AudioFixture,
} from '../__fixtures__/kaanaAudioFixtures';

jest.setTimeout(60_000);

const EDGE_KEY_ID = 'oxy-edge-realtime-test';
const edgeKeys = generateKeyPairSync('ed25519');
const EDGE_PRIVATE_PEM = edgeKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/* -------------------------------------------------------------------------- */
/*  The fake Kaana                                                            */
/* -------------------------------------------------------------------------- */

/** One upstream connection, as the fake data plane sees it. */
interface UpstreamConnection {
  readonly headers: http.IncomingHttpHeaders;
  readonly firstFrame: Buffer;
  readonly verified: boolean;
  readonly commands: RealtimeClientCommand[];
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  /** Next command, in arrival order. */
  nextCommand(): Promise<RealtimeClientCommand>;
}

interface Kaana {
  readonly connections: UpstreamConnection[];
  nextConnection(): Promise<UpstreamConnection>;
  close(): Promise<void>;
  port: number;
}

async function startKaana(): Promise<Kaana> {
  const connections: UpstreamConnection[] = [];
  const waiters: { resolve: (connection: UpstreamConnection) => void; reject: (error: Error) => void }[] = [];
  const server = http.createServer((req, res) => {
    // The one-shot hop admission uses: exact-id attestation.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        if (req.url !== KAANA_DEPLOYMENTS_QUERY_PATH || !verifyEdgeSignature(EDGE_KEY_ID, edgeKeys.publicKey, req.headers, body)) {
          res.writeHead(401).end();
          return;
        }
        const query = JSON.parse(body.toString('utf8')) as { deploymentIds: string[] };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(await attestFixtureDeployments(query.deploymentIds)));
      })();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== KAANA_REALTIME_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const commands: RealtimeClientCommand[] = [];
      const commandWaiters: ((command: RealtimeClientCommand) => void)[] = [];
      const queued: RealtimeClientCommand[] = [];
      let first: Buffer | undefined;
      let resolveClosed: (code: number) => void = () => undefined;
      const closed = new Promise<number>((resolve) => {
        resolveClosed = resolve;
      });
      ws.on('close', (code) => resolveClosed(code));
      ws.on('message', (data: RawData, isBinary: boolean) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (first === undefined) {
          first = bytes;
          const verified = !isBinary && verifyEdgeSignature(EDGE_KEY_ID, edgeKeys.publicKey, req.headers, bytes);
          const connection: UpstreamConnection = {
            headers: req.headers,
            firstFrame: bytes,
            verified,
            commands,
            socket: ws,
            closed,
            nextCommand: () =>
              new Promise((resolve) => {
                const ready = queued.shift();
                if (ready !== undefined) resolve(ready);
                else commandWaiters.push(resolve);
              }),
          };
          connections.push(connection);
          if (!verified) {
            ws.close(1008, 'signature');
            // Fail the waiting case at once rather than at its timeout: an
            // unverifiable first frame is the failure, not a slow path.
            waiters.shift()?.reject(new Error('the first frame did not verify'));
            return;
          }
          waiters.shift()?.resolve(connection);
          return;
        }
        const command = realtimeClientCommandSchema.parse(JSON.parse(bytes.toString('utf8')));
        commands.push(command);
        const waiter = commandWaiters.shift();
        if (waiter !== undefined) waiter(command);
        else queued.push(command);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const kaana: Kaana = {
    connections,
    port: (server.address() as AddressInfo).port,
    nextConnection: () => new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return kaana;
}

/** Stamps the framing every event carries, numbering one session's events from 0. */
class Emitter {
  sequence = 0;
  constructor(
    readonly request: RealtimeSessionRequest,
    public socket: WebSocket
  ) {}

  get requestId(): string {
    return this.request.attribution.requestId;
  }

  get route() {
    return this.request.authorizedRoutes[0];
  }

  event(payload: Record<string, unknown>): number {
    const sequence = this.sequence++;
    this.socket.send(JSON.stringify({ schemaVersion: 1, requestId: this.requestId, sequence, ...payload }));
    return sequence;
  }

  created(resumeWindowMs = 30_000): void {
    const now = new Date();
    this.event({
      type: 'session.created',
      resolvedModelReference: this.route.modelReference,
      servingProvider: this.route.provider,
      deploymentId: this.route.deploymentId,
      kind: this.request.kind,
      config: this.request.config,
      limits: this.request.limits,
      resumeWindowMs,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.request.limits.maxDurationMs).toISOString(),
    });
  }

  accepted(command: RealtimeClientCommand): void {
    this.event({ type: 'command.accepted', commandId: command.commandId, duplicate: false });
  }

  response(units: UsageQuantity[]): void {
    const responseId = `resp-${this.sequence}`;
    this.event({ type: 'response.created', responseId });
    this.event({
      type: 'output_audio.delta',
      responseId,
      itemId: 'item-1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: Buffer.from('pcm-bytes').toString('base64'),
    });
    this.event({
      type: 'response.done',
      responseId,
      status: 'completed',
      deploymentId: this.route.deploymentId,
      units,
      usageSource: 'provider_reported',
    });
  }

  closed(units: UsageQuantity[], reason = 'client_closed'): void {
    this.event({
      type: 'session.closed',
      reason,
      deploymentId: this.route.deploymentId,
      units,
      usageSource: 'provider_reported',
      closedAt: new Date().toISOString(),
    });
  }

  report(units: UsageQuantity[], outcome = 'completed'): void {
    const now = new Date().toISOString();
    this.socket.send(
      JSON.stringify({
        schemaVersion: 2,
        requestId: this.requestId,
        attribution: this.request.attribution,
        outcome,
        units,
        usageSource: 'provider_reported',
        resolvedModelReference: this.route.modelReference,
        servingProvider: this.route.provider,
        deploymentId: this.route.deploymentId,
        routeSwitches: 0,
        startedAt: now,
        completedAt: now,
      })
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  The edge and its customers                                                */
/* -------------------------------------------------------------------------- */

interface Customer {
  readonly socket: WebSocket;
  readonly requestId: string;
  readonly events: Record<string, unknown>[];
  readonly closed: Promise<{ code: number; reason: string }>;
  next(type?: string): Promise<Record<string, unknown>>;
  send(payload: unknown): void;
}

interface Harness {
  readonly kaana: Kaana;
  connect(token: string, model?: string): Promise<Customer>;
}

async function withEdge(run: (harness: Harness) => Promise<void>): Promise<void> {
  const kaana = await startKaana();
  process.env[KAANA_BASE_URL_VARIABLE] = 'https://kaana.ai';
  process.env[KAANA_SIGNING_KEY_ID_VARIABLE] = EDGE_KEY_ID;
  process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE] = EDGE_PRIVATE_PEM;
  const systemFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    expect(requested.origin).toBe('https://kaana.ai');
    return systemFetch(`http://127.0.0.1:${kaana.port}${requested.pathname}`, init);
  }) as typeof fetch;

  const dialled: string[] = [];
  const kaanaRealtimeClient = createKaanaRealtimeClient({
    dial: (url, options) => {
      dialled.push(url);
      return new WebSocket(`ws://127.0.0.1:${kaana.port}${KAANA_REALTIME_PATH}`, {
        headers: options.headers,
        maxPayload: options.maxPayload,
      });
    },
  });
  const kaanaClient = createHttpKaanaClient();
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = attachRealtimeEdge(server, {
    ...(kaanaClient === undefined ? {} : { kaanaClient }),
    ...(kaanaRealtimeClient === undefined ? {} : { kaanaRealtimeClient }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const customers: WebSocket[] = [];

  const connect = (token: string, model?: string): Promise<Customer> =>
    new Promise((resolve, reject) => {
      const path = model === undefined ? '/v1/realtime' : `/v1/realtime?model=${encodeURIComponent(model)}`;
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      customers.push(socket);
      const events: Record<string, unknown>[] = [];
      const waiters: { type?: string; resolve: (event: Record<string, unknown>) => void }[] = [];
      let cursor = 0;
      const pump = (): void => {
        for (let index = 0; index < waiters.length; index += 1) {
          const waiter = waiters[index];
          while (cursor < events.length) {
            const event = events[cursor];
            cursor += 1;
            if (waiter.type === undefined || event.type === waiter.type) {
              waiters.splice(index, 1);
              index -= 1;
              waiter.resolve(event);
              break;
            }
          }
        }
      };
      socket.on('message', (data: RawData) => {
        events.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>);
        pump();
      });
      const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
        socket.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString('utf8') }));
      });
      socket.on('upgrade', (response) => {
        const requestId = String(response.headers['x-oxy-request-id']);
        socket.once('open', () =>
          resolve({
            socket,
            requestId,
            events,
            closed,
            next: (type) =>
              new Promise((resolveEvent) => {
                waiters.push({ type, resolve: resolveEvent });
                pump();
              }),
            send: (payload) => socket.send(JSON.stringify(payload)),
          })
        );
      });
      socket.on('error', reject);
    });

  try {
    await run({ kaana, connect });
    for (const url of dialled) expect(url).toBe('wss://kaana.ai/internal/v1/realtime');
  } finally {
    for (const socket of customers) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await kaana.close();
    globalThis.fetch = systemFetch;
    delete process.env[KAANA_BASE_URL_VARIABLE];
    delete process.env[KAANA_SIGNING_KEY_ID_VARIABLE];
    delete process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE];
  }
}

const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  Object.keys(EDGE_ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]])
);
const ORIGINAL_GRACE = realtimeTimings.reportGraceMs;

beforeAll(async () => {
  Object.assign(process.env, EDGE_ROLLOUT_ENVIRONMENT);
  await connectPostgres();
});

afterAll(async () => {
  realtimeTimings.reportGraceMs = ORIGINAL_GRACE;
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const realtimeModel = (): Promise<AudioFixture> =>
  makeAudioFixture({
    inputModalities: ['text', 'audio'],
    outputModalities: ['text', 'audio'],
    realtime: { transports: ['websocket'], sessionKinds: ['conversation'] },
  });

const openFrame = (overrides: Record<string, unknown> = {}) => ({
  type: 'session.open',
  kind: 'conversation',
  config: {
    instructions: 'Be brief.',
    outputModalities: ['audio'],
    voice: 'alloy',
    inputAudioFormat: 'pcm16_24khz',
    outputAudioFormat: 'pcm16_24khz',
    turnDetection: { type: 'server_vad', createResponse: true, interruptResponse: true },
    maxOutputTokens: 1000,
  },
  limits: { maxResponses: 2, maxDurationMs: 60_000 },
  ...overrides,
});

const command = (requestId: string, commandId: string, payload: Record<string, unknown>) => ({
  schemaVersion: 1,
  requestId,
  commandId,
  ...payload,
});

const RESPONSE_UNITS: UsageQuantity[] = [
  { unit: 'input_tokens', quantity: 100 },
  { unit: 'audio_input_tokens', quantity: 200 },
  { unit: 'audio_output_tokens', quantity: 300 },
];
const SESSION_UNITS: UsageQuantity[] = [{ unit: 'requests', quantity: 1 }, ...RESPONSE_UNITS];
/** 100 × $3/M + 200 × $40/M + 300 × $80/M. */
const SESSION_CHARGE = '0.032300000000';

async function oneReceipt(accountId: string) {
  return waitFor(async () => {
    const rows = await receiptsFor(accountId);
    return rows.length > 0 ? rows : undefined;
  }, 'the session receipt');
}

/** Open a session and have the fake Kaana answer `session.created`. */
async function opened(harness: Harness, fixture: AudioFixture, frame = openFrame()) {
  const customer = await harness.connect(fixture.token, fixture.modelReference);
  const upstream = harness.kaana.nextConnection();
  customer.send(frame);
  const connection = await upstream;
  const request = realtimeSessionRequestSchema.parse(JSON.parse(connection.firstFrame.toString('utf8')));
  const emit = new Emitter(request, connection.socket);
  emit.created();
  await customer.next('session.created');
  return { customer, connection, request, emit };
}

/* -------------------------------------------------------------------------- */
/*  The signed session request                                                */
/* -------------------------------------------------------------------------- */

describe('the signed first frame', () => {
  it('signs the exact bytes of a contract session request with same-model routes', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, connection, request, emit } = await opened(harness, fixture);
      expect(connection.verified).toBe(true);
      expect(request.attribution.requestId).toBe(customer.requestId);
      expect(request.attribution.principal.applicationId).toBe(fixture.applicationId);
      expect(request.modelReference).toBe(fixture.modelReference);
      expect(request.kind).toBe('conversation');
      expect(request.transport).toBe('websocket');
      expect(request.limits).toEqual({
        maxDurationMs: 60_000,
        idleTimeoutMs: 60_000,
        maxInputAudioBytes: 28_800_000,
        maxOutputAudioBytes: 28_800_000,
        maxResponses: 2,
      });
      expect(request.authorizedRoutes.map((route) => route.deploymentId)).toEqual(fixture.deploymentIds);
      expect(request.authorizedRoutes.every((route) => route.substitution === 'same_model')).toBe(true);

      // The positive control: the same headers over different bytes do not verify.
      const tampered = Buffer.from(connection.firstFrame.toString('utf8').replace('Be brief.', 'Be long.'));
      expect(verifyEdgeSignature(EDGE_KEY_ID, edgeKeys.publicKey, connection.headers, tampered)).toBe(false);

      emit.closed([]);
      emit.report([], 'failed');
      await customer.closed;
    });
  });

  it('holds spend against the signed limits: responses × window in, responses × cap out', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, emit } = await opened(harness, fixture);
      const [reservation] = await reservationsFor(fixture.accountId);
      // 2 responses × 32 000-token window at the dearest input unit ($40/M audio)
      // + 2 × 1 000-token cap at the dearest output unit ($80/M audio).
      expect(reservation.reservedAmount).toBe('2.720000000000');
      // The hold outlives the session: 60 s + the 60 s resume window + grace.
      expect(reservation.expiresAt.getTime()).toBeGreaterThan(Date.now() + 120_000);
      emit.closed([]);
      emit.report([], 'failed');
      await customer.closed;
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Relay and settlement                                                      */
/* -------------------------------------------------------------------------- */

describe('a session, relayed and settled', () => {
  it('relays commands and events both ways and settles once from the report', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, connection, emit } = await opened(harness, fixture);
      const append = command(customer.requestId, 'c-1', {
        type: 'input_audio.append',
        data: Buffer.from('user-speech').toString('base64'),
      });
      customer.send(append);
      const forwarded = await connection.nextCommand();
      expect(forwarded).toEqual(append);
      emit.accepted(forwarded);
      expect(await customer.next('command.accepted')).toMatchObject({ commandId: 'c-1', sequence: 1 });

      emit.response(RESPONSE_UNITS);
      expect(await customer.next('output_audio.delta')).toMatchObject({ format: 'pcm16_24khz' });
      await customer.next('response.done');

      customer.send(command(customer.requestId, 'c-2', { type: 'session.close' }));
      emit.accepted(await connection.nextCommand());
      emit.closed(SESSION_UNITS);
      emit.report(SESSION_UNITS);

      const closedEvent = await customer.next('session.closed');
      expect(closedEvent).toMatchObject({ reason: 'client_closed' });
      expect((await customer.closed).code).toBe(1000);
      // One monotonic sequence, relayed intact.
      const sequences = customer.events.map((event) => event.sequence as number);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

      const receipts = await oneReceipt(fixture.accountId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        billedAmount: SESSION_CHARGE,
        outcome: 'completed',
        audioInputTokens: 200,
        audioOutputTokens: 300,
      });
      const [reservation] = await reservationsFor(fixture.accountId);
      expect(reservation.status).toBe('settled');
      expect(heldRealtimeSessionCount()).toBe(0);
    });
  });

  it('never charges twice: a second report is a protocol error, not a second receipt', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, emit } = await opened(harness, fixture);
      emit.closed(SESSION_UNITS);
      emit.report(SESSION_UNITS);
      emit.report(SESSION_UNITS);
      await customer.closed;
      await oneReceipt(fixture.accountId);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(await receiptsFor(fixture.accountId)).toHaveLength(1);
    });
  });

  it('recovers from session.closed when the report frame is lost, never as completed', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, connection, emit } = await opened(harness, fixture);
      emit.response(RESPONSE_UNITS);
      emit.closed(SESSION_UNITS, 'idle_timeout');
      await customer.next('session.closed');
      connection.socket.close(1000);
      expect((await customer.closed).code).toBe(1000);
      const [receipt] = await oneReceipt(fixture.accountId);
      expect(receipt.billedAmount).toBe(SESSION_CHARGE);
      expect(receipt.outcome).toBe('partial');
    });
  });

  it('closes a customer that sends a binary frame through the data plane, 1003', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, connection, emit } = await opened(harness, fixture);
      customer.socket.send(Buffer.from([1, 2, 3]), { binary: true });
      const close = await connection.nextCommand();
      expect(close.type).toBe('session.close');
      expect(close.commandId).toMatch(/^oxy-edge-close-/);
      emit.closed([]);
      emit.report([], 'failed');
      await customer.next('session.closed');
      expect((await customer.closed).code).toBe(1003);
      await oneReceipt(fixture.accountId);
    });
  });

  it('closes a customer that sends a command for another session, 1008, and forwards nothing of it', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, connection, emit } = await opened(harness, fixture);
      customer.send(command('another-request-id', 'c-1', { type: 'input_audio.commit' }));
      const close = await connection.nextCommand();
      expect(close.type).toBe('session.close');
      emit.closed([]);
      emit.report([], 'failed');
      expect((await customer.closed).code).toBe(1008);
      expect(connection.commands.map((sent) => sent.type)).toEqual(['session.close']);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Reconnect                                                                 */
/* -------------------------------------------------------------------------- */

describe('a dropped customer', () => {
  it('resumes on a new connection with a signed session.resume, replays nothing, settles once', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, connection, emit } = await opened(harness, fixture);
      customer.send(command(customer.requestId, 'c-1', { type: 'response.create' }));
      emit.accepted(await connection.nextCommand());
      await customer.next('command.accepted');

      // The customer vanishes. The edge drops its upstream connection WITHOUT
      // closing the session (1001), so the session stays resumable upstream.
      customer.socket.terminate();
      expect(await connection.closed).toBe(1001);

      const second = await harness.connect(fixture.token);
      const upstream = harness.kaana.nextConnection();
      const resume = command(customer.requestId, 'r-1', { type: 'session.resume', afterSequence: 1 });
      second.send(resume);
      const resumed = await upstream;
      expect(resumed.verified).toBe(true);
      expect(JSON.parse(resumed.firstFrame.toString('utf8'))).toEqual(resume);

      emit.socket = resumed.socket;
      emit.event({ type: 'session.resumed', afterSequence: 1 });
      await second.next('session.resumed');
      emit.response(RESPONSE_UNITS);
      emit.closed(SESSION_UNITS);
      emit.report(SESSION_UNITS);
      expect((await second.closed).code).toBe(1000);

      // Nothing was replayed upstream: every command id arrived exactly once.
      const ids = [...connection.commands, ...resumed.commands].map((sent) => sent.commandId);
      expect(new Set(ids).size).toBe(ids.length);
      const receipts = await oneReceipt(fixture.accountId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].billedAmount).toBe(SESSION_CHARGE);
    });
  });

  it('refuses a resume from another application exactly as Kaana would', async () => {
    const fixture = await realtimeModel();
    const stranger = await realtimeModel();
    await withEdge(async (harness) => {
      const { customer, emit } = await opened(harness, fixture);
      const other = await harness.connect(stranger.token);
      other.send(command(customer.requestId, 'r-1', { type: 'session.resume', afterSequence: 0 }));
      const refusal = await other.next('error');
      expect(refusal).toMatchObject({ fatal: true, sequence: 0, error: { code: 'invalid_request' } });
      expect((await other.closed).code).toBe(1008);
      expect(harness.kaana.connections).toHaveLength(1);
      emit.closed([]);
      emit.report([], 'failed');
      await customer.closed;
    });
  });

  it('settles from the responses it saw once the resume window passes with no resume', async () => {
    realtimeTimings.reportGraceMs = 100;
    try {
      const fixture = await realtimeModel();
      await withEdge(async (harness) => {
        const customer = await harness.connect(fixture.token, fixture.modelReference);
        const upstream = harness.kaana.nextConnection();
        customer.send(openFrame());
        const connection = await upstream;
        const request = realtimeSessionRequestSchema.parse(JSON.parse(connection.firstFrame.toString('utf8')));
        const emit = new Emitter(request, connection.socket);
        emit.created(0);
        emit.response(RESPONSE_UNITS);
        await customer.next('response.done');
        customer.socket.terminate();

        const [receipt] = await oneReceipt(fixture.accountId);
        // The two measured response units, at their prices; `requests` was never
        // reported by a response and is priced at zero anyway.
        expect(receipt.billedAmount).toBe('0.032300000000');
        expect(receipt.outcome).toBe('cancelled');
        expect(heldRealtimeSessionCount()).toBe(0);
      });
    } finally {
      realtimeTimings.reportGraceMs = ORIGINAL_GRACE;
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                  */
/* -------------------------------------------------------------------------- */

describe('refusals before a session exists', () => {
  async function refusedWith(
    harness: Harness,
    token: string,
    model: string | undefined,
    frame: unknown
  ): Promise<{ error: Record<string, unknown>; code: number }> {
    const customer = await harness.connect(token, model);
    customer.send(frame);
    const event = await customer.next('error');
    expect(event).toMatchObject({ fatal: true, sequence: 0, requestId: customer.requestId });
    return { error: event.error as Record<string, unknown>, code: (await customer.closed).code };
  }

  it('refuses a bad API key on the socket, 1008', async () => {
    await withEdge(async (harness) => {
      const customer = await harness.connect('oxy_sk_not_a_real_key');
      const event = await customer.next('error');
      expect(event).toMatchObject({ error: { code: 'authentication_failed' } });
      expect((await customer.closed).code).toBe(1008);
    });
  });

  it('refuses an application outside the edge audience, like every /v1 endpoint', async () => {
    const fixture = await realtimeModel();
    const audience = process.env.INFERENCE_EDGE_AUDIENCE;
    delete process.env.INFERENCE_EDGE_AUDIENCE;
    try {
      await withEdge(async (harness) => {
        const customer = await harness.connect(fixture.token, fixture.modelReference);
        const event = await customer.next('error');
        expect(event).toMatchObject({ error: { code: 'permission_denied' } });
        expect((await customer.closed).code).toBe(1008);
        expect(harness.kaana.connections).toHaveLength(0);
      });
    } finally {
      process.env.INFERENCE_EDGE_AUDIENCE = audience;
    }
  });

  it('refuses a model that declares no realtime sessions, before any hold or upstream', async () => {
    const fixture = await makeAudioFixture({ realtime: null });
    await withEdge(async (harness) => {
      const refused = await refusedWith(harness, fixture.token, fixture.modelReference, openFrame());
      expect(refused.error).toMatchObject({ code: 'unsupported_modality' });
      expect(refused.error.message).toContain('does not hold realtime conversation sessions');
      expect(harness.kaana.connections).toHaveLength(0);
      expect(await reservationsFor(fixture.accountId)).toHaveLength(0);
    });
  });

  it('refuses a session kind whose cost no signed limit bounds', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const refused = await refusedWith(
        harness,
        fixture.token,
        fixture.modelReference,
        openFrame({
          kind: 'transcription',
          config: {
            inputAudioFormat: 'pcm16_24khz',
            turnDetection: { type: 'none' },
            inputAudioTranscription: {},
          },
        })
      );
      expect(refused.error).toMatchObject({ code: 'unsupported_modality', param: 'kind' });
      expect(await reservationsFor(fixture.accountId)).toHaveLength(0);
    });
  });

  it('refuses limits the contract refuses, before the hold', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const refused = await refusedWith(
        harness,
        fixture.token,
        fixture.modelReference,
        openFrame({ limits: { maxDurationMs: 60_000, idleTimeoutMs: 120_000 } })
      );
      expect(refused.error).toMatchObject({ code: 'invalid_request', param: 'limits.idleTimeoutMs' });
      expect(refused.code).toBe(1008);
      expect(await reservationsFor(fixture.accountId)).toHaveLength(0);
      expect(harness.kaana.connections).toHaveLength(0);
    });
  });

  it('refuses an open with no model', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const refused = await refusedWith(harness, fixture.token, undefined, openFrame());
      expect(refused.error).toMatchObject({ code: 'invalid_request', param: 'model' });
    });
  });

  it('releases the hold when Kaana refuses the signed frame', async () => {
    const fixture = await realtimeModel();
    await withEdge(async (harness) => {
      const customer = await harness.connect(fixture.token, fixture.modelReference);
      const upstream = harness.kaana.nextConnection();
      customer.send(openFrame());
      const connection = await upstream;
      connection.socket.close(1008, 'refused');
      expect((await customer.closed).code).toBe(1011);
      const [receipt] = await oneReceipt(fixture.accountId);
      expect(receipt).toMatchObject({ billedAmount: '0.000000000000', usageSource: 'estimated' });
    });
  });
});

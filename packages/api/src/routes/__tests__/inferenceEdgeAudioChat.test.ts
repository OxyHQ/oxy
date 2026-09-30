/**
 * Audio chat on `POST /v1/chat/completions` (contract set 3.2.0, OxyHQ/Kaana#90)
 * — against a REAL signed HTTP hop to a stub data plane, a real Postgres, a
 * real machine credential and the real ledger.
 *
 * What each group makes falsifiable:
 *
 *  - **Rendering.** The stub streams Kaana's `audio` events and
 *    `output_audio_transcript` deltas; the assertions read OpenAI's own shapes
 *    back (`delta.audio`, `message.audio`, the nested usage details), so a
 *    renderer that dropped the transcript, leaked it into `content`, or
 *    mis-nested the audio tokens goes red on a named field.
 *  - **Money.** Every settlement asserts an EXACT amount computed from the
 *    fixture's own prices, including `audio_output_tokens` at its own rate — a
 *    ledger that folded audio into text tokens would bill a different number.
 *    The hold is asserted too: it is sized at the audio output price, the most
 *    expensive member of the output partition.
 *  - **Refusals before the data plane.** Each refusal asserts the stub saw no
 *    inference call and no reservation was written, because "refused" and
 *    "refused after reserving and forwarding" are both a 4xx to the caller.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import type { InferenceRequest, UsageQuantity } from '@oxy.so/contracts';
import {
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
} from '../../config/kaanaDataPlane';
import { closePostgres, connectPostgres } from '../../config/postgres';
import {
  createHttpKaanaClient,
  KAANA_DEPLOYMENTS_QUERY_PATH,
  KAANA_INFERENCE_PATH,
} from '../../services/httpKaanaClient';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import { attestFixtureDeployments } from '../__fixtures__/kaanaRuntimeFixtures';
import {
  AUDIO_PRICES,
  EDGE_ROLLOUT_ENVIRONMENT,
  makeAudioFixture,
  receiptsFor,
  reservationsFor,
  verifyEdgeSignature,
  waitFor,
  type AudioFixture,
} from '../__fixtures__/kaanaAudioFixtures';

jest.setTimeout(60_000);

const EDGE_KEY_ID = 'oxy-edge-audio-test';
const edgeKeys = generateKeyPairSync('ed25519');
const EDGE_PRIVATE_PEM = edgeKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/* -------------------------------------------------------------------------- */
/*  The stub data plane                                                       */
/* -------------------------------------------------------------------------- */

interface Emit {
  readonly envelope: InferenceRequest;
  readonly event: (payload: Record<string, unknown>) => void;
  readonly report: (units: UsageQuantity[], outcome?: string) => void;
}

type Script = (emit: Emit) => void;

interface Stub {
  readonly baseUrl: string;
  readonly received: InferenceRequest[];
  script: Script;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    baseUrl: '',
    received: [],
    script: () => undefined,
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        if (!verifyEdgeSignature(EDGE_KEY_ID, edgeKeys.publicKey, req.headers, body)) {
          res.writeHead(401).end();
          return;
        }
        if (req.url === KAANA_DEPLOYMENTS_QUERY_PATH) {
          const query = JSON.parse(body.toString('utf8')) as { deploymentIds: string[] };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(await attestFixtureDeployments(query.deploymentIds)));
          return;
        }
        if (req.url !== KAANA_INFERENCE_PATH) {
          res.writeHead(404).end();
          return;
        }
        const envelope = JSON.parse(body.toString('utf8')) as InferenceRequest;
        stub.received.push(envelope);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const route = envelope.authorizedRoutes[0];
        const requestId = envelope.attribution.requestId;
        let sequence = 0;
        const frame = (name: string, payload: unknown): void => {
          res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        stub.script({
          envelope,
          event: (payload) =>
            frame('stream_event', {
              schemaVersion: payload.type === 'usage' ? 2 : 1,
              requestId,
              sequence: sequence++,
              ...payload,
            }),
          report: (units, outcome = 'completed') => {
            const now = new Date().toISOString();
            frame('usage_report', {
              schemaVersion: 2,
              requestId,
              generationId: `gen-${requestId}`,
              attribution: envelope.attribution,
              outcome,
              units,
              usageSource: 'provider_reported',
              resolvedModelReference: route.modelReference,
              servingProvider: route.provider,
              deploymentId: route.deploymentId,
              routeSwitches: 0,
              startedAt: now,
              completedAt: now,
            });
          },
        });
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  (stub as { baseUrl: string }).baseUrl = `http://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

/* -------------------------------------------------------------------------- */
/*  The edge                                                                  */
/* -------------------------------------------------------------------------- */

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

async function withEdge(run: (stub: Stub, post: (body: unknown, token: string) => Promise<Answer>) => Promise<void>): Promise<void> {
  const stub = await startStub();
  process.env[KAANA_BASE_URL_VARIABLE] = 'https://kaana.ai';
  process.env[KAANA_SIGNING_KEY_ID_VARIABLE] = EDGE_KEY_ID;
  process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE] = EDGE_PRIVATE_PEM;
  const systemFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    expect(requested.origin).toBe('https://kaana.ai');
    return systemFetch(`${stub.baseUrl}${requested.pathname}`, init);
  }) as typeof fetch;

  const kaanaClient = createHttpKaanaClient();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createInferenceEdgeRouter(kaanaClient === undefined ? {} : { kaanaClient }));
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  const { port } = server.address() as AddressInfo;

  const post = (body: unknown, token: string): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8');
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
        }
      );
      request.on('error', reject);
      request.end(payload);
    });

  try {
    await run(stub, post);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await stub.close();
    globalThis.fetch = systemFetch;
    delete process.env[KAANA_BASE_URL_VARIABLE];
    delete process.env[KAANA_SIGNING_KEY_ID_VARIABLE];
    delete process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE];
  }
}

const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  Object.keys(EDGE_ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]])
);

beforeAll(async () => {
  Object.assign(process.env, EDGE_ROLLOUT_ENVIRONMENT);
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
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const spokenBody = (fixture: AudioFixture, overrides: Record<string, unknown> = {}) => ({
  model: fixture.modelReference,
  messages: [{ role: 'user', content: 'Say hello.' }],
  max_tokens: 1000,
  modalities: ['text', 'audio'],
  audio: { voice: 'alloy', format: 'wav' },
  ...overrides,
});

/** Two chunks of "audio", independently base64-encoded as the contract requires. */
const CLIP_A = Buffer.from('RIFF-first-half').toString('base64');
const CLIP_B = Buffer.from('-second-half').toString('base64');

const SPOKEN_UNITS: UsageQuantity[] = [
  { unit: 'requests', quantity: 1 },
  { unit: 'input_tokens', quantity: 12 },
  { unit: 'output_tokens', quantity: 5 },
  { unit: 'audio_output_tokens', quantity: 50 },
];

/** 12 × $3/M + 5 × $15/M + 50 × $80/M. */
const SPOKEN_CHARGE = '0.004111000000';

function speaks(mediaType: string): Script {
  return (emit) => {
    emit.event({
      type: 'start',
      generationId: `gen-${emit.envelope.attribution.requestId}`,
      resolvedModelReference: emit.envelope.authorizedRoutes[0].modelReference,
      servingProvider: emit.envelope.authorizedRoutes[0].provider,
      startedAt: new Date().toISOString(),
    });
    emit.event({ type: 'delta', outputIndex: 0, channel: 'output_audio_transcript', text: 'Hel' });
    emit.event({ type: 'audio', outputIndex: 0, mediaType, data: CLIP_A });
    emit.event({ type: 'delta', outputIndex: 0, channel: 'output_audio_transcript', text: 'lo.' });
    emit.event({ type: 'audio', outputIndex: 0, mediaType, data: CLIP_B });
    emit.event({
      type: 'usage',
      deploymentId: emit.envelope.authorizedRoutes[0].deploymentId,
      units: SPOKEN_UNITS,
      usageSource: 'provider_reported',
    });
    emit.event({ type: 'done', finishReason: 'stop', completedAt: new Date().toISOString() });
    emit.report(SPOKEN_UNITS);
  };
}

/* -------------------------------------------------------------------------- */
/*  Non-streaming                                                             */
/* -------------------------------------------------------------------------- */

describe('a spoken chat completion, not streamed', () => {
  it('forwards audioOutput and renders message.audio with its transcript and audio usage', async () => {
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      stub.script = speaks('audio/wav');
      const answer = await post(spokenBody(fixture), fixture.token);
      expect(answer.status).toBe(200);

      const envelope = stub.received[0];
      expect(envelope.audioOutput).toEqual({ voice: 'alloy', format: 'wav' });
      expect(envelope.modality).toBe('audio');
      expect(envelope.client.apiFormat).toBe('chat_completions');

      const body = JSON.parse(answer.body) as {
        created: number;
        choices: { message: { content: string | null; audio: Record<string, unknown> } }[];
        usage: Record<string, unknown>;
      };
      const requestId = String(answer.headers['x-oxy-request-id']);
      const message = body.choices[0].message;
      // The words are the transcript, never a second written answer.
      expect(message.content).toBeNull();
      expect(message.audio).toEqual({
        id: `audio_${requestId}`,
        data: Buffer.concat([
          Buffer.from(CLIP_A, 'base64'),
          Buffer.from(CLIP_B, 'base64'),
        ]).toString('base64'),
        transcript: 'Hello.',
        expires_at: body.created,
      });
      expect(body.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 55,
        total_tokens: 67,
        prompt_tokens_details: {
          cached_tokens: 0,
          audio_tokens: 0,
          cached_tokens_details: { audio_tokens: 0 },
        },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 50 },
      });
      expect(answer.headers['x-oxy-usage-audio-output-tokens']).toBe('50');

      const receipts = await receiptsFor(fixture.accountId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].billedAmount).toBe(SPOKEN_CHARGE);
      expect(receipts[0].audioOutputTokens).toBe(50);
      expect(receipts[0].outputTokens).toBe(5);
    });
  });

  it('sizes the hold at the audio output price, the dearest member of the output partition', async () => {
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      stub.script = speaks('audio/wav');
      const answer = await post(spokenBody(fixture), fixture.token);
      expect(answer.status).toBe(200);
      const [reservation] = await reservationsFor(fixture.accountId);
      // Input ceiling: "Say hello." is 10 characters + 8 template tokens = 18,
      // at the dearer of $3/M (text) and $1/M (cached). Output ceiling: 1000 at
      // the dearest of $15/M (text), $15/M (reasoning) and $80/M (audio).
      expect(reservation.reservedAmount).toBe('0.080054000000');
    });
  });

  it('renders the audio usage details on a text-only answer only when audio was metered', async () => {
    // The control for the byte-compatibility promise: a plain completion on an
    // audio-capable model still renders the pre-3.2.0 usage shape.
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      const units: UsageQuantity[] = [
        { unit: 'requests', quantity: 1 },
        { unit: 'input_tokens', quantity: 12 },
        { unit: 'output_tokens', quantity: 3 },
      ];
      stub.script = (emit) => {
        emit.event({ type: 'delta', outputIndex: 0, channel: 'output_text', text: 'Hi.' });
        emit.event({ type: 'done', finishReason: 'stop', completedAt: new Date().toISOString() });
        emit.report(units);
      };
      const answer = await post(
        { model: fixture.modelReference, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 100 },
        fixture.token
      );
      expect(answer.status).toBe(200);
      expect(stub.received[0].audioOutput).toBeUndefined();
      expect(stub.received[0].modality).toBe('text');
      const body = JSON.parse(answer.body) as {
        choices: { message: Record<string, unknown> }[];
        usage: Record<string, unknown>;
      };
      expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'Hi.' });
      expect(body.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      });
      expect(answer.headers['x-oxy-usage-audio-output-tokens']).toBeUndefined();
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Streaming                                                                 */
/* -------------------------------------------------------------------------- */

describe('a spoken chat completion, streamed', () => {
  it('streams delta.audio data and transcript, then audio usage, and settles exactly', async () => {
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      stub.script = speaks('audio/pcm');
      const answer = await post(
        spokenBody(fixture, { stream: true, audio: { voice: 'alloy', format: 'pcm16' } }),
        fixture.token
      );
      expect(answer.status).toBe(200);
      expect(stub.received[0].audioOutput).toEqual({ voice: 'alloy', format: 'pcm' });
      expect(stub.received[0].stream).toBe(true);

      const requestId = String(answer.headers['x-oxy-request-id']);
      const frames = answer.body
        .split('\n\n')
        .map((frame) => frame.replace(/^data: /, ''))
        .filter((data) => data.length > 0);
      expect(frames[frames.length - 1]).toBe('[DONE]');
      const chunks = frames
        .slice(0, -1)
        .map((data) => JSON.parse(data) as { created: number; choices: { delta: Record<string, unknown> }[]; usage?: Record<string, unknown> });
      const audioDeltas = chunks
        .filter((chunk) => chunk.choices[0]?.delta.audio !== undefined)
        .map((chunk) => chunk.choices[0].delta.audio);
      const id = `audio_${requestId}`;
      expect(audioDeltas).toEqual([
        { id, transcript: 'Hel' },
        { id, data: CLIP_A, expires_at: chunks[0].created },
        { id, transcript: 'lo.' },
        { id, data: CLIP_B },
      ]);
      // Neither the transcript nor the audio ever becomes `delta.content`.
      expect(chunks.some((chunk) => chunk.choices[0]?.delta.content !== undefined)).toBe(false);
      const usage = chunks.find((chunk) => chunk.usage !== undefined)?.usage;
      expect(usage).toMatchObject({
        completion_tokens: 55,
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 50 },
      });

      const receipts = await waitFor(async () => {
        const rows = await receiptsFor(fixture.accountId);
        return rows.length > 0 ? rows : undefined;
      }, 'the streamed receipt');
      expect(receipts).toHaveLength(1);
      expect(receipts[0].billedAmount).toBe(SPOKEN_CHARGE);
      expect(receipts[0].audioOutputTokens).toBe(50);
    });
  });

  it('refuses a streamed non-pcm format before reserving or forwarding', async () => {
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      const answer = await post(spokenBody(fixture, { stream: true }), fixture.token);
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { param: 'audio.format' } });
      expect(stub.received).toHaveLength(0);
      expect(await reservationsFor(fixture.accountId)).toHaveLength(0);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Capability and price refusals                                             */
/* -------------------------------------------------------------------------- */

describe('spoken output is authorized only against a declaration and a full price list', () => {
  it('refuses a model that declares no api formats: catalogue presence is not evidence', async () => {
    const fixture = await makeAudioFixture({ apiFormats: null });
    await withEdge(async (stub, post) => {
      const answer = await post(spokenBody(fixture), fixture.token);
      expect(answer.status).toBe(400);
      const body = JSON.parse(answer.body) as { error: { message: string; param?: string } };
      expect(body.error.message).toContain('does not declare spoken output on chat_completions');
      expect(stub.received).toHaveLength(0);
      expect(await reservationsFor(fixture.accountId)).toHaveLength(0);
    });
  });

  it('refuses a model that declares chat but produces no audio', async () => {
    const fixture = await makeAudioFixture({
      apiFormats: ['chat_completions'],
      outputModalities: ['text'],
    });
    await withEdge(async (stub, post) => {
      const answer = await post(spokenBody(fixture), fixture.token);
      expect(answer.status).toBe(400);
      expect(stub.received).toHaveLength(0);
    });
  });

  it('refuses ordinary chat on a model whose declaration excludes chat_completions', async () => {
    const fixture = await makeAudioFixture({ apiFormats: ['audio_speech'] });
    await withEdge(async (stub, post) => {
      const answer = await post(
        { model: fixture.modelReference, messages: [{ role: 'user', content: 'Hi' }] },
        fixture.token
      );
      expect(answer.status).toBe(400);
      const body = JSON.parse(answer.body) as { error: { message: string } };
      expect(body.error.message).toContain('is not served through chat_completions');
      expect(stub.received).toHaveLength(0);
    });
  });

  it('refuses before a hold when a route leaves audio_output_tokens unpriced', async () => {
    // The existing rule for an unpriced unit, on the new one: it never becomes
    // free. Every ceiling scenario must quote, and one cannot.
    const { audio_output_tokens: _unpriced, ...withoutAudioOutput } = AUDIO_PRICES;
    const fixture = await makeAudioFixture({
      apiFormats: ['chat_completions'],
      prices: withoutAudioOutput,
    });
    await withEdge(async (stub, post) => {
      const answer = await post(spokenBody(fixture), fixture.token);
      expect(answer.status).toBe(503);
      expect(stub.received).toHaveLength(0);
      expect(await reservationsFor(fixture.accountId)).toHaveLength(0);
    });
  });

  it('serves the same request once the price exists (the control for the refusal above)', async () => {
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      stub.script = speaks('audio/wav');
      const answer = await post(spokenBody(fixture), fixture.token);
      expect(answer.status).toBe(200);
      expect(stub.received).toHaveLength(1);
    });
  });

  it.each([
    [{ modalities: ['text', 'audio'] }, 'audio'],
    [{ audio: { voice: 'alloy', format: 'wav' }, modalities: ['text'] }, 'modalities'],
    [{ modalities: ['audio'] }, 'modalities'],
    [{ audio: { voice: 'alloy', format: 'aac' } }, 'audio.format'],
  ])('refuses an inconsistent audio request %j at the dialect', async (overrides, param) => {
    const fixture = await makeAudioFixture({ apiFormats: ['chat_completions'] });
    await withEdge(async (stub, post) => {
      const base = spokenBody(fixture) as Record<string, unknown>;
      const body = { ...base, ...overrides } as Record<string, unknown>;
      if (!('audio' in overrides) && param === 'audio') delete body.audio;
      const answer = await post(body, fixture.token);
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { param } });
      expect(stub.received).toHaveLength(0);
    });
  });
});

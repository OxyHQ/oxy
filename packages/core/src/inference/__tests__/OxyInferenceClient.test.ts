/**
 * What the inference client puts on the wire, and what it makes of an answer.
 *
 * Three things here can actually be wrong, and they are what these cases pin:
 *
 *  1. **The URL.** A canonical model id contains a slash, so it becomes TWO path
 *     segments; a single encoded one matches no route.
 *  2. **The credential lane.** A static key is sent verbatim; a function is
 *     called on EVERY request, because an Oxy bearer rotates and a captured one
 *     goes stale.
 *  3. **The refusal.** Two routers answer under `/v1` with two different error
 *     shapes, and both must become one `OxyInferenceError` carrying the server's
 *     own `code`, `retryable` and `requestId` — never a retryability this client
 *     inferred from a status.
 *
 * Every "sends nothing" assertion is paired with a positive control proving a
 * valid input DOES reach the transport; without one, a method that threw
 * unconditionally would satisfy them all.
 */

import {
    OxyInferenceClient,
    OxyInferenceError,
    OxyInferenceProtocolError,
} from '../OxyInferenceClient';

type StubAnswer =
    | {
          readonly status: number;
          readonly body: unknown;
          readonly headers?: Record<string, string>;
      }
    | {
          readonly status: number;
          readonly sse: readonly string[];
          readonly headers?: Record<string, string>;
          readonly keepOpen?: boolean;
          readonly onCancel?: () => void;
      }
    | {
          readonly status: number;
          readonly rawSse: readonly Uint8Array[];
          readonly headers?: Record<string, string>;
          readonly keepOpen?: boolean;
          readonly onCancel?: () => void;
      };

/** A `fetch` double that records its calls and replays queued answers. */
function stubFetch(answers: StubAnswer[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const answer = answers.shift() ?? { status: 200, body: {} };
        if ('sse' in answer || 'rawSse' in answer) {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    const encoder = new TextEncoder();
                    const chunks = 'sse' in answer
                        ? answer.sse.map((chunk) => encoder.encode(chunk))
                        : answer.rawSse;
                    for (const chunk of chunks) controller.enqueue(chunk);
                    if (answer.keepOpen !== true) controller.close();
                },
                cancel() {
                    answer.onCancel?.();
                },
            });
            return new Response(body, {
                status: answer.status,
                headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'X-Oxy-Request-Id': 'req-stream',
                    ...(answer.headers ?? {}),
                },
            });
        }
        return new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: {
                'Content-Type': 'application/json',
                ...(answer.headers ?? {}),
            },
        });
    });
    return { impl: impl as unknown as typeof fetch, calls };
}

const STREAM_START = {
    schemaVersion: 1,
    type: 'start',
    requestId: 'req-stream',
    sequence: 0,
    generationId: 'generation-1',
    resolvedModelReference: 'acme/some-model@2026-09-02',
    servingProvider: 'acme-cloud',
    startedAt: '2026-09-02T08:00:00.000Z',
} as const;

const STREAM_DONE = {
    schemaVersion: 1,
    type: 'done',
    requestId: 'req-stream',
    sequence: 1,
    generationId: 'generation-1',
    finishReason: 'stop',
    receiptId: 'receipt-1',
    completedAt: '2026-09-02T08:00:01.000Z',
} as const;

function sseFrame(event: { readonly type: string }): string {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function headerOf(init: RequestInit, name: string): string | undefined {
    const headers = init.headers as Record<string, string> | undefined;
    return headers?.[name];
}

describe('OxyInferenceClient', () => {
    describe('the two credential lanes', () => {
        it('sends a static machine key verbatim, exactly as a stock SDK would', async () => {
            const { impl, calls } = stubFetch([{ status: 200, body: { data: [], count: 0 } }]);
            const client = new OxyInferenceClient({
                credential: 'oxy_sk_0123456789abcdef_deadbeef',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await client.listModels();

            expect(headerOf(calls[0].init, 'Authorization')).toBe(
                'Bearer oxy_sk_0123456789abcdef_deadbeef',
            );
        });

        it('calls a credential FUNCTION on every request, so a rotated bearer is used', async () => {
            const { impl, calls } = stubFetch([
                { status: 200, body: { data: [], count: 0 } },
                { status: 200, body: { data: [], count: 0 } },
            ]);
            const bearers = ['first', 'second'];
            const client = new OxyInferenceClient({
                credential: () => bearers.shift() ?? null,
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await client.listModels();
            await client.listModels();

            // A client that captured the bearer at construction would send
            // `first` twice — which is what an expired session looks like an
            // hour into a process's life.
            expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer first');
            expect(headerOf(calls[1].init, 'Authorization')).toBe('Bearer second');
        });

        it('refuses before fetching when the credential resolves to nothing', async () => {
            const { impl, calls } = stubFetch([]);
            const client = new OxyInferenceClient({
                credential: () => null,
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await expect(client.listModels()).rejects.toThrow('no bearer');
            expect(calls).toHaveLength(0);
        });
    });

    describe('catalogue reads', () => {
        it('GETs /v1/models and unwraps the data envelope', async () => {
            const entry = { schemaVersion: 1, modelId: 'acme/some-model' };
            const { impl, calls } = stubFetch([
                { status: 200, body: { data: [entry], count: 1 } },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await expect(client.listModels()).resolves.toEqual([entry]);
            expect(calls[0].url).toBe('http://test.invalid/v1/models');
        });

        it('returns [] for an empty catalogue rather than throwing', async () => {
            // The catalogue IS empty today. A consumer treating `[]` as a failure
            // would be broken on the only answer the endpoint currently gives.
            const { impl } = stubFetch([{ status: 200, body: { data: [], count: 0 } }]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await expect(client.listModels()).resolves.toEqual([]);
        });

        it('splits a canonical model id into two path segments', async () => {
            const entry = { schemaVersion: 1, modelId: 'acme/some-model' };
            const { impl, calls } = stubFetch([{ status: 200, body: { data: entry } }]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await expect(client.getModel('acme/some-model')).resolves.toEqual(entry);
            // NOT `/v1/models/acme%2Fsome-model` — one encoded segment matches no route.
            expect(calls[0].url).toBe('http://test.invalid/v1/models/acme/some-model');
        });

        it.each([
            ['a revision pin, which names a reference and not a model', 'acme/some-model@2026-05-01'],
            ['no publisher segment', 'some-model'],
            ['a third segment', 'acme/some-model/turbo'],
            ['an empty publisher', '/some-model'],
            ['an empty model', 'acme/'],
            ['uppercase, which the id grammar forbids', 'Acme/Some-Model'],
            ['the empty string', ''],
        ])('getModel refuses %s, and sends nothing', async (_label, modelId) => {
            const { impl, calls } = stubFetch([]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await expect(client.getModel(modelId)).rejects.toThrow('Not a canonical model id');
            expect(calls).toHaveLength(0);
        });

        it('positive control: a well-formed id DOES reach the transport', async () => {
            const { impl, calls } = stubFetch([
                { status: 200, body: { data: { schemaVersion: 1, modelId: 'acme/other' } } },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await client.getModel('acme/other');
            expect(calls).toHaveLength(1);
        });

        it('GETs the routing-profiles collection as ONE segment', async () => {
            // Were it built as two, `/v1/models/:publisher/:model` would capture
            // it and read it as a model lookup.
            const { impl, calls } = stubFetch([
                { status: 200, body: { data: [{ schemaVersion: 1, slug: 'auto' }], count: 1 } },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await client.listRoutingProfiles();
            expect(calls[0].url).toBe('http://test.invalid/v1/models/routing-profiles');
        });
    });

    describe('respond', () => {
        it('POSTs the request body to /v1/responses', async () => {
            const { impl, calls } = stubFetch([
                {
                    status: 200,
                    body: {
                        schemaVersion: 1,
                        requestId: 'req-1',
                        model: 'acme/some-model@1',
                        servingProvider: 'acme-cloud',
                        finishReason: 'stop',
                        output: [],
                        usage: [],
                        routingPolicy: { routingPolicyId: 'platform-default', policyVersion: 1 },
                    },
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const answer = await client.respond({ model: 'acme/some-model', input: 'hello' });

            expect(calls[0].url).toBe('http://test.invalid/v1/responses');
            expect(calls[0].init.method).toBe('POST');
            expect(JSON.parse(String(calls[0].init.body))).toEqual({
                model: 'acme/some-model',
                input: 'hello',
            });
            expect(answer.requestId).toBe('req-1');
        });

        it('serializes an exact routing-profile ID byte-for-byte', async () => {
            const { impl, calls } = stubFetch([{ status: 200, body: {} }]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await client.respond({ routingProfileId: ' profile-pk ', input: 'hello' });

            expect(JSON.parse(String(calls[0].init.body))).toEqual({
                routingProfileId: ' profile-pk ',
                input: 'hello',
            });
        });

        it('carries the idempotency key and the delegated user in headers, not the body', async () => {
            const { impl, calls } = stubFetch([{ status: 200, body: {} }]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            await client.respond(
                { model: 'acme/some-model', input: 'hello' },
                { idempotencyKey: 'key-1', delegatedUserId: 'user-1' },
            );

            expect(headerOf(calls[0].init, 'Idempotency-Key')).toBe('key-1');
            expect(headerOf(calls[0].init, 'X-Oxy-User-Id')).toBe('user-1');
            // Neither belongs in the body: the delegated user is attribution and
            // never a billing identity, and the key is a transport concern.
            expect(JSON.parse(String(calls[0].init.body))).toEqual({
                model: 'acme/some-model',
                input: 'hello',
            });
        });

        it('passes the abort signal through, so a disconnect can cancel', async () => {
            const { impl, calls } = stubFetch([{ status: 200, body: {} }]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const controller = new AbortController();

            await client.respond({ input: 'hello' }, { signal: controller.signal });

            expect(calls[0].init.signal).toBe(controller.signal);
        });
    });

    describe('stream', () => {
        it('POSTs stream: true and yields contract-validated SSE events', async () => {
            const { impl, calls } = stubFetch([
                {
                    status: 200,
                    sse: [sseFrame(STREAM_START), sseFrame(STREAM_DONE)],
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'service-token',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const types: string[] = [];

            for await (const event of client.stream({
                routingProfile: 'quality',
                input: 'hello',
            })) {
                types.push(event.type);
            }

            expect(types).toEqual(['start', 'done']);
            expect(calls[0].url).toBe('http://test.invalid/v1/responses');
            expect(calls[0].init.method).toBe('POST');
            expect(headerOf(calls[0].init, 'Accept')).toBe('text/event-stream');
            expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer service-token');
            expect(JSON.parse(String(calls[0].init.body))).toEqual({
                routingProfile: 'quality',
                input: 'hello',
                stream: true,
            });
        });

        it('sends idempotency and delegated-user attribution as headers and forwards abort', async () => {
            const { impl, calls } = stubFetch([
                { status: 200, sse: [sseFrame(STREAM_START), sseFrame(STREAM_DONE)] },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const controller = new AbortController();

            for await (const _event of client.stream(
                { model: 'acme/some-model', input: 'hello' },
                {
                    signal: controller.signal,
                    idempotencyKey: 'run-1-step-1',
                    delegatedUserId: 'user-1',
                },
            )) {
                // Iterating is the operation: async-generator code starts on the
                // first `next()`, not when `stream()` returns the iterator.
            }

            expect(calls[0].init.signal).toBe(controller.signal);
            expect(headerOf(calls[0].init, 'Idempotency-Key')).toBe('run-1-step-1');
            expect(headerOf(calls[0].init, 'X-Oxy-User-Id')).toBe('user-1');
            expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('delegatedUserId');
        });

        it('re-reads a service-token credential for every streamed request', async () => {
            const { impl, calls } = stubFetch([
                { status: 200, sse: [sseFrame(STREAM_START), sseFrame(STREAM_DONE)] },
                { status: 200, sse: [sseFrame(STREAM_START), sseFrame(STREAM_DONE)] },
            ]);
            const bearers = ['service-token-1', 'service-token-2'];
            const client = new OxyInferenceClient({
                credential: () => bearers.shift() ?? null,
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            for await (const _event of client.stream({ input: 'first' })) {
                // Consume the stream fully so its terminal contract is checked.
            }
            for await (const _event of client.stream({ input: 'second' })) {
                // Consume the second stream with a newly minted bearer.
            }

            expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer service-token-1');
            expect(headerOf(calls[1].init, 'Authorization')).toBe('Bearer service-token-2');
        });

        it('decodes fragmented CRLF frames, comments and multiline data', async () => {
            const start = JSON.stringify(STREAM_START);
            const { impl } = stubFetch([
                {
                    status: 200,
                    sse: [
                        ': keep-alive\r\nevent: st',
                        `art\r\ndata: ${start.slice(0, 1)}\r\ndata: ${start.slice(1)}\r`,
                        `\n\r\n${sseFrame(STREAM_DONE)}`,
                    ],
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const types: string[] = [];

            for await (const event of client.stream({ input: 'hello' })) {
                types.push(event.type);
            }

            expect(types).toEqual(['start', 'done']);
        });

        it('accepts usage schema v2 only when it carries its deployment id', async () => {
            const usage = {
                schemaVersion: 2,
                type: 'usage',
                requestId: 'req-stream',
                sequence: 1,
                deploymentId: 'deployment-1',
                units: [{ unit: 'output_tokens', quantity: 12 }],
                usageSource: 'provider_reported',
            } as const;
            const done = { ...STREAM_DONE, sequence: 2 };
            const { impl } = stubFetch([
                {
                    status: 200,
                    sse: [sseFrame(STREAM_START), sseFrame(usage), sseFrame(done)],
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const deploymentIds: string[] = [];

            for await (const event of client.stream({ input: 'hello' })) {
                if (event.type === 'usage') deploymentIds.push(event.deploymentId);
            }

            expect(deploymentIds).toEqual(['deployment-1']);
        });

        it('fails closed when a usage event is not schema v2', async () => {
            const usageV1 = {
                schemaVersion: 1,
                type: 'usage',
                requestId: 'req-stream',
                sequence: 1,
                units: [{ unit: 'output_tokens', quantity: 12 }],
                usageSource: 'provider_reported',
            };
            const { impl } = stubFetch([
                {
                    status: 200,
                    sse: [sseFrame(STREAM_START), sseFrame(usageV1)],
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const iterator = client.stream({ input: 'hello' });

            await expect(iterator.next()).resolves.toMatchObject({
                value: { type: 'start' },
            });
            await expect(iterator.next()).rejects.toBeInstanceOf(OxyInferenceProtocolError);
        });

        it('throws OxyInferenceError for a refusal before SSE opens', async () => {
            const { impl } = stubFetch([
                {
                    status: 403,
                    body: {
                        schemaVersion: 1,
                        code: 'permission_denied',
                        message: 'Missing inference:invoke.',
                        retryable: false,
                        requestId: 'req-refused',
                    },
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const error = await client
                .stream({ input: 'hello' })
                .next()
                .catch((thrown: unknown) => thrown);

            expect(error).toBeInstanceOf(OxyInferenceError);
            expect(error).toMatchObject({
                code: 'permission_denied',
                requestId: 'req-refused',
            });
        });

        it('yields a validated in-stream terminal error and expects no done event', async () => {
            const terminal = {
                schemaVersion: 1,
                type: 'error',
                requestId: 'req-stream',
                sequence: 1,
                error: {
                    schemaVersion: 1,
                    code: 'provider_error',
                    message: 'The provider disconnected.',
                    retryable: true,
                    requestId: 'req-stream',
                },
            } as const;
            const { impl } = stubFetch([
                {
                    status: 200,
                    sse: [sseFrame(STREAM_START), sseFrame(terminal)],
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const types: string[] = [];

            for await (const event of client.stream({ input: 'hello' })) {
                types.push(event.type);
            }

            expect(types).toEqual(['start', 'error']);
        });

        it('keeps reading to EOF and rejects any event after a terminal event', async () => {
            const postTerminalUsage = {
                schemaVersion: 2,
                type: 'usage',
                requestId: 'req-stream',
                sequence: 2,
                deploymentId: 'deployment-1',
                units: [{ unit: 'output_tokens', quantity: 12 }],
                usageSource: 'provider_reported',
            } as const;
            const { impl } = stubFetch([
                {
                    status: 200,
                    sse: [
                        sseFrame(STREAM_START),
                        sseFrame(STREAM_DONE),
                        sseFrame(postTerminalUsage),
                    ],
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const iterator = client.stream({ input: 'hello' });

            await expect(iterator.next()).resolves.toMatchObject({
                value: { type: 'start' },
                done: false,
            });
            await expect(iterator.next()).resolves.toMatchObject({
                value: { type: 'done' },
                done: false,
            });
            await expect(iterator.next()).rejects.toThrow('after a terminal event');
        });

        it('fails closed on malformed JSON and on a stream without a terminal event', async () => {
            const malformed = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: stubFetch([{ status: 200, sse: ['event: start\ndata: {nope}\n\n'] }]).impl,
            });
            const incomplete = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: stubFetch([{ status: 200, sse: [sseFrame(STREAM_START)] }]).impl,
            });
            const incompleteIterator = incomplete.stream({ input: 'hello' });

            await expect(malformed.stream({ input: 'hello' }).next()).rejects.toBeInstanceOf(
                OxyInferenceProtocolError,
            );
            await expect(incompleteIterator.next()).resolves.toMatchObject({
                value: { type: 'start' },
            });
            await expect(incompleteIterator.next()).rejects.toBeInstanceOf(
                OxyInferenceProtocolError,
            );
        });

        it('fails closed on invalid UTF-8 and on unbounded empty data-line arrays', async () => {
            const invalidUtf8 = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: stubFetch([
                    {
                        status: 200,
                        rawSse: [
                            new TextEncoder().encode('event: start\ndata: '),
                            new Uint8Array([0xff]),
                            new TextEncoder().encode('\n\n'),
                        ],
                    },
                ]).impl,
            });
            const tooManyLines = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: stubFetch([
                    {
                        status: 200,
                        sse: [`event: start\n${'data:\n'.repeat(4097)}\n`],
                    },
                ]).impl,
            });

            await expect(invalidUtf8.stream({ input: 'hello' }).next()).rejects.toMatchObject({
                name: 'OxyInferenceProtocolError',
                message: expect.stringContaining('valid UTF-8'),
            });
            await expect(tooManyLines.stream({ input: 'hello' }).next()).rejects.toMatchObject({
                name: 'OxyInferenceProtocolError',
                message: expect.stringContaining('over 4096 data lines'),
            });
        });

        it('cancels the response body when the caller stops iterating', async () => {
            let cancelled = false;
            const { impl } = stubFetch([
                {
                    status: 200,
                    sse: [sseFrame(STREAM_START)],
                    keepOpen: true,
                    onCancel: () => {
                        cancelled = true;
                    },
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            for await (const _event of client.stream({ input: 'hello' })) {
                break;
            }

            expect(cancelled).toBe(true);
        });
    });

    describe('refusals', () => {
        it('maps the edge error body onto OxyInferenceError, keeping the server verdict', async () => {
            // This IS what a developer observes today: the edge authenticates,
            // reserves, finds no data plane, releases the hold and refuses.
            const { impl } = stubFetch([
                {
                    status: 503,
                    body: {
                        schemaVersion: 1,
                        code: 'service_unavailable',
                        message: 'No inference data plane is configured for this deployment.',
                        retryable: false,
                        requestId: 'req-503',
                    },
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const error: unknown = await client
                .respond({ model: 'acme/some-model', input: 'hi' })
                .catch((thrown: unknown) => thrown);

            expect(error).toBeInstanceOf(OxyInferenceError);
            const inferenceError = error as OxyInferenceError;
            expect(inferenceError.code).toBe('service_unavailable');
            expect(inferenceError.requestId).toBe('req-503');
            expect(inferenceError.status).toBe(503);
            // NOT derived from the 503: an unconfigured deployment is an
            // operator's to fix, and a retrying client would make it a storm.
            expect(inferenceError.retryable).toBe(false);
        });

        it('keeps retryAfterMs only when the server said the retry could succeed', async () => {
            const { impl } = stubFetch([
                {
                    status: 429,
                    body: {
                        schemaVersion: 1,
                        code: 'rate_limited',
                        message: 'Slow down.',
                        retryable: true,
                        retryAfterMs: 2000,
                        requestId: 'req-429',
                    },
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const error = (await client
                .respond({ model: 'acme/some-model', input: 'hi' })
                .catch((thrown: unknown) => thrown)) as OxyInferenceError;

            expect(error.retryable).toBe(true);
            expect(error.retryAfterMs).toBe(2000);
        });

        it('treats a body that asserts nothing as NOT retryable', async () => {
            // The safe direction. Inventing a retryable code for an unreadable
            // failure is how one outage becomes a retry storm.
            const { impl } = stubFetch([{ status: 500, body: {} }]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const error = (await client
                .respond({ model: 'acme/some-model', input: 'hi' })
                .catch((thrown: unknown) => thrown)) as OxyInferenceError;

            expect(error.retryable).toBe(false);
            expect(error.code).toBe('internal_error');
        });

        it('reads the platform envelope the catalogue router answers with', async () => {
            // Two routers serve `/v1`, and only one of them speaks the contract
            // error shape. A caller's `catch` must not have to know which.
            const { impl } = stubFetch([
                {
                    status: 404,
                    body: { error: 'Not Found', message: 'No model acme/nope is available to you' },
                    headers: { 'X-Oxy-Request-Id': 'req-404' },
                },
            ]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const error = (await client
                .getModel('acme/nope')
                .catch((thrown: unknown) => thrown)) as OxyInferenceError;

            expect(error).toBeInstanceOf(OxyInferenceError);
            expect(error.code).toBe('model_not_found');
            expect(error.message).toBe('No model acme/nope is available to you');
            // The envelope carries no requestId, so the header is the source.
            expect(error.requestId).toBe('req-404');
        });
    });

    it('trims a trailing slash from the base URL rather than doubling it', async () => {
        const { impl, calls } = stubFetch([{ status: 200, body: { data: [], count: 0 } }]);
        const client = new OxyInferenceClient({
            credential: 'k',
            baseURL: 'http://test.invalid/',
            fetch: impl,
        });

        await client.listModels();
        expect(calls[0].url).toBe('http://test.invalid/v1/models');
    });
});

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

import { OxyInferenceClient, OxyInferenceError } from '../OxyInferenceClient';

/** A `fetch` double that records its calls and replays queued answers. */
function stubFetch(
    answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const answer = answers.shift() ?? { status: 200, body: {} };
        return new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) },
        });
    });
    return { impl: impl as unknown as typeof fetch, calls };
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
        const start = {
            schemaVersion: 1,
            type: 'start',
            requestId: 'req_1',
            sequence: 0,
            resolvedModelReference: 'openai/gpt-5@2026-06-01',
            servingProvider: 'openai',
            startedAt: '2026-08-15T09:41:00.000Z',
        };
        const done = {
            schemaVersion: 1,
            type: 'done',
            requestId: 'req_1',
            sequence: 1,
            finishReason: 'stop',
            completedAt: '2026-08-15T09:41:02.000Z',
        };

        function streamFetch(events: readonly Record<string, unknown>[]) {
            const calls: Array<{ url: string; init: RequestInit }> = [];
            const impl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
                calls.push({ url: String(url), init: init ?? {} });
                const body = events
                    .map(
                        (event) =>
                            `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
                    )
                    .join('');
                return new Response(body, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
                });
            });
            return { impl: impl as unknown as typeof fetch, calls };
        }

        function rawStreamFetch(body: BodyInit, contentType = 'text/event-stream; charset=utf-8') {
            return jest.fn(
                async () =>
                    new Response(body, {
                        status: 200,
                        headers: { 'Content-Type': contentType },
                    }),
            ) as unknown as typeof fetch;
        }

        it('owns the streaming transport and yields only validated normalized events', async () => {
            const { impl, calls } = streamFetch([start, done]);
            const client = new OxyInferenceClient({
                credential: 'service-token',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const events = [];
            for await (const event of client.stream(
                { input: 'hello' },
                { delegatedUserId: 'user-1' },
            )) {
                events.push(event);
            }

            expect(events.map((event) => event.type)).toEqual(['start', 'done']);
            expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer service-token');
            expect(headerOf(calls[0].init, 'X-Oxy-User-Id')).toBe('user-1');
            expect(JSON.parse(String(calls[0].init.body))).toEqual({
                input: 'hello',
                stream: true,
            });
        });

        it.each([
            ['a non-start first event', [{ ...done, sequence: 0 }]],
            ['a sequence gap', [start, { ...done, sequence: 2 }]],
            ['a changed request id', [start, { ...done, requestId: 'req_other' }]],
        ])('rejects %s with a user-safe message', async (_label, events) => {
            const secret = 'credential-sensitive-value';
            const poisoned = events.map((event) => ({ ...event, ignored: secret }));
            const { impl } = streamFetch(poisoned);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });

            const error = await (async () => {
                try {
                    for await (const _event of client.stream({ input: 'hello' })) {
                        // Consume until validation rejects the stream.
                    }
                    return undefined;
                } catch (thrown) {
                    return thrown;
                }
            })();

            expect(error).toBeInstanceOf(Error);
            expect(String(error)).toContain('invalid event stream');
            expect(String(error)).not.toContain(secret);
        });

        it.each([
            [
                'an event-name mismatch',
                `event: done\ndata: ${JSON.stringify(start)}\n\n`,
            ],
            ['malformed JSON', 'event: start\ndata: {"credential":"sensitive-value"\n\n'],
            [
                'a stream without a terminal event',
                `event: start\ndata: ${JSON.stringify(start)}\n\n`,
            ],
            [
                'an oversized frame',
                `event: start\ndata: ${'x'.repeat(1024 * 1024 + 1)}\n\n`,
            ],
        ])('rejects %s without reflecting the upstream frame', async (_label, body) => {
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: rawStreamFetch(body),
            });

            const error = await (async () => {
                try {
                    for await (const _event of client.stream({ input: 'hello' })) {
                        // Consume until validation rejects the stream.
                    }
                    return undefined;
                } catch (thrown) {
                    return thrown;
                }
            })();

            expect(error).toBeInstanceOf(Error);
            expect(String(error)).toBe('Error: The inference API returned an invalid event stream.');
            expect(String(error)).not.toContain('sensitive-value');
        });

        it('rejects lookalike content types instead of treating them as SSE', async () => {
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: rawStreamFetch('', 'text/event-stream-not-really'),
            });

            await expect(async () => {
                for await (const _event of client.stream({ input: 'hello' })) {
                    // The response is rejected before decoding.
                }
            }).rejects.toThrow('invalid event stream');
        });

        it('actively cancels the response reader when the caller aborts', async () => {
            const cancel = jest.fn();
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(`event: start\ndata: ${JSON.stringify(start)}\n\n`),
                    );
                },
                cancel,
            });
            const controller = new AbortController();
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: rawStreamFetch(body),
            });
            const iterator = client
                .stream({ input: 'hello' }, { signal: controller.signal })
                [Symbol.asyncIterator]();

            await expect(iterator.next()).resolves.toEqual({ value: start, done: false });
            controller.abort();
            await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        it('passes cancellation to the owned fetch', async () => {
            const { impl, calls } = streamFetch([start, done]);
            const client = new OxyInferenceClient({
                credential: 'k',
                baseURL: 'http://test.invalid',
                fetch: impl,
            });
            const controller = new AbortController();

            for await (const _event of client.stream(
                { input: 'hello' },
                { signal: controller.signal },
            )) {
                // Exhaust the response.
            }

            expect(calls[0].init.signal).toBe(controller.signal);
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

/**
 * The Oxy inference client — one surface, two credential lanes (issue #972,
 * workstream 15).
 *
 * ```typescript
 * // An OpenAI-style machine key: one bearer string, no session, no exchange.
 * const oxy = new OxyInferenceClient({ credential: process.env.OXY_API_KEY });
 *
 * // Oxy auth: whatever bearer the session or the service-token mint holds.
 * const oxy = oxyServices.inference();
 * ```
 *
 * Both lanes reach the SAME endpoints and are told apart only by how the bearer
 * is produced: a machine key is a constant string, and an Oxy bearer rotates, so
 * it is a function this client calls on every request rather than a value it
 * captures once. There is no third lane, and no method behaves differently
 * depending on which one you used.
 *
 * `respond()` returns one completed response. `stream()` reads the same
 * `/v1/responses` endpoint without buffering and validates every SSE event
 * against `inferenceStreamEventSchema` before exposing it to the caller.
 *
 * ## Why this is a client and not more methods on `OxyServices`
 *
 * Two reasons, both structural. A machine-key holder has no Oxy session at all,
 * so a surface reached only through the session client would be unreachable for
 * exactly the developer this workstream exists to serve. And the `/v1` error
 * body is the contract's `InferenceError` at the top level rather than the
 * platform's `{ error, message }` envelope — it carries `requestId`, `retryable`
 * and `retryAfterMs`, all of which `OxyServices.handleError` would flatten into a
 * message string. `oxyServices.inference()` binds the session bearer into this
 * client so a session-holding app writes no plumbing of its own.
 *
 * ## Streaming is an explicit method
 *
 * `stream()` injects `stream: true` on the wire. The request type deliberately
 * has no `stream` field, so `respond({ stream: true })` cannot promise a JSON
 * response while the server sends SSE, and `stream({ stream: false })` cannot
 * silently buffer. The method is the transport choice.
 *
 * ## Field names, and the one place they could drift
 *
 * Every VALUE type here comes from `@oxyhq/contracts` — messages, tools, tool
 * choice, response format, usage quantities, unit prices, error codes. The
 * request FIELD NAMES cannot: they belong to `responsesRequestSchema`, which
 * lives in the API because it is a public dialect rather than an Oxy↔data-plane
 * contract. `packages/api/src/schemas/__tests__/sdkRequestCompatibility.test.ts`
 * is the gate — it parses a value of this module's request type against that
 * schema, so a rename on either side fails a build rather than a customer's
 * request.
 */

import type {
    CurrencyCode,
    ExactDecimal,
    InferenceEnvironment,
    InferenceErrorCode,
    InferenceFinishReason,
    InferenceMessage,
    InferenceRequestOutcome,
    InferenceStreamEvent,
    ModelCatalogueEntry,
    ResponseFormat,
    RoutingPolicyReference,
    RoutingProfile,
    ToolChoice,
    ToolDefinition,
    UnitPrice,
    UsageQuantity,
    UsageSource,
} from '@oxyhq/contracts';
import { INFERENCE_ERROR_CODES, inferenceStreamEventSchema, modelIdSchema } from '@oxyhq/contracts';

/** The base URL of the Oxy API, when a caller names none. */
export const OXY_INFERENCE_BASE_URL = 'https://api.oxy.so';

/**
 * How this client gets its bearer.
 *
 * A `string` is a static machine credential (`oxy_sk_…`) — presented verbatim,
 * exactly as a stock OpenAI SDK would present it. A function is the Oxy auth
 * lane and is called on EVERY request, because a session bearer and a service
 * token both rotate and a captured one goes stale inside the hour.
 */
export type OxyInferenceCredential =
    | string
    | (() => string | null | Promise<string | null>);

/**
 * The `fetch` this client calls.
 *
 * The global signature rather than a narrowed one, so any drop-in
 * implementation — a test double, an instrumented wrapper, a Node agent — is
 * assignable without a cast at either end.
 */
export type OxyInferenceFetch = typeof fetch;

export interface OxyInferenceClientOptions {
    readonly credential: OxyInferenceCredential;
    /** Defaults to {@link OXY_INFERENCE_BASE_URL}. A trailing slash is trimmed. */
    readonly baseURL?: string;
    /** Defaults to the global `fetch`. */
    readonly fetch?: OxyInferenceFetch;
}

/**
 * A request to `POST /v1/responses`.
 *
 * `model`, `routingProfile`, and `routingProfileId` are mutually exclusive and
 * all are optional: an
 * application whose routing policy carries a `defaultTarget` may name neither,
 * which is what "per-application default model or routing profile" means. Naming
 * both is refused by the edge with `invalid_request`.
 */
export interface OxyResponsesRequest {
    /** `<publisher>/<model>` or `<publisher>/<model>@<revision>`. */
    readonly model?: string;
    /** A routing profile slug. Never contains a slash, so it is never a model id. */
    readonly routingProfile?: string;
    /** An exact opaque routing-profile database ID; serialized byte-for-byte. */
    readonly routingProfileId?: string;
    /** A prompt, or the message list it is shorthand for. */
    readonly input: string | readonly InferenceMessage[];
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly frequencyPenalty?: number;
    readonly presencePenalty?: number;
    readonly seed?: number;
    readonly stopSequences?: readonly string[];
    readonly tools?: readonly ToolDefinition[];
    readonly toolChoice?: ToolChoice;
    readonly responseFormat?: ResponseFormat;
    /** Cost-attribution tags, echoed back on the receipt. At most 16. */
    readonly labels?: Readonly<Record<string, string>>;
    /** Your own correlation id, echoed on the response. */
    readonly clientRequestId?: string;
}

export interface OxyInferenceRequestOptions {
    /**
     * Abort the request. The edge treats a client disconnect as a cancellation:
     * it settles what was produced and refunds the rest, so a cancelled request
     * is a normal terminal state rather than an error to clean up after.
     */
    readonly signal?: AbortSignal;
    /**
     * `Idempotency-Key`. A key already bound to a reservation is REFUSED with
     * `idempotency_conflict` rather than replayed — responses are not retained,
     * so there is nothing to replay, and refusing is what makes "a retry never
     * produces a second charge" structural. At most 128 characters.
     */
    readonly idempotencyKey?: string;
    /**
     * `X-Oxy-User-Id` — the end user this request is made on behalf of.
     * ATTRIBUTION ONLY: it never changes which account is charged.
     */
    readonly delegatedUserId?: string;
}

/** The body of a successful `POST /v1/responses`. */
export interface OxyInferenceResponse {
    readonly schemaVersion: 1;
    /** Also on `X-Oxy-Request-Id`, on success and on every refusal. */
    readonly requestId: string;
    readonly generationId?: string;
    /** Always revision-pinned, even when you named only the model line. */
    readonly model: string;
    readonly servingProvider: string;
    readonly finishReason: InferenceFinishReason;
    readonly output: readonly InferenceMessage[];
    /** Metered quantities. Never money — the charge is on the receipt. */
    readonly usage: readonly UsageQuantity[];
    /** The exact policy version this request was admitted under. */
    readonly routingPolicy: RoutingPolicyReference;
    /**
     * How long Oxy took over this request, in whole milliseconds — also on
     * `X-Oxy-Latency-Ms`.
     *
     * Measured from the moment the edge received the request through
     * authentication, admission, routing, the reservation, the call to the
     * inference data plane and the settlement of the hold. Most of it is the
     * upstream generating tokens; it does not separate the two.
     *
     * It is NOT the round trip you can measure yourself, which additionally
     * covers DNS, TLS, both network legs and your own parse. Report them side by
     * side rather than picking one — this figure has no network in it and yours
     * cannot be attributed to the model.
     *
     * Optional because it is additive: an Oxy deployment older than the field
     * omits it, and a streamed request never carries it (the head is written
     * before the first frame arrives, so the number does not exist yet).
     */
    readonly latencyMs?: number;
}

/**
 * A settled receipt, as `GET /v1/generations/:id` returns it.
 *
 * Carries the price SNAPSHOT rather than a reference to a price version, so the
 * arithmetic stays checkable after that version has been superseded.
 */
export interface OxyGenerationReceipt {
    readonly schemaVersion: 1;
    readonly receiptId: string;
    readonly requestId: string;
    readonly generationId?: string;
    readonly applicationId: string;
    readonly credentialId: string;
    /** Attribution only. Never the billing identity. */
    readonly delegatedUserId?: string;
    readonly environment: InferenceEnvironment;
    readonly outcome: InferenceRequestOutcome;
    readonly usageSource: UsageSource;
    /** EVERY unit, including the zeros — see `usageSource` for what a zero means. */
    readonly units: readonly UsageQuantity[];
    readonly resolvedModelReference: string;
    readonly servingProvider: string;
    readonly priceSnapshot: {
        readonly priceVersionId: string;
        readonly currency: CurrencyCode;
        readonly unitPrices: readonly UnitPrice[];
    };
    readonly billedAmount: ExactDecimal;
    readonly currency: CurrencyCode;
    /** A BYOK route: `billedAmount` is Oxy's fee, not the cost of the tokens. */
    readonly platformFeeOnly: boolean;
    readonly settledAt: string;
}

/**
 * Anything the inference API refused.
 *
 * `retryable` is asserted by the server and looked up from a total map over the
 * closed code set — never inferred here from the status. A client that decides
 * retryability from an HTTP status is exactly what the contract's retryability
 * rule exists to prevent, so this class carries the server's answer and does not
 * compute one.
 */
export class OxyInferenceError extends Error {
    readonly code: InferenceErrorCode;
    readonly retryable: boolean;
    readonly requestId: string;
    readonly status: number;
    /** How long to wait. Only ever present when `retryable`. */
    readonly retryAfterMs?: number;
    /** The request field at fault, for `invalid_request`. */
    readonly param?: string;

    constructor(input: {
        code: InferenceErrorCode;
        message: string;
        retryable: boolean;
        requestId: string;
        status: number;
        retryAfterMs?: number;
        param?: string;
    }) {
        super(input.message);
        this.name = 'OxyInferenceError';
        this.code = input.code;
        this.retryable = input.retryable;
        this.requestId = input.requestId;
        this.status = input.status;
        if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
        if (input.param !== undefined) this.param = input.param;
    }
}

/**
 * The edge opened an SSE response but its framing or one of its events violated
 * the published inference stream contract.
 *
 * This is distinct from {@link OxyInferenceError}: the latter is a refusal the
 * server deliberately returned, while this error means the client could not
 * safely interpret a nominally successful stream.
 */
export class OxyInferenceProtocolError extends Error {
    /** The request id from the response header, when the edge supplied one. */
    readonly requestId?: string;

    constructor(message: string, requestId?: string) {
        super(message);
        this.name = 'OxyInferenceProtocolError';
        if (requestId !== undefined) this.requestId = requestId;
    }
}

/** `{ data, count }` — the catalogue's collection envelope. */
interface CatalogueCollection<T> {
    data: T[];
    count: number;
}

/** The shape `/v1/responses` and `/v1/generations/:id` return on a refusal. */
interface WireInferenceError {
    schemaVersion?: number;
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
    retryAfterMs?: number;
    param?: string;
}

/**
 * The Oxy inference API.
 *
 * Stateless: it holds a base URL, a way to get a bearer and a `fetch`. Nothing
 * is cached, because the two things worth caching here are a catalogue that is
 * audience-scoped and a receipt that is immutable but rarely re-read.
 *
 * Completed JSON responses are TYPED, not re-parsed. The server validates every
 * one against its own schema before serving it, and a second client-side parse
 * of a non-strict shape would silently DROP fields a newer API added — turning
 * forward compatibility into data loss. Stream events are different: each is a
 * versioned wire message and is parsed against the shared contract before it is
 * yielded. Refusals are read defensively, because two routers answer under `/v1`
 * and an unreadable failure must still reach the caller as one.
 */
export class OxyInferenceClient {
    readonly #baseURL: string;
    readonly #credential: OxyInferenceCredential;
    readonly #fetch: OxyInferenceFetch;

    constructor(options: OxyInferenceClientOptions) {
        const baseURL = options.baseURL ?? OXY_INFERENCE_BASE_URL;
        this.#baseURL = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
        this.#credential = options.credential;

        const fetchImpl = options.fetch ?? globalThis.fetch;
        if (fetchImpl === undefined) {
            throw new Error(
                'OxyInferenceClient needs a fetch implementation: this runtime has no global fetch, so pass one as `fetch`.',
            );
        }
        this.#fetch = fetchImpl;
    }

    /**
     * The models this caller may use — `GET /v1/models`.
     *
     * Audience-scoped server-side. A machine credential and an anonymous caller
     * both see the PUBLIC catalogue; only an internal/system application's
     * service token sees internal-only routes.
     *
     * **`[]` is a normal answer**, and is the only answer today: the catalogue
     * is populated by operators, and a route is not publicly exposed until
     * somebody has reviewed the right to resell it.
     */
    async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelCatalogueEntry[]> {
        const body = await this.#request<CatalogueCollection<ModelCatalogueEntry>>(
            'GET',
            '/v1/models',
            { ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
        return body.data;
    }

    /**
     * One catalogue entry by its canonical id — `GET /v1/models/:publisher/:model`.
     *
     * The id is TWO path segments, because a canonical model id contains a slash
     * and a single encoded segment would never match the route.
     *
     * A model you may not see answers 404 identically to one that does not
     * exist, deliberately: the catalogue is never an existence oracle for what
     * Oxy runs internally.
     *
     * @param modelId - `<publisher>/<model>`. A revision pin
     *   (`<publisher>/<model>@<revision>`) names a model REFERENCE rather than a
     *   model and is rejected here rather than sent, because the catalogue is
     *   keyed on models and a pinned reference would 404 indistinguishably from
     *   "no such model".
     */
    async getModel(
        modelId: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<ModelCatalogueEntry> {
        const parsed = modelIdSchema.safeParse(modelId);
        if (!parsed.success) {
            throw new Error(
                `Not a canonical model id: ${modelId}. Expected <publisher>/<model>, e.g. acme/some-model.`,
            );
        }

        const [publisher, model] = parsed.data.split('/');
        const body = await this.#request<{ data: ModelCatalogueEntry }>(
            'GET',
            `/v1/models/${encodeURIComponent(publisher)}/${encodeURIComponent(model)}`,
            { ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
        return body.data;
    }

    /**
     * The routing profiles this caller may select — `GET /v1/models/routing-profiles`.
     *
     * A profile is a named strategy for CHOOSING among routes, not a model: no
     * publisher, no revision, no licence, no weights. Like the model list, `[]`
     * is a normal answer.
     */
    async listRoutingProfiles(
        options: { signal?: AbortSignal } = {},
    ): Promise<RoutingProfile[]> {
        const body = await this.#request<CatalogueCollection<RoutingProfile>>(
            'GET',
            '/v1/models/routing-profiles',
            { ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
        return body.data;
    }

    /**
     * Send one non-streaming inference request — `POST /v1/responses`.
     *
     * @throws {OxyInferenceError} for every refusal, carrying the server's own
     *   `code`, `retryable` and `requestId`.
     */
    async respond(
        request: OxyResponsesRequest,
        options: OxyInferenceRequestOptions = {},
    ): Promise<OxyInferenceResponse> {
        return this.#request<OxyInferenceResponse>('POST', '/v1/responses', {
            body: request,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            ...(options.delegatedUserId === undefined
                ? {}
                : { delegatedUserId: options.delegatedUserId }),
        });
    }

    /**
     * Stream one inference request from `POST /v1/responses`.
     *
     * The transport choice is method-level: this method adds `stream: true` and
     * requests SSE, while {@link respond} never does. Every yielded value has
     * already passed `inferenceStreamEventSchema`, belongs to the request id in
     * the response header and advances the stream sequence. A terminal `error`
     * event is yielded as part of the published union; an HTTP refusal before
     * the stream opens throws {@link OxyInferenceError}.
     *
     * Breaking out of the iterator cancels the response body. Passing an abort
     * signal additionally lets the caller cancel while waiting for the first or
     * any later event.
     *
     * @throws {OxyInferenceError} when the edge refuses before opening SSE.
     * @throws {OxyInferenceProtocolError} when a successful SSE response cannot
     *   be interpreted under the published stream contract.
     */
    async *stream(
        request: OxyResponsesRequest,
        options: OxyInferenceRequestOptions = {},
    ): AsyncGenerator<InferenceStreamEvent> {
        const response = await this.#fetch(`${this.#baseURL}/v1/responses`, {
            method: 'POST',
            headers: await this.#headers('text/event-stream', {
                hasBody: true,
                ...(options.idempotencyKey === undefined
                    ? {}
                    : { idempotencyKey: options.idempotencyKey }),
                ...(options.delegatedUserId === undefined
                    ? {}
                    : { delegatedUserId: options.delegatedUserId }),
            }),
            body: JSON.stringify({ ...request, stream: true }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });

        if (!response.ok) {
            const payload: unknown = await response.json().catch(() => undefined);
            throw toInferenceError(
                payload,
                response.status,
                response.headers.get('X-Oxy-Request-Id'),
            );
        }

        const requestId = response.headers.get('X-Oxy-Request-Id') ?? undefined;
        const mediaType = response.headers
            .get('Content-Type')
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase();
        if (mediaType !== 'text/event-stream') {
            await cancelUnreadResponse(response);
            throw protocolError(
                `The inference API answered a streaming request with ${mediaType ?? 'no Content-Type'} instead of text/event-stream.`,
                requestId,
            );
        }
        if (requestId === undefined || requestId.length === 0) {
            await cancelUnreadResponse(response);
            throw protocolError(
                'The inference API opened a stream without X-Oxy-Request-Id.',
                requestId,
            );
        }
        if (response.body === null) {
            throw protocolError(
                'The inference API opened a stream with no response body.',
                requestId,
            );
        }

        let lastSequence = -1;
        let terminal = false;
        for await (const frame of decodeEventStream(response.body, requestId)) {
            if (terminal) {
                throw protocolError(
                    'The inference API sent an event after a terminal event.',
                    requestId,
                );
            }

            let payload: unknown;
            try {
                payload = JSON.parse(frame.data);
            } catch (_error) {
                throw protocolError(
                    `The inference API sent a ${frame.name || 'unnamed'} SSE event that is not JSON.`,
                    requestId,
                );
            }

            const parsed = inferenceStreamEventSchema.safeParse(payload);
            if (!parsed.success) {
                const path = parsed.error.issues[0]?.path;
                throw protocolError(
                    `The inference API sent an event outside the published stream contract at ${path === undefined || path.length === 0 ? 'an unknown field' : path.join('.')}.`,
                    requestId,
                );
            }

            const event = parsed.data;
            if (frame.name !== event.type) {
                throw protocolError(
                    `The inference API framed a ${event.type} event as ${frame.name || 'unnamed'}.`,
                    requestId,
                );
            }
            if (event.requestId !== requestId) {
                throw protocolError(
                    'The inference API sent an event for a different request id.',
                    requestId,
                );
            }
            if (event.sequence <= lastSequence) {
                throw protocolError(
                    'The inference API sent a stream sequence that did not advance.',
                    requestId,
                );
            }

            lastSequence = event.sequence;
            terminal = event.type === 'done' || event.type === 'error';
            yield event;
        }

        if (!terminal) {
            throw protocolError(
                'The inference API closed the stream before a terminal done or error event.',
                requestId,
            );
        }
    }

    /**
     * Read back the settled receipt for one request —
     * `GET /v1/generations/:id`.
     *
     * `id` is the `requestId` you already hold (it is on every response and
     * every error) or the `generationId`. Requires the `inference:usage:read`
     * scope; a caller without it, or one whose application did not make the
     * request, is told the receipt does not exist rather than that it belongs to
     * somebody else.
     */
    async getGeneration(
        id: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<OxyGenerationReceipt> {
        const body = await this.#request<{ data: OxyGenerationReceipt }>(
            'GET',
            `/v1/generations/${encodeURIComponent(id)}`,
            { ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
        return body.data;
    }

    /** The bearer for this request, from whichever lane was configured. */
    async #bearer(): Promise<string> {
        const value =
            typeof this.#credential === 'string'
                ? this.#credential
                : await this.#credential();
        if (value === null || value === undefined || value.length === 0) {
            throw new Error(
                'OxyInferenceClient has no bearer: the configured credential resolved to nothing. On the Oxy auth lane this usually means the session is not restored yet.',
            );
        }
        return value;
    }

    /** Build the authenticated headers for one request, re-reading its bearer. */
    async #headers(
        accept: 'application/json' | 'text/event-stream',
        options: {
            hasBody: boolean;
            idempotencyKey?: string;
            delegatedUserId?: string;
        },
    ): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${await this.#bearer()}`,
            Accept: accept,
        };
        if (options.hasBody) headers['Content-Type'] = 'application/json';
        if (options.idempotencyKey !== undefined) {
            headers['Idempotency-Key'] = options.idempotencyKey;
        }
        if (options.delegatedUserId !== undefined) {
            headers['X-Oxy-User-Id'] = options.delegatedUserId;
        }
        return headers;
    }

    /**
     * One request, and the one place a refusal becomes an
     * {@link OxyInferenceError}.
     *
     * Two error shapes arrive here, because two routers serve `/v1`. The edge
     * returns the contract error at the top level; the catalogue returns the
     * platform's `{ error, message }` envelope. Both are read, and a body that
     * is neither still produces an `OxyInferenceError` — with the code the
     * status maps to — rather than a bare `Error`, so a caller's `catch` never
     * has to branch on which router answered.
     */
    async #request<T>(
        method: 'GET' | 'POST',
        path: string,
        options: {
            body?: unknown;
            signal?: AbortSignal;
            idempotencyKey?: string;
            delegatedUserId?: string;
        },
    ): Promise<T> {
        const response = await this.#fetch(`${this.#baseURL}${path}`, {
            method,
            headers: await this.#headers('application/json', {
                hasBody: options.body !== undefined,
                ...(options.idempotencyKey === undefined
                    ? {}
                    : { idempotencyKey: options.idempotencyKey }),
                ...(options.delegatedUserId === undefined
                    ? {}
                    : { delegatedUserId: options.delegatedUserId }),
            }),
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });

        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
            throw toInferenceError(
                payload,
                response.status,
                response.headers.get('X-Oxy-Request-Id'),
            );
        }

        return payload as T;
    }
}

/** Bound one public SSE event before parsing it as JSON. */
const MAX_INFERENCE_STREAM_EVENT_CHARACTERS = 8 * 1024 * 1024;

/** Bound the `data:` array too; empty lines consume memory without characters. */
const MAX_INFERENCE_STREAM_EVENT_DATA_LINES = 4096;

/** One SSE frame after transport decoding and before contract validation. */
interface RawInferenceStreamFrame {
    readonly name: string;
    readonly data: string;
}

function protocolError(message: string, requestId?: string): OxyInferenceProtocolError {
    return new OxyInferenceProtocolError(message, requestId);
}

/** Cancel a nominally successful response whose stream contract is unreadable. */
async function cancelUnreadResponse(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

/**
 * Decode SSE incrementally, preserving chunk boundaries only until a complete
 * line is available.
 *
 * Multiple `data:` lines join with a newline, comments are ignored and a final
 * frame does not need a trailing blank line. Cancelling the iterator cancels the
 * body reader, which is how breaking out of `for await` closes the HTTP request
 * instead of leaving generation running upstream.
 */
async function* decodeEventStream(
    body: ReadableStream<Uint8Array>,
    requestId: string,
): AsyncGenerator<RawInferenceStreamFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let name = '';
    let data: string[] = [];
    let accumulated = 0;
    let dataLines = 0;
    let reachedEnd = false;

    const decode = (chunk?: Uint8Array, options?: TextDecodeOptions): string => {
        try {
            return decoder.decode(chunk, options);
        } catch (_error) {
            throw protocolError(
                'The inference API sent an SSE stream that is not valid UTF-8.',
                requestId,
            );
        }
    };

    const dispatch = (): RawInferenceStreamFrame | undefined => {
        if (data.length === 0 && name.length === 0) return undefined;
        const frame = { name, data: data.join('\n') };
        name = '';
        data = [];
        accumulated = 0;
        dataLines = 0;
        return frame;
    };

    const consume = (raw: string): RawInferenceStreamFrame | undefined => {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.length === 0) return dispatch();
        if (line.startsWith(':')) return undefined;

        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        const rawValue = separator === -1 ? '' : line.slice(separator + 1);
        const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

        if (field === 'data') {
            dataLines += 1;
            if (dataLines > MAX_INFERENCE_STREAM_EVENT_DATA_LINES) {
                throw protocolError(
                    `The inference API sent an SSE event with over ${MAX_INFERENCE_STREAM_EVENT_DATA_LINES} data lines.`,
                    requestId,
                );
            }
            accumulated += value.length;
            if (accumulated > MAX_INFERENCE_STREAM_EVENT_CHARACTERS) {
                throw protocolError(
                    `The inference API sent an SSE event over ${MAX_INFERENCE_STREAM_EVENT_CHARACTERS} characters.`,
                    requestId,
                );
            }
            data.push(value);
        } else if (field === 'event') {
            name = value.trim();
        }
        return undefined;
    };

    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                reachedEnd = true;
                break;
            }

            pending += decode(chunk.value, { stream: true });
            if (pending.length > MAX_INFERENCE_STREAM_EVENT_CHARACTERS) {
                throw protocolError(
                    `The inference API sent an SSE line over ${MAX_INFERENCE_STREAM_EVENT_CHARACTERS} characters with no boundary.`,
                    requestId,
                );
            }

            let newline = pending.indexOf('\n');
            while (newline !== -1) {
                const frame = consume(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
                if (frame !== undefined) yield frame;
                newline = pending.indexOf('\n');
            }
        }

        pending += decode();
        if (pending.length > 0) {
            const frame = consume(pending);
            if (frame !== undefined) yield frame;
        }
        const trailing = dispatch();
        if (trailing !== undefined) yield trailing;
    } finally {
        if (!reachedEnd) {
            // Preserve the original parse/abort error if transport cancellation
            // itself also refuses: cancellation is cleanup, never the diagnosis.
            await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }
}

/**
 * Which code a status means when the body did not name one.
 *
 * Deliberately partial: only the statuses whose meaning is unambiguous without a
 * body. Everything else becomes `internal_error`, which is non-retryable — the
 * safe direction, since inventing a retryable code for an unreadable failure is
 * how one outage becomes a retry storm.
 */
const STATUS_FALLBACK_CODE: Readonly<Record<number, InferenceErrorCode>> = {
    400: 'invalid_request',
    401: 'authentication_failed',
    403: 'permission_denied',
    404: 'model_not_found',
    409: 'idempotency_conflict',
    413: 'request_too_large',
    429: 'rate_limited',
    502: 'provider_error',
    503: 'service_unavailable',
    504: 'provider_timeout',
};

/**
 * The closed set the contract defines, as a lookup.
 *
 * A `code` outside it is a contract violation rather than a code this client
 * has not caught up with — `INFERENCE_ERROR_CODES` and the version header move
 * together — so an unrecognised one falls back to the status map instead of
 * being asserted into the type.
 */
const INFERENCE_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(INFERENCE_ERROR_CODES);

/** Read whichever error shape arrived into the one this client throws. */
function toInferenceError(
    payload: unknown,
    status: number,
    requestIdHeader: string | null,
): OxyInferenceError {
    const body = (payload ?? {}) as WireInferenceError & { error?: unknown };

    // The edge's own shape is the contract error at the top level; the
    // catalogue's is the platform envelope, whose `error` is a string.
    const code =
        typeof body.code === 'string' && INFERENCE_ERROR_CODE_SET.has(body.code)
            ? (body.code as InferenceErrorCode)
            : (STATUS_FALLBACK_CODE[status] ?? 'internal_error');

    const message =
        typeof body.message === 'string' && body.message.length > 0
            ? body.message
            : typeof body.error === 'string' && body.error.length > 0
              ? body.error
              : `The inference API answered ${status}.`;

    return new OxyInferenceError({
        code,
        message,
        // A body that did not assert retryability is not retryable: the server
        // is the only thing that may say a retry could succeed.
        retryable: body.retryable === true,
        requestId:
            typeof body.requestId === 'string' && body.requestId.length > 0
                ? body.requestId
                : (requestIdHeader ?? ''),
        status,
        ...(body.retryable === true && typeof body.retryAfterMs === 'number'
            ? { retryAfterMs: body.retryAfterMs }
            : {}),
        ...(typeof body.param === 'string' ? { param: body.param } : {}),
    });
}

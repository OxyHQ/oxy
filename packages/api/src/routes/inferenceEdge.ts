/**
 * `api.oxy.so/v1` — the Oxy public inference edge (issue #972 workstream 4,
 * ADR 0010).
 *
 * ```text
 * POST /v1/responses            the preferred modern endpoint
 * POST /v1/chat/completions     OpenAI-compatible
 * GET  /v1/generations/:id      the usage/cost receipt
 * ```
 *
 * `GET /v1/models` and `GET /v1/models/:publisher/:model` are served by
 * `routes/inferenceCatalogue.ts`, mounted at `/v1/models` in `server.ts` — the
 * SAME router that serves `/models`, so the catalogue cannot answer one thing at
 * one path and another at the other.
 *
 * ## What this does to the Alia proxy, and why
 *
 * ADR 0010 decided that `/v1` becomes the Oxy inference edge rather than a proxy
 * to a product, and it names `POST /v1/chat/completions` as the compatibility
 * surface. This router is therefore mounted at `/v1` BEFORE `aliaRoutes`, and it
 * takes exactly three paths from it: `/v1/responses` and `/v1/generations/:id`
 * (which the proxy never served) and `/v1/chat/completions` (which it did).
 *
 * **The proxy itself is untouched and still reachable at `/alia/chat/completions`**
 * — the same router, the same `#981` first-party gate, the same behaviour — so
 * every platform-trusted caller it serves today keeps a working path, one base
 * URL apart. `/v1/voice/token` and `/v1/voice/transcribe` still fall through to
 * it unchanged: ADR 0010 says explicitly that those are Alia product endpoints
 * which happen to live under `/v1`, that they are not part of the inference edge,
 * and that where they end up is workstream 14's decision rather than this one's.
 *
 * The visible consequence is honest and intended: a trusted caller that posts to
 * `/v1/chat/completions` now reaches an edge with no data plane behind it and
 * receives a typed `service_unavailable`, instead of being silently proxied to
 * Alia on one shared upstream key with no reservation and no attribution. The
 * epic's own invariant is that generic inference is served through the Oxy edge,
 * not through Alia as infrastructure; keeping the old behaviour on the new path
 * would be the fallback that makes the invariant untrue.
 *
 * ## Which deployments serve it at all
 *
 * `INFERENCE_EDGE_AUDIENCE` (`config/rolloutFlags.ts`) is unset by default and a
 * deployment that has not set it serves NOBODY here — an authenticated caller
 * gets `permission_denied` with their request id. The audience is what makes the
 * epic's rollout states (internal Alia canary, Oxy first-party canary, closed
 * external beta, prepaid public launch) expressible and enforceable rather than
 * announced, and the check sits in {@link edgeGate} so every endpoint below is
 * covered by one decision.
 *
 * ## Rate limits
 *
 * Three, all with unique prefixes (`rate-limit-redis` throws
 * `ERR_ERL_DOUBLE_COUNT` on a shared key): the per-credential and
 * per-application budgets from `middleware/machineCredential.ts` — MOUNTED here,
 * which is what #980 left for this workstream — plus one that covers both lanes,
 * keyed on the credential id. None of them is a substitute for the spend
 * reservation, and none of them is keyed on an IP: an anonymous key would bucket
 * every unauthenticated attempt together, and a per-source-IP key would collapse
 * a whole customer's traffic behind one NAT.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { z } from 'zod';
import type {
  InferenceContentSource,
  InferenceError,
  InferenceFinishReason,
  InferenceMessage,
  InferenceStreamEvent,
  UsageQuantity,
  UsageUnit,
} from '@oxyhq/contracts';
import { admitToInferenceEdge } from '../config/rolloutFlags';
import {
  machineApplicationLimiter,
  machineCredentialLimiter,
  type MachineCredentialRequest,
} from '../middleware/machineCredential';
import { rateLimit } from '../middleware/rateLimiter';
import {
  allocateRequestId,
  authenticateEdgeCaller,
  executeInferenceRequest,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_REQUEST_BYTES,
  readGenerationReceipt,
  streamInferenceRequest,
  type EdgeCompletion,
  type EdgeExecutionContext,
  type EdgePrincipal,
  type EdgeStreamFrame,
  type EdgeStreamHead,
} from '../services/inferenceEdge.service';
import { createHttpRelayClient } from '../services/httpRelayClient';
import type { RelayClient } from '../services/relayClient';
import {
  chatCompletionsRequestSchema,
  imageGenerationsRequestSchema,
  normalizeChatCompletionsRequest,
  normalizeImageGenerationsRequest,
  normalizeResponsesRequest,
  normalizeSpeechRequest,
  responsesRequestSchema,
  speechRequestSchema,
  type NormalizedEdgeRequest,
} from '../schemas/inferenceEdge.schemas';
import {
  applyInferenceHeaders,
  buildInferenceError,
  openAiErrorBody,
  sendInferenceError,
  sendOpenAiError,
} from '../utils/inferenceEdgeErrors';
import { logger } from '../utils/logger';

/** What the gate leaves on the request for the handlers below. */
interface EdgeRequest extends MachineCredentialRequest {
  edge?: {
    readonly requestId: string;
    /** Monotonic reading taken beside the request id — see {@link edgeGate}. */
    readonly receivedAt: number;
    readonly principal: EdgePrincipal;
  };
}

/**
 * Both dialects and the receipt read share one budget, per credential.
 *
 * Exported for `__tests__/inferenceEdgeGateCoverage.test.ts`, which asserts by
 * IDENTITY that every registered route carries it. Name cannot substitute:
 * `rateLimit()` returns `expressRateLimit(...)` directly, so all three limiters on
 * these routes have the same `Function.name` and are indistinguishable by it.
 */
export const inferenceEdgeLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  prefix: 'rl:inference:edge:',
  keyGenerator: (req) => (req as EdgeRequest).edge?.principal.credentialId ?? '',
  skip: (req) => (req as EdgeRequest).edge === undefined,
  message: 'Inference request limit exceeded, please slow down.',
});

/** How each surface renders a structured error. */
type ErrorRenderer = (res: Response, error: ReturnType<typeof buildInferenceError>) => void;

/**
 * Authenticate, and size-check the body.
 *
 * The request id is allocated FIRST, before authentication, so that a rejected
 * request is still traceable — ADR 0010's step 1, and the reason a customer can
 * report a 401 by id rather than by reproduction.
 *
 * The arrival instant is read on the same line, and on the MONOTONIC clock. It
 * is what `inference_usage_events.latency_ms` is measured from, so taking it
 * here rather than inside the service is what makes that figure cover
 * authentication and admission — the parts of a slow request a customer feels
 * and the service alone cannot see.
 */
function edgeGate(render: ErrorRenderer) {
  return async (req: EdgeRequest, res: Response, next: NextFunction): Promise<void> => {
    const requestId = allocateRequestId();
    const receivedAt = performance.now();

    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      render(
        res,
        buildInferenceError({
          code: 'request_too_large',
          message: `Request bodies are limited to ${MAX_REQUEST_BYTES} bytes.`,
          requestId,
        })
      );
      return;
    }

    try {
      const authentication = await authenticateEdgeCaller(req);
      if (!authentication.ok) {
        logger.warn('inference.edge.unauthenticated', {
          requestId,
          reason: authentication.reason,
          path: req.path,
        });
        render(
          res,
          buildInferenceError({
            code: 'authentication_failed',
            message: 'The provided API key is invalid, expired, or revoked.',
            requestId,
          })
        );
        return;
      }

      // Is this deployment's edge open to this application at all (issue #972
      // workstream 16, `config/rolloutFlags.ts`)? Applied HERE, in the one gate
      // every endpoint below mounts, so both dialects and the receipt read are
      // covered by one decision. Distinct from authentication, and answered
      // distinctly: the caller proved who they are, and this deployment does not
      // serve them yet.
      //
      // It is NOT structurally impossible to add an endpoint without it. This
      // gate is a per-route middleware, repeated on each `router.post`/`router.get`
      // below, and it cannot be hoisted to a `router.use` because each dialect
      // needs its OWN error renderer (`sendInferenceError` vs `sendOpenAiError`)
      // and a `router.use` sees one chain for all of them. What actually enforces
      // it is `__tests__/inferenceEdgeGateCoverage.test.ts`, which walks this
      // router's own stack, DISCOVERS every registered route rather than being
      // given a list, and fails when one answers anything but the gate's own
      // refusal — so a fourth endpoint added without the gate goes red there.
      const admission = admitToInferenceEdge(authentication.principal);
      if (admission.status === 'refused') {
        logger.warn('inference.edge.outside_audience', {
          requestId,
          reason: admission.reason,
          tier: admission.tier,
          applicationId: authentication.principal.applicationId,
          path: req.path,
        });
        render(
          res,
          buildInferenceError({
            code: 'permission_denied',
            message: 'The Oxy inference API is not open to this application yet.',
            requestId,
          })
        );
        return;
      }

      // The machine lane's own limiters key on this. Set here rather than
      // inside the service so the service stays free of Express state.
      if (authentication.machinePrincipal !== undefined) {
        req.machineCredential = authentication.machinePrincipal;
      }
      req.edge = { requestId, receivedAt, principal: authentication.principal };
      next();
    } catch (error) {
      logger.error(
        'inference.edge.gate_failed',
        error instanceof Error ? error : new Error(String(error)),
        { requestId, path: req.path }
      );
      render(
        res,
        buildInferenceError({
          code: 'internal_error',
          message: 'The request could not be authenticated.',
          requestId,
        })
      );
    }
  };
}

/**
 * The delegated end-user identity, from the ecosystem header or the OpenAI
 * `user` field.
 *
 * The header wins when both are present: `X-Oxy-User-Id` is the ecosystem's own
 * delegation channel and is what every other Oxy service reads. Either way this
 * is ATTRIBUTION ONLY — it never reaches the billing principal, which is
 * structurally impossible to confuse it with (`billingPrincipalSchema` is
 * `.strict()` and holds one differently-branded field).
 */
function delegatedUserId(req: Request, fromBody?: string): string | undefined {
  const header = req.headers['x-oxy-user-id'];
  const value = typeof header === 'string' && header.length > 0 ? header : fromBody;
  if (value === undefined) return undefined;
  return value.length > 0 && value.length <= 64 ? value : undefined;
}

/**
 * The customer's `Idempotency-Key`, when they sent a usable one.
 *
 * A key longer than {@link MAX_IDEMPOTENCY_KEY_LENGTH} is REFUSED rather than
 * truncated: two keys that differ only past the cut would silently become one,
 * and the whole point of the header is that two different requests are two
 * different charges.
 */
type IdempotencyKey =
  | { readonly ok: true; readonly key?: string }
  | { readonly ok: false };

function idempotencyKey(req: Request): IdempotencyKey {
  const header = req.headers['idempotency-key'];
  if (typeof header !== 'string' || header.length === 0) return { ok: true };
  if (header.length > MAX_IDEMPOTENCY_KEY_LENGTH) return { ok: false };
  return { ok: true, key: header };
}

/**
 * A signal that fires when the client goes away.
 *
 * Cancellation is propagated to the data plane the moment there is one to
 * propagate it to — `RelayClient.execute` takes this signal. It cannot be
 * exercised end to end today, and it costs one parameter, which is the whole
 * reason it is here rather than in a follow-up.
 */
function connectionSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  // `res` closing before the response was written IS the disconnect. Listening
  // on `req`'s deprecated `aborted` event as well would fire the same signal
  // twice and warn on modern Node for nothing.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

/**
 * Usage headers, in the one vocabulary both surfaces speak.
 *
 * Four token headers rather than two, because the contract's units PARTITION a
 * request: `X-Oxy-Usage-Input-Tokens` is the UNCACHED input and
 * `X-Oxy-Usage-Output-Tokens` the visible output, so without the other two a
 * customer cannot see the cache discount they were charged at, and cannot add
 * the headers up to the prompt and completion sizes their provider would quote.
 */
function applyUsageHeaders(res: Response, completion: EdgeCompletion): void {
  res.setHeader('X-Oxy-Model', completion.resolvedModelReference);
  res.setHeader('X-Oxy-Provider', completion.servingProvider);
  res.setHeader('X-Oxy-Usage-Input-Tokens', String(completion.units.input_tokens ?? 0));
  res.setHeader(
    'X-Oxy-Usage-Cached-Input-Tokens',
    String(completion.units.cached_input_tokens ?? 0)
  );
  res.setHeader('X-Oxy-Usage-Output-Tokens', String(completion.units.output_tokens ?? 0));
  res.setHeader('X-Oxy-Usage-Reasoning-Tokens', String(completion.units.reasoning_tokens ?? 0));
  res.setHeader('X-Oxy-Routing-Policy', completion.routingPolicy.routingPolicyId);
  res.setHeader('X-Oxy-Routing-Policy-Version', String(completion.routingPolicy.policyVersion));
}

/**
 * Oxy's partitioned units as the OpenAI dialect states them: NESTED.
 *
 * `prompt_tokens` includes its cached tokens and `completion_tokens` includes
 * its reasoning tokens in every OpenAI-compatible response, and a stock client
 * adds the two into `total_tokens` and shows it to somebody. Oxy's own units are
 * disjoint (`@oxyhq/contracts`' `USAGE_UNITS`), so the children are added back
 * HERE, at the compatibility boundary, rather than the internal reading being
 * bent to the dialect — bending it is what double-charges the ledger.
 *
 * The `_details` objects are OpenAI's own fields, not an Oxy extension: without
 * them the compatibility surface cannot show a customer the cache hit their
 * bill was discounted for.
 */
function openAiUsage(units: EdgeCompletion['units']): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
} {
  const cachedTokens = units.cached_input_tokens ?? 0;
  const reasoningTokens = units.reasoning_tokens ?? 0;
  const promptTokens = (units.input_tokens ?? 0) + cachedTokens;
  const completionTokens = (units.output_tokens ?? 0) + reasoningTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

/** The text of an assistant message, as the OpenAI shape carries it. */
/** The dialect-agnostic zod failure, rendered as the edge's typed error. */
function parseFailure(error: z.ZodError, requestId: string): InferenceError {
  const issue = error.issues[0];
  return buildInferenceError({
    code: 'invalid_request',
    message: issue?.message ?? 'The request could not be parsed.',
    requestId,
    ...(issue?.path.length ? { param: issue.path.join('.') } : {}),
  });
}

/** The one refusal an over-long idempotency key produces. */
function idempotencyKeyTooLong(requestId: string): InferenceError {
  return buildInferenceError({
    code: 'invalid_request',
    message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    requestId,
    param: 'Idempotency-Key',
  });
}

/**
 * The first content part of a given type across every output message.
 *
 * Written as a search rather than an index because the number and order of output
 * messages is the data plane's choice, not this endpoint's: assuming
 * `output[0].content[0]` would be a claim about a shape the wire never promised.
 */
function firstPartOfType(
  output: readonly InferenceMessage[],
  type: 'audio' | 'image'
): InferenceMessage['content'][number] | undefined {
  for (const message of output) {
    for (const part of message.content) {
      if (part.type === type) return part;
    }
  }
  return undefined;
}

/** Every image source in the output, in the order the data plane produced them. */
function imageParts(output: readonly InferenceMessage[]): InferenceContentSource[] {
  const sources: InferenceContentSource[] = [];
  for (const message of output) {
    for (const part of message.content) {
      if (part.type === 'image') sources.push(part.source);
    }
  }
  return sources;
}

function messageText(message: InferenceMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * OpenAI's `finish_reason`, which has neither a `cancelled` nor a `refusal`
 * member.
 *
 * Both are reported as `stop` in the body — the closest thing a stock client
 * understands, and what OpenAI itself returns for a model refusal — and
 * truthfully in `X-Oxy-Finish-Reason`, so the compatibility surface stays
 * parseable without the fact being lost.
 */
function openAiFinishReason(reason: InferenceFinishReason): string {
  return reason === 'cancelled' || reason === 'refusal' ? 'stop' : reason;
}

/* -------------------------------------------------------------------------- */
/*  Streaming                                                                 */
/* -------------------------------------------------------------------------- */

/** OpenAI's end-of-stream sentinel. Its stock clients stop on this exact text. */
const OPENAI_STREAM_DONE = '[DONE]';

/**
 * Write one SSE frame and let it go out.
 *
 * `res.write` on a chunked response reaches the socket immediately, so there is
 * no explicit flush here — but that only holds because
 * {@link openEventStream} sets `Cache-Control: no-transform`, which is what makes
 * `compression()` (mounted globally in `server.ts`, and matching `text/*`) leave
 * this response alone. Compressed, every frame would sit in a zlib buffer until
 * it filled, and time to first token would become time to last token with nothing
 * failing.
 *
 * A write to a socket the client already dropped is skipped rather than attempted:
 * the disconnect is handled by the abort signal, and an EPIPE from a courtesy
 * write would surface as an unrelated error.
 */
function writeSse(res: Response, name: string | undefined, data: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${name === undefined ? '' : `event: ${name}\n`}data: ${data}\n\n`);
}

/**
 * Commit the response to being a stream, before the first frame.
 *
 * The model, provider and routing policy are known at admission and go out as
 * headers, exactly as they do on a non-streaming response. The USAGE headers do
 * not: they are only known when the stream ends, and headers cannot be sent
 * twice. A streaming customer reads usage from the `usage` event instead, which
 * is why the contract has one.
 */
function openEventStream(res: Response, head: EdgeStreamHead): void {
  applyInferenceHeaders(res, head.requestId);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // `no-transform` is load-bearing, not decoration — see {@link writeSse}.
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Defence in depth against a reverse proxy that buffers by default and would
  // otherwise silently undo everything above.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Oxy-Model', head.resolvedModelReference);
  res.setHeader('X-Oxy-Provider', head.servingProvider);
  res.setHeader('X-Oxy-Routing-Policy', head.routingPolicy.routingPolicyId);
  res.setHeader('X-Oxy-Routing-Policy-Version', String(head.routingPolicy.policyVersion));
  res.status(200);
  res.flushHeaders();
}

/** How one dialect renders a normalized stream onto an already-open response. */
interface StreamWriter {
  /** Render one normalized event. */
  readonly event: (event: InferenceStreamEvent) => void;
  /** Terminal: a failure the EDGE produced, after the response was committed. */
  readonly fail: (error: InferenceError) => void;
  readonly end: () => void;
}

/**
 * `/v1/responses` — the normalized events themselves, one named SSE frame each.
 *
 * The frame name is the event's own `type`, so an `EventSource` consumer can
 * subscribe per kind, and the `data:` payload is exactly the contract shape a
 * non-streaming caller would have received inside the response. There is no
 * `[DONE]` sentinel: `done` and `error` are already terminal, and a second
 * terminality signal is a second thing that can disagree with the first.
 */
function responsesStreamWriter(res: Response): StreamWriter {
  let lastSequence = -1;

  return {
    event: (event) => {
      lastSequence = event.sequence;
      writeSse(res, event.type, JSON.stringify(event));
    },
    fail: (error) => {
      // A well-formed `error` event rather than a bare error body, so a client
      // parsing this stream against `inferenceStreamEventSchema` never meets a
      // frame the union cannot describe. The sequence continues the data plane's
      // own numbering, which is what keeps it monotonic.
      writeSse(
        res,
        'error',
        JSON.stringify({
          schemaVersion: 1,
          type: 'error',
          requestId: error.requestId,
          sequence: lastSequence + 1,
          error,
        })
      );
    },
    end: () => {
      res.end();
    },
  };
}

/**
 * `/v1/chat/completions` — OpenAI's own streaming idiom.
 *
 * Unnamed `data:` frames carrying `chat.completion.chunk` objects, terminated by
 * `data: [DONE]`, because that is what an unmodified OpenAI SDK parses. Three
 * consequences of that constraint, stated rather than discovered:
 *
 *  - **`reasoning` deltas are dropped.** There is no field for them in the chunk
 *    shape, and putting them in `delta.content` would render a model's private
 *    reasoning to a customer as its answer. A caller who wants reasoning uses
 *    `/v1/responses`, where it is a first-class channel.
 *  - **A `route_switch` rides on a chunk with `choices: []`**, under
 *    `oxy_route_switch`. The epic requires the switch be surfaced to the
 *    customer; a frame that is not chunk-shaped would break a stock parser, and
 *    `choices: []` is a shape OpenAI itself emits for its usage-only chunk, so a
 *    stock client skips it and an Oxy-aware one reads the extension.
 *  - **`usage` rides the same way**, so a customer sees what they were metered
 *    without the Oxy usage headers a stream cannot carry.
 */
function chatCompletionsStreamWriter(res: Response, head: EdgeStreamHead): StreamWriter {
  const id = `chatcmpl-${head.requestId}`;
  const created = Math.floor(Date.now() / 1000);
  /** OpenAI numbers tool calls by position in the message; the contract does not. */
  const toolCallIndexes = new Map<string, number>();

  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): void => {
    writeSse(
      res,
      undefined,
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: head.resolvedModelReference,
        choices,
        ...extra,
      })
    );
  };

  return {
    event: (event) => {
      switch (event.type) {
        case 'start':
          chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
          break;
        case 'delta':
          if (event.channel === 'output_text') {
            chunk([
              { index: event.outputIndex, delta: { content: event.text }, finish_reason: null },
            ]);
          } else if (event.channel === 'refusal') {
            // `delta.refusal` is OpenAI's own field, not an Oxy extension.
            chunk([
              { index: event.outputIndex, delta: { refusal: event.text }, finish_reason: null },
            ]);
          }
          break;
        case 'tool_call': {
          const index = toolCallIndexes.get(event.toolCallId) ?? toolCallIndexes.size;
          toolCallIndexes.set(event.toolCallId, index);
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: event.toolCallId,
                    type: 'function',
                    function: {
                      ...(event.name === undefined ? {} : { name: event.name }),
                      ...(event.argumentsDelta === undefined
                        ? {}
                        : { arguments: event.argumentsDelta }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ]);
          break;
        }
        case 'usage':
          chunk([], { usage: openAiUsage(unitMap(event.units)) });
          break;
        case 'route_switch':
          chunk([], {
            oxy_route_switch: { reason: event.reason, detail: event.detail },
          });
          break;
        case 'error':
          // The data plane's terminal error. No `[DONE]` follows one, so a client
          // that saw a failure never also has to reconcile a success.
          writeSse(res, undefined, JSON.stringify(openAiErrorBody(event.error)));
          break;
        case 'done':
          chunk([
            {
              index: 0,
              delta: {},
              finish_reason: openAiFinishReason(event.finishReason),
            },
          ]);
          writeSse(res, undefined, OPENAI_STREAM_DONE);
          break;
      }
    },
    fail: (error) => {
      writeSse(res, undefined, JSON.stringify(openAiErrorBody(error)));
    },
    end: () => {
      res.end();
    },
  };
}

/** The contract's unit array as the map {@link openAiUsage} reads. */
function unitMap(quantities: readonly UsageQuantity[]): Partial<Record<UsageUnit, number>> {
  const units: Partial<Record<UsageUnit, number>> = {};
  for (const quantity of quantities) units[quantity.unit] = quantity.quantity;
  return units;
}

/**
 * Drive one streamed request from the service's frames onto the response.
 *
 * Shared by both dialects, because everything that differs is inside a
 * {@link StreamWriter}: what a frame LOOKS like is the dialect's business, and
 * when a frame is written, whether the response has been committed and what
 * happens when the client vanishes are not.
 *
 * Three properties this loop is responsible for:
 *
 *  - **Nothing is buffered.** Each frame is written inside the loop, so the
 *    customer has frame N before the data plane has produced N+1.
 *  - **A refusal before the first frame is still an HTTP status.** The response
 *    is committed only on `open`, so an unauthorized, unfundable or unroutable
 *    request answers `403`/`402`/`503` with a normal body, exactly as a
 *    non-streaming one does.
 *  - **A dead socket ends the loop, which settles the hold.** `break` runs the
 *    generator's `finally`, which aborts the hop to the data plane and settles
 *    whatever was measured. Nothing here has to know that; it only has to stop.
 */
async function pumpEdgeStream(
  res: Response,
  frames: AsyncGenerator<EdgeStreamFrame>,
  renderError: ErrorRenderer,
  createWriter: (head: EdgeStreamHead) => StreamWriter
): Promise<void> {
  let writer: StreamWriter | undefined;

  for await (const frame of frames) {
    if (frame.kind === 'open') {
      openEventStream(res, frame.head);
      writer = createWriter(frame.head);
      continue;
    }

    if (frame.kind === 'error') {
      if (writer === undefined) {
        // Nothing was written yet, so this is an ordinary HTTP refusal.
        renderError(res, frame.error);
        return;
      }
      writer.fail(frame.error);
      writer.end();
      return;
    }

    // `open` always precedes the first event, so the writer exists; the guard is
    // what makes that a fact the compiler agrees with rather than an assertion.
    if (writer === undefined) break;
    writer.event(frame.event);
    if (res.destroyed) break;
  }

  writer?.end();
}

export interface InferenceEdgeRouterOptions {
  /**
   * The data plane. `undefined` means this deployment configured none, and every
   * invoke then answers a typed `service_unavailable` while `stream: true` is
   * refused. A fake belongs only in a test.
   */
  readonly relayClient?: RelayClient;
}

export function createInferenceEdgeRouter(
  options: InferenceEdgeRouterOptions = {}
): Router {
  const router = Router();

  /**
   * `POST /v1/responses` — the preferred endpoint.
   *
   * Errors are the structured contract shape at the top level rather than the
   * platform's `{ error, message }` envelope: that envelope carries neither
   * `requestId` nor `retryable`, and both are load-bearing here.
   */
  router.post(
    '/responses',
    edgeGate(sendInferenceError),
    machineCredentialLimiter,
    machineApplicationLimiter,
    inferenceEdgeLimiter,
    async (req: EdgeRequest, res: Response) => {
      const edge = req.edge;
      if (edge === undefined) return;

      const parsed = responsesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendInferenceError(
          res,
          buildInferenceError({
            code: 'invalid_request',
            message: parsed.error.issues[0]?.message ?? 'The request could not be parsed.',
            requestId: edge.requestId,
            ...(parsed.error.issues[0]?.path.length
              ? { param: parsed.error.issues[0].path.join('.') }
              : {}),
          })
        );
        return;
      }

      const key = idempotencyKey(req);
      if (!key.ok) {
        sendInferenceError(
          res,
          buildInferenceError({
            code: 'invalid_request',
            message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
            requestId: edge.requestId,
            param: 'Idempotency-Key',
          })
        );
        return;
      }

      const normalized: NormalizedEdgeRequest = normalizeResponsesRequest(parsed.data);
      const context: EdgeExecutionContext = {
        requestId: edge.requestId,
        receivedAt: edge.receivedAt,
        principal: edge.principal,
        request: normalized,
        ...(delegatedUserId(req) === undefined
          ? {}
          : { delegatedUserId: delegatedUserId(req) }),
        ...(key.key === undefined ? {} : { idempotencyKey: key.key }),
        apiFormat: 'responses',
        endpoint: '/v1/responses',
        signal: connectionSignal(res),
        ...(options.relayClient === undefined ? {} : { relayClient: options.relayClient }),
      };

      if (normalized.stream) {
        await pumpEdgeStream(res, streamInferenceRequest(context), sendInferenceError, () =>
          responsesStreamWriter(res)
        );
        return;
      }

      const execution = await executeInferenceRequest(context);

      if (execution.status === 'refused') {
        sendInferenceError(res, execution.error);
        return;
      }

      const { completion } = execution;
      applyInferenceHeaders(res, completion.requestId);
      applyUsageHeaders(res, completion);
      res.status(200).json({
        schemaVersion: 1,
        requestId: completion.requestId,
        ...(completion.generationId === undefined
          ? {}
          : { generationId: completion.generationId }),
        model: completion.resolvedModelReference,
        servingProvider: completion.servingProvider,
        finishReason: completion.finishReason,
        output: completion.output,
        usage: Object.entries(completion.units).map(([unit, quantity]) => ({
          unit,
          quantity,
        })),
        routingPolicy: completion.routingPolicy,
      });
    }
  );

  /**
   * `POST /v1/chat/completions` — the compatibility surface.
   *
   * The body is exactly what a stock OpenAI client parses, in both directions.
   * Everything Oxy-specific — the request id, the resolved model, the routing
   * policy, the error code and its retryability — rides in headers, which is the
   * rule that keeps it compatible rather than merely similar.
   */
  router.post(
    '/chat/completions',
    edgeGate(sendOpenAiError),
    machineCredentialLimiter,
    machineApplicationLimiter,
    inferenceEdgeLimiter,
    async (req: EdgeRequest, res: Response) => {
      const edge = req.edge;
      if (edge === undefined) return;

      const parsed = chatCompletionsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendOpenAiError(
          res,
          buildInferenceError({
            code: 'invalid_request',
            message: parsed.error.issues[0]?.message ?? 'The request could not be parsed.',
            requestId: edge.requestId,
            ...(parsed.error.issues[0]?.path.length
              ? { param: parsed.error.issues[0].path.join('.') }
              : {}),
          })
        );
        return;
      }

      const key = idempotencyKey(req);
      if (!key.ok) {
        sendOpenAiError(
          res,
          buildInferenceError({
            code: 'invalid_request',
            message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
            requestId: edge.requestId,
            param: 'Idempotency-Key',
          })
        );
        return;
      }

      const normalized = normalizeChatCompletionsRequest(parsed.data);
      const delegated = delegatedUserId(req, normalized.delegatedUserId);
      const context: EdgeExecutionContext = {
        requestId: edge.requestId,
        receivedAt: edge.receivedAt,
        principal: edge.principal,
        request: normalized,
        ...(delegated === undefined ? {} : { delegatedUserId: delegated }),
        ...(key.key === undefined ? {} : { idempotencyKey: key.key }),
        apiFormat: 'chat_completions',
        endpoint: '/v1/chat/completions',
        signal: connectionSignal(res),
        ...(options.relayClient === undefined ? {} : { relayClient: options.relayClient }),
      };

      if (normalized.stream) {
        await pumpEdgeStream(res, streamInferenceRequest(context), sendOpenAiError, (head) =>
          chatCompletionsStreamWriter(res, head)
        );
        return;
      }

      const execution = await executeInferenceRequest(context);

      if (execution.status === 'refused') {
        sendOpenAiError(res, execution.error);
        return;
      }

      const { completion } = execution;
      applyInferenceHeaders(res, completion.requestId);
      applyUsageHeaders(res, completion);
      res.setHeader('X-Oxy-Finish-Reason', completion.finishReason);

      res.status(200).json({
        id: `chatcmpl-${completion.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: completion.resolvedModelReference,
        choices: completion.output.map((message, index) => ({
          index,
          message: {
            role: 'assistant',
            content: messageText(message),
            ...(message.toolCalls === undefined
              ? {}
              : {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }),
          },
          finish_reason: openAiFinishReason(completion.finishReason),
        })),
        usage: openAiUsage(completion.units),
      });
    }
  );

  /**
   * `POST /v1/audio/speech` — text to audio (#972, the later modalities).
   *
   * Ceiling: `characters` = `input.length`. EXACT, declared, and the unit every
   * real TTS provider bills. Deliberately no `audio_output_milliseconds` — see
   * `speechRequestSchema`. A duration-priced route fails to quote and is refused
   * through the existing `no_route_available` path rather than a new branch.
   *
   * Nothing serves this today: the catalogue is empty and no data plane is
   * configured, so every call answers `service_unavailable`. The point of landing
   * it now is that the CEILING is sound before the route exists — the alternative
   * is somebody adding this endpoint later under delivery pressure and reaching
   * for a duration guess.
   */
  router.post(
    '/audio/speech',
    edgeGate(sendInferenceError),
    machineCredentialLimiter,
    machineApplicationLimiter,
    inferenceEdgeLimiter,
    async (req: EdgeRequest, res: Response) => {
      const edge = req.edge;
      if (edge === undefined) return;

      const parsed = speechRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendInferenceError(res, parseFailure(parsed.error, edge.requestId));
        return;
      }

      const key = idempotencyKey(req);
      if (!key.ok) {
        sendInferenceError(res, idempotencyKeyTooLong(edge.requestId));
        return;
      }

      const normalized: NormalizedEdgeRequest = normalizeSpeechRequest(parsed.data);
      const execution = await executeInferenceRequest({
        requestId: edge.requestId,
        receivedAt: edge.receivedAt,
        principal: edge.principal,
        request: normalized,
        ...(delegatedUserId(req, parsed.data.user) === undefined
          ? {}
          : { delegatedUserId: delegatedUserId(req, parsed.data.user) }),
        ...(key.key === undefined ? {} : { idempotencyKey: key.key }),
        apiFormat: 'audio_speech',
        endpoint: '/v1/audio/speech',
        signal: connectionSignal(res),
        ...(options.relayClient === undefined ? {} : { relayClient: options.relayClient }),
      });

      if (execution.status === 'refused') {
        sendInferenceError(res, execution.error);
        return;
      }

      const { completion } = execution;
      applyInferenceHeaders(res, completion.requestId);
      applyUsageHeaders(res, completion);

      // The output arrives from the data plane, so its SHAPE is a claim the wire
      // may not honour — a declared type is not an enforcement of it. A data plane
      // that answered a speech request with text is a data-plane fault, and it must
      // surface as a typed error rather than as a crash or as silence.
      const audio = firstPartOfType(completion.output, 'audio');
      if (audio === undefined || audio.type !== 'audio') {
        sendInferenceError(
          res,
          buildInferenceError({
            code: 'provider_error',
            message: 'The data plane returned no audio for a speech request.',
            requestId: completion.requestId,
          })
        );
        return;
      }
      if (audio.source.kind !== 'inline') {
        // OpenAI's speech endpoint answers with bytes and has no URL form, so a
        // URL here cannot be rendered in this dialect. Refusing beats redirecting
        // a caller that is reading a response body.
        sendInferenceError(
          res,
          buildInferenceError({
            code: 'provider_error',
            message: 'The data plane returned audio by reference, which this endpoint cannot render.',
            requestId: completion.requestId,
          })
        );
        return;
      }
      res.status(200);
      res.type(audio.source.mediaType);
      res.send(Buffer.from(audio.source.data, 'base64'));
    }
  );

  /**
   * `POST /v1/images/generations` — text to image (#972, the later modalities).
   *
   * Ceiling: `images` = `n ?? 1`. EXACT and declared; the prompt adds
   * `input_tokens` on the usual character bound. `size` and `quality` are
   * forwarded and do NOT widen the hold, which rests on one route per
   * size/quality class in the catalogue — see `imageGenerationsRequestSchema` for
   * why that is a catalogue decision rather than a contracts one.
   *
   * As with speech, nothing serves this today; the value is a sound ceiling
   * before the endpoint exists.
   */
  router.post(
    '/images/generations',
    edgeGate(sendInferenceError),
    machineCredentialLimiter,
    machineApplicationLimiter,
    inferenceEdgeLimiter,
    async (req: EdgeRequest, res: Response) => {
      const edge = req.edge;
      if (edge === undefined) return;

      const parsed = imageGenerationsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendInferenceError(res, parseFailure(parsed.error, edge.requestId));
        return;
      }

      const key = idempotencyKey(req);
      if (!key.ok) {
        sendInferenceError(res, idempotencyKeyTooLong(edge.requestId));
        return;
      }

      const normalized: NormalizedEdgeRequest = normalizeImageGenerationsRequest(parsed.data);
      const execution = await executeInferenceRequest({
        requestId: edge.requestId,
        receivedAt: edge.receivedAt,
        principal: edge.principal,
        request: normalized,
        ...(delegatedUserId(req, parsed.data.user) === undefined
          ? {}
          : { delegatedUserId: delegatedUserId(req, parsed.data.user) }),
        ...(key.key === undefined ? {} : { idempotencyKey: key.key }),
        apiFormat: 'images_generations',
        endpoint: '/v1/images/generations',
        signal: connectionSignal(res),
        ...(options.relayClient === undefined ? {} : { relayClient: options.relayClient }),
      });

      if (execution.status === 'refused') {
        sendInferenceError(res, execution.error);
        return;
      }

      const { completion } = execution;
      applyInferenceHeaders(res, completion.requestId);
      applyUsageHeaders(res, completion);

      // Same wire-claim caution as speech. An empty list is a data-plane fault and
      // is reported as one, rather than answered as a successful zero-image
      // generation the customer has already been held for.
      const images = imageParts(completion.output);
      if (images.length === 0) {
        sendInferenceError(
          res,
          buildInferenceError({
            code: 'provider_error',
            message: 'The data plane returned no image for an image-generation request.',
            requestId: completion.requestId,
          })
        );
        return;
      }
      res.status(200).json({
        created: Math.floor(Date.now() / 1000),
        data: images.map((source) =>
          source.kind === 'url' ? { url: source.url } : { b64_json: source.data }
        ),
      });
    }
  );

  /**
   * `GET /v1/generations/:id` — the usage and cost receipt.
   *
   * `:id` is the `requestId` from `X-Oxy-Request-Id`, or the `generationId`.
   * A caller without `inference:usage:read`, or one whose application did not
   * make the request, is told the receipt does not exist — the entitlement
   * answer and the existence answer are deliberately the same, so this endpoint
   * cannot be used to probe another application's spend.
   *
   * The refusal carries `model_not_found`, which is a compromise worth naming:
   * `INFERENCE_ERROR_CODES` is a CLOSED set with no generic "not found" member,
   * and it is the only code in it that maps to a 404 — which is the status a
   * customer's HTTP client needs for a GET that resolved nothing. The message
   * says what was actually not found. Widening the enum is a contract change
   * with a version bump, and it belongs to whoever next has a second reason for
   * one rather than to this route alone.
   */
  router.get(
    '/generations/:id',
    edgeGate(sendInferenceError),
    machineCredentialLimiter,
    machineApplicationLimiter,
    inferenceEdgeLimiter,
    async (req: EdgeRequest, res: Response) => {
      const edge = req.edge;
      if (edge === undefined) return;

      try {
        const lookup = await readGenerationReceipt(edge.principal, req.params.id);
        if (lookup.status === 'not-found') {
          sendInferenceError(
            res,
            buildInferenceError({
              code: 'model_not_found',
              message: 'No generation receipt with that id is available to you.',
              requestId: edge.requestId,
            })
          );
          return;
        }

        applyInferenceHeaders(res, edge.requestId);
        res.status(200).json({ data: lookup.receipt });
      } catch (error) {
        logger.error(
          'inference.edge.receipt_failed',
          error instanceof Error ? error : new Error(String(error)),
          { requestId: edge.requestId }
        );
        sendInferenceError(
          res,
          buildInferenceError({
            code: 'internal_error',
            message: 'The receipt could not be read.',
            requestId: edge.requestId,
          })
        );
      }
    }
  );

  return router;
}

/**
 * The router `server.ts` mounts, wired to whatever data plane this deployment
 * configured.
 *
 * `createHttpRelayClient()` returns `undefined` unless `RELAY_BASE_URL`,
 * `RELAY_EDGE_SIGNING_KEY_ID` and `RELAY_EDGE_SIGNING_PRIVATE_KEY` are all set,
 * so a deployment that has configured none behaves exactly as it did before this
 * existed: every invoke answers a typed `service_unavailable` and `stream: true`
 * is refused.
 *
 * Resolved HERE rather than inside {@link createInferenceEdgeRouter}, so a test
 * that constructs a router gets exactly the client it passed and never one the
 * ambient environment supplied.
 */
const configuredRelayClient = createHttpRelayClient();

export default createInferenceEdgeRouter(
  configuredRelayClient === undefined ? {} : { relayClient: configuredRelayClient }
);

/* -------------------------------------------------------------------------- */
/*  Placement note                                                            */
/* -------------------------------------------------------------------------- */

/*
 * The block below sits AFTER the factory on purpose, not beside the routes it
 * talks about.
 *
 * `scripts/generate-openapi.ts` harvests the JSDoc block immediately above a
 * `router.<verb>(...)` call as that operation's published summary and description.
 * An explanatory block placed between a route's own JSDoc and the route therefore
 * DISPLACES it, and the generated contract falls back to "No long-form
 * description. Add a JSDoc block…" for a live endpoint — silently, with a green
 * build and no path added or removed.
 *
 * Measured: an earlier draft of this comment sat above `GET /generations/:id` and
 * cost that endpoint its entire published description, including the argument for
 * why it answers `model_not_found` on a 404. A prose comment is not inert here; it
 * is an input to a published artifact.
 */

/* ------------------------------------------------------------------------ */
/*  The two modalities that have NO ROUTE, and why                          */
/* ------------------------------------------------------------------------ */

/**
 * `POST /v1/audio/transcriptions` and `POST /v1/batches` are ABSENT from this
 * router deliberately. The reason lives here, beside the routes that do exist,
 * because the next person to reach for either will be reading this file — and
 * both have a plausible-looking implementation that is financially unsound.
 *
 * ## Transcriptions: no sound ceiling exists in the request
 *
 * Providers bill audio by DURATION, and duration is a property of the uploaded
 * bytes rather than a declared field. `Content-Length` bounds bytes only, and
 * `duration = bytes ÷ bitrate` needs a bitrate the request never states: 25 MB
 * is roughly thirty minutes of 112 kbps MP3 or four minutes of 48 kHz 16-bit
 * stereo WAV, a ~7x spread that widens across the formats such an endpoint
 * accepts. A byte-derived hold sized for the worst case over-holds by an order
 * of magnitude on every ordinary request; sized for the typical case it
 * UNDER-holds, and an under-sized hold is how a balance goes negative.
 * `output_tokens` inherits the same unsoundness, because transcript length is a
 * function of duration.
 *
 * **Do not reach for `bytes / 4`.** Two things would make this sound, and both
 * are decisions rather than code: probe the container server-side before
 * reserving (a new dependency, a parsing attack surface on untrusted bytes, and
 * a rule for a container that lies about its own duration), or have the
 * catalogue declare a per-route maximum duration and hold at
 * `min(byte-derived worst case, route max)` — which needs an additive field on
 * `modelCapabilitiesSchema` and is therefore a two-repo release, since Relay
 * derives its contract from the published package and gates on drift.
 *
 * It is also blocked upstream of the ceiling: the request is
 * `multipart/form-data` with a file, this edge is JSON-only behind
 * `express.json`, and the internal envelope's input union has no audio-reference
 * arm.
 *
 * ## Batches: the ledger protocol does not fit, which is the disqualifying half
 *
 * Two independent failures. The ceiling is a sum over N sub-requests of each
 * one's own ceiling — computable only by parsing the uploaded file, and no
 * sounder than the weakest modality it contains, so a batch of transcriptions
 * inherits everything above.
 *
 * The second is the one that cannot be engineered around here: `reserve` →
 * `settle` assumes ONE hold per HTTP request, settled inside
 * `RESERVATION_TTL_SECONDS`. OpenAI's `completion_window` is twenty-four hours.
 * A day-long hold against a fifteen-minute TTL means `expireReservations`
 * releases it mid-batch and the work later settles against a reservation that no
 * longer stands. **Raising the TTL is not the fix** — a day-long hold on a shared
 * balance is a different financial product, and ADR 0009's terminal-write model
 * has exactly one settlement per hold. What batches actually need is a hold per
 * sub-request taken at dispatch, or a new long-lived reservation class with its
 * own expiry and partial-settlement semantics. That is an amendment to ADR 0009,
 * not an endpoint.
 *
 * Until then a caller of either path gets a 404 from the router, which is the
 * honest answer: the endpoint does not exist. It is deliberately NOT a route
 * that refuses, because a registered route implies a surface Oxy intends to
 * serve, and `inferenceEdgeGateCoverage.test.ts` would then have to carry two
 * entries that can never pass their own gate.
 */

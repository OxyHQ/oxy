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
import type { InferenceFinishReason, InferenceMessage } from '@oxyhq/contracts';
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
  type EdgeCompletion,
  type EdgePrincipal,
} from '../services/inferenceEdge.service';
import type { RelayClient } from '../services/relayClient';
import {
  chatCompletionsRequestSchema,
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
  responsesRequestSchema,
  type NormalizedEdgeRequest,
} from '../schemas/inferenceEdge.schemas';
import {
  applyInferenceHeaders,
  buildInferenceError,
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

/** Both dialects and the receipt read share one budget, per credential. */
const inferenceEdgeLimiter = rateLimit({
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
      // all three endpoints share, so both dialects and the receipt read are
      // covered by one decision and a fourth endpoint cannot be added without
      // it. Distinct from authentication, and answered distinctly: the caller
      // proved who they are, and this deployment does not serve them yet.
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

export interface InferenceEdgeRouterOptions {
  /**
   * The data plane. Absent in every deployment today, which is why every invoke
   * resolves to a typed `service_unavailable`. A fake belongs only in a test.
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
      const execution = await executeInferenceRequest({
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
      });

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
      const execution = await executeInferenceRequest({
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
      });

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

/** The router `server.ts` mounts: no data plane, so every invoke refuses. */
export default createInferenceEdgeRouter();

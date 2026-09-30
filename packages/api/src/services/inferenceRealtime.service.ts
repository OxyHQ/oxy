/**
 * Realtime sessions at the Oxy edge — `GET /v1/realtime` (contract set 3.2.0,
 * OxyHQ/Kaana#90; `@oxy.so/contracts` `inference/realtime.ts` is normative).
 *
 * A session IS one request for attribution, metering and settlement. It is
 * admitted by the SAME admission path as every one-shot request
 * (`admitRequest`: scopes, policy, catalogue capability, exact-id attestation,
 * spend reservation), signed as ONE session request, relayed frame by frame in
 * both directions, and settled EXACTLY ONCE from the usage report Kaana sends
 * after `session.closed`.
 *
 * ```text
 * customer ──ws── edge (this module) ──signed ws── Kaana ── provider
 *   frame 1: session.open  → admit + hold → sign realtimeSessionRequest
 *   frame 1: session.resume→ same task, same application → sign the resume
 *   commands  → validated, re-serialized, forwarded
 *   events    ← validated, relayed verbatim in shape, sequence-checked
 *   usage report (after session.closed) → settle once → close 1000
 * ```
 *
 * ## The ceiling is the signed limits, and it is sound for one kind today
 *
 * Kaana enforces `limits` exactly, so the hold is sized from them:
 * `maxResponses × context window` over the four input token units and
 * `maxResponses × per-response output cap` over the three output units, per
 * authorized route, every unit priced (`routeCeilingScenarios`). That bound holds
 * for a `conversation` session whose every billed token belongs to a response.
 * Beside it, every scenario holds `session_milliseconds` at the signed
 * duration plus the bounded open (`realtimeMaxSessionMilliseconds`): a provider
 * that bills a session's wall clock (xAI under `server_vad`) is held for all of
 * it, and every other route must price the unit — at zero — or be refused
 * before the hold, because an unpriced unit never becomes a free one.
 * Two shapes consume audio OUTSIDE responses, where no signed limit bounds the
 * tokens, and are refused here rather than held against a guess: `transcription`
 * and `translation` sessions, and input-audio transcription on a conversation.
 * A declared audio-token rate per model (or a duration-priced route whose
 * milliseconds are exact from the signed byte caps) is what serves them.
 *
 * ## Commands are never replayed, by this hop or any other
 *
 * The edge forwards each validated customer command once, on the connection it
 * arrived with. When either connection drops, nothing is re-sent: the customer
 * reconnects with `session.resume` naming the last sequence it processed, and a
 * command whose acknowledgement it never saw is its own to retry under the SAME
 * `commandId` (acknowledged, not re-applied) — the contract's at-most-once rule.
 *
 * ## Resume is held in THIS task's memory, exactly as Kaana holds sessions
 *
 * A session's settlement context — its hold, its signed routes, its evidence —
 * lives in the edge task that admitted it, and Kaana holds the session itself in
 * the task that opened it (wire spec §7). A `session.resume` that reaches another
 * edge task is refused the way Kaana refuses one (`error` fatal
 * `invalid_request`, close 1008); the original task settles when the resume
 * window passes. Neither side pretends to state it does not have.
 *
 * ## Settlement, in order of authority
 *
 *  1. the usage report frame after `session.closed`, validated against the
 *     signed routes — the one exact record;
 *  2. when that frame was lost: the units `session.closed` carried, else the sum
 *     of the `response.done` units seen — measurement evidence, settled as the
 *     one-shot edge settles a lost report (never `completed`), and reconcilable
 *     by `requestId`;
 *  3. nothing: zero units marked `estimated` (`usage_unavailable`).
 *
 * The ledger's own idempotency key (`oxy-edge:req:<requestId>`) makes a second
 * settlement a no-op; the `settled` flag makes it unreachable.
 *
 * ## What never enters a log line
 *
 * Frames. Audio, transcripts, instructions and tool arguments all ride them.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_REALTIME_RESUME_WINDOW_MS,
  realtimeClientCommandSchema,
  realtimeSessionRequestSchema,
  realtimeSessionResumeCommandSchema,
  type InferenceError,
  type InferenceErrorCode,
  type NormalizedUsageReport,
  type RealtimeClientCommand,
  type RealtimeServerEvent,
  type RealtimeSessionLimits,
  type UsageSource,
  type UsageUnit,
} from '@oxy.so/contracts';
import type { z } from 'zod';
import { logger } from '../utils/logger';
import { buildInferenceError, inferenceErrorStatus } from '../utils/inferenceEdgeErrors';
import type { NormalizedEdgeRequest, RealtimeOpenFrame } from '../schemas/inferenceEdge.schemas';
import type { EdgeRoute } from './inferenceCatalogue.service';
import {
  admitRequest,
  attributionFor,
  recordEdgeTelemetry,
  settleMeasured,
  settlementFrom,
  validateUsageEvidence,
  validateUsageReport,
  type AdmittedRequest,
  type EdgeExecutionContext,
  type EdgePrincipal,
} from './inferenceEdge.service';
import type { KaanaClient, KaanaUsageEvidence } from './kaanaClient';
import {
  MAX_KAANA_REALTIME_FIRST_FRAME_BYTES,
  type KaanaRealtimeClient,
  type KaanaRealtimeConnection,
} from './kaanaRealtimeClient';

/* -------------------------------------------------------------------------- */
/*  Bounds and defaults                                                       */
/* -------------------------------------------------------------------------- */

export const REALTIME_ENDPOINT = '/v1/realtime';

/** How long a customer has to send its first frame after the upgrade. */
export const REALTIME_FIRST_FRAME_TIMEOUT_MS = 10_000;

/**
 * How long past the resume window the edge waits for a detached session's
 * customer (or its usage report) before settling from the evidence it holds.
 * A mutable record rather than a constant only so a test can shorten the wait
 * without fake timers over real sockets; production never writes it.
 */
export const realtimeTimings = { reportGraceMs: 30_000 };

/** The most frames a customer may send before its session is attached. */
export const MAX_REALTIME_PENDING_FRAMES = 32;

/**
 * Concurrent sessions one credential may hold in one edge task. A bound on the
 * holds and upstream sockets one key can pin, not a rate limit: the per-request
 * limiters do not apply to a WebSocket upgrade, and a Redis-backed per-credential
 * session budget is the follow-up.
 */
export const MAX_REALTIME_SESSIONS_PER_CREDENTIAL = 16;

/** 24 kHz mono PCM16, the densest format a session carries: 48 bytes per ms. */
const PCM16_BYTES_PER_MS = 48;

/**
 * The limits a session is signed for when the customer asks for none. Ten
 * minutes, two idle minutes, audio caps equal to ten minutes of PCM16 each way,
 * and twenty responses — the last is what sizes the hold, so it is the one a
 * customer should set.
 */
export const DEFAULT_REALTIME_LIMITS: RealtimeSessionLimits = {
  maxDurationMs: 600_000,
  idleTimeoutMs: 120_000,
  maxInputAudioBytes: 600_000 * PCM16_BYTES_PER_MS,
  maxOutputAudioBytes: 600_000 * PCM16_BYTES_PER_MS,
  maxResponses: 20,
};

/** The requested limits over the defaults; an idle default never outlasts a shorter session. */
export function sessionLimits(requested: Partial<RealtimeSessionLimits> | undefined): RealtimeSessionLimits {
  const maxDurationMs = requested?.maxDurationMs ?? DEFAULT_REALTIME_LIMITS.maxDurationMs;
  return {
    maxDurationMs,
    idleTimeoutMs:
      requested?.idleTimeoutMs ?? Math.min(DEFAULT_REALTIME_LIMITS.idleTimeoutMs, maxDurationMs),
    maxInputAudioBytes: requested?.maxInputAudioBytes ?? DEFAULT_REALTIME_LIMITS.maxInputAudioBytes,
    maxOutputAudioBytes:
      requested?.maxOutputAudioBytes ?? DEFAULT_REALTIME_LIMITS.maxOutputAudioBytes,
    maxResponses: requested?.maxResponses ?? DEFAULT_REALTIME_LIMITS.maxResponses,
  };
}

/**
 * How long the data plane's open of an upstream session may take before the
 * session's own clock (`maxDurationMs`, from `session.created`) starts: Kaana
 * bounds the handshake and the configure-then-confirm exchange at 20 s each
 * (`internal/provider/openairealtime`, `openTimeout`), and measures
 * `session_milliseconds` from the accepted handshake, because that is when a
 * provider billing session time starts its own clock. Sixty seconds covers both
 * stages and the close with room to spare.
 */
export const REALTIME_SESSION_OPEN_ALLOWANCE_MS = 60_000;

/**
 * The ceiling on `session_milliseconds` (contract set 3.3.0): the session can be
 * open upstream for at most its signed duration plus the bounded open. Kaana
 * ends it at `maxDurationMs` exactly (wire rule 8), whether or not a customer
 * connection is attached, so this is a bound rather than an estimate.
 */
export function realtimeMaxSessionMilliseconds(limits: RealtimeSessionLimits): number {
  return limits.maxDurationMs + REALTIME_SESSION_OPEN_ALLOWANCE_MS;
}

/** How long a session's hold must stand: the session, its resume window, and the report. */
export function realtimeReservationTtlSeconds(limits: RealtimeSessionLimits): number {
  return Math.ceil(
    (limits.maxDurationMs + MAX_REALTIME_RESUME_WINDOW_MS + 4 * realtimeTimings.reportGraceMs) / 1000
  );
}

/* -------------------------------------------------------------------------- */
/*  The customer side                                                         */
/* -------------------------------------------------------------------------- */

/** The customer's connection, as this module needs it. */
export interface RealtimeCustomerLink {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** WebSocket close codes the customer protocol uses. */
export const REALTIME_CLOSE = {
  normal: 1000,
  unsupportedData: 1003,
  policy: 1008,
  internal: 1011,
  tryAgainLater: 1013,
  /** This connection was replaced by a `session.resume` on another. */
  resumedElsewhere: 4000,
} as const;

/** The close code a pre-session refusal carries, from its error's HTTP status. */
export function closeCodeFor(code: InferenceErrorCode): number {
  const status = inferenceErrorStatus(code);
  if (status === 503) return REALTIME_CLOSE.tryAgainLater;
  if (status >= 500) return REALTIME_CLOSE.internal;
  return REALTIME_CLOSE.policy;
}

/**
 * A refusal before any session exists: ONE contract `error` event, fatal, at
 * sequence 0, then the close. No `session.closed` follows because no session
 * was opened — the same answer Kaana gives a refused resume (wire spec §7).
 */
export function refuseCustomer(customer: RealtimeCustomerLink, error: InferenceError): void {
  customer.send(
    JSON.stringify({
      schemaVersion: 1,
      type: 'error',
      requestId: error.requestId,
      sequence: 0,
      fatal: true,
      error,
    })
  );
  customer.close(closeCodeFor(error.code), error.code);
}

/* -------------------------------------------------------------------------- */
/*  The registry                                                              */
/* -------------------------------------------------------------------------- */

const sessions = new Map<string, RealtimeSession>();

/** Sessions this task holds. Exported for tests and diagnostics only. */
export function heldRealtimeSessionCount(): number {
  return sessions.size;
}

function sessionsOf(credentialId: string): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.context.principal.credentialId === credentialId) count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/*  Opening                                                                   */
/* -------------------------------------------------------------------------- */

export interface OpenRealtimeSessionInput {
  readonly requestId: string;
  readonly receivedAt: number;
  readonly principal: EdgePrincipal;
  readonly model: string | undefined;
  readonly frame: RealtimeOpenFrame;
  readonly delegatedUserId?: string;
  readonly customer: RealtimeCustomerLink;
  /** Aborted when the customer disconnects before the session is attached. */
  readonly signal: AbortSignal;
  /** The one-shot client, for the exact-id attestation admission performs. */
  readonly kaanaClient: KaanaClient | undefined;
  readonly kaana: KaanaRealtimeClient | undefined;
}

/**
 * Admit, hold, sign and open one session, then attach the customer to it.
 * Every refusal is answered on the customer's socket and leaves no hold standing.
 */
export async function openRealtimeSession(input: OpenRealtimeSessionInput): Promise<RealtimeSession | undefined> {
  const { requestId, customer } = input;
  const refuse = (code: InferenceErrorCode, message: string, param?: string): undefined => {
    logger.warn('inference.realtime.refused', {
      requestId,
      code,
      applicationId: input.principal.applicationId,
      credentialId: input.principal.credentialId,
    });
    refuseCustomer(
      customer,
      buildInferenceError({ code, message, requestId, ...(param === undefined ? {} : { param }) })
    );
    return undefined;
  };

  if (input.model === undefined) {
    return refuse('invalid_request', 'Name the model: GET /v1/realtime?model=<publisher>/<model>.', 'model');
  }
  const { frame } = input;
  if (frame.kind !== 'conversation') {
    return refuse(
      'unsupported_modality',
      `Realtime ${frame.kind} sessions are not served yet: their audio is metered outside any response, and no signed limit bounds what it can cost.`,
      'kind'
    );
  }
  if (frame.config.inputAudioTranscription !== undefined) {
    return refuse(
      'unsupported_modality',
      'Input audio transcription is not served yet: it is metered per committed item, which no signed limit bounds.',
      'config.inputAudioTranscription'
    );
  }
  if (sessionsOf(input.principal.credentialId) >= MAX_REALTIME_SESSIONS_PER_CREDENTIAL) {
    return refuse(
      'rate_limited',
      `A credential may hold at most ${MAX_REALTIME_SESSIONS_PER_CREDENTIAL} concurrent realtime sessions.`
    );
  }

  const transport = frame.transport ?? 'websocket';
  const limits = sessionLimits(frame.limits);
  const request: NormalizedEdgeRequest = {
    operation: {
      kind: 'realtime_session',
      sessionKind: frame.kind,
      transport,
      maxResponses: limits.maxResponses,
      maxSessionMilliseconds: realtimeMaxSessionMilliseconds(limits),
      requiredOutput: frame.config.outputModalities?.includes('audio') === true ? 'audio' : 'text',
      reservationTtlSeconds: realtimeReservationTtlSeconds(limits),
    },
    target: { kind: 'model', modelReference: input.model },
    // Only for the capacity check: the instructions and tools must fit the
    // context window before a single turn has been spoken.
    input: { format: 'text', text: frame.config.instructions ?? '' },
    stream: true,
    ...(frame.config.maxOutputTokens === undefined ? {} : { maxOutputTokens: frame.config.maxOutputTokens }),
    sampling: {},
    tools: frame.config.tools ?? [],
    ...(frame.labels === undefined ? {} : { labels: frame.labels }),
    ...(frame.clientSessionId === undefined ? {} : { clientRequestId: frame.clientSessionId }),
  };
  const context: EdgeExecutionContext = {
    requestId,
    receivedAt: input.receivedAt,
    principal: input.principal,
    request,
    ...(input.delegatedUserId === undefined ? {} : { delegatedUserId: input.delegatedUserId }),
    endpoint: REALTIME_ENDPOINT,
    signal: input.signal,
    ...(input.kaanaClient === undefined ? {} : { kaanaClient: input.kaanaClient }),
  };
  const receivedAtIso = new Date().toISOString();

  // The session request's own refinements (kind × config, limits, tool names)
  // are checked BEFORE the hold, against a provisional route list: a request
  // the contract would refuse at signing must never cost an attestation or a
  // reservation. Only the customer's fields can fail here.
  const provisional = realtimeSessionRequestSchema.safeParse(
    sessionRequest(context, frame, input.model, transport, limits, receivedAtIso, {
      routingPolicy: { routingPolicyId: 'platform-default', policyVersion: 1 },
      authorizedRoutes: [
        {
          substitution: 'same_model',
          deploymentId: 'provisional-route',
          modelReference: input.model,
          provider: 'oxy',
          regions: [],
        },
      ],
    })
  );
  if (!provisional.success) {
    const issue = provisional.error.issues.find(
      (candidate) => candidate.path[0] !== 'authorizedRoutes' && candidate.path[0] !== 'routingPolicy'
    );
    if (issue !== undefined) {
      return refuse('invalid_request', issue.message, issue.path.join('.'));
    }
  }

  if (input.kaana === undefined || input.kaanaClient === undefined) {
    return refuse('service_unavailable', 'No inference data plane is configured for this deployment.');
  }

  const admission = await admitRequest(context);
  if (admission.status === 'refused') {
    refuseCustomer(customer, admission.error);
    return undefined;
  }
  const { admitted } = admission;

  const signed = realtimeSessionRequestSchema.safeParse(
    sessionRequest(context, frame, input.model, transport, limits, receivedAtIso, {
      routingPolicy: admitted.routingPolicy,
      authorizedRoutes: admitted.authorizedRoutes.map((route) => ({
        substitution: 'same_model' as const,
        deploymentId: route.deploymentId,
        modelReference: route.modelReference,
        provider: route.provider,
        regions: [...route.regions],
        ...(route.customerProviderCredential === undefined
          ? {}
          : { customerProviderCredential: route.customerProviderCredential }),
      })),
    })
  );
  const session = new RealtimeSession(context, admitted, limits);
  if (!signed.success) {
    // Unreachable once the provisional parse passed, unless admission produced a
    // route the contract refuses — an Oxy fault. The hold is released.
    await session.releaseUnopened('failed');
    logger.error('inference.realtime.unsignable_request', new Error('the session request failed its schema'), {
      requestId,
      path: signed.error.issues[0]?.path.join('.') ?? 'unknown',
    });
    refuseCustomer(
      customer,
      buildInferenceError({ code: 'internal_error', message: 'The session could not be signed.', requestId })
    );
    return undefined;
  }
  const firstFrame = Buffer.from(JSON.stringify(signed.data), 'utf8');
  if (firstFrame.length > MAX_KAANA_REALTIME_FIRST_FRAME_BYTES) {
    await session.releaseUnopened('failed');
    refuseCustomer(
      customer,
      buildInferenceError({
        code: 'request_too_large',
        message: `The signed session request is limited to ${MAX_KAANA_REALTIME_FIRST_FRAME_BYTES} bytes; shorten the instructions or tools.`,
        requestId,
        param: 'config',
      })
    );
    return undefined;
  }
  if (input.signal.aborted) {
    await session.releaseUnopened('cancelled');
    return undefined;
  }

  sessions.set(requestId, session);
  const attached = await session.attach(customer, input.kaana, firstFrame, -1, true);
  return attached ? session : undefined;
}

type SessionRequestInput = z.input<typeof realtimeSessionRequestSchema>;

function sessionRequest(
  context: EdgeExecutionContext,
  frame: RealtimeOpenFrame,
  model: string,
  transport: 'websocket',
  limits: RealtimeSessionLimits,
  receivedAt: string,
  routing: Pick<SessionRequestInput, 'routingPolicy' | 'authorizedRoutes'>
): SessionRequestInput {
  return {
    schemaVersion: 1,
    attribution: attributionFor(context),
    modelReference: model,
    kind: frame.kind,
    transport,
    config: frame.config,
    limits,
    client: {
      endpoint: REALTIME_ENDPOINT,
      ...(frame.clientSessionId === undefined ? {} : { clientSessionId: frame.clientSessionId }),
      receivedAt,
      ...(frame.labels === undefined ? {} : { labels: frame.labels }),
    },
    routingPolicy: routing.routingPolicy,
    authorizedRoutes: routing.authorizedRoutes,
  };
}

/* -------------------------------------------------------------------------- */
/*  Resuming                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Attach a new customer connection to a session this task holds, from the
 * contract's own `session.resume` command — signed as its connection's first
 * frame. Refused, exactly as Kaana refuses one, when this task does not hold
 * the session, when another application asks, or when it has ended.
 */
export async function resumeRealtimeSession(input: {
  readonly requestId: string;
  readonly principal: EdgePrincipal;
  readonly frame: unknown;
  readonly customer: RealtimeCustomerLink;
  readonly kaana: KaanaRealtimeClient | undefined;
}): Promise<RealtimeSession | undefined> {
  const parsed = realtimeSessionResumeCommandSchema.safeParse(input.frame);
  const refuse = (message: string): undefined => {
    refuseCustomer(
      input.customer,
      buildInferenceError({ code: 'invalid_request', message, requestId: input.requestId })
    );
    return undefined;
  };
  if (!parsed.success) return refuse('The first frame is not a session.resume command.');
  const session = sessions.get(parsed.data.requestId);
  if (
    session === undefined ||
    session.finished ||
    session.context.principal.applicationId !== input.principal.applicationId
  ) {
    // One answer for "not here", "not yours" and "over": which of the three is
    // true tells a caller holding someone else's request id nothing it may know.
    return refuse('No resumable session with that request id is held here.');
  }
  if (input.kaana === undefined) return refuse('No inference data plane is configured for this deployment.');
  const attached = await session.attach(
    input.customer,
    input.kaana,
    Buffer.from(JSON.stringify(parsed.data), 'utf8'),
    parsed.data.afterSequence,
    false
  );
  return attached ? session : undefined;
}

/* -------------------------------------------------------------------------- */
/*  One session                                                               */
/* -------------------------------------------------------------------------- */

type ResponseEvidence = Map<UsageUnit, number>;
type RealtimeSessionClosedEvent = Extract<RealtimeServerEvent, { type: 'session.closed' }>;

/** One admitted session, attached or waiting for its customer to resume. */
export class RealtimeSession {
  private customer: RealtimeCustomerLink | undefined;
  private upstream: KaanaRealtimeConnection | undefined;
  /** Bumped on every attach, so callbacks from a replaced connection are ignored. */
  private generation = 0;
  /** The last sequence the current upstream connection delivered; replays start above the resume point. */
  private connectionFloor = -1;
  private servedRoute: EdgeRoute | undefined;
  private resumeWindowMs = MAX_REALTIME_RESUME_WINDOW_MS;
  private readonly responseUnits: ResponseEvidence = new Map();
  private responseUsageSource: UsageSource | undefined;
  private closedEvent: RealtimeSessionClosedEvent | undefined;
  /** An edge-initiated close in progress: the code the customer is closed with. */
  private closingWith: { readonly code: number; readonly reason: string } | undefined;
  private customerClosedSession = false;
  private customerVanished = false;
  private sawOutput = false;
  private protocolRejected = false;
  private settled = false;
  private detachTimer: NodeJS.Timeout | undefined;
  private readonly deadline: NodeJS.Timeout;
  finished = false;

  constructor(
    readonly context: EdgeExecutionContext,
    private readonly admitted: AdmittedRequest,
    limits: RealtimeSessionLimits
  ) {
    // The backstop for a data plane that never ends the session it was signed
    // for: past its maximum duration, the resume window and the report grace,
    // the session is ended here and settled from the evidence held.
    this.deadline = setTimeout(() => {
      void this.finishFromEvidence(REALTIME_CLOSE.internal, 'session deadline');
    }, limits.maxDurationMs + MAX_REALTIME_RESUME_WINDOW_MS + 2 * realtimeTimings.reportGraceMs);
    this.deadline.unref();
  }

  get requestId(): string {
    return this.context.requestId;
  }

  /**
   * Open an upstream connection with `firstFrame` and attach `customer` to it.
   * A connection this session already has is replaced (wire spec §10: one
   * attached connection per session; a resume detaches the old one).
   */
  async attach(
    customer: RealtimeCustomerLink,
    kaana: KaanaRealtimeClient,
    firstFrame: Buffer,
    afterSequence: number,
    initial: boolean
  ): Promise<boolean> {
    this.clearDetachTimer();
    const previousCustomer = this.customer;
    const previousUpstream = this.upstream;
    this.generation += 1;
    const generation = this.generation;
    // The customer is attached BEFORE the upstream opens, so a disconnect while
    // it opens is seen (`customerGone`) and the open is abandoned rather than
    // attached to a socket that is already gone.
    this.customer = customer;
    this.upstream = undefined;
    previousCustomer?.close(REALTIME_CLOSE.resumedElsewhere, 'resumed on another connection');
    previousUpstream?.close(1001, 'resumed on another connection');
    this.connectionFloor = afterSequence;

    let upstream: KaanaRealtimeConnection;
    try {
      upstream = await kaana.open(firstFrame, {
        onEvent: (event) => {
          if (generation === this.generation) this.fromUpstream(event);
        },
        onUsageReport: (report) => {
          if (generation === this.generation) void this.settleWithReport(report);
        },
        onProtocolError: (error) => {
          if (generation !== this.generation) return;
          logger.error('inference.realtime.upstream_protocol_error', error, { requestId: this.requestId });
          this.protocolRejected = true;
          void this.finishFromEvidence(REALTIME_CLOSE.internal, 'data plane protocol error');
        },
        onClose: (code) => {
          if (generation === this.generation) void this.upstreamClosed(code);
        },
      });
    } catch (error) {
      logger.error(
        'inference.realtime.upstream_open_failed',
        error instanceof Error ? error : new Error(String(error)),
        { requestId: this.requestId }
      );
      refuseCustomer(
        customer,
        buildInferenceError({
          code: 'service_unavailable',
          message: 'The inference data plane could not open the realtime session.',
          requestId: this.requestId,
        })
      );
      if (initial) {
        // Nothing was ever opened: release the hold now rather than wait.
        await this.finishFromEvidence(REALTIME_CLOSE.tryAgainLater, 'upstream open failed');
      } else {
        this.startDetachTimer();
      }
      return false;
    }
    if (generation !== this.generation || this.finished) {
      upstream.close(1001, 'superseded');
      return false;
    }
    this.upstream = upstream;
    return true;
  }

  /* ---- upstream → customer ---------------------------------------------- */

  private fromUpstream(event: RealtimeServerEvent): void {
    if (event.requestId !== this.requestId || event.sequence <= this.connectionFloor) {
      this.violation('the data plane sent an event out of order or for another request');
      return;
    }
    this.connectionFloor = event.sequence;

    switch (event.type) {
      case 'session.created': {
        const route = this.admitted.authorizedRoutes.find(
          (candidate) =>
            candidate.deploymentId === event.deploymentId &&
            candidate.modelReference === event.resolvedModelReference &&
            candidate.provider === event.servingProvider
        );
        if (route === undefined) {
          this.violation('the session opened on a deployment no route authorized');
          return;
        }
        this.servedRoute = route;
        this.resumeWindowMs = event.resumeWindowMs;
        break;
      }
      case 'response.done':
        if (this.servedRoute === undefined || event.deploymentId !== this.servedRoute.deploymentId) {
          this.violation('a response was metered on a deployment the session did not open on');
          return;
        }
        for (const quantity of event.units) {
          this.responseUnits.set(quantity.unit, (this.responseUnits.get(quantity.unit) ?? 0) + quantity.quantity);
        }
        this.responseUsageSource = event.usageSource;
        break;
      case 'output_audio.delta':
      case 'text.delta':
      case 'transcript.delta':
      case 'tool_call':
        this.sawOutput = true;
        break;
      case 'session.closed':
        this.closedEvent = event;
        break;
      default:
        break;
    }

    // The contract shape, re-serialized from the validated parse: the customer
    // speaks the same events the data plane emits, with its sequence intact.
    this.customer?.send(JSON.stringify(event));
  }

  private async upstreamClosed(code: number): Promise<void> {
    this.upstream = undefined;
    if (this.finished) return;
    if (this.settled || this.closedEvent !== undefined) {
      // The report either arrived (settled) or was lost after the session ended.
      await this.finishFromEvidence(this.closingWith?.code ?? REALTIME_CLOSE.normal, this.closingWith?.reason ?? 'session closed');
      return;
    }
    if (this.servedRoute === undefined && this.connectionFloor === -1) {
      // Kaana closed before the session ever opened — a refused signature or
      // first frame (1008), or no route that would open. Nothing exists to
      // resume, and nothing was consumed: release the hold now.
      await this.finishFromEvidence(
        code === REALTIME_CLOSE.policy ? REALTIME_CLOSE.internal : REALTIME_CLOSE.tryAgainLater,
        'the data plane did not open the session'
      );
      return;
    }
    // The session is still alive upstream for its resume window, unless this
    // close was Kaana refusing a resume (1008 after a fatal error it sent).
    const customer = this.customer;
    this.customer = undefined;
    customer?.close(
      code === REALTIME_CLOSE.policy ? REALTIME_CLOSE.policy : REALTIME_CLOSE.internal,
      code === REALTIME_CLOSE.policy ? 'session refused by the data plane' : 'upstream connection lost; resumable'
    );
    this.startDetachTimer();
  }

  /* ---- customer → upstream ---------------------------------------------- */

  /** One frame from the attached customer. */
  fromCustomer(customer: RealtimeCustomerLink, data: string | undefined, isBinary: boolean): void {
    if (customer !== this.customer || this.upstream === undefined || this.closingWith !== undefined) return;
    if (isBinary || data === undefined) {
      this.closeFromEdge(REALTIME_CLOSE.unsupportedData, 'binary frames are refused');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      this.closeFromEdge(REALTIME_CLOSE.policy, 'a frame that is not JSON');
      return;
    }
    const parsed = realtimeClientCommandSchema.safeParse(payload);
    if (!parsed.success) {
      this.closeFromEdge(REALTIME_CLOSE.policy, 'a frame that is not a realtime command');
      return;
    }
    const command = parsed.data;
    if (command.requestId !== this.requestId || command.type === 'session.resume') {
      this.closeFromEdge(REALTIME_CLOSE.policy, 'a command outside this session');
      return;
    }
    if (command.type === 'session.update' && command.config.inputAudioTranscription !== undefined) {
      // Outside the shape the session was admitted for; see the module header.
      this.closeFromEdge(REALTIME_CLOSE.policy, 'input audio transcription is not served');
      return;
    }
    if (command.type === 'session.close') this.customerClosedSession = true;
    this.upstream.send(command);
  }

  /**
   * The customer broke the protocol: stop reading it, ask the data plane to
   * close the session (a command of the edge's own, never a replay of the
   * customer's), relay the events up to `session.closed`, settle, and close the
   * customer with `code`. Every event keeps the data plane's own sequence.
   */
  private closeFromEdge(code: number, reason: string): void {
    this.closingWith = { code, reason };
    const command: RealtimeClientCommand = {
      schemaVersion: 1,
      requestId: this.requestId,
      commandId: `oxy-edge-close-${randomUUID()}`,
      type: 'session.close',
    };
    this.upstream?.send(command);
  }

  /** The customer's connection closed. */
  customerGone(customer: RealtimeCustomerLink): void {
    if (customer !== this.customer || this.finished) return;
    this.customer = undefined;
    if (this.closedEvent !== undefined || this.closingWith !== undefined) {
      // The session is already ending: keep the upstream open for the report.
      return;
    }
    this.customerVanished = true;
    const upstream = this.upstream;
    this.upstream = undefined;
    // Also abandons an upstream still opening: `attach` sees the generation move.
    this.generation += 1;
    // Not `session.close`: the session stays resumable upstream for its window.
    upstream?.close(1001, 'client connection lost');
    this.startDetachTimer();
  }

  /* ---- settlement -------------------------------------------------------- */

  private async settleWithReport(report: NormalizedUsageReport): Promise<void> {
    const usable = validateUsageReport(report, this.requestId, this.admitted.authorizedRoutes);
    if (usable === undefined) {
      logger.error(
        'inference.realtime.usage_report_rejected',
        new Error('the session usage report does not answer the session that was admitted'),
        { requestId: this.requestId }
      );
      await this.settleOnce(this.recoveryEvidence());
    } else {
      await this.settleOnce({ kind: 'report', report: usable.report }, usable.route);
    }
    await this.finishFromEvidence(this.closingWith?.code ?? REALTIME_CLOSE.normal, this.closingWith?.reason ?? 'session closed');
  }

  /**
   * The evidence a lost report leaves: the totals `session.closed` carried, else
   * the sum of every `response.done`. Exact units tied to the session's one
   * deployment; the outcome is the edge's own, never `completed`.
   */
  private recoveryEvidence(): KaanaUsageEvidence | undefined {
    if (this.protocolRejected && this.closedEvent !== undefined) {
      // The frame that failed may have been the report itself: the whole
      // metering record is contradictory, and no earlier evidence is trusted.
      return undefined;
    }
    const route = this.servedRoute;
    if (route === undefined) return undefined;
    if (this.closedEvent !== undefined && this.closedEvent.units.length > 0) {
      return {
        kind: 'partial',
        requestId: this.requestId,
        deploymentId: this.closedEvent.deploymentId ?? route.deploymentId,
        units: this.closedEvent.units,
        usageSource: this.closedEvent.usageSource,
      };
    }
    if (this.responseUnits.size === 0 || this.responseUsageSource === undefined) return undefined;
    return {
      kind: 'partial',
      requestId: this.requestId,
      deploymentId: route.deploymentId,
      units: [...this.responseUnits.entries()].map(([unit, quantity]) => ({ unit, quantity })),
      usageSource: this.responseUsageSource,
    };
  }

  private async settleOnce(evidence: KaanaUsageEvidence | undefined, reportedRoute?: EdgeRoute): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.clearDetachTimer();
    clearTimeout(this.deadline);

    const primary = this.admitted.route;
    let validated = evidence;
    let servedRoute = reportedRoute ?? this.servedRoute ?? primary;
    if (evidence !== undefined && evidence.kind === 'partial') {
      const validation = validateUsageEvidence(evidence, this.requestId, this.admitted.authorizedRoutes);
      if (validation.status === 'valid') {
        servedRoute = validation.route;
      } else {
        logger.error('inference.realtime.recovered_usage_rejected', new Error(validation.reason), {
          requestId: this.requestId,
        });
        validated = undefined;
      }
    }
    const outcome: 'failed' | 'cancelled' | 'partial' = this.customerVanished && !this.customerClosedSession
      ? 'cancelled'
      : this.sawOutput
        ? 'partial'
        : 'failed';
    const settlement = settlementFrom(validated, outcome, servedRoute.provider);
    await settleMeasured(this.context, this.admitted, settlement, servedRoute);
    await recordEdgeTelemetry(this.context, {
      requestedModelReference: this.admitted.requestedModelReference,
      statusCode: this.servedRoute === undefined ? inferenceErrorStatus('no_route_available') : 200,
      units: settlement.units,
      resolvedModelReference: servedRoute.modelReference,
      servingProvider: settlement.servingProvider,
      outcome: settlement.outcome,
      usageSource: settlement.usageSource,
      ...(validated?.kind === 'report' ? { routeSwitches: validated.report.routeSwitches } : {}),
      ...(settlement.generationId === undefined ? {} : { generationId: settlement.generationId }),
    });
  }

  /** Release the hold of a session that never opened upstream. */
  async releaseUnopened(outcome: 'failed' | 'cancelled'): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.deadline);
    await settleMeasured(this.context, this.admitted, settlementFrom(undefined, outcome, this.admitted.route.provider), this.admitted.route);
    this.finished = true;
  }

  /** Settle from whatever is held (if not yet settled), then close everything. */
  private async finishFromEvidence(code: number, reason: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    sessions.delete(this.requestId);
    this.clearDetachTimer();
    clearTimeout(this.deadline);
    const customer = this.customer;
    const upstream = this.upstream;
    this.customer = undefined;
    this.upstream = undefined;
    this.generation += 1;
    if (!this.settled) await this.settleOnce(this.recoveryEvidence());
    customer?.close(code, reason);
    upstream?.close(1000, 'session settled');
  }

  private violation(message: string): void {
    logger.error('inference.realtime.upstream_violation', new Error(message), { requestId: this.requestId });
    this.protocolRejected = true;
    void this.finishFromEvidence(REALTIME_CLOSE.internal, 'data plane protocol error');
  }

  private startDetachTimer(): void {
    this.clearDetachTimer();
    this.detachTimer = setTimeout(() => {
      void this.finishFromEvidence(REALTIME_CLOSE.normal, 'resume window elapsed');
    }, this.resumeWindowMs + realtimeTimings.reportGraceMs);
    this.detachTimer.unref();
  }

  private clearDetachTimer(): void {
    if (this.detachTimer !== undefined) clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
  }
}

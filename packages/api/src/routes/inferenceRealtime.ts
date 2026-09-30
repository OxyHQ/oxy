/**
 * `GET /v1/realtime?model=<publisher>/<model>` — realtime sessions over one
 * WebSocket (contract set 3.2.0, OxyHQ/Kaana#90).
 *
 * ## The customer protocol is the contract's own
 *
 * Oxy-native, not a dialect: after the upgrade the customer speaks the
 * normalized `realtimeClientCommandSchema` commands and hears the
 * `realtimeServerEventSchema` events, one JSON text frame each, exactly as the
 * data plane does. Two things are Oxy's:
 *
 *  - **Authentication is the public inference API's.** `Authorization: Bearer
 *    <api key>` on the upgrade, resolved by the same `authenticateEdgeCaller`
 *    and the same audience gate (`INFERENCE_EDGE_AUDIENCE`) as every `/v1`
 *    endpoint. Browsers cannot set that header, and no customer key belongs in
 *    a browser: an ephemeral-token flow is the follow-up for them.
 *  - **The FIRST frame** is either `session.open` (`realtimeOpenFrameSchema`:
 *    kind, transport, config and a partial `limits` request) — which the edge
 *    authorizes against the catalogue, holds spend for and signs as the
 *    contract's `realtimeSessionRequestSchema` — or the contract's own
 *    `session.resume` command, which reattaches to a session this edge task
 *    holds.
 *
 * `X-Oxy-Request-Id` on the `101` response names the session: its request id,
 * its receipt at `GET /v1/generations/:id`, and the id every command carries.
 *
 * ## Refusals and closes
 *
 * Before a session exists, a refusal is ONE `error` event (`fatal: true`,
 * `sequence: 0`) and a close — 1008 for a request error, 1013 for an
 * unavailable service, 1011 for Oxy's own failure. After, the session ends the
 * contract's way (`session.closed`, then close 1000). A customer frame that is
 * binary (1003) or not a valid command of this session (1008) ends the session
 * the same way: the edge asks the data plane to close it and relays every event
 * up to `session.closed`. A lost upstream closes the customer 1011 and the
 * session stays resumable for its window. The authoritative handling is
 * `services/inferenceRealtime.service.ts`.
 *
 * ## Why the upgrade is accepted before authentication
 *
 * `server.ts` attaches Socket.IO to the same HTTP server, and engine.io ends
 * any upgrade it does not own that has written nothing within one second. An
 * authentication that waited on Postgres before the `101` would race that
 * timer under load; answering the upgrade first and refusing on the socket is
 * the ordering that cannot lose it.
 */

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { modelReferenceSchema } from '@oxy.so/contracts';
import { admitToInferenceEdge } from '../config/rolloutFlags';
import { realtimeOpenFrameSchema } from '../schemas/inferenceEdge.schemas';
import {
  allocateRequestId,
  authenticateEdgeCaller,
  type EdgePrincipal,
} from '../services/inferenceEdge.service';
import type { KaanaClient } from '../services/kaanaClient';
import {
  MAX_REALTIME_PENDING_FRAMES,
  openRealtimeSession,
  REALTIME_CLOSE,
  REALTIME_ENDPOINT,
  REALTIME_FIRST_FRAME_TIMEOUT_MS,
  refuseCustomer,
  resumeRealtimeSession,
  type RealtimeCustomerLink,
  type RealtimeSession,
} from '../services/inferenceRealtime.service';
import type { KaanaRealtimeClient } from '../services/kaanaRealtimeClient';
import { buildInferenceError } from '../utils/inferenceEdgeErrors';
import { logger } from '../utils/logger';

/**
 * The largest frame a customer may send. A command's audio is bounded by the
 * contract at 64 KiB of base64; the large frames are conversation items with
 * text, which the contract bounds at a mebibyte of characters per part.
 * Anything larger is closed by the WebSocket layer with 1009.
 */
export const MAX_REALTIME_CUSTOMER_FRAME_BYTES = 2 * 1024 * 1024;

export interface RealtimeEdgeOptions {
  /** The one-shot client: admission's exact-id attestation runs through it. */
  readonly kaanaClient?: KaanaClient;
  readonly kaanaRealtimeClient?: KaanaRealtimeClient;
}

/**
 * Serve `GET /v1/realtime` on `server`'s upgrades. Other upgrade paths are left
 * to their own listeners (Socket.IO's, in `server.ts`).
 */
export function attachRealtimeEdge(server: http.Server, options: RealtimeEdgeOptions): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REALTIME_CUSTOMER_FRAME_BYTES,
    perMessageDeflate: false,
  });
  const requestIds = new WeakMap<http.IncomingMessage, string>();
  wss.on('headers', (headers: string[], req: http.IncomingMessage) => {
    const requestId = requestIds.get(req);
    if (requestId !== undefined) headers.push(`X-Oxy-Request-Id: ${requestId}`);
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://edge.invalid');
    } catch {
      return;
    }
    if (url.pathname !== REALTIME_ENDPOINT) return;
    // Allocated before authentication, as on every `/v1` endpoint, so a refused
    // connection is still traceable.
    const requestId = allocateRequestId();
    const receivedAt = performance.now();
    requestIds.set(req, requestId);
    wss.handleUpgrade(req, socket, head, (ws) => {
      void serveConnection(ws, req, url, requestId, receivedAt, options).catch((error: unknown) => {
        logger.error(
          'inference.realtime.connection_failed',
          error instanceof Error ? error : new Error(String(error)),
          { requestId }
        );
        ws.close(REALTIME_CLOSE.internal, 'internal_error');
      });
    });
  });
  return wss;
}

interface CustomerFrame {
  readonly text: string | undefined;
  readonly isBinary: boolean;
}

async function serveConnection(
  ws: WebSocket,
  req: http.IncomingMessage,
  url: URL,
  requestId: string,
  receivedAt: number,
  options: RealtimeEdgeOptions
): Promise<void> {
  const link: RealtimeCustomerLink = {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: (code, reason) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    },
  };
  const abort = new AbortController();
  const pending: CustomerFrame[] = [];
  let session: RealtimeSession | undefined;
  let closed = false;
  let deliverFirst: (frame: CustomerFrame | undefined) => void = () => undefined;
  let firstSeen = false;
  const firstFrame = new Promise<CustomerFrame | undefined>((resolve) => {
    deliverFirst = resolve;
  });

  ws.on('message', (data: RawData, isBinary: boolean) => {
    const frame: CustomerFrame = { text: isBinary ? undefined : rawText(data), isBinary };
    if (!firstSeen) {
      firstSeen = true;
      deliverFirst(frame);
      return;
    }
    if (session !== undefined) {
      session.fromCustomer(link, frame.text, frame.isBinary);
      return;
    }
    // Frames sent while the session is still being admitted and opened are
    // held, in order, and forwarded once it is attached — never dropped.
    if (pending.length >= MAX_REALTIME_PENDING_FRAMES) {
      link.close(REALTIME_CLOSE.policy, 'too many frames before the session opened');
      return;
    }
    pending.push(frame);
  });
  ws.on('close', () => {
    closed = true;
    abort.abort();
    deliverFirst(undefined);
    session?.customerGone(link);
  });
  // `close` always follows an `error`; nothing further to do here, and nothing
  // from the frame is logged.
  ws.on('error', () => undefined);

  const refuse = (code: Parameters<typeof buildInferenceError>[0]['code'], message: string, param?: string): void => {
    refuseCustomer(
      link,
      buildInferenceError({ code, message, requestId, ...(param === undefined ? {} : { param }) })
    );
  };

  const authentication = await authenticateEdgeCaller(req);
  if (!authentication.ok) {
    logger.warn('inference.realtime.unauthenticated', { requestId, reason: authentication.reason });
    refuse('authentication_failed', 'The provided API key is invalid, expired, or revoked.');
    return;
  }
  const principal: EdgePrincipal = authentication.principal;
  const admission = admitToInferenceEdge(principal);
  if (admission.status === 'refused') {
    logger.warn('inference.realtime.outside_audience', {
      requestId,
      reason: admission.reason,
      applicationId: principal.applicationId,
    });
    refuse('permission_denied', 'The Oxy inference API is not open to this application yet.');
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    firstFrame,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), REALTIME_FIRST_FRAME_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (first === undefined || closed) return;
  if (first === 'timeout') {
    refuse('invalid_request', `Send the first frame within ${REALTIME_FIRST_FRAME_TIMEOUT_MS} ms.`);
    return;
  }
  if (first.isBinary || first.text === undefined) {
    refuse('invalid_request', 'Every frame is one JSON text message; binary frames are refused.');
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(first.text);
  } catch {
    refuse('invalid_request', 'The first frame is not JSON.');
    return;
  }
  const type = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'type') : undefined;

  if (type === 'session.open') {
    const open = realtimeOpenFrameSchema.safeParse(payload);
    if (!open.success) {
      const issue = open.error.issues[0];
      refuse('invalid_request', issue?.message ?? 'The session.open frame could not be parsed.', issue?.path.join('.'));
      return;
    }
    const modelParam = url.searchParams.get('model');
    const model = modelParam === null ? undefined : modelReferenceSchema.safeParse(modelParam);
    if (model !== undefined && !model.success) {
      refuse('invalid_request', 'model is not a canonical <publisher>/<model> reference.', 'model');
      return;
    }
    const delegated = req.headers['x-oxy-user-id'];
    session = await openRealtimeSession({
      requestId,
      receivedAt,
      principal,
      model: model?.data,
      frame: open.data,
      ...(typeof delegated === 'string' && delegated.length > 0 && delegated.length <= 64
        ? { delegatedUserId: delegated }
        : {}),
      customer: link,
      signal: abort.signal,
      kaanaClient: options.kaanaClient,
      kaana: options.kaanaRealtimeClient,
    });
  } else if (type === 'session.resume') {
    session = await resumeRealtimeSession({
      requestId,
      principal,
      frame: payload,
      customer: link,
      kaana: options.kaanaRealtimeClient,
    });
  } else {
    refuse('invalid_request', 'The first frame is session.open or session.resume.', 'type');
    return;
  }

  if (session === undefined) return;
  if (closed) {
    session.customerGone(link);
    return;
  }
  for (const frame of pending.splice(0)) session.fromCustomer(link, frame.text, frame.isBinary);
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

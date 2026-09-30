/**
 * The Oxy → Kaana realtime hop: one signed WebSocket per attached session
 * connection (contract set 3.2.0, OxyHQ/Kaana#90).
 *
 * ```text
 * GET wss://kaana.ai/internal/v1/realtime            (RFC 6455 upgrade, no subprotocol)
 *   X-Oxy-Kaana-Key-Id / -Timestamp / -Signature     over the EXACT bytes of frame 1
 * frame 1   realtimeSessionRequestSchema | session.resume   (text, signed, ≤ 64 KiB)
 * then      client commands  →   ←  server events
 * after session.closed: exactly ONE text frame, a normalizedUsageReportSchema
 * then      close 1000
 * ```
 *
 * ## The signature covers the first frame's exact bytes
 *
 * The signing input is the one the inference envelope uses —
 * `kaanaSignatureHeaders`, the inference domain `oxy-kaana-envelope:v1` — and
 * the SAME `Buffer` that was hashed is the frame that is sent, as a text frame.
 * Serializing the request a second time would authenticate something other than
 * what Kaana executes. Every later frame is covered by the connection that
 * signature opened.
 *
 * ## Frames are read in protocol order, and nothing else is accepted
 *
 * Before `session.closed` every frame must parse as `realtimeServerEventSchema`;
 * the ONE frame after it must parse as `normalizedUsageReportSchema`; any frame
 * after that, any binary frame and any frame that fails its schema is a
 * {@link KaanaProtocolError}, and the connection is closed. That is the
 * contract's versioning rule — a producer running ahead of its consumer fails at
 * the parse — and for the usage report the stake is a charge.
 *
 * ## What never enters a log line
 *
 * Frames. Audio, prompts, transcripts and tool arguments all ride them; the
 * failure paths here name a request id, a close code and a schema path only.
 */

import WebSocket, { type RawData } from 'ws';
import {
  normalizedUsageReportSchema,
  realtimeServerEventSchema,
  type NormalizedUsageReport,
  type RealtimeClientCommand,
  type RealtimeServerEvent,
} from '@oxy.so/contracts';
import { resolveKaanaDataPlane, type KaanaDataPlaneConfig } from '../config/kaanaDataPlane';
import { kaanaSignatureHeaders } from './httpKaanaClient';
import { KaanaEnvelopeRejectedError, KaanaProtocolError } from './kaanaClient';

/** Kaana's realtime route, on the same origin as `POST /internal/v1/inference`. */
export const KAANA_REALTIME_PATH = '/internal/v1/realtime';

/** Kaana reads a first frame of at most this many bytes (wire spec §2). */
export const MAX_KAANA_REALTIME_FIRST_FRAME_BYTES = 64 * 1024;

/**
 * The largest single frame this client accepts from Kaana. Audio frames are
 * bounded by the contract at 64 KiB of base64; the large ones are conversation
 * items carrying text, and the bound is the one the SSE decoder applies.
 */
const MAX_KAANA_REALTIME_FRAME_BYTES = 8 * 1024 * 1024;

/** The upgrade must complete within this, or the open fails. */
const KAANA_REALTIME_HANDSHAKE_TIMEOUT_MS = 10_000;

/** What the connection reports, in protocol order. */
export interface KaanaRealtimeHandlers {
  readonly onEvent: (event: RealtimeServerEvent) => void;
  /** The one frame after `session.closed`. */
  readonly onUsageReport: (report: NormalizedUsageReport) => void;
  /** A frame this build cannot read, or one out of protocol order. The connection is closed. */
  readonly onProtocolError: (error: KaanaProtocolError) => void;
  /** The WebSocket closed, for any reason, after it opened. */
  readonly onClose: (code: number, reason: string) => void;
}

export interface KaanaRealtimeConnection {
  /** One client command, serialized once. A write to a closed socket is dropped. */
  send(command: RealtimeClientCommand): void;
  close(code: number, reason: string): void;
}

export interface KaanaRealtimeClient {
  /**
   * Open a connection whose FIRST frame is `firstFrame` — the exact bytes that
   * are signed. Resolves once the upgrade completed and the frame was written;
   * rejects if the upgrade was refused ({@link KaanaEnvelopeRejectedError}) or
   * never completed.
   */
  open(firstFrame: Buffer, handlers: KaanaRealtimeHandlers): Promise<KaanaRealtimeConnection>;
}

/** How a WebSocket is dialled. Replaceable only so a test can reach a loopback stub. */
export type KaanaRealtimeDialer = (
  url: string,
  options: { readonly headers: Record<string, string>; readonly maxPayload: number; readonly handshakeTimeout: number }
) => WebSocket;

const defaultDialer: KaanaRealtimeDialer = (url, options) =>
  new WebSocket(url, {
    headers: options.headers,
    maxPayload: options.maxPayload,
    handshakeTimeout: options.handshakeTimeout,
    perMessageDeflate: false,
  });

/**
 * The realtime client for this deployment's data plane, or `undefined` when it
 * configured none — exactly as `createHttpKaanaClient` is resolved, and from the
 * same three variables.
 */
export function createKaanaRealtimeClient(
  options: { readonly dial?: KaanaRealtimeDialer } = {}
): KaanaRealtimeClient | undefined {
  const resolution = resolveKaanaDataPlane();
  if (resolution.status !== 'configured') return undefined;
  return new WebSocketKaanaRealtimeClient(resolution.config, options.dial ?? defaultDialer);
}

/** `https://kaana.ai` → `wss://kaana.ai/internal/v1/realtime`. */
export function kaanaRealtimeUrl(baseUrl: string): string {
  const url = new URL(KAANA_REALTIME_PATH, baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

class WebSocketKaanaRealtimeClient implements KaanaRealtimeClient {
  constructor(
    private readonly config: KaanaDataPlaneConfig,
    private readonly dial: KaanaRealtimeDialer
  ) {}

  open(firstFrame: Buffer, handlers: KaanaRealtimeHandlers): Promise<KaanaRealtimeConnection> {
    if (firstFrame.length > MAX_KAANA_REALTIME_FIRST_FRAME_BYTES) {
      return Promise.reject(
        new KaanaProtocolError('The realtime first frame exceeds the data plane’s 64 KiB bound.')
      );
    }

    const socket = this.dial(kaanaRealtimeUrl(this.config.baseUrl), {
      headers: kaanaSignatureHeaders(this.config, firstFrame),
      maxPayload: MAX_KAANA_REALTIME_FRAME_BYTES,
      handshakeTimeout: KAANA_REALTIME_HANDSHAKE_TIMEOUT_MS,
    });

    return new Promise<KaanaRealtimeConnection>((resolve, reject) => {
      let opened = false;
      let sessionClosed = false;
      let reported = false;
      let failed = false;

      const protocolError = (message: string): void => {
        if (failed) return;
        failed = true;
        socket.close(1002, 'protocol error');
        handlers.onProtocolError(new KaanaProtocolError(message));
      };

      socket.on('unexpected-response', (_request, response) => {
        // An HTTP answer instead of an upgrade: Oxy's signature, key or frame was
        // refused before any session existed. Never the customer's fault.
        response.resume();
        socket.terminate();
        if (!opened) reject(new KaanaEnvelopeRejectedError(response.statusCode ?? 0, undefined));
      });

      socket.on('error', (error) => {
        if (!opened) reject(error);
      });

      socket.on('open', () => {
        opened = true;
        // The SAME buffer that was signed, as ONE text frame.
        socket.send(firstFrame, { binary: false });
        resolve({
          send: (command) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
          },
          close: (code, reason) => {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
              socket.close(code, reason);
            }
          },
        });
      });

      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (failed) return;
        if (isBinary) {
          protocolError('The data plane sent a binary realtime frame.');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(rawText(data));
        } catch {
          protocolError('The data plane sent a realtime frame that is not JSON.');
          return;
        }
        if (reported) {
          protocolError('The data plane sent a frame after the session’s usage report.');
          return;
        }
        if (sessionClosed) {
          const report = normalizedUsageReportSchema.safeParse(payload);
          if (!report.success) {
            protocolError(
              `The data plane sent a usage report Oxy could not read: ${issuePath(report.error.issues[0]?.path)}.`
            );
            return;
          }
          reported = true;
          handlers.onUsageReport(report.data);
          return;
        }
        const event = realtimeServerEventSchema.safeParse(payload);
        if (!event.success) {
          protocolError(
            `The data plane sent a realtime event Oxy could not read: ${issuePath(event.error.issues[0]?.path)}.`
          );
          return;
        }
        if (event.data.type === 'session.closed') sessionClosed = true;
        handlers.onEvent(event.data);
      });

      socket.on('close', (code: number, reason: Buffer) => {
        if (!opened) {
          reject(new KaanaProtocolError(`The data plane closed the realtime upgrade (${code}).`));
          return;
        }
        handlers.onClose(code, reason.toString('utf8'));
      });
    });
  }
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function issuePath(path: readonly (string | number)[] | undefined): string {
  return path === undefined || path.length === 0 ? 'unknown field' : path.join('.');
}

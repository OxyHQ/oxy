/**
 * The socket every postgres.js client this package opens connects through: a
 * TCP connection with keepalive on, and a deadline on how long the server may
 * stay silent once the client has sent it something.
 *
 * ## Why a socket, and not a timer around each query
 *
 * A connection whose peer vanished without a FIN or RST (a NAT entry dropped,
 * a failover, a host that lost power) does not fail: the next query is written
 * into the kernel's send queue and TCP retransmits it until `tcp_retries2`
 * gives up, about fifteen minutes on Linux. Keepalive cannot shorten that,
 * because the kernel sends no keepalive probe while data is unacknowledged.
 * postgres.js has no query timeout, and a timer that merely rejected the
 * caller's promise would leave the dead connection in the pool, where
 * postgres.js keeps pipelining queries onto it. The connection has to be
 * DESTROYED, and only the socket underneath it can do that, so the deadline
 * lives here, in the `socket` hook postgres.js calls for each connection.
 *
 * ## What the deadline measures
 *
 * The time from the first write the server has not yet answered to the
 * server's next byte. Postgres answers every request, and says nothing while a
 * statement runs, so for a live server that silence is bounded by the
 * statement itself, and so by `statement_timeout`: past it the server sends
 * an error. A deadline set above the statement timeout therefore never fires
 * on a live server, only on a socket nothing will ever arrive on. When it
 * fires the socket is destroyed with a {@link QueryDeadlineError}; postgres.js
 * rejects every query on the connection with it and opens a fresh one for the
 * next.
 *
 * An idle pooled connection has no unanswered write, so it is never timed.
 * Once a response has started arriving, a peer that dies mid-response leaves
 * nothing unacknowledged on the client, which is exactly the case keepalive
 * covers.
 *
 * Over TLS the TLS socket closes a tick after the error reaches postgres.js,
 * so a query dispatched onto that connection in between rejects with
 * postgres.js's own `CONNECTION_CLOSED` rather than waiting; the one after it
 * gets a new connection.
 *
 * ## Why a Duplex in front of the TCP socket
 *
 * postgres.js negotiates TLS itself, by wrapping the socket this hook returns
 * in `tls.connect({ socket })`. Wrapped, a `net.Socket` stops emitting `data`
 * and its writes no longer pass through JavaScript (in Node and in Bun), so a
 * deadline on the TCP socket would see nothing. A Duplex proxy is read and
 * written through JavaScript whatever is layered on top of it, so the deadline
 * sees the (encrypted) bytes either way, and TLS stays postgres.js's.
 */

import net from 'node:net';
import { Duplex } from 'node:stream';

/** The `code` a {@link QueryDeadlineError} carries, alongside postgres.js's own codes. */
export const QUERY_DEADLINE_EXCEEDED = 'QUERY_DEADLINE_EXCEEDED';

/**
 * The server sent nothing for `deadlineMs` after a request, so the connection
 * was destroyed. Every query in flight on that connection rejects with it.
 */
export class QueryDeadlineError extends Error {
  readonly code = QUERY_DEADLINE_EXCEEDED;

  constructor(readonly deadlineMs: number) {
    super(
      `@oxy.so/db: the database sent nothing for ${deadlineMs}ms after a request, so the ` +
        'connection was destroyed as dead. A statement that legitimately runs this long ' +
        'needs a higher `statementTimeoutMs` (the deadline follows it) or `queryDeadlineMs`.',
    );
    this.name = 'QueryDeadlineError';
  }
}

/** Whether `error` is a {@link QueryDeadlineError}, by its code. */
export function isQueryDeadlineError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === QUERY_DEADLINE_EXCEEDED
  );
}

/**
 * The parts of postgres.js's parsed options this hook reads. postgres.js
 * passes its whole parsed options object; with a `socket` hook it no longer
 * connects or sets keepalive on its own, so both are done here.
 */
export interface SocketTarget {
  readonly host: readonly string[];
  readonly port: readonly number[];
  readonly path?: string | false | null;
  /** Seconds; falsy means no keepalive, as in postgres.js. */
  readonly keep_alive?: number | null | false;
}

/**
 * The `socket` option for a postgres.js client: one {@link DeadlineSocket} per
 * connection. Multiple hosts are tried in turn, one per new connection, as
 * postgres.js does without the hook.
 */
export function deadlineSocketFactory(deadlineMs: number): (target: SocketTarget) => Duplex {
  let attempt = 0;
  return (target) => {
    const index = attempt++ % Math.max(1, target.host.length);
    const host = target.host[index];
    const port = target.port[index] ?? target.port[0];
    const inner = target.path ? net.connect(target.path) : net.connect(port, host);
    const keepAliveSeconds = target.keep_alive;
    if (keepAliveSeconds) {
      inner.once('connect', () => inner.setKeepAlive(true, keepAliveSeconds * 1000));
    }
    return new DeadlineSocket(inner, deadlineMs, host);
  };
}

/** A TCP socket behind a Duplex that destroys itself when the server goes silent. */
export class DeadlineSocket extends Duplex {
  /** Read by postgres.js as the TLS `servername`. */
  readonly host: string | undefined;
  readonly #inner: net.Socket;
  readonly #deadlineMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(inner: net.Socket, deadlineMs: number, host?: string) {
    super({ allowHalfOpen: false });
    this.#inner = inner;
    this.#deadlineMs = deadlineMs;
    this.host = host;
    inner.on('data', (chunk: Buffer) => {
      this.#answered();
      if (!this.push(chunk)) inner.pause();
    });
    inner.on('end', () => this.push(null));
    inner.on('error', (error) => this.destroy(error));
    inner.on('close', () => this.destroy());
  }

  /** postgres.js sends its Terminate message only to an `'open'` socket. */
  get readyState(): string {
    return this.#inner.readyState;
  }

  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.#inner.setKeepAlive(enable, initialDelay);
    return this;
  }

  setNoDelay(noDelay?: boolean): this {
    this.#inner.setNoDelay(noDelay);
    return this;
  }

  override _read(): void {
    this.#inner.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#awaitAnswer();
    this.#inner.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#inner.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#answered();
    this.#inner.destroy();
    callback(error);
  }

  /** Start the deadline, unless an earlier write is still unanswered. */
  #awaitAnswer(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.destroy(new QueryDeadlineError(this.#deadlineMs));
    }, this.#deadlineMs);
    // The connection itself keeps the process alive while it is open.
    this.#timer.unref?.();
  }

  #answered(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/**
 * The user socket for a session a platform holds (ADR 0058 decision 1, "what
 * still works").
 *
 * On a session host the application holds no device credential and its token
 * is an application token, which the server joins to `user:<id>` only — never
 * to a device room. So this socket is just that: it authenticates with the
 * current bearer on every handshake, carries the app's server events
 * (notifications, `supervision_changed`, `civic:attested`, …) and nothing of
 * the device (`session_state` is the platform's).
 *
 * It is never opened without a bearer, and {@link UserEventSocket.restart}
 * drops the connection so an account change rejoins the new account's room.
 */
import { logger } from '../logger';
import { getSocketIO, type MinimalSocket, type SocketIOFactory } from './socketLoader';

export interface UserEventSocketOptions {
  baseURL: string;
  /** The bearer to authenticate a handshake with, read afresh each time. */
  getAccessToken: () => string | null;
  /** Injected `socket.io-client` `io`; the lazy loader otherwise. */
  socketFactory?: SocketIOFactory;
}

export interface UserEventSocket {
  /**
   * Subscribe to a named server event. Listeners survive reconnects and
   * restarts; payloads are delivered as-is (callers validate the shape).
   */
  onServerEvent(event: string, listener: (payload: unknown) => void): () => void;
  /** Connect when a bearer is held and no socket is open; close when none is. */
  sync(): void;
  /** Close the connection and open a new one for the current bearer. */
  restart(): void;
  /** Close it. A later `sync` or `restart` (a remount) opens it again. */
  stop(): void;
}

export function createUserEventSocket(options: UserEventSocketOptions): UserEventSocket {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bound = new Set<string>();
  let socket: MinimalSocket | null = null;
  let generation = 0;
  let opening = false;

  const dispatch = (event: string, payload: unknown): void => {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (error) {
        logger.warn(
          '[UserEventSocket] server-event listener threw',
          { component: 'UserEventSocket' },
          error,
        );
      }
    }
  };

  const bind = (event: string): void => {
    if (!socket || bound.has(event)) return;
    bound.add(event);
    socket.on(event, (payload: unknown) => dispatch(event, payload));
  };

  const close = (): void => {
    generation += 1;
    opening = false;
    bound.clear();
    if (socket) {
      const current = socket;
      socket = null;
      current.disconnect();
    }
  };

  const open = async (): Promise<void> => {
    const opened = generation;
    opening = true;
    const io = options.socketFactory ?? (await getSocketIO());
    if (opened !== generation) return;
    opening = false;
    if (!io || !options.getAccessToken()) return;
    socket = io(options.baseURL, {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: (cb: (data: Record<string, string>) => void) => {
        cb({ token: options.getAccessToken() ?? '' });
      },
    });
    for (const event of listeners.keys()) bind(event);
  };

  const sync = (): void => {
    if (!options.getAccessToken()) {
      close();
      return;
    }
    if (socket || opening) return;
    void open().catch((error) => {
      opening = false;
      logger.warn('[UserEventSocket] could not open', { component: 'UserEventSocket' }, error);
    });
  };

  return {
    onServerEvent(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      bind(event);
      return () => {
        set.delete(listener);
      };
    },
    sync,
    restart() {
      close();
      sync();
    },
    stop() {
      close();
    },
  };
}

import { logger } from '../logger';

export interface MinimalSocket {
  connected: boolean;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler?: (...args: unknown[]) => void): void;
  /** Client→server emit (e.g. joining the `/auth-session` room for a QR flow). */
  emit(event: string, ...args: unknown[]): void;
  connect(): void;
  disconnect(): void;
}

export type SocketIOFactory = (uri: string, opts?: Record<string, unknown>) => MinimalSocket;

let cachedFactory: SocketIOFactory | null = null;
let loadAttempted = false;

export async function getSocketIO(): Promise<SocketIOFactory | null> {
  if (cachedFactory) return cachedFactory;
  if (loadAttempted) return null;
  loadAttempted = true;
  try {
    const mod = (await import('socket.io-client')) as {
      io?: SocketIOFactory;
      default?: SocketIOFactory;
    };
    cachedFactory = mod.io ?? mod.default ?? null;
    return cachedFactory;
  } catch (error) {
    logger.warn(
      '[SessionClient] socket.io-client import failed; realtime session sync disabled',
      { component: 'SessionClient' },
      error,
    );
    return null;
  }
}

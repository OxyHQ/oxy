/**
 * Waiting for auth.oxy.so to finish a link (ADR 0029 D3).
 *
 * Commons has signed the link proof; the person now confirms the code on
 * auth.oxy.so with their passkey. This polls the request until it completes,
 * is cancelled, or expires — the only three endings — and never outlives the
 * screen that started it (`signal`).
 */
import type { IdentityLinkState } from '@oxy.so/contracts';

export type LinkOutcome = 'completed' | 'cancelled' | 'expired';

export interface AwaitLinkDeps {
  getState: () => Promise<IdentityLinkState>;
  signal: AbortSignal;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function awaitLinkCompletion(deps: AwaitLinkDeps): Promise<LinkOutcome | 'aborted'> {
  const interval = deps.intervalMs ?? 2000;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let expiresAt = Number.POSITIVE_INFINITY;
  while (!deps.signal.aborted) {
    try {
      const state = await deps.getState();
      expiresAt = state.expiresAt;
      if (state.status === 'completed') return 'completed';
      if (state.status === 'cancelled') return 'cancelled';
    } catch {
      // A missed poll is retried; the deadline still ends the wait.
    }
    if (now() >= expiresAt) return 'expired';
    await sleep(interval);
  }
  return 'aborted';
}

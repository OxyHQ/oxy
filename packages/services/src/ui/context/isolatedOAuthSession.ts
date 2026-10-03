import type { OxyRuntime } from '../runtime';
import type { LogoutResult } from './oxyContextTypes';
import { isInvalidSessionError } from '../utils/errorHandlers';

interface IsolatedOAuthSession {
  readonly sessionId: string;
  readonly clientId: string;
}

// Provider-local, ephemeral provenance. Only the SDK OAuth commit sets it;
// missing device state is never treated as evidence of an isolated session.
const isolatedSessions = new WeakMap<OxyRuntime, IsolatedOAuthSession>();

export function setIsolatedOAuthSession(runtime: OxyRuntime, session: IsolatedOAuthSession): void {
  isolatedSessions.set(runtime, Object.freeze({ ...session }));
}

export function hasIsolatedOAuthSession(runtime: OxyRuntime): boolean {
  return isolatedSessions.has(runtime);
}

export function clearIsolatedOAuthSession(runtime: OxyRuntime): void {
  isolatedSessions.delete(runtime);
}

export function readIsolatedOAuthSession(runtime: OxyRuntime): IsolatedOAuthSession | null {
  const session = isolatedSessions.get(runtime);
  return session && session.sessionId === runtime.getSnapshot().activeSessionId ? session : null;
}

/** Exact self-revocation; never a fallback for an unknown device session. */
export async function logoutIsolatedOAuthSession(input: {
  session: IsolatedOAuthSession;
  targetSessionId?: string;
  revokeSelf: (sessionId: string) => Promise<void>;
  clearSessionState: () => Promise<void>;
}): Promise<LogoutResult> {
  if (input.targetSessionId && input.targetSessionId !== input.session.sessionId) {
    return { status: 'failed', error: new Error('An isolated OAuth session may sign out only itself') };
  }
  try {
    await input.revokeSelf(input.session.sessionId);
  } catch (error) {
    if (!isInvalidSessionError(error)) return { status: 'failed', error };
  }
  await input.clearSessionState();
  return { status: 'signed-out' };
}

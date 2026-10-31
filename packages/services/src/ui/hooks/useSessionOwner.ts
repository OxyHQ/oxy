import { useCallback, useInsertionEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OxyServices } from '@oxy.so/core';
import type { OxyRuntime } from '../runtime/createOxyRuntime';

/** How an action handles a bearer without a readable `userId` or `id` claim. */
export type SessionOwnerSubjectPolicy = 'require-match' | 'allow-unknown';

interface ProjectionOwner {
  oxy: OxyServices;
  runtime: OxyRuntime;
  accountId: string | null;
  subjectPolicy: SessionOwnerSubjectPolicy;
}

/**
 * Capture a render's authenticated session for later synchronous checks.
 *
 * Call the returned function immediately before every request or local effect,
 * and again after every await. It becomes false after logout, a replacement
 * session, a runtime subject transition, or unmount cleanup. Ordinary bearer
 * refresh within the same Core session remains valid. It retains no bearer.
 *
 * `require-match` requires the bearer subject to equal the projected account.
 * `allow-unknown` preserves compatibility with opaque and sub-only bearers, but
 * cannot prove which account owns such a token. A known mismatch always fails.
 * This is not authorization, does not cancel requests already sent, and cannot
 * observe app-local projection changes until this hook's insertion effect runs.
 * A child ref cleanup or another insertion effect may run first during the same
 * commit. Use the provider's runtime as the projection source and the returned
 * function from the render that created the work.
 * This helper covers authenticated operations, not guest ownership.
 */
export function useSessionOwner(
  oxy: OxyServices,
  runtime: OxyRuntime,
  accountId: string | null,
  subjectPolicy: SessionOwnerSubjectPolicy,
): () => boolean {
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribeSession = oxy.session.onChange(notify);
    const unsubscribeRuntime = runtime.subscribe(notify);
    return () => { unsubscribeSession(); unsubscribeRuntime(); };
  }, [oxy, runtime]);
  const snapshot = useCallback(
    () => JSON.stringify([
      oxy.http.getSessionEpoch(), !!oxy.session.accessToken, oxy.session.userId,
      runtime.getSubjectGeneration(), runtime.getSnapshot().account?.id ?? null,
    ]),
    [oxy, runtime],
  );
  const renderSession = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [owner, setOwner] = useState<ProjectionOwner>(() => ({ oxy, runtime, accountId, subjectPolicy }));
  if (owner.oxy !== oxy || owner.runtime !== runtime || owner.accountId !== accountId || owner.subjectPolicy !== subjectPolicy) {
    setOwner({ oxy, runtime, accountId, subjectPolicy });
  }
  const committedOwner = useRef<ProjectionOwner | null>(null);
  useInsertionEffect(() => {
    committedOwner.current = owner;
    return () => {
      if (committedOwner.current === owner) committedOwner.current = null;
    };
  }, [owner]);

  return () => {
    if (committedOwner.current !== owner || !accountId || snapshot() !== renderSession) return false;
    if (!runtime.ownsClient(oxy) || !oxy.session.accessToken || runtime.getSnapshot().account?.id !== accountId) return false;
    const subject = oxy.session.userId;
    return subject === accountId || (subject === null && subjectPolicy === 'allow-unknown');
  };
}

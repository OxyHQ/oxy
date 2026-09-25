import React, { useCallback } from 'react';
import { Icons } from '@/constants/icons';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { LoadingState, STATE_MIN_HEIGHT } from './loading-state';
import { Redirect } from 'expo-router';
import { useOxy, useOnlineStatus } from '@oxy.so/services';
import { logger } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';
import { useOnboardingStatus } from '@/hooks/useOnboardingStatus';
import { useSyncIdentity } from '@/hooks/identity/useSyncIdentity';

interface SessionGateProps {
  /** The session-dependent content, rendered only once a live session is up. */
  children: React.ReactNode;
}

/**
 * Gate for vault screens whose data hangs off the current SESSION.
 *
 * Every civic/identity data screen keys its React Query calls on the signed-in
 * user's id (`user?.id ?? getCurrentUserId()`). With no session that id is
 * `null`, so those queries stay permanently `enabled: false` — which React Query
 * reports as `isPending: true` forever, i.e. an infinite spinner. Commons
 * legitimately reaches the vault without a live session: the local-first router
 * lands a returning user here the moment a healthy local identity is present,
 * without waiting on the network.
 *
 * Commons IS the identity — it NEVER asks its owner to "sign in", and it cannot
 * be signed in as anyone else: the provider runs `sessionMode="identity"`, so
 * the SDK pins the session to the owner of this device's primary key and owns
 * every automatic path to it (the `identity-key-signin` cold-boot step, the
 * pinned re-mint, the 401 recovery arm, the offline→online reconnect heal).
 * This gate renders the matching state around that:
 *   - cold boot still resolving (`!isAuthResolved`) → a bounded neutral spinner;
 *   - live session → the children (their `isPending` is now a real fetch);
 *   - no local identity at all (impossible past the root onboarding gate) → route
 *     to onboarding, never a sign-in prompt;
 *   - no session, offline → a calm "offline, will reconnect" notice (no button —
 *     the SDK re-mints on the reconnect edge);
 *   - no session, a manual reconnect in flight → "Connecting your identity…";
 *   - no session, online, boot concluded without one → a "couldn't connect" state
 *     whose Retry re-runs the vault's identity sync (register-if-needed + key
 *     sign-in) for the device's own key.
 */
export function SessionGate({ children }: SessionGateProps) {
  const { isAuthResolved, user } = useOxy();
  const online = useOnlineStatus();
  const { identityPresent, status } = useOnboardingStatus();
  const { syncIdentity, identitySyncState } = useSyncIdentity();
  const { t } = useTranslation();

  // The one manual path back to a session. `syncIdentity` is single-flight
  // (global sync lock) and publishes `isSyncing`, so the in-flight state below
  // is derived rather than tracked locally. Its own failure funnel already
  // surfaces a message to the user; the breadcrumb here keeps a manual retry
  // failure greppable without swallowing the rejection.
  const handleRetry = useCallback(() => {
    syncIdentity().catch((error: unknown) => {
      logger.warn('[commons] manual identity reconnect failed', {
        component: 'SessionGate',
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }, [syncIdentity]);

  // A live session is up → the private content.
  if (isAuthResolved && user) {
    return <>{children}</>;
  }

  // Still connecting: the cold boot is resolving, the onboarding probe has not
  // answered yet (never redirect on that transient window), or a manual
  // reconnect is in flight while online.
  const connecting =
    !isAuthResolved ||
    (identityPresent ? online && identitySyncState.isSyncing : status === 'checking');
  if (connecting) {
    return <LoadingState description={t('civic.sessionGate.connecting')} />;
  }

  // No session. Defensive: if the local identity is somehow absent (impossible
  // past the root onboarding gate), route to onboarding rather than spin — never
  // a sign-in prompt.
  if (!identityPresent) {
    return <Redirect href="/(auth)" />;
  }

  // Offline: no lane can mint. Say so calmly — the SDK re-mints by itself on the
  // offline→online edge, so there is no action to offer.
  if (!online) {
    return (
      <EmptyState
        icon={Icons.offline}
        title={t('civic.sessionGate.offline.title')}
        description={t('civic.sessionGate.offline.body')}
        minHeight={STATE_MIN_HEIGHT}
      />
    );
  }

  // Online, the cold boot concluded, and it did NOT produce a session — that is
  // a definitive verdict, not a pending one, so say it and offer the retry.
  return (
    <EmptyState
      icon={Icons.offline}
      title={t('civic.sessionGate.error.title')}
      description={t('civic.sessionGate.error.body')}
      action={{ label: t('common.retry'), onPress: handleRetry }}
      minHeight={STATE_MIN_HEIGHT}
    />
  );
}

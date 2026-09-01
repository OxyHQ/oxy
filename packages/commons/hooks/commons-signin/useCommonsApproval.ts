import { useCallback, useEffect, useRef, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import {
  getCommonsApprovalBlockingReason,
  logger,
  type CommonsApprovalInfo,
} from '@oxyhq/core';
import type { CommonsDenyReason } from '@oxyhq/contracts';
import {
  requestLocalConfirmation,
  type LocalConfirmationUnavailableReason,
} from '@/lib/biometricAuth';

/**
 * Lifecycle of a "Sign in with Oxy" approval on the Commons (approver) side.
 *
 *   loading    → resolving the request identity via the API
 *   ready      → server-resolved identity available; awaiting the user's choice
 *   confirming → the device's own biometric/passcode prompt is up
 *   approving  → confirmation passed; calling `approveCommonsSignIn`
 *   approved   → the RP can now claim its session
 *   denying    → calling `denyCommonsSignIn` with the reason the user gave
 *   denied     → the request was cancelled, and why is recorded
 *   error      → invalid / used / expired code, or a network failure
 *
 * `confirming` is a real state rather than an internal flag: the single primary
 * action opens the device prompt directly, so the UI has to be able to show that
 * the request is mid-confirmation without inventing a second screen.
 */
export type ApprovalState =
  | 'loading'
  | 'ready'
  | 'confirming'
  | 'approving'
  | 'approved'
  | 'denying'
  | 'denied'
  | 'error';

/**
 * Why the local confirmation did not happen. Kept as a discriminated union so
 * the screen can say something true and specific — "this device can't ask you",
 * "you dismissed it", "the sensor is locked out" — instead of one vague
 * "verification failed" line that leaves the user with nothing to do.
 */
export type ApprovalConfirmationIssue =
  /** The device cannot ask at all; nothing was prompted. */
  | { kind: 'unavailable'; reason: LocalConfirmationUnavailableReason }
  /** The prompt appeared and the user dismissed it. */
  | { kind: 'declined' }
  /** Too many failed attempts — the device locked the sensor out. */
  | { kind: 'lockout' }
  /** The prompt appeared and the attempt was rejected. */
  | { kind: 'failed' };

export interface UseCommonsApproval {
  state: ApprovalState;
  /** Server-resolved (TRUSTED) requesting-app identity; null until `ready`. */
  info: CommonsApprovalInfo | null;
  /**
   * Why the local biometric/passcode confirmation did not complete, or `null`
   * when there is nothing to explain. Never a reason to proceed: the approval
   * call only ever runs after a `confirmed` outcome.
   */
  confirmationIssue: ApprovalConfirmationIssue | null;
  /** Optional server/network error message for the `error` state. */
  errorMessage: string | null;
  /**
   * The reason the request was denied with, once it has been. `null` until a
   * denial completes, so the terminal state can tell the user what was actually
   * recorded instead of describing a denial that hasn't happened.
   */
  denialReason: CommonsDenyReason | null;
  /** The single primary action: confirm locally, then sign + approve. */
  approve: () => Promise<void>;
  /**
   * Deny the request, recording WHY. Defaults to the ordinary `'declined'`:
   * `'not_me'` marks the denial as suspicious, so it is opt-in and belongs only
   * to a user who explicitly said they did not start the request.
   */
  deny: (reason?: CommonsDenyReason) => Promise<void>;
  /** Re-fetch the request identity (used by the "try again" affordance). */
  reload: () => void;
}

/**
 * Drives the Commons approval screen.
 *
 * SECURITY: the requesting-app identity shown to the user comes ONLY from
 * `getCommonsApprovalInfo(code)` (resolved server-side from the authorize
 * code) — never from the scanned QR string. Approval is gated behind the
 * device biometric/passcode before the signed authorize call is made, so a
 * stolen unlocked-but-unattended phone still can't approve.
 *
 * The gate is `requestLocalConfirmation`, which resolves device capability
 * BEFORE prompting and returns a discriminated outcome. A device that cannot ask
 * (no sensor, nothing enrolled) is reported as such and the request is left
 * pending — it is never treated as an implicit confirmation. There is exactly
 * ONE user action: `approve()` opens the device prompt itself; there is no
 * intermediate confirm step to pass through first.
 *
 * The one-shot identity fetch uses a `useEffect` keyed on the code + SDK
 * readiness — a legitimate imperative data load tied to a route param (the
 * same pattern used by the vault's public-key load), not derived state.
 *
 * @param code - The public authorize code (from the QR / deep-link).
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useCommonsApproval(
  code: string | undefined,
  biometricReason: string,
): UseCommonsApproval {
  const { oxyServices } = useOxy();
  const [state, setState] = useState<ApprovalState>('loading');
  const [info, setInfo] = useState<CommonsApprovalInfo | null>(null);
  const [confirmationIssue, setConfirmationIssue] = useState<ApprovalConfirmationIssue | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState<CommonsDenyReason | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Single-flight latch for the primary action. The device prompt is modal, but
  // a queued double-tap can still deliver a second press before the first render
  // disables the button, and approval is single-use.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!code) {
      setState('error');
      setErrorMessage(null);
      return;
    }
    // Wait until the SDK client is available before fetching.
    if (!oxyServices) return;

    let cancelled = false;
    setState('loading');
    setErrorMessage(null);

    // Progress-only signal so the waiting relying party can show "Opened in
    // Commons" the moment the user actually lands here (issue #691, Phase 4).
    // It never approves and never advances the authorization state machine, so
    // it is fired alongside — never before or instead of — the identity fetch,
    // is never awaited, and a rejection is logged and otherwise ignored: a
    // missed progress line must never cost the user their approval.
    void oxyServices.markCommonsApprovalOpened(code).catch((error: unknown) => {
      logger.warn(
        '[commons] could not report the approval screen as opened',
        { component: 'useCommonsApproval' },
        error,
      );
    });

    oxyServices
      .getCommonsApprovalInfo(code)
      .then((result) => {
        if (cancelled) return;
        const blockingReason = getCommonsApprovalBlockingReason(result);
        if (blockingReason) {
          setInfo(null);
          setErrorMessage(blockingReason);
          setState('error');
          return;
        }
        setInfo(result);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : null);
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [code, oxyServices, reloadKey]);

  const approve = useCallback(async () => {
    if (!code || !oxyServices) return;
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      // Local confirmation gate — must pass BEFORE we sign the authorize
      // request. Anything other than `confirmed` leaves the request untouched
      // and pending, with a specific explanation for the user.
      setConfirmationIssue(null);
      setState('confirming');
      const confirmation = await requestLocalConfirmation(biometricReason);
      if (confirmation.outcome !== 'confirmed') {
        setConfirmationIssue(
          confirmation.outcome === 'unavailable'
            ? { kind: 'unavailable', reason: confirmation.reason }
            : { kind: confirmation.outcome },
        );
        setState('ready');
        return;
      }

      setState('approving');
      try {
        await oxyServices.approveCommonsSignIn({ authorizeCode: code });
        setState('approved');
      } catch (error: unknown) {
        setErrorMessage(error instanceof Error ? error.message : null);
        setState('error');
      }
    } finally {
      inFlight.current = false;
    }
  }, [code, oxyServices, biometricReason]);

  const deny = useCallback(
    async (reason: CommonsDenyReason = 'declined') => {
      if (!code || !oxyServices) return;
      if (inFlight.current) return;
      inFlight.current = true;

      setState('denying');
      try {
        await oxyServices.denyCommonsSignIn(code, reason);
        setDenialReason(reason);
        setState('denied');
      } catch (error: unknown) {
        setErrorMessage(error instanceof Error ? error.message : null);
        setState('error');
      } finally {
        inFlight.current = false;
      }
    },
    [code, oxyServices],
  );

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return { state, info, confirmationIssue, errorMessage, denialReason, approve, deny, reload };
}

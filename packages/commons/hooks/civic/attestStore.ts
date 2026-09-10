import { create } from 'zustand';
import type { OxyServices } from '@oxy.so/core';
import type { RealLifeAttestationResult } from '@oxy.so/contracts';
import { userIdFromDid } from '@/lib/civic/did';
import { attestErrorCode, type AttestErrorCode } from '@/lib/civic/civic-errors';

/**
 * Zustand store for the real-life attestation FLOW on the SCANNER's (B's) side.
 *
 * Two lanes share this store:
 *   - Reviewed (`prepare` → biometric → `confirm`): the in-app scanner and the
 *     deep-link screen hold the payload until B reviews A's card and passes
 *     the device gate.
 *   - Auto (`submit`): legacy one-shot path kept for tests; production entry
 *     points use the reviewed lane.
 *
 * The server upserts idempotently, so re-confirming the same person is fine and
 * there is deliberately NO client-side cooldown or dedupe here.
 *
 * This store owns ONLY the flow state (what B just did); the subject's card
 * (name/avatar) is server state and stays in TanStack Query (`useCivicCard`,
 * keyed off `subjectUserId`). `result` is the response of this flow's own
 * one-shot submit — the analogue of a mutation result, not mirrored reads.
 */

/**
 *   idle       → no attestation in flight (nothing scanned yet / after reset)
 *   reviewing  → payload parsed + subject resolving; B reviews A's card before
 *                signing (the confirm-before-submit lane on the scanner
 *                screen). Nothing is signed until `confirm`.
 *   submitting → signing + submitting (either the auto lane's `submit` or the
 *                reviewed lane's `confirm`)
 *   done       → accepted (points awarded to A)
 *   error      → rejected / failed (see `errorCode`)
 */
export type AttestFlowStatus = 'idle' | 'reviewing' | 'submitting' | 'done' | 'error';

/** The fields the scanner (B) carries over from a parsed attest payload. */
export interface AttestSubmitParams {
  subjectDid: string;
  context: string;
  nonce: string;
  exp: number;
}

/** The single SDK capability the submit needs (narrow keeps tests honest). */
type AttestSubmitServices = Pick<OxyServices, 'submitRealLifeAttestation'>;

export interface AttestFlowState {
  status: AttestFlowStatus;
  /** A's DID as carried by the payload of the CURRENT attestation. */
  subjectDid: string | null;
  /** A's account id (derived from the DID) — the `useCivicCard` key. */
  subjectUserId: string | null;
  /** The accepted result (points awarded) for the `done` status. */
  result: RealLifeAttestationResult | null;
  /** Classified rejection code for the `error` status (drives friendly copy). */
  errorCode: AttestErrorCode | null;
  /**
   * The parsed payload held between `prepare` and `confirm` on the reviewed
   * lane. Non-null only while `status === 'reviewing'`; cleared on confirm/reset.
   */
  pendingParams: AttestSubmitParams | null;
}

export interface AttestFlowStore extends AttestFlowState {
  /**
   * Sign + submit the attestation for a freshly parsed payload. One shot: the
   * payload carries a signed single-use nonce, so a failed submit is NEVER
   * auto-retried (re-driving the request could only burn the nonce) — the user
   * scans a fresh payload instead. Enters `submitting` synchronously.
   */
  submit: (params: AttestSubmitParams, oxyServices: AttestSubmitServices) => Promise<void>;
  /**
   * Reviewed lane, step 1: hold a freshly parsed payload and resolve A's card
   * (via `subjectUserId`) WITHOUT signing, so B can review before committing.
   * Enters `reviewing` synchronously (or `error` if the DID can't resolve).
   */
  prepare: (params: AttestSubmitParams) => void;
  /**
   * Reviewed lane, step 2: sign + submit the held payload after B confirms
   * (with `biometricOk` reflecting a passed device gate). No-op unless a
   * payload is currently held (`status === 'reviewing'`). Same one-shot,
   * never-auto-retried semantics as {@link AttestFlowStore.submit}.
   */
  confirm: (oxyServices: AttestSubmitServices, biometricOk: boolean) => Promise<void>;
  /** Return to `idle` and abandon any in-flight submission's outcome. */
  reset: () => void;
}

const defaultState: AttestFlowState = {
  status: 'idle',
  subjectDid: null,
  subjectUserId: null,
  result: null,
  errorCode: null,
  pendingParams: null,
};

export const useAttestStore = create<AttestFlowStore>((set, get) => {
  // Monotonic id of the CURRENT submission. A completion (success or failure)
  // applies only while it is still current, so a newer payload or a reset is
  // never clobbered by a stale in-flight response — each payload's flow is
  // independent.
  let submission = 0;

  // Sign + submit a payload, transitioning submitting → done/error. Shared by
  // the auto lane (`submit`) and the reviewed lane (`confirm`); `biometricOk`
  // records whether a device gate was passed for this attestation.
  const runSubmit = async (
    params: AttestSubmitParams,
    oxyServices: AttestSubmitServices,
    biometricOk: boolean,
  ) => {
    const current = ++submission;
    try {
      const result = await oxyServices.submitRealLifeAttestation({
        subjectDid: params.subjectDid,
        context: params.context,
        nonce: params.nonce,
        exp: params.exp,
        biometricOk,
      });
      if (current !== submission) return;
      set({ status: 'done', result, errorCode: null, pendingParams: null });
    } catch (error) {
      if (current !== submission) return;
      set({ status: 'error', result: null, errorCode: attestErrorCode(error), pendingParams: null });
    }
  };

  return {
    ...defaultState,

    submit: async (params, oxyServices) => {
      const subjectUserId = userIdFromDid(params.subjectDid);
      if (!subjectUserId) {
        // The DID in the payload cannot resolve to an account — surface the
        // same friendly copy an unknown subject gets, without burning a request.
        submission++;
        set({
          status: 'error',
          subjectDid: params.subjectDid,
          subjectUserId: null,
          result: null,
          errorCode: 'subject_not_found',
          pendingParams: null,
        });
        return;
      }

      set({
        status: 'submitting',
        subjectDid: params.subjectDid,
        subjectUserId,
        result: null,
        errorCode: null,
        pendingParams: null,
      });

      await runSubmit(params, oxyServices, false);
    },

    prepare: (params) => {
      const subjectUserId = userIdFromDid(params.subjectDid);
      if (!subjectUserId) {
        submission++;
        set({
          status: 'error',
          subjectDid: params.subjectDid,
          subjectUserId: null,
          result: null,
          errorCode: 'subject_not_found',
          pendingParams: null,
        });
        return;
      }

      // Bump the counter so any in-flight submit from a prior payload can't land
      // its result over this freshly-held review.
      submission++;
      set({
        status: 'reviewing',
        subjectDid: params.subjectDid,
        subjectUserId,
        result: null,
        errorCode: null,
        pendingParams: params,
      });
    },

    confirm: async (oxyServices, biometricOk) => {
      const { status, pendingParams } = get();
      if (status !== 'reviewing' || !pendingParams) return;

      set({ status: 'submitting', result: null, errorCode: null });
      await runSubmit(pendingParams, oxyServices, biometricOk);
    },

    reset: () => {
      submission++;
      set(defaultState);
    },
  };
});

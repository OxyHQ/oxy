import { useCallback } from 'react';
import { useOxy } from '@oxy.so/services';
import type { CivicCardResult } from '@oxy.so/core';
import type { RealLifeAttestationResult } from '@oxy.so/contracts';
import type { AttestErrorCode } from '@/lib/civic/civic-errors';
import { useCivicCard } from '@/hooks/useCivicCard';
import { useAttestStore, type AttestFlowStatus, type AttestSubmitParams } from './attestStore';

/** What a screen needs to drive + render the automatic attest flow. */
export interface AttestFlowView {
  status: AttestFlowStatus;
  /** A's DID for the current flow (lets a deep-link screen match its subject). */
  subjectDid: string | null;
  /** A's resolved public card (name/avatar) — TanStack-owned, never mirrored. */
  subject: CivicCardResult | null;
  /** True when the card lookup itself failed (subject can't be resolved). */
  subjectFailed: boolean;
  result: RealLifeAttestationResult | null;
  errorCode: AttestErrorCode | null;
  /** Fire the automatic sign + submit for a freshly parsed payload (an event
   *  handler's call — never a mount side-effect). */
  submit: (params: AttestSubmitParams) => void;
  /** Reviewed lane: hold a parsed payload for review (no signing yet). */
  prepare: (params: AttestSubmitParams) => void;
  /** Reviewed lane: sign + submit the held payload after B confirms. */
  confirm: (biometricOk: boolean) => void;
  reset: () => void;
}

/**
 * Read the attest flow (Zustand) together with the subject's card (TanStack
 * Query) and bind the store's `submit` to the SDK from context.
 *
 * @param subjectUserIdOverride - Pin the card to a route-derived subject (the
 *   cold deep-link screen passes its own parsed id, or `null` when unparseable);
 *   omit to follow the store's current attestation (the scanner).
 */
export function useAttestFlow(subjectUserIdOverride?: string | null): AttestFlowView {
  const { oxyServices } = useOxy();
  const status = useAttestStore((s) => s.status);
  const subjectDid = useAttestStore((s) => s.subjectDid);
  const subjectUserId = useAttestStore((s) => s.subjectUserId);
  const result = useAttestStore((s) => s.result);
  const errorCode = useAttestStore((s) => s.errorCode);
  const submitToStore = useAttestStore((s) => s.submit);
  const prepareInStore = useAttestStore((s) => s.prepare);
  const confirmInStore = useAttestStore((s) => s.confirm);
  const reset = useAttestStore((s) => s.reset);

  const card = useCivicCard(subjectUserIdOverride === undefined ? subjectUserId : subjectUserIdOverride);

  const submit = useCallback(
    (params: AttestSubmitParams) => {
      void submitToStore(params, oxyServices);
    },
    [submitToStore, oxyServices],
  );

  const confirm = useCallback(
    (biometricOk: boolean) => {
      void confirmInStore(oxyServices, biometricOk);
    },
    [confirmInStore, oxyServices],
  );

  return {
    status,
    subjectDid,
    subject: card.data ?? null,
    subjectFailed: card.isError,
    result,
    errorCode,
    submit,
    prepare: prepareInStore,
    confirm,
    reset,
  };
}

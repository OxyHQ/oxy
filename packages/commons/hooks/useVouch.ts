import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { VouchResult } from '@oxy.so/contracts';
import { vouchErrorCode, type VouchErrorCode } from '@/lib/civic/civic-errors';
import { authenticate } from '@/lib/biometricAuth';
import { personhoodQueryKey } from './usePersonhood';

/**
 *   idle        → awaiting the voucher's action
 *   vouching    → biometric passed; signing + submitting the vouch
 *   withdrawing → withdrawing an existing vouch (no biometric, no signed record)
 *   done        → vouch accepted (points awarded to the subject)
 *   withdrawn   → vouch withdrawn
 *   error       → submit / withdraw failed (see `errorCode`)
 */
export type VouchState =
  | 'idle'
  | 'vouching'
  | 'withdrawing'
  | 'done'
  | 'withdrawn'
  | 'error';

export interface UseVouch {
  state: VouchState;
  /** Set when the device biometric/passcode gate was not satisfied. */
  biometricFailed: boolean;
  /** Classified rejection code for the `error` state (drives friendly copy). */
  errorCode: VouchErrorCode | null;
  /** The accepted vouch result (clamped stake + points) for the `done` state. */
  result: VouchResult | null;
  /** Run the biometric gate, then sign + submit the vouch for the subject. */
  vouch: (stakeAmount?: number) => Promise<void>;
  /** Withdraw the current user's active vouch for the subject (no biometric). */
  withdraw: () => Promise<void>;
}

/**
 * Drives the "vouch for this person" confirm screen.
 *
 * Vouching is an ATTESTATION: it signs a self-issued `personhood_vouch` record
 * on the voucher's own chain, so it is gated behind the device biometric before
 * `vouchForPerson` signs. The server is authoritative — it enforces voucher
 * eligibility (personhood ≥ τ), self-vouch and sock-puppet/graph exclusions, and
 * stakes the voucher (a false vouch can later be slashed); those rejections
 * surface as a classified `errorCode` for friendly copy. Withdrawal is NOT an
 * attestation (no signed record), so it needs no biometric. Either success
 * invalidates the subject's personhood query so the badge/score refreshes.
 *
 * NATIVE-ONLY (the vouch signs with the on-device key).
 *
 * @param subjectDid - The subject's DID (`did:web:oxy.so:u:<userId>`); the vouch
 *   record's `about`. `null` disables the actions (unparseable target).
 * @param subjectUserId - The subject account's Mongo `_id`, used to key the
 *   withdraw call and the personhood-cache invalidation.
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useVouch(
  subjectDid: string | null,
  subjectUserId: string | null,
  biometricReason: string,
): UseVouch {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const [state, setState] = useState<VouchState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<VouchErrorCode | null>(null);
  const [result, setResult] = useState<VouchResult | null>(null);

  const invalidatePersonhood = useCallback(
    () => queryClient.invalidateQueries({ queryKey: personhoodQueryKey(subjectUserId) }),
    [queryClient, subjectUserId],
  );

  const vouch = useCallback(
    async (stakeAmount?: number) => {
      if (!oxyServices || !subjectDid) return;

      // Biometric/passcode gate — must pass BEFORE we sign the vouch.
      setBiometricFailed(false);
      const auth = await authenticate(biometricReason);
      if (!auth.success) {
        setBiometricFailed(true);
        return;
      }

      setState('vouching');
      try {
        const res = await oxyServices.vouchForPerson({
          subjectDid,
          stakeAmount,
          biometricOk: true,
        });
        setResult(res);
        setState('done');
        void invalidatePersonhood();
      } catch (error: unknown) {
        setErrorCode(vouchErrorCode(error));
        setState('error');
      }
    },
    [oxyServices, subjectDid, biometricReason, invalidatePersonhood],
  );

  const withdraw = useCallback(async () => {
    if (!oxyServices || !subjectUserId) return;
    setState('withdrawing');
    try {
      await oxyServices.withdrawVouch(subjectUserId);
      setState('withdrawn');
      void invalidatePersonhood();
    } catch (error: unknown) {
      setErrorCode(vouchErrorCode(error));
      setState('error');
    }
  }, [oxyServices, subjectUserId, invalidatePersonhood]);

  return { state, biometricFailed, errorCode, result, vouch, withdraw };
}

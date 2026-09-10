import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { ValidationVerdict } from '@oxy.so/contracts';
import { voteErrorCode, type VoteErrorCode } from '@/lib/civic/civic-errors';
import { authenticate } from '@/lib/biometricAuth';
import { VALIDATOR_INBOX_KEY } from './useValidatorInbox';

/**
 *   idle    → awaiting the juror's action
 *   voting  → biometric passed; signing + submitting a verdict
 *   denying → recusing (no biometric, no signed record)
 *   done    → verdict recorded / recused (inbox invalidated)
 *   error   → submit failed (see `errorCode`)
 */
export type ValidationVoteState = 'idle' | 'voting' | 'denying' | 'done' | 'error';

export interface UseValidationVote {
  state: ValidationVoteState;
  biometricFailed: boolean;
  errorCode: VoteErrorCode | null;
  /** Cast a SIGNED verdict (`valid`/`invalid`/`abstain`) — gated on biometric. */
  vote: (verdict: ValidationVerdict) => Promise<void>;
  /** Recuse from the jury (no biometric, no signed record). */
  deny: () => Promise<void>;
}

/**
 * Drives the juror vote screen. Any signed verdict (`valid`/`invalid`/`abstain`)
 * is gated behind the device biometric before `submitValidationVote` signs a
 * `validation_verdict` record bound to the request id + payload hash. Recusal
 * (`deny`) needs no biometric (it is not an attestation). Server rejections
 * (`request_closed` / `already_voted` / `not_selected`) surface as a classified
 * `errorCode`; on success the juror inbox query is invalidated so the request
 * drops off the list.
 *
 * NATIVE-ONLY (the vote signs with the on-device key).
 *
 * @param requestId - The validation request being voted on.
 * @param payloadHash - The request's canonical payload hash (from the inbox).
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useValidationVote(
  requestId: string | null,
  payloadHash: string | null,
  biometricReason: string,
): UseValidationVote {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ValidationVoteState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<VoteErrorCode | null>(null);

  const invalidateInbox = useCallback(
    () => queryClient.invalidateQueries({ queryKey: VALIDATOR_INBOX_KEY }),
    [queryClient],
  );

  const vote = useCallback(
    async (verdict: ValidationVerdict) => {
      if (!oxyServices || !requestId || !payloadHash) return;

      setBiometricFailed(false);
      const auth = await authenticate(biometricReason);
      if (!auth.success) {
        setBiometricFailed(true);
        return;
      }

      setState('voting');
      try {
        await oxyServices.submitValidationVote(requestId, payloadHash, verdict);
        setState('done');
        void invalidateInbox();
      } catch (error: unknown) {
        setErrorCode(voteErrorCode(error));
        setState('error');
      }
    },
    [oxyServices, requestId, payloadHash, biometricReason, invalidateInbox],
  );

  const deny = useCallback(async () => {
    if (!oxyServices || !requestId) return;
    setState('denying');
    try {
      await oxyServices.denyValidation(requestId);
      setState('done');
      void invalidateInbox();
    } catch (error: unknown) {
      setErrorCode(voteErrorCode(error));
      setState('error');
    }
  }, [oxyServices, requestId, invalidateInbox]);

  return { state, biometricFailed, errorCode, vote, deny };
}

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { RevokeCredentialResult } from '@oxy.so/core';
import type { VerifiableCredentialResponse } from '@oxy.so/contracts';
import {
  credentialRevokeErrorCode,
  type CredentialRevokeErrorCode,
} from '@/lib/civic/civic-errors';
import { authenticate } from '@/lib/biometricAuth';

/**
 *   idle     → awaiting the issuer's action
 *   revoking → biometric passed; submitting the revoke
 *   done     → credential revoked
 *   error    → revoke failed (see `errorCode`)
 */
export type RevokeState = 'idle' | 'revoking' | 'done' | 'error';

export interface UseRevokeCredential {
  state: RevokeState;
  /** Set when the device biometric/passcode gate was not satisfied. */
  biometricFailed: boolean;
  /** Classified rejection code for the `error` state (drives friendly copy). */
  errorCode: CredentialRevokeErrorCode | null;
  /** The revoke result (carries the now-`revoked` credential) for the `done` state. */
  result: RevokeCredentialResult | null;
  /** Run the biometric gate, then revoke the supplied credential. */
  revoke: (credential: VerifiableCredentialResponse) => Promise<void>;
}

/**
 * Drives the "revoke credential" action on the credential detail screen (Fase 4).
 *
 * Only the ORIGINAL user issuer may revoke (the server enforces this; the detail
 * screen additionally only OFFERS the action when `issuerUserId` is the current
 * user). Revoking is a destructive write attributed to the issuer's key, so it
 * is gated behind the device biometric before `revokeCredential` runs. The
 * append-only signed record is untouched — only the projection flips to
 * `revoked`. On success the holder's credential list and the credential's verify
 * cache are invalidated so the change is reflected everywhere.
 *
 * NATIVE-ONLY (the issuer revokes a record they signed on-device).
 *
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useRevokeCredential(biometricReason: string): UseRevokeCredential {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const [state, setState] = useState<RevokeState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<CredentialRevokeErrorCode | null>(null);
  const [result, setResult] = useState<RevokeCredentialResult | null>(null);

  const revoke = useCallback(
    async (credential: VerifiableCredentialResponse) => {
      if (!oxyServices) return;

      // Biometric/passcode gate — must pass BEFORE we revoke.
      setBiometricFailed(false);
      const auth = await authenticate(biometricReason);
      if (!auth.success) {
        setBiometricFailed(true);
        return;
      }

      setState('revoking');
      try {
        const res = await oxyServices.revokeCredential(credential.id);
        setResult(res);
        setState('done');
        void queryClient.invalidateQueries({
          queryKey: ['civic', 'credentials', credential.holderUserId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['civic', 'credential-verify', credential.recordId],
        });
      } catch (error: unknown) {
        setErrorCode(credentialRevokeErrorCode(error));
        setState('error');
      }
    },
    [oxyServices, biometricReason, queryClient],
  );

  return { state, biometricFailed, errorCode, result, revoke };
}

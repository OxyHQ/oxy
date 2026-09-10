/**
 * Drives the on-demand "Verify" action on the credential detail screen (Fase 4).
 *
 * `oxyServices.verifyCredential(recordId)` re-checks the credential's signature
 * against a CURRENT verification method of the issuer DID (server-side, from the
 * stored envelope) and confirms it is neither revoked nor expired, resolving to
 * `{ valid, reason?, credential }`. It does NOT throw on an untrusted credential
 * — only a transport failure rejects — so this hook surfaces three outcomes:
 *   - `valid`   → the signature checks out and the credential is live;
 *   - `invalid` → it verified to `false` (reason classified for friendly copy);
 *   - `error`   → the verify request itself failed (offline / transport).
 *
 * Verification is a read, so there is no biometric gate (unlike issue / revoke).
 */

import { useCallback, useState } from 'react';
import { useOxy } from '@oxy.so/services';
import type { CredentialVerifyResult } from '@oxy.so/contracts';
import {
  credentialVerifyReason,
  type CredentialVerifyReasonCode,
} from '@/lib/civic/civic-errors';

/**
 *   idle      → not yet verified
 *   verifying → the verify request is in flight
 *   valid     → verified true (signature current + not revoked/expired)
 *   invalid   → verified false (see `reasonCode`)
 *   error     → the verify request itself failed (transport / offline)
 */
export type VerifyState = 'idle' | 'verifying' | 'valid' | 'invalid' | 'error';

export interface UseVerifyCredential {
  state: VerifyState;
  /** The full verify result (carries the freshest `credential` + status). */
  result: CredentialVerifyResult | null;
  /** Classified rejection reason for the `invalid` state (drives friendly copy). */
  reasonCode: CredentialVerifyReasonCode | null;
  /** Run the verification for the bound record id. */
  verify: () => Promise<void>;
}

/**
 * @param recordId - The credential's signed-record id, or `null` (the action
 *   no-ops) when the detail target is unresolved.
 */
export function useVerifyCredential(recordId: string | null): UseVerifyCredential {
  const { oxyServices } = useOxy();
  const [state, setState] = useState<VerifyState>('idle');
  const [result, setResult] = useState<CredentialVerifyResult | null>(null);
  const [reasonCode, setReasonCode] = useState<CredentialVerifyReasonCode | null>(null);

  const verify = useCallback(async () => {
    if (!oxyServices || !recordId) return;
    setState('verifying');
    setReasonCode(null);
    try {
      const res = await oxyServices.verifyCredential(recordId);
      setResult(res);
      if (res.valid) {
        setState('valid');
      } else {
        setReasonCode(credentialVerifyReason(res.reason));
        setState('invalid');
      }
    } catch {
      // Only a transport failure rejects — an untrusted credential resolves to
      // `valid: false` above, so reaching here means we couldn't reach Oxy.
      setState('error');
    }
  }, [oxyServices, recordId]);

  return { state, result, reasonCode, verify };
}

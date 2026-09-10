import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { CredentialIssueResult } from '@oxy.so/contracts';
import {
  credentialIssueErrorCode,
  type CredentialIssueErrorCode,
} from '@/lib/civic/civic-errors';
import { authenticate } from '@/lib/biometricAuth';
import { userIdFromDid } from '@/lib/civic/did';

/**
 *   idle    → awaiting the issuer's action
 *   issuing → biometric passed; signing + submitting the credential
 *   done    → credential issued + stored
 *   error   → submit failed (see `errorCode`)
 */
export type IssueState = 'idle' | 'issuing' | 'done' | 'error';

/** The parts of a credential the issue form collects (the holder DID is bound). */
export interface IssueCredentialParams {
  /** The specific VC type tags; the base `'VerifiableCredential'` is added by the SDK. */
  types: string[];
  /** The issuer-asserted claim set about the holder (signed verbatim). */
  claims: Record<string, unknown>;
  /** Optional ISO-8601 expiry; absent = non-expiring. */
  expiresAt?: string;
}

export interface UseIssueCredential {
  state: IssueState;
  /** Set when the device biometric/passcode gate was not satisfied. */
  biometricFailed: boolean;
  /** Classified rejection code for the `error` state (drives friendly copy). */
  errorCode: CredentialIssueErrorCode | null;
  /** The issued credential for the `done` state. */
  result: CredentialIssueResult | null;
  /** Run the biometric gate, then sign + submit the credential. */
  issue: (params: IssueCredentialParams) => Promise<void>;
}

/**
 * Drives the "issue a credential" form (Fase 4).
 *
 * Issuing a credential is an ATTESTATION: it signs a self-issued `credential`
 * record on the issuer's own chain, attributed to the issuer's key and publicly
 * verifiable. It is therefore gated behind the device biometric before
 * `issueCredential` signs. The server is authoritative — it enforces holder
 * existence, the self-credential exclusion, the base-type/holder/expiry shape,
 * and chain ordering; those rejections surface as a classified `errorCode` for
 * friendly copy. On success the holder's credential list is invalidated so a
 * re-read reflects the new credential.
 *
 * NATIVE-ONLY (the credential signs with the on-device key).
 *
 * @param holderDid - The holder's DID (`did:web:oxy.so:u:<userId>`) — the
 *   credential's `about`. `null` disables the action (unparseable target).
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useIssueCredential(
  holderDid: string | null,
  biometricReason: string,
): UseIssueCredential {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const [state, setState] = useState<IssueState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<CredentialIssueErrorCode | null>(null);
  const [result, setResult] = useState<CredentialIssueResult | null>(null);

  const issue = useCallback(
    async (params: IssueCredentialParams) => {
      if (!oxyServices || !holderDid) return;

      // Biometric/passcode gate — must pass BEFORE we sign the credential.
      setBiometricFailed(false);
      const auth = await authenticate(biometricReason);
      if (!auth.success) {
        setBiometricFailed(true);
        return;
      }

      setState('issuing');
      try {
        const res = await oxyServices.issueCredential({
          holderDid,
          types: params.types,
          claims: params.claims,
          expiresAt: params.expiresAt,
        });
        setResult(res);
        setState('done');
        // The credential lands on the HOLDER's list — invalidate every status
        // filter of their key so a re-read reflects it.
        const holderUserId = userIdFromDid(holderDid);
        if (holderUserId) {
          void queryClient.invalidateQueries({
            queryKey: ['civic', 'credentials', holderUserId],
          });
        }
      } catch (error: unknown) {
        setErrorCode(credentialIssueErrorCode(error));
        setState('error');
      }
    },
    [oxyServices, holderDid, biometricReason, queryClient],
  );

  return { state, biometricFailed, errorCode, result, issue };
}

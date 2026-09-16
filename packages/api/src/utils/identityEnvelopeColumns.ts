/**
 * How a `WebIdentityEnvelope` maps onto `identity_web_envelopes` columns — the one
 * mapping every writer uses (holder routes, passkey sign-up, recovery).
 *
 * Version 1 stores its entropy seal in `entropy_nonce`/`sealed_entropy`; version 2
 * stores its secret seal in the same two columns and names the kind.
 */
import type { WebIdentityEnvelope } from '@oxy.so/contracts';

export function envelopeColumns(envelope: WebIdentityEnvelope, publicKey: string) {
  if (envelope.version === 1) {
    return {
      publicKey,
      version: 1,
      algorithm: envelope.algorithm,
      secretKind: null,
      entropyNonce: envelope.entropyNonce.toLowerCase(),
      sealedEntropy: envelope.sealedEntropy.toLowerCase(),
      wraps: envelope.wraps,
    };
  }
  return {
    publicKey,
    version: 2,
    algorithm: envelope.algorithm,
    secretKind: envelope.secretKind,
    entropyNonce: envelope.secretNonce.toLowerCase(),
    sealedEntropy: envelope.sealedSecret.toLowerCase(),
    wraps: envelope.wraps,
  };
}

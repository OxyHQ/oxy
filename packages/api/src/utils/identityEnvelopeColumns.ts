/**
 * How a `WebIdentityEnvelope` maps onto `identity_web_envelopes` columns — the one
 * mapping every writer uses (holder routes, passkey sign-up, recovery). The secret
 * seal lives in `entropy_nonce`/`sealed_entropy`, next to its kind.
 */
import type { WebIdentityEnvelope } from '@oxy.so/contracts';

export function envelopeColumns(envelope: WebIdentityEnvelope, publicKey: string) {
  return {
    publicKey,
    version: envelope.version,
    algorithm: envelope.algorithm,
    secretKind: envelope.secretKind,
    entropyNonce: envelope.secretNonce.toLowerCase(),
    sealedEntropy: envelope.sealedSecret.toLowerCase(),
    wraps: envelope.wraps,
  };
}

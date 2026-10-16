/**
 * `@oxy.so/protocol/sign` — message and envelope signatures (secp256k1).
 *
 * The same functions the root entry exports, on their own entry so a client
 * can load the signer (and `@noble/curves` under it) where it signs — inside
 * `@oxy.so/core/crypto`, which apps load on first use — while the root entry
 * it imports at startup for hashing and platform loaders stays free of the
 * curve library once a bundler drops the root's unused re-exports.
 */

export {
  signEnvelope,
  signMessage,
  verifyEnvelopeSignature,
  verifySignature,
} from './envelope/sign';

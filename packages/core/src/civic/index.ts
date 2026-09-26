/**
 * `@oxy.so/core/civic` — the Oxy ID QR payloads: parse, build, verify.
 *
 * Pure functions over the signed public card and the real-life attestation
 * QR. Their own entry because verifying a card pulls the protocol's signature
 * code, which an app that never scans a card should not ship.
 */
// Verifying a card reaches `@noble/*`; the shim goes first (see `../crypto/polyfill`).
import '../crypto/polyfill';

export { parseIdPayload, parseAttestPayload, verifyPublicCardAttestation } from './payloads';
export type { IdCardRef, AttestQrPayload, ParsedAttestPayload } from './payloads';

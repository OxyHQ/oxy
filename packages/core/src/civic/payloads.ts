/**
 * Oxy ID / Commons QR payloads — pure, dependency-free helpers (Hermes-safe, no
 * `URL` global) a scanner can use without an `OxyServices` instance, plus the
 * client-side check of a public card's Oxy attestation.
 *
 * The Oxy ID QR encodes ONLY the DID (`oxycommons://card?did=…&v=1`) — never trust
 * data — so a card cannot be spoofed by crafting a QR; the scanner resolves the
 * signed card server-side and re-verifies it. The real-life-attestation QR
 * (`oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…`) is shown by the person
 * being attested and parsed by the scanner.
 */
import type { ExportAttestation, PublicCard } from '@oxy.so/contracts';

/** The DID extracted from a scanned `oxycommons://card?did=…` Oxy ID payload. */
export interface IdCardRef {
  /** The subject's Oxy DID (`did:web:oxy.so:u:<userId>`). */
  did: string;
}

/** URI scheme/host that introduces a Commons Oxy ID card payload. */
const CARD_MATCHER = /^oxycommons:\/\/card(?:[/?#]|$)/i;

/** URI scheme/host that introduces a real-life counterparty attestation payload. */
const ATTEST_MATCHER = /^oxycommons:\/\/attest(?:[/?#]|$)/i;

/**
 * Minimal, allocation-light query-string parser (no `URL` / `URLSearchParams`)
 * so it runs identically under Hermes and jsdom — mirrors the robustness of the
 * "Sign in with Oxy" approval-link parser. Shared by every `oxycommons://…`
 * payload parser in this module.
 */
function parseCommonsQuery(raw: string): Map<string, string> {
  const params = new Map<string, string>();
  const qIndex = raw.indexOf('?');
  if (qIndex < 0) return params;

  let query = raw.slice(qIndex + 1);
  const hashIndex = query.indexOf('#');
  if (hashIndex >= 0) query = query.slice(0, hashIndex);

  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      params.set(
        decodeURIComponent(rawKey),
        decodeURIComponent(rawValue.replace(/\+/g, ' ')),
      );
    } catch {
      // Malformed percent-encoding — keep the raw token rather than throwing, so
      // a single bad field doesn't sink an otherwise valid payload.
      params.set(rawKey, rawValue);
    }
  }
  return params;
}

/**
 * Parse a scanned / deep-linked Oxy ID payload (`oxycommons://card?did=…`) into
 * the referenced DID. Pure + dependency-free (Hermes-safe, no `URL` global) so
 * Commons (and any scanner) can reuse it without an OxyServices instance.
 *
 * @param raw - The raw scanned string or deep-link URL.
 * @returns `{ did }` when a usable DID is present; `null` for anything else (a
 *   non-card scheme, a missing/empty `did`, or non-string input).
 */
export function parseIdPayload(raw: string): IdCardRef | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  const value = raw.trim();
  if (!CARD_MATCHER.test(value)) {
    return null;
  }
  const did = parseCommonsQuery(value).get('did');
  if (!did || did.length === 0) {
    return null;
  }
  return { did };
}

/**
 * The fields decoded from a scanned real-life-attestation QR
 * (`oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…`). The SCANNER feeds these
 * to `oxy.civic.attest`.
 */
export interface ParsedAttestPayload {
  /** The DID of the person being attested (A) — becomes the record's `about`. */
  subjectDid: string;
  /** Opaque interaction id (`ctx`); `''` when the QR omitted it. */
  context: string;
  /** Single-use replay-guard nonce. */
  nonce: string;
  /** Nonce expiry (epoch ms); the server re-checks freshness authoritatively. */
  exp: number;
}

/**
 * The QR a person shows to be attested in real life, plus the fresh nonce/exp it
 * embeds so the displaying app can track which scan completed it.
 */
export interface AttestQrPayload {
  /** The `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` string to encode as a QR. */
  payload: string;
  /** The single-use nonce embedded in the payload. */
  nonce: string;
  /** The nonce expiry embedded in the payload (epoch ms). */
  exp: number;
}

/**
 * Parse a scanned / deep-linked real-life-attestation payload
 * (`oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…`). Pure + dependency-free
 * (Hermes-safe, no `URL` global), mirroring {@link parseIdPayload}, so Commons
 * (and any scanner) can reuse it without an OxyServices instance.
 *
 * @param raw - The raw scanned string or deep-link URL.
 * @returns `{ subjectDid, context, nonce, exp }` when the required fields are
 *   present and `exp` is a positive finite number; `null` otherwise (a non-attest
 *   scheme, a missing `subject`/`nonce`/`exp`, an unparseable `exp`, or non-string
 *   input). `context` defaults to `''` when the QR omits `ctx`.
 */
export function parseAttestPayload(raw: string): ParsedAttestPayload | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  const value = raw.trim();
  if (!ATTEST_MATCHER.test(value)) {
    return null;
  }
  const params = parseCommonsQuery(value);
  const subjectDid = params.get('subject');
  const nonce = params.get('nonce');
  const expRaw = params.get('exp');
  if (!subjectDid || !nonce || expRaw === undefined || expRaw.length === 0) {
    return null;
  }
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) {
    return null;
  }
  return { subjectDid, context: params.get('ctx') ?? '', nonce, exp };
}

/**
 * Verify the Oxy custodial attestation on a public card.
 *
 * Re-canonicalizes the received `card` (so the order of the JSON keys on the
 * wire is irrelevant; `canonicalize` also omits any `undefined`-valued optional
 * key, matching the server which omits absent keys entirely) and checks the
 * `ES256K-DER-SHA256` signature against `attestation.publicKey`.
 *
 * NEVER throws: `verifySignature` already swallows malformed-input
 * errors and returns `false`, and an absent attestation short-circuits to
 * `false`. A pure, reusable helper (Commons can call it on a cached card).
 *
 * @param card - The card to verify (exactly as received).
 * @param attestation - The card's attestation, or `null` (unsigned ⇒ `false`).
 */
export async function verifyPublicCardAttestation(
  card: PublicCard,
  attestation: ExportAttestation | null,
): Promise<boolean> {
  if (!attestation) {
    return false;
  }
  const { signature, publicKey } = attestation;
  if (!signature || !publicKey) {
    return false;
  }
  const { canonicalize, verifySignature } = await import('../crypto/internal');
  return verifySignature(canonicalize(card), signature, publicKey);
}

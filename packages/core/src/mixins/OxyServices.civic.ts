/**
 * Civic Methods Mixin (Commons "Oxy ID" — Fase 1; anti-gaming — Fase 2)
 *
 * Provides typed access to the public, verifiable citizen-identity ("Oxy ID")
 * card a Commons user shows and others scan, plus the Fase 2 anti-gaming surfaces
 * (real-life counterparty attestation + the validator/jury flow):
 *
 *  - {@link OxyServicesCivicMixin.getPublicCard} fetches a user's signed card
 *    (`GET /civic/:userId/card`) and verifies the Oxy custodial attestation
 *    CLIENT-SIDE, so a scanner can trust the card OFFLINE (e.g. a cached card
 *    replayed without network) instead of re-trusting the transport.
 *  - {@link OxyServicesCivicMixin.getMyIdPayload} builds the QR payload the user
 *    displays. The QR encodes ONLY the DID (`oxycommons://card?did=…&v=1`) — never
 *    trust data — so the card cannot be spoofed by crafting a QR; the scanner
 *    resolves the signed card server-side and re-verifies it.
 *  - {@link OxyServicesCivicMixin.buildAttestQrPayload} builds the high-value
 *    real-life-attestation QR the person BEING attested (A) shows; the SCANNER
 *    (B) parses it with {@link parseAttestPayload} and signs a self-issued
 *    counterparty attestation via
 *    {@link OxyServicesCivicMixin.submitRealLifeAttestation}.
 *  - {@link OxyServicesCivicMixin.getValidatorInbox} /
 *    {@link OxyServicesCivicMixin.submitValidationVote} /
 *    {@link OxyServicesCivicMixin.denyValidation} drive a randomly-selected
 *    juror's medium-weight peer-validation duties.
 *
 * The wire shapes (`PublicCard`, `SignedPublicCard`, `ExportAttestation`,
 * `RealLifeAttestationResult`, `ValidationRequestSummary`, `ValidationVoteResult`,
 * `SignedRecordEnvelope`) come from `@oxy.so/contracts` — the single source of
 * truth the API validates its output against — so producer and consumer cannot
 * drift. The public Oxy ID card's attestation is an `ES256K-DER-SHA256` signature
 * over `canonicalize(card)` (the exact bytes the server signed, with ONLY the
 * present keys), so a consumer re-canonicalizes the `card` it received and checks
 * the signature against `attestation.publicKey`.
 *
 * Card verification NEVER throws on a bad/absent signature — it returns
 * `verified: false` so the UI can render a forged/unsigned card as visibly
 * untrusted rather than silently trusting it. A transport/network failure (the
 * fetch itself) still rejects, as everywhere else in the SDK.
 *
 * The Fase 2 writes (`submitRealLifeAttestation`, `submitValidationVote`) sign a
 * v2 self-issued signed-record envelope with the on-device identity key (so they
 * are NATIVE-ONLY — they throw on web, where `KeyManager` has no key) on the
 * caller's own per-subject hash chain: each fetches the caller's chain head
 * (`GET /identity/records/:userId/chain/head`) to set `seq`/`prev` before signing
 * with {@link SignatureService.signRecordV2}.
 *
 * Reading a public card and building/parsing the QR payloads are
 * platform-agnostic; deriving the current user's DID requires an authenticated
 * session.
 */
import type {
  ChainHeadResponse,
  CredentialIssueResult,
  CredentialListResult,
  CredentialStatus,
  CredentialVerifyResult,
  ExportAttestation,
  OxySignedRecordType,
  PersonhoodStatusResult,
  PublicCard,
  RealLifeAttestationResult,
  SignedPublicCard,
  SignedRecordEnvelope,
  ValidationRequestSummary,
  ValidationVerdict,
  ValidationVoteResult,
  VerifiableCredentialResponse,
  VouchResult,
} from '@oxy.so/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { canonicalize, verifySignature } from '@oxy.so/protocol';
import { SignatureService } from '../crypto/signatureService';
import { buildUserDid } from './OxyServices.identity';
import { CACHE_TIMES } from './mixinHelpers';

/**
 * Validity window of a real-life-attestation QR (`oxycommons://attest?…exp=…`),
 * matching the server's `REAL_LIFE_NONCE_MAX_AGE_MS` ceiling: the QR must be
 * scanned and submitted within this window. The server is authoritative on
 * freshness; this is the client-issued `exp`.
 */
const ATTEST_QR_TTL_MS = 10 * 60 * 1000;

/** AtProto-style collection for a real-life counterparty attestation record. */
const ATTEST_COLLECTION = 'app.oxy.attestation';

/** AtProto-style collection for a validator's signed verdict record. */
const VALIDATION_COLLECTION = 'app.oxy.validation';

/** AtProto-style collection for a personhood vouch record. */
const VOUCH_COLLECTION = 'app.oxy.vouch';

/**
 * AtProto-style collection (NSID) for a verifiable credential record — matches
 * the server's `CREDENTIAL_COLLECTION`. Each credential is its own chain entry,
 * so the per-credential `rkey` MUST be unique (a fresh nonce), unlike the
 * one-per-subject vouch keyed on the subject DID.
 */
const CREDENTIAL_COLLECTION = 'app.oxy.credential';

/**
 * The W3C base VC type (`CREDENTIAL_BASE_TYPE` on the server) that MUST be
 * present in every credential's `types`. The client prepends it when the caller
 * omits it; the server rejects a credential record lacking it (`missing_base_type`).
 */
const CREDENTIAL_BASE_TYPE = 'VerifiableCredential';

/**
 * Cache-key prefix of every credential read — the holder list
 * (`GET /civic/credentials/:holderUserId`) and the by-record verify
 * (`GET /civic/credentials/by-record/:recordId/verify`) both start with it.
 * Swept after an issue / revoke so a re-read reflects the new credential set /
 * status instead of a stale cached one. The identity tag is a key SUFFIX, so
 * this prefix invalidates the resource for every cached identity.
 */
const CREDENTIAL_CACHE_PREFIX = 'GET:/civic/credentials/';

/**
 * Cache-key prefix of every personhood-status read (`GET /civic/personhood/:userId`).
 * Swept after a vouch / withdraw so a re-read reflects the recomputed snapshot
 * instead of a stale cached one. The identity tag is a key SUFFIX, so this
 * prefix invalidates the resource for every cached identity.
 */
const PERSONHOOD_CACHE_PREFIX = 'GET:/civic/personhood/';

/**
 * Cache-key prefix of the current user's `GET /users/me`. Swept after a vouch /
 * withdraw because a subject crossing the personhood threshold flips their
 * mirrored `User.verified` flag.
 */
const USERS_ME_CACHE_PREFIX = 'GET:/users/me';

/**
 * A {@link SignedPublicCard} augmented with the client's verification verdict.
 *
 * - `card` / `attestation` are echoed straight from the API response.
 * - `verified` is `true` ONLY when `attestation` is present and its signature
 *   over `canonicalize(card)` checks out against `attestation.publicKey`. It is
 *   `false` for an unsigned card (dev, `attestation === null`), a tampered card,
 *   or a signature made with a different key.
 *
 * `verified` confirms the attestation's signature is internally consistent with
 * its embedded `publicKey` (and that the card bytes were not mutated). It does
 * NOT, on its own, establish that `publicKey` is Oxy's custodial key — that trust
 * anchor is the Oxy API the card was fetched from (over TLS) and, for the
 * pinning-conscious, `attestation.issuer` (the Oxy DID). The UI shows a trust
 * indicator from `verified`; a `false` verdict MUST be surfaced as untrusted.
 */
export interface CivicCardResult extends SignedPublicCard {
  verified: boolean;
}

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
 * to {@link OxyServicesCivicMixin.submitRealLifeAttestation}.
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
  return verifySignature(canonicalize(card), signature, publicKey);
}

/**
 * Input for {@link OxyServicesCivicMixin.submitRealLifeAttestation} — the fields
 * the SCANNER (B) carries over from a parsed {@link ParsedAttestPayload}, plus
 * the optional co-location / biometric support signals B contributes.
 */
export interface SubmitRealLifeAttestationInput {
  /** The DID of the person being attested (A); becomes the record's `about`. */
  subjectDid: string;
  /** Opaque interaction id from the QR. */
  context: string;
  /** Single-use nonce from the QR (also the record's `rkey`). */
  nonce: string;
  /** Nonce expiry from the QR (epoch ms). */
  exp: number;
  /** Coarse co-location proof (optional). */
  geohash?: string;
  /** Whether B's device biometric gate fired before signing (optional). */
  biometricOk?: boolean;
}

/** Result of {@link OxyServicesCivicMixin.denyValidation}. */
export interface DenyValidationResult {
  denied: boolean;
}

/**
 * Input for {@link OxyServicesCivicMixin.vouchForPerson} — the SUBJECT (A) the
 * current user (B) is vouching for, plus B's optional stake and biometric
 * support signal.
 */
export interface VouchForPersonInput {
  /** A's DID (`did:web:oxy.so:u:<userId>`); becomes the vouch record's `about`. */
  subjectDid: string;
  /**
   * B's chosen stake (the `stake` wire field). Omitted ⇒ the server applies its
   * default; the server clamps any value into its `[min, max]` and echoes the
   * recorded amount back as `VouchResult.stakeAmount`.
   */
  stakeAmount?: number;
  /** Whether B's device biometric gate fired before signing (optional signal). */
  biometricOk?: boolean;
}

/** Result of {@link OxyServicesCivicMixin.withdrawVouch}. */
export interface WithdrawVouchResult {
  withdrawn: boolean;
}

/**
 * Input for {@link OxyServicesCivicMixin.issueCredential} — the HOLDER the
 * caller (issuer) attests a claim about, the VC type tags, the issuer's claim
 * set, and an optional ISO-8601 expiry.
 */
export interface IssueCredentialInput {
  /** The holder's Oxy DID (`did:web:oxy.so:u:<userId>`); becomes the record's `about`. */
  holderDid: string;
  /**
   * The VC type tags. `'VerifiableCredential'` is the required base type and is
   * prepended automatically when the caller omits it; provide at least one
   * specific type alongside (e.g. `'EmploymentCredential'`).
   */
  types: string[];
  /** The arbitrary, issuer-asserted claim set about the holder (signed verbatim). */
  claims: Record<string, unknown>;
  /**
   * Optional expiry as an ISO-8601 date string; absent = non-expiring. Converted
   * to epoch milliseconds in the signed record (the wire/storage unit), so a
   * holder cannot extend validity after the fact. Must be a parseable date and,
   * per the server, in the future.
   */
  expiresAt?: string;
}

/** Result of {@link OxyServicesCivicMixin.revokeCredential} (`POST …/:id/revoke`). */
export interface RevokeCredentialResult {
  revoked: boolean;
  credential: VerifiableCredentialResponse;
}

export function OxyServicesCivicMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Fetch a user's signed public Oxy ID card and verify the Oxy attestation
     * client-side. Public (no auth required); short-TTL cached.
     *
     * Resolves to `{ card, attestation, verified }`. A bad/absent signature does
     * NOT reject — it yields `verified: false` so the UI can warn. Only a
     * transport failure (the fetch itself) rejects.
     *
     * @param userId - The subject account's Mongo `_id`. URL-encoded into the path.
     */
    async getPublicCard(userId: string): Promise<CivicCardResult> {
      try {
        const signed = await this.makeRequest<SignedPublicCard>(
          'GET',
          `/civic/${encodeURIComponent(userId)}/card`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        const verified = await verifyPublicCardAttestation(signed.card, signed.attestation);
        return { card: signed.card, attestation: signed.attestation, verified };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Build the Oxy ID QR payload for the current user:
     * `oxycommons://card?did=<did>&v=1`, where `<did>` is the user's Oxy DID
     * (`did:web:oxy.so:u:<userId>`). The QR encodes ONLY the DID (anti-spoof — no
     * trust data); a scanner resolves the signed card via {@link getPublicCard}.
     * Round-trips through {@link parseIdPayload}.
     *
     * Throws if no user is authenticated (no DID to derive).
     */
    getMyIdPayload(): string {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot build an Oxy ID payload.');
      }
      return `oxycommons://card?did=${buildUserDid(userId)}&v=1`;
    }

    // =========================================================================
    // FASE 2 — real-life counterparty attestation (HIGH weight)
    // =========================================================================

    /**
     * Build the real-life-attestation QR the current user (A) shows to be
     * attested by a counterparty (B):
     * `oxycommons://attest?subject=<A.did>&ctx=<context>&nonce=<fresh>&exp=<now+10m>`.
     *
     * A fresh crypto-random nonce is minted per call (single-use replay guard);
     * `exp` is `now + 10min` (matching the server ceiling — scan promptly). The
     * QR carries NO trust data; B re-signs and the server is authoritative. The
     * returned `nonce`/`exp` let the displaying screen track which scan completed.
     *
     * Async because a crypto-secure nonce requires the platform RNG (async on
     * native via expo-crypto). Throws if no user is authenticated.
     *
     * @param input.context - An opaque interaction id describing the encounter.
     */
    async buildAttestQrPayload(input: { context: string }): Promise<AttestQrPayload> {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot build an attestation QR.');
      }
      const subject = buildUserDid(userId);
      const nonce = await SignatureService.generateChallenge();
      const exp = Date.now() + ATTEST_QR_TTL_MS;
      const payload =
        `oxycommons://attest?subject=${subject}` +
        `&ctx=${encodeURIComponent(input.context)}` +
        `&nonce=${nonce}&exp=${exp}`;
      return { payload, nonce, exp };
    }

    /**
     * Submit a real-life counterparty attestation as the SCANNER (B): sign a
     * self-issued `real_life_attestation` v2 record on B's own chain
     * (`subject === issuer === B.did`), referencing A via `record.about`, then
     * `POST /civic/attestations`. The server enforces nonce single-use,
     * freshness, graph-exclusion (B is not A's puppet), and the per-pair
     * cooldown, then awards A the HIGH-weight points.
     *
     * NATIVE-ONLY (signs with the on-device key; throws on web / when no
     * identity or no authenticated user). The record is keyed
     * `collection: 'app.oxy.attestation'`, `rkey: <nonce>`.
     *
     * @param input - The parsed QR fields ({@link ParsedAttestPayload}) plus B's
     *   optional `geohash` / `biometricOk` support signals.
     */
    async submitRealLifeAttestation(
      input: SubmitRealLifeAttestationInput,
    ): Promise<RealLifeAttestationResult> {
      try {
        const envelope = await this._signMyCivicRecordV2(
          'real_life_attestation',
          {
            about: input.subjectDid,
            context: input.context,
            nonce: input.nonce,
            exp: input.exp,
            ...(input.geohash !== undefined ? { geohash: input.geohash } : {}),
            ...(input.biometricOk !== undefined ? { biometricOk: input.biometricOk } : {}),
          },
          ATTEST_COLLECTION,
          input.nonce,
        );
        return await this.makeRequest<RealLifeAttestationResult>(
          'POST',
          '/civic/attestations',
          envelope,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // FASE 2 — validator / jury (MEDIUM weight)
    // =========================================================================

    /**
     * List the current user's pending jury duties (`GET /civic/validations/inbox`).
     * Auth required; never cached (the inbox is a live queue). Returns `[]` when
     * the caller is on no juries.
     */
    async getValidatorInbox(): Promise<ValidationRequestSummary[]> {
      try {
        const res = await this.makeRequest<{ requests?: ValidationRequestSummary[] }>(
          'GET',
          '/civic/validations/inbox',
          undefined,
          { cache: false },
        );
        return res.requests ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Cast a SIGNED verdict on a validation request as a selected juror: sign a
     * self-issued `validation_verdict` v2 record on the juror's own chain bound
     * to `requestId` + `payloadHash` (so a verdict cannot be replayed onto a
     * different request or an altered payload), then
     * `POST /civic/validations/:id/vote`.
     *
     * NATIVE-ONLY (signs with the on-device key; throws on web / when no
     * identity or no authenticated user). The record is keyed
     * `collection: 'app.oxy.validation'`, `rkey: <requestId>`.
     *
     * @param requestId - The validation request being voted on.
     * @param payloadHash - The request's canonical payload hash (from the inbox);
     *   the server rejects a vote whose hash does not match the stored request.
     * @param verdict - `'valid'` | `'invalid'` | `'abstain'`.
     */
    async submitValidationVote(
      requestId: string,
      payloadHash: string,
      verdict: ValidationVerdict,
    ): Promise<ValidationVoteResult> {
      try {
        const envelope = await this._signMyCivicRecordV2(
          'validation_verdict',
          { requestId, payloadHash, verdict },
          VALIDATION_COLLECTION,
          requestId,
        );
        return await this.makeRequest<ValidationVoteResult>(
          'POST',
          `/civic/validations/${encodeURIComponent(requestId)}/vote`,
          envelope,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Recuse from a validation request (`POST /civic/validations/:id/deny`): the
     * juror is removed from the jury and the request is re-tallied. Auth
     * required; no signed record (recusal is not an attestation).
     *
     * @param requestId - The validation request to recuse from.
     */
    async denyValidation(requestId: string): Promise<DenyValidationResult> {
      try {
        return await this.makeRequest<DenyValidationResult>(
          'POST',
          `/civic/validations/${encodeURIComponent(requestId)}/deny`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // FASE 3 — proof-of-personhood web-of-trust (staked vouch)
    // =========================================================================

    /**
     * Vouch that another user is a real person as the VOUCHER (B): sign a
     * self-issued `personhood_vouch` v2 record on B's own chain
     * (`subject === issuer === B.did`), referencing the subject (A) via
     * `record.about`, then `POST /civic/personhood/vouch`. The server verifies
     * it, enforces the voucher-eligibility (personhood ≥ τ) + graph-exclusion
     * gates, stakes B, awards A `personhood_vouched`, and recomputes A's
     * personhood. The voucher id is resolved server-side from the session — never
     * from the body.
     *
     * The signed record matches the API schema: `{ about, stake?, … }` — note the
     * wire field is `stake` (the caller's `stakeAmount` request), distinct from
     * the server-clamped `VouchResult.stakeAmount` it returns. The optional
     * `biometricOk` is carried as a signed support signal.
     *
     * NATIVE-ONLY (signs with the on-device key; throws on web / when no identity
     * or no authenticated user). The record is keyed
     * `collection: 'app.oxy.vouch'`, `rkey: <subjectDid>` (one vouch per subject
     * on the voucher's chain — last-writer-wins). After a successful vouch the
     * personhood + `/users/me` GET caches are swept.
     *
     * @param input - The subject DID plus B's optional stake / biometric signal.
     */
    async vouchForPerson(input: VouchForPersonInput): Promise<VouchResult> {
      try {
        const envelope = await this._signMyCivicRecordV2(
          'personhood_vouch',
          {
            about: input.subjectDid,
            ...(input.stakeAmount !== undefined ? { stake: input.stakeAmount } : {}),
            ...(input.biometricOk !== undefined ? { biometricOk: input.biometricOk } : {}),
          },
          VOUCH_COLLECTION,
          input.subjectDid,
        );
        const result = await this.makeRequest<VouchResult>(
          'POST',
          '/civic/personhood/vouch',
          envelope,
          { cache: false },
        );
        this._sweepPersonhoodCaches();
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Withdraw the current user's active vouch for a subject
     * (`DELETE /civic/personhood/vouch/:subjectUserId`). The vouch flips to
     * `withdrawn` server-side and the subject is recomputed (which may demote
     * them below θ). Auth required; no signed record (withdrawal is not an
     * attestation). After a successful withdraw the personhood + `/users/me` GET
     * caches are swept.
     *
     * @param subjectUserId - The subject account's Mongo `_id` (NOT a DID) — the
     *   id the server keys the vouch on. URL-encoded into the path.
     */
    async withdrawVouch(subjectUserId: string): Promise<WithdrawVouchResult> {
      try {
        const result = await this.makeRequest<WithdrawVouchResult>(
          'DELETE',
          `/civic/personhood/vouch/${encodeURIComponent(subjectUserId)}`,
          undefined,
          { cache: false },
        );
        this._sweepPersonhoodCaches();
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch a user's public personhood status snapshot
     * (`GET /civic/personhood/:userId`). Read-only: the server returns the cached
     * snapshot, or a zeroed `unverified` shape (`breakdown`/`updatedAt` null) when
     * none exists yet. Public (no auth required); short-TTL cached.
     *
     * @param userId - The subject account's Mongo `_id`. URL-encoded into the path.
     */
    async getPersonhood(userId: string): Promise<PersonhoodStatusResult> {
      try {
        return await this.makeRequest<PersonhoodStatusResult>(
          'GET',
          `/civic/personhood/${encodeURIComponent(userId)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch the CURRENT user's personhood status ({@link getPersonhood} for the
     * authenticated user's id). Throws if no user is authenticated.
     */
    async getMyPersonhood(): Promise<PersonhoodStatusResult> {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot resolve personhood status.');
      }
      return this.getPersonhood(userId);
    }

    // =========================================================================
    // FASE 4 — verifiable credentials
    // =========================================================================

    /**
     * Issue a verifiable credential as the ISSUER: sign a self-issued
     * `credential` v2 record on the caller's own chain
     * (`subject === issuer === issuer.did`) whose `record.about` is the HOLDER's
     * DID (the W3C `credentialSubject`), then `POST /civic/credentials`. The
     * server verifies the signature + the issuer's CURRENT verification method +
     * chain continuity, stores the signed record, and projects a queryable
     * credential row. All claim data comes from the SIGNED envelope — the issuer
     * id is resolved server-side from the session, never from the body.
     *
     * `'VerifiableCredential'` is ensured present as the base type (prepended
     * when the caller omits it; the server rejects a record missing it). An
     * `expiresAt` ISO string is converted to the epoch-ms the signed record
     * carries (the server rejects a past expiry).
     *
     * NATIVE-ONLY (signs with the on-device key; throws on web / when no identity
     * or no authenticated user). The record is keyed
     * `collection: 'app.oxy.credential'`, `rkey: <fresh unique nonce>` (each
     * credential is a distinct chain entry, so the rkey must be unique per
     * credential). After a successful issue the credential GET caches are swept.
     *
     * @param input - The holder DID, VC types, claims, and optional ISO expiry.
     */
    async issueCredential(input: IssueCredentialInput): Promise<CredentialIssueResult> {
      try {
        const types = input.types.includes(CREDENTIAL_BASE_TYPE)
          ? input.types
          : [CREDENTIAL_BASE_TYPE, ...input.types];

        let expiresAtMs: number | undefined;
        if (input.expiresAt !== undefined) {
          const parsed = Date.parse(input.expiresAt);
          if (Number.isNaN(parsed)) {
            throw new Error('Invalid expiresAt — must be an ISO 8601 date string.');
          }
          expiresAtMs = parsed;
        }

        const record: Record<string, unknown> = {
          about: input.holderDid,
          types,
          claims: input.claims,
          ...(expiresAtMs !== undefined ? { expiresAt: expiresAtMs } : {}),
        };

        // A fresh crypto-random rkey: every credential is its own chain entry, so
        // (unlike the one-per-subject vouch keyed on the subject DID) the rkey
        // must be unique per credential or a second credential would collide.
        const rkey = await SignatureService.generateChallenge();
        const envelope = await this._signMyCivicRecordV2(
          'credential',
          record,
          CREDENTIAL_COLLECTION,
          rkey,
        );
        const result = await this.makeRequest<CredentialIssueResult>(
          'POST',
          '/civic/credentials',
          envelope,
          { cache: false },
        );
        this._sweepCredentialCaches();
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * List a holder's verifiable credentials
     * (`GET /civic/credentials/:holderUserId`), newest first, optionally filtered
     * by stored `status`. Public (credentials are issuer-signed attestations a
     * holder collects to SHOW); short-TTL cached and swept after the caller's own
     * issue / revoke. An unknown holder yields an empty list.
     *
     * @param holderUserId - The holder account's Mongo `_id` (NOT a DID). URL-encoded.
     * @param opts.status - Optional `'active' | 'revoked' | 'expired'` filter.
     */
    async listCredentials(
      holderUserId: string,
      opts: { status?: CredentialStatus } = {},
    ): Promise<CredentialListResult> {
      try {
        const base = `/civic/credentials/${encodeURIComponent(holderUserId)}`;
        const url = opts.status ? `${base}?status=${encodeURIComponent(opts.status)}` : base;
        return await this.makeRequest<CredentialListResult>(
          'GET',
          url,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * List the CURRENT user's verifiable credentials ({@link listCredentials} for
     * the authenticated user's id). Throws if no user is authenticated.
     *
     * @param opts.status - Optional status filter.
     */
    async listMyCredentials(
      opts: { status?: CredentialStatus } = {},
    ): Promise<CredentialListResult> {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot list credentials.');
      }
      return this.listCredentials(userId, opts);
    }

    /**
     * Verify a credential by its signed-record id
     * (`GET /civic/credentials/by-record/:recordId/verify`). The server recomputes
     * the canonical signing input from the STORED envelope and verifies the
     * signature against a CURRENT verification method of the ISSUER DID (so a
     * key the issuer has since rotated away no longer verifies), then checks the
     * credential is neither revoked nor expired. Public; short-TTL cached
     * (matching the server's `max-age=60`) and swept after the caller's own issue
     * / revoke.
     *
     * A revoked / expired / unverifiable credential yields `valid: false` (NOT a
     * throw) so the UI can render it as untrusted; `credential` is `null` only
     * when no credential exists for the record id. Only a transport failure (the
     * fetch itself) rejects.
     *
     * @param recordId - The credential's signed-record id. URL-encoded into the path.
     */
    async verifyCredential(recordId: string): Promise<CredentialVerifyResult> {
      try {
        return await this.makeRequest<CredentialVerifyResult>(
          'GET',
          `/civic/credentials/by-record/${encodeURIComponent(recordId)}/verify`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Revoke a credential the current user originally issued
     * (`POST /civic/credentials/:id/revoke`). Only the original USER issuer may
     * revoke; the server flips the credential to `revoked`. After a successful
     * revoke the credential GET caches are swept.
     *
     * @param id - The credential's id (the projection row `_id`, NOT the signed
     *   record id). URL-encoded into the path.
     */
    async revokeCredential(id: string): Promise<RevokeCredentialResult> {
      try {
        const result = await this.makeRequest<RevokeCredentialResult>(
          'POST',
          `/civic/credentials/${encodeURIComponent(id)}/revoke`,
          undefined,
          { cache: false },
        );
        this._sweepCredentialCaches();
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Sweep the credential GET caches an issue / revoke invalidates: every
     * credential read (the holder list + the by-record verify, which share the
     * `GET:/civic/credentials/` prefix) so a re-read reflects the new credential
     * set / status. Public rather than `private` for the same TS4094 reason as
     * {@link _signMyCivicRecordV2}.
     */
    _sweepCredentialCaches(): void {
      this.clearCacheByPrefix(CREDENTIAL_CACHE_PREFIX);
    }

    /**
     * Sweep the GET caches a vouch / withdraw can invalidate: every personhood
     * status read (the subject's snapshot changed) and `/users/me` (a subject
     * crossing the threshold flips their mirrored `User.verified`). Public rather
     * than `private` for the same TS4094 reason as {@link _signMyCivicRecordV2}.
     */
    _sweepPersonhoodCaches(): void {
      this.clearCacheByPrefix(PERSONHOOD_CACHE_PREFIX);
      this.clearCacheByPrefix(USERS_ME_CACHE_PREFIX);
    }

    /**
     * Sign a self-issued v2 signed-record envelope on the CURRENT user's own
     * per-subject hash chain. Fetches the caller's chain head fresh (uncached, so
     * `seq`/`prev` are never stale → no `bad_seq`/`chain_fork`) and signs with
     * {@link SignatureService.signRecordV2}.
     *
     * NATIVE-ONLY (the private key lives in native secure storage). Internal
     * helper (leading underscore); public rather than `private` because mixins
     * compose into an exported anonymous class where TypeScript cannot represent a
     * private member in the emitted declaration file (TS4094).
     *
     * @param type - The signed-record category.
     * @param record - The record payload (canonicalized into the signed bytes).
     * @param collection - The AtProto-style collection namespace.
     * @param rkey - The AtProto-style record key within the collection.
     */
    async _signMyCivicRecordV2(
      type: OxySignedRecordType,
      record: Record<string, unknown>,
      collection: string,
      rkey: string,
    ): Promise<SignedRecordEnvelope> {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot sign a civic record.');
      }
      const subject = buildUserDid(userId);
      const head = await this.makeRequest<ChainHeadResponse>(
        'GET',
        `/identity/records/${encodeURIComponent(userId)}/chain/head`,
        undefined,
        { cache: false },
      );
      return SignatureService.signRecordV2(type, subject, record, {
        seq: head.seq + 1,
        prev: head.headRecordId,
        collection,
        rkey,
      });
    }
  };
}

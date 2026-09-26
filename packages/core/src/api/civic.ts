/**
 * `oxy.civic` — the Commons "Oxy ID": the public, verifiable citizen-identity
 * card a person shows and others scan, real-life attestation, the validator
 * (jury) flow, personhood vouching, and verifiable credentials.
 *
 *  - `publicCard` fetches a user's signed card and verifies the Oxy custodial
 *    attestation CLIENT-SIDE, so a scanner can trust the card OFFLINE (a cached
 *    card replayed without network) instead of re-trusting the transport.
 *  - `idPayload` / `buildAttestQrPayload` build the QRs a person shows; the
 *    scanner parses them with `parseIdPayload` / `parseAttestPayload`
 *    (`civic/payloads.ts`).
 *  - `attest`, `validation.vote`, `vouch`, `credentials.issue` sign a self-issued
 *    v2 record on the caller's own chain with the on-device key, so they are
 *    NATIVE-ONLY — they throw on web, where there is no key.
 *
 * Wire shapes come from `@oxy.so/contracts`. Card verification NEVER throws on a
 * bad or absent signature — it returns `verified: false` so the UI can render a
 * forged/unsigned card as visibly untrusted. A transport failure still rejects.
 */
import type {
  CredentialIssueResult,
  CredentialListResult,
  CredentialStatus,
  CredentialVerifyResult,
  PersonhoodStatusResult,
  RealLifeAttestationResult,
  SignedPublicCard,
  ValidationRequestSummary,
  ValidationVerdict,
  ValidationVoteResult,
  VerifiableCredentialResponse,
  VouchResult,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import { verifyPublicCardAttestation, type AttestQrPayload } from '../civic/payloads';
import { buildUserDid, signOwnChainRecord } from './identity';

/** Short-TTL read cache for public civic reads. */
const SHORT_TTL = 60 * 1000;

/**
 * Validity window of a real-life-attestation QR, matching the server's
 * `REAL_LIFE_NONCE_MAX_AGE_MS` ceiling. The server is authoritative on
 * freshness; this is the client-issued `exp`.
 */
const ATTEST_QR_TTL_MS = 10 * 60 * 1000;

/** AtProto-style collections of the civic records. */
const ATTEST_COLLECTION = 'app.oxy.attestation';
const VALIDATION_COLLECTION = 'app.oxy.validation';
const VOUCH_COLLECTION = 'app.oxy.vouch';
/**
 * Each credential is its own chain entry, so its `rkey` MUST be unique (a fresh
 * nonce), unlike the one-per-subject vouch keyed on the subject DID.
 */
const CREDENTIAL_COLLECTION = 'app.oxy.credential';

/**
 * The W3C base VC type that MUST be present in every credential's `types`;
 * prepended when the caller omits it (the server rejects a record lacking it).
 */
const CREDENTIAL_BASE_TYPE = 'VerifiableCredential';

/** Every credential read (holder list + by-record verify) starts with this. */
const CREDENTIAL_CACHE_PREFIX = 'GET:/civic/credentials/';
/** Every personhood-status read starts with this. */
const PERSONHOOD_CACHE_PREFIX = 'GET:/civic/personhood/';
/**
 * `GET /users/me`: a subject crossing the personhood threshold flips their
 * mirrored `User.verified`, so a vouch / withdraw sweeps it.
 */
const USERS_ME_CACHE_PREFIX = 'GET:/users/me';

/**
 * A `SignedPublicCard` plus the client's verdict. `verified` is `true` ONLY when
 * `attestation` is present and its signature over `canonicalize(card)` checks
 * out against `attestation.publicKey`. It does NOT on its own establish that
 * `publicKey` is Oxy's key — that anchor is the Oxy API the card came from (over
 * TLS) and `attestation.issuer`. A `false` verdict MUST be shown as untrusted.
 */
export interface CivicCardResult extends SignedPublicCard {
  verified: boolean;
}

/** Input for {@link CivicApi.attest} — the scanned QR's fields plus B's support signals. */
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

/** Result of `oxy.civic.validation.deny`. */
export interface DenyValidationResult {
  denied: boolean;
}

/** Input for {@link CivicApi.vouch} — the subject (A) the caller (B) vouches for. */
export interface VouchForPersonInput {
  /** A's DID (`did:web:oxy.so:u:<userId>`); becomes the vouch record's `about`. */
  subjectDid: string;
  /**
   * B's chosen stake (the `stake` wire field). Omitted ⇒ the server's default;
   * the server clamps it and echoes the recorded amount as `VouchResult.stakeAmount`.
   */
  stakeAmount?: number;
  /** Whether B's device biometric gate fired before signing (optional signal). */
  biometricOk?: boolean;
}

/** Result of {@link CivicApi.withdrawVouch}. */
export interface WithdrawVouchResult {
  withdrawn: boolean;
}

/** Input for `oxy.civic.credentials.issue`. */
export interface IssueCredentialInput {
  /** The holder's Oxy DID; becomes the record's `about`. */
  holderDid: string;
  /**
   * The VC type tags. `'VerifiableCredential'` is prepended when omitted;
   * provide at least one specific type (e.g. `'EmploymentCredential'`).
   */
  types: string[];
  /** The issuer-asserted claim set about the holder (signed verbatim). */
  claims: Record<string, unknown>;
  /**
   * Optional ISO-8601 expiry; absent = non-expiring. Converted to epoch ms in the
   * signed record, so a holder cannot extend validity after the fact.
   */
  expiresAt?: string;
}

/** Result of `oxy.civic.credentials.revoke`. */
export interface RevokeCredentialResult {
  revoked: boolean;
  credential: VerifiableCredentialResponse;
}

export class CivicApi {
  /** The validator (jury) flow — MEDIUM-weight peer validation. */
  readonly validation: CivicValidationApi;
  /** Verifiable credentials. */
  readonly credentials: CivicCredentialsApi;

  constructor(private readonly ctx: OxyContext) {
    this.validation = new CivicValidationApi(ctx);
    this.credentials = new CivicCredentialsApi(ctx);
  }

  /**
   * A user's signed public Oxy ID card, with the Oxy attestation verified
   * client-side. Public; short-TTL cached. A bad or absent signature does NOT
   * reject — it yields `verified: false`.
   */
  async publicCard(userId: string): Promise<CivicCardResult> {
    const signed = await this.ctx.request<SignedPublicCard>('GET', `/civic/${encodeURIComponent(userId)}/card`, undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
    const verified = await verifyPublicCardAttestation(signed.card, signed.attestation);
    return { card: signed.card, attestation: signed.attestation, verified };
  }

  /**
   * The signed-in user's Oxy ID QR payload: `oxycommons://card?did=<did>&v=1`.
   * Encodes ONLY the DID; a scanner resolves the signed card via `publicCard`.
   * Throws when signed out.
   */
  idPayload(): string {
    return `oxycommons://card?did=${this.myDid('build an Oxy ID payload')}&v=1`;
  }

  /**
   * The real-life-attestation QR the signed-in user (A) shows to be attested by
   * a counterparty (B):
   * `oxycommons://attest?subject=<A.did>&ctx=<context>&nonce=<fresh>&exp=<now+10m>`.
   * A fresh crypto-random nonce per call (single-use replay guard). Throws when
   * signed out.
   */
  async buildAttestQrPayload(input: { context: string }): Promise<AttestQrPayload> {
    const subject = this.myDid('build an attestation QR');
    const { SignatureService } = await import('../crypto/internal');
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
   * self-issued `real_life_attestation` record on B's own chain referencing A via
   * `record.about`, then `POST /civic/attestations`. The server enforces nonce
   * single-use, freshness, graph-exclusion and the per-pair cooldown, then awards
   * A the HIGH-weight points. NATIVE-ONLY.
   */
  async attest(input: SubmitRealLifeAttestationInput): Promise<RealLifeAttestationResult> {
    const envelope = await signOwnChainRecord(
      this.ctx,
      'real_life_attestation',
      {
        about: input.subjectDid,
        context: input.context,
        nonce: input.nonce,
        exp: input.exp,
        ...(input.geohash !== undefined ? { geohash: input.geohash } : {}),
        ...(input.biometricOk !== undefined ? { biometricOk: input.biometricOk } : {}),
      },
      { collection: ATTEST_COLLECTION, rkey: input.nonce },
    );
    return this.ctx.request<RealLifeAttestationResult>('POST', '/civic/attestations', envelope, { cache: false });
  }

  /**
   * Vouch that another user is a real person as the VOUCHER (B): sign a
   * self-issued `personhood_vouch` record (`{ about, stake? }`) on B's own chain,
   * then `POST /civic/personhood/vouch`. The server enforces voucher eligibility
   * and graph-exclusion, stakes B, and recomputes A's personhood. One vouch per
   * subject (`rkey: <subjectDid>`, last-writer-wins). NATIVE-ONLY.
   */
  async vouch(input: VouchForPersonInput): Promise<VouchResult> {
    const envelope = await signOwnChainRecord(
      this.ctx,
      'personhood_vouch',
      {
        about: input.subjectDid,
        ...(input.stakeAmount !== undefined ? { stake: input.stakeAmount } : {}),
        ...(input.biometricOk !== undefined ? { biometricOk: input.biometricOk } : {}),
      },
      { collection: VOUCH_COLLECTION, rkey: input.subjectDid },
    );
    const result = await this.ctx.request<VouchResult>('POST', '/civic/personhood/vouch', envelope, { cache: false });
    this.sweepPersonhood();
    return result;
  }

  /**
   * Withdraw the signed-in user's active vouch for a subject. The subject is
   * recomputed (which may demote them).
   *
   * @param subjectUserId - The subject's account id (NOT a DID).
   */
  async withdrawVouch(subjectUserId: string): Promise<WithdrawVouchResult> {
    const result = await this.ctx.request<WithdrawVouchResult>(
      'DELETE',
      `/civic/personhood/vouch/${encodeURIComponent(subjectUserId)}`,
      undefined,
      { cache: false },
    );
    this.sweepPersonhood();
    return result;
  }

  /**
   * A user's public personhood status snapshot (default: the signed-in user's).
   * A zeroed `unverified` shape when none exists yet. Short-TTL cached.
   */
  async personhood(userId?: string): Promise<PersonhoodStatusResult> {
    const id = userId ?? this.myUserId('resolve personhood status');
    return this.ctx.request<PersonhoodStatusResult>('GET', `/civic/personhood/${encodeURIComponent(id)}`, undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
  }

  /** A vouch / withdraw changes personhood reads and (via `verified`) `/users/me`. */
  private sweepPersonhood(): void {
    this.ctx.http.invalidateCache({ prefixes: [PERSONHOOD_CACHE_PREFIX, USERS_ME_CACHE_PREFIX] });
  }

  private myUserId(action: string): string {
    const userId = this.ctx.oxy.session.userId;
    if (!userId) {
      throw new Error(`No authenticated user — cannot ${action}.`);
    }
    return userId;
  }

  private myDid(action: string): string {
    return buildUserDid(this.myUserId(action));
  }
}

/** `oxy.civic.validation` — a randomly selected juror's duties. */
export class CivicValidationApi {
  constructor(private readonly ctx: OxyContext) {}

  /** The signed-in user's pending jury duties. Never cached; `[]` when on no juries. */
  async inbox(): Promise<ValidationRequestSummary[]> {
    const res = await this.ctx.request<{ requests?: ValidationRequestSummary[] }>('GET', '/civic/validations/inbox', undefined, {
      cache: false,
    });
    return res.requests ?? [];
  }

  /**
   * Cast a SIGNED verdict as a selected juror: a self-issued `validation_verdict`
   * record bound to `requestId` + `payloadHash` (so it cannot be replayed onto a
   * different request or an altered payload). NATIVE-ONLY.
   *
   * @param payloadHash - The request's canonical payload hash (from the inbox).
   */
  async vote(requestId: string, payloadHash: string, verdict: ValidationVerdict): Promise<ValidationVoteResult> {
    const envelope = await signOwnChainRecord(
      this.ctx,
      'validation_verdict',
      { requestId, payloadHash, verdict },
      { collection: VALIDATION_COLLECTION, rkey: requestId },
    );
    return this.ctx.request<ValidationVoteResult>(
      'POST',
      `/civic/validations/${encodeURIComponent(requestId)}/vote`,
      envelope,
      { cache: false },
    );
  }

  /** Recuse from a validation request: the juror leaves the jury and it is re-tallied. */
  async deny(requestId: string): Promise<DenyValidationResult> {
    return this.ctx.request<DenyValidationResult>(
      'POST',
      `/civic/validations/${encodeURIComponent(requestId)}/deny`,
      undefined,
      { cache: false },
    );
  }
}

/** `oxy.civic.credentials` — verifiable credentials. */
export class CivicCredentialsApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * Issue a verifiable credential as the ISSUER: sign a self-issued `credential`
   * record on the caller's own chain whose `record.about` is the HOLDER's DID,
   * then `POST /civic/credentials`. `'VerifiableCredential'` is ensured as the
   * base type; an `expiresAt` ISO string becomes epoch ms. NATIVE-ONLY.
   */
  async issue(input: IssueCredentialInput): Promise<CredentialIssueResult> {
    const types = input.types.includes(CREDENTIAL_BASE_TYPE) ? input.types : [CREDENTIAL_BASE_TYPE, ...input.types];

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

    // A fresh crypto-random rkey: every credential is its own chain entry.
    const { SignatureService } = await import('../crypto/internal');
    const rkey = await SignatureService.generateChallenge();
    const envelope = await signOwnChainRecord(this.ctx, 'credential', record, { collection: CREDENTIAL_COLLECTION, rkey });
    const result = await this.ctx.request<CredentialIssueResult>('POST', '/civic/credentials', envelope, { cache: false });
    this.sweep();
    return result;
  }

  /**
   * A holder's credentials, newest first (default holder: the signed-in user),
   * optionally filtered by status. Public; short-TTL cached.
   *
   * @param holderUserId - The holder's account id (NOT a DID).
   */
  async list(holderUserId?: string, opts: { status?: CredentialStatus } = {}): Promise<CredentialListResult> {
    const holder = holderUserId ?? this.ctx.oxy.session.userId;
    if (!holder) {
      throw new Error('No authenticated user — cannot list credentials.');
    }
    const base = `/civic/credentials/${encodeURIComponent(holder)}`;
    const url = opts.status ? `${base}?status=${encodeURIComponent(opts.status)}` : base;
    return this.ctx.request<CredentialListResult>('GET', url, undefined, { cache: true, cacheTTL: SHORT_TTL });
  }

  /**
   * Verify a credential by its signed-record id: the server re-checks the
   * signature against a CURRENT verification method of the issuer DID, then
   * that it is neither revoked nor expired. A failing credential yields
   * `valid: false`, not a throw. Short-TTL cached.
   */
  async verify(recordId: string): Promise<CredentialVerifyResult> {
    return this.ctx.request<CredentialVerifyResult>(
      'GET',
      `/civic/credentials/by-record/${encodeURIComponent(recordId)}/verify`,
      undefined,
      { cache: true, cacheTTL: SHORT_TTL },
    );
  }

  /**
   * Revoke a credential the signed-in user issued.
   *
   * @param id - The credential's id (the projection row id, NOT the record id).
   */
  async revoke(id: string): Promise<RevokeCredentialResult> {
    const result = await this.ctx.request<RevokeCredentialResult>(
      'POST',
      `/civic/credentials/${encodeURIComponent(id)}/revoke`,
      undefined,
      { cache: false },
    );
    this.sweep();
    return result;
  }

  private sweep(): void {
    this.ctx.http.invalidateCache({ prefixes: [CREDENTIAL_CACHE_PREFIX] });
  }
}

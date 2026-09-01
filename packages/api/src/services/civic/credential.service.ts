/**
 * Verifiable Credential Service (civic / Commons — Fase 4).
 *
 * A Verifiable Credential (VC) is an ISSUER (an employer / course / app that
 * holds a DID) cryptographically attesting a CLAIM about a HOLDER — e.g. "worked
 * at X 2020–2024", "completed course Y". The credential is a SIGNED record
 * (envelope `type: 'credential'`, an Oxy record type in `OxySignedRecordType`) whose
 * `record.about` is the HOLDER's DID (the W3C `credentialSubject`). It is
 * verifiable OFFLINE against the issuer DID's CURRENT verification method plus a
 * revocation/expiry check — anyone the holder shows the credential to can verify
 * it without trusting Oxy beyond resolving the issuer's DID document.
 *
 * Two issuance modes share one wire shape (`record.about` is ALWAYS the holder):
 *
 *  1. USER-ISSUED ({@link issueCredential}) — the issuer signs with their OWN
 *     key; the envelope is SELF-ISSUED (`subject === issuer === issuerDid`) and
 *     lands on the issuer's per-subject hash chain. This mirrors
 *     `real_life_attestation` / `personhood_vouch` exactly and reuses
 *     `verifyAndStoreRecord` UNCHANGED.
 *
 *  2. APP/ORG-ISSUED ({@link issueOrgCredential}, internal seam) — the Oxy
 *     CUSTODIAL key signs on behalf of an Application DID (`issuer === OXY_DID`,
 *     `subject === holderDid`) and lands on the HOLDER's chain. This mirrors
 *     `reputation_attestation` (see `attestation.service.ts`): the server reads
 *     the holder's chain head + retries the multi-writer race. A user cannot
 *     forge one (they lack `OXY_PRIVATE_KEY`).
 *
 * The {@link VerifiableCredential} model is a queryable projection; the signed
 * envelope on the {@link SignedRecord} ledger is the authoritative proof.
 * Verification ALWAYS recomputes the canonical signing input from the stored
 * envelope — never from the projection's denormalized claims.
 */

import type {
  SignedRecordEnvelope,
  VerifiableCredentialResponse,
  CredentialStatus,
  DidDocument,
  Secp256k1VerificationMethod,
} from '@oxyhq/contracts';
import { credentialRecordSchema } from '@oxyhq/contracts';
import { signedRecordSigningInput, verifyEnvelopeSignature, type RejectionReason } from '@oxyhq/protocol';
import SignatureService from '../signature.service';
import {
  buildUserDid,
  isSelfIssuedByUser,
  parseUserDid,
  buildDidDocument,
  buildOxyDidDocument,
  OXY_DID,
  type DidUserInput,
} from '../did.service';
import { and, desc, eq } from 'drizzle-orm';
import { verifyAndStoreRecord } from '../signedRecord.service';
import { getHead } from '../repoLog.service';
import { oxyRecordStore } from '../oxyRecordStore';
import { getDb } from '../../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { userVerifiedDomains } from '../../db/schema/userVerifiedDomains';
import { users } from '../../db/schema/users';
import { verifiableCredentials } from '../../db/schema/verifiableCredentials';
import { CREDENTIAL_COLLECTION, CREDENTIAL_BASE_TYPE } from '../../utils/civic.constants';
import { logger } from '../../utils/logger';

const ALG = 'ES256K-DER-SHA256' as const;

/** Retry budget for the org-issued holder-chain head race (rare). */
const MAX_CREDENTIAL_ATTEMPTS = 4;

/** Why a credential issuance can be rejected (stable, machine-readable). */
export type CredentialIssueRejectionReason =
  | 'invalid_type'
  | 'not_self_issued'
  | 'invalid_record'
  | 'missing_base_type'
  | 'invalid_holder'
  | 'self_credential'
  | 'holder_not_found'
  | 'invalid_expiry'
  | 'oxy_key_unconfigured'
  | RejectionReason;

export type CredentialIssueResult =
  | { ok: true; credential: VerifiableCredentialResponse }
  | { ok: false; reason: CredentialIssueRejectionReason };

/** Why a revoke can be rejected. */
export type CredentialRevokeRejectionReason = 'not_found' | 'not_issuer' | 'already_revoked';

export type CredentialRevokeResult =
  | { ok: true; credential: VerifiableCredentialResponse }
  | { ok: false; reason: CredentialRevokeRejectionReason };

/** The verdict of verifying a credential. `credential` is null only when none exists. */
export interface CredentialVerification {
  valid: boolean;
  reason?: string;
  credential: VerifiableCredentialResponse | null;
}

/** A stored credential projection row. */
type VerifiableCredentialRow = typeof verifiableCredentials.$inferSelect;

/** The unique index behind the idempotent projection insert. */
const CREDENTIAL_RECORD_UNIQUE = 'verifiable_credentials_record_id_unique';

/**
 * The effective status of a credential AT READ TIME: an `active` credential past
 * its `expiresAt` reads as `expired` even if the row has not yet been flipped by
 * the lazy sweep. `revoked` is terminal and never overridden.
 */
function effectiveStatus(
  vc: Pick<VerifiableCredentialRow, 'status' | 'expiresAt'>,
  now: number,
): CredentialStatus {
  if (vc.status === 'active' && vc.expiresAt && vc.expiresAt.getTime() <= now) {
    return 'expired';
  }
  return vc.status;
}

/**
 * The issuer-asserted claim set, as `jsonb` hands it back. The column carries a
 * `default {}` and every writer supplies an object, so a non-object here means
 * the row was written outside this service — reported as an empty claim set
 * rather than passed to a consumer that expects to index it.
 */
function readClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** Serialize a stored credential to the public wire shape. */
function serializeCredential(vc: VerifiableCredentialRow): VerifiableCredentialResponse {
  return {
    id: vc.id,
    recordId: vc.recordId,
    holderUserId: vc.holderUserId,
    holderDid: vc.holderDid,
    ...(vc.issuerUserId ? { issuerUserId: vc.issuerUserId } : {}),
    issuerDid: vc.issuerDid,
    types: vc.types,
    claims: readClaims(vc.claims),
    status: effectiveStatus(vc, Date.now()),
    issuedAt: vc.issuedAt.getTime(),
    ...(vc.expiresAt ? { expiresAt: vc.expiresAt.getTime() } : {}),
    ...(vc.revokedAt ? { revokedAt: vc.revokedAt.getTime() } : {}),
  };
}

/** Fields needed to insert a credential projection row. */
interface PersistCredentialInput {
  holderUserId: string;
  holderDid: string;
  issuerUserId?: string;
  issuerDid: string;
  types: string[];
  claims: Record<string, unknown>;
  recordId: string;
  issuedAt: number;
  expiresAt?: number;
}

/**
 * Insert the credential projection row, idempotently on `recordId`. If a row for
 * this signed record already exists (a retried write after the SignedRecord was
 * stored), the existing row is returned rather than throwing.
 */
async function persistCredentialRow(input: PersistCredentialInput): Promise<VerifiableCredentialResponse> {
  try {
    const [created] = await getDb()
      .insert(verifiableCredentials)
      .values({
        holderUserId: input.holderUserId,
        holderDid: input.holderDid,
        issuerUserId: input.issuerUserId,
        issuerDid: input.issuerDid,
        types: input.types,
        claims: input.claims,
        recordId: input.recordId,
        status: 'active',
        issuedAt: new Date(input.issuedAt),
        expiresAt: input.expiresAt === undefined ? undefined : new Date(input.expiresAt),
      })
      .returning();
    return serializeCredential(created);
  } catch (error) {
    if (isUniqueViolation(error, CREDENTIAL_RECORD_UNIQUE)) {
      const [existing] = await getDb()
        .select()
        .from(verifiableCredentials)
        .where(eq(verifiableCredentials.recordId, input.recordId))
        .limit(1);
      if (existing) {
        return serializeCredential(existing);
      }
    }
    throw error;
  }
}

/**
 * Issue a USER-signed verifiable credential. The caller (`issuerUserId`) signs a
 * SELF-ISSUED `credential` envelope with their own key (`subject === issuer ===
 * issuerDid`); `record.about` references the HOLDER. The envelope is verified +
 * appended to the issuer's hash chain, then projected into a queryable row.
 *
 * The holder + all claim data are taken from the SIGNED envelope (the source of
 * truth) — never from out-of-band request metadata — so an issuer cannot persist
 * a claim they did not sign.
 */
export async function issueCredential(
  envelope: SignedRecordEnvelope,
  issuerUserId: string,
): Promise<CredentialIssueResult> {
  if (envelope.type !== 'credential') {
    return { ok: false, reason: 'invalid_type' };
  }

  // User-issued: the envelope is self-issued by the caller (their key signs).
  // Account-based check — the SDK's DID spelling may differ from the server's
  // `DID_WEB_DOMAIN` anchor for the same account. The persisted row keeps the
  // server-canonical spelling (`issuerDid` below), consistent with org rows.
  if (!isSelfIssuedByUser(envelope, issuerUserId)) {
    return { ok: false, reason: 'not_self_issued' };
  }
  const issuerDid = buildUserDid(issuerUserId);

  const parsedRecord = credentialRecordSchema.safeParse(envelope.record);
  if (!parsedRecord.success) {
    return { ok: false, reason: 'invalid_record' };
  }
  const record = parsedRecord.data;

  if (!record.types.includes(CREDENTIAL_BASE_TYPE)) {
    return { ok: false, reason: 'missing_base_type' };
  }

  const holderUserId = parseUserDid(record.about);
  if (!holderUserId) {
    return { ok: false, reason: 'invalid_holder' };
  }
  if (holderUserId === issuerUserId) {
    return { ok: false, reason: 'self_credential' };
  }

  // An expiry, if present, must be in the future (issuing a dead credential is
  // a no-op and almost always a client bug). It is part of the signed bytes.
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return { ok: false, reason: 'invalid_expiry' };
  }

  if (!(await userExists(holderUserId))) {
    return { ok: false, reason: 'holder_not_found' };
  }

  // Cheap forgery gate before the authoritative verify-and-store (which repeats
  // signature + current-VM + chain-continuity checks transactionally).
  if (!(await verifyEnvelopeSignature(envelope))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // A `credential` must be a v2 (chained) envelope — `oxyStorePolicy` enforces
  // that — so the returned content address always names a stored row, which is
  // what `verifiable_credentials.record_id`'s foreign key requires.
  const stored = await verifyAndStoreRecord(envelope, issuerUserId);
  if (!stored.ok) {
    return { ok: false, reason: stored.reason };
  }
  const recordId = stored.record.recordId;

  const credential = await persistCredentialRow({
    holderUserId,
    holderDid: record.about,
    issuerUserId,
    issuerDid,
    types: record.types,
    claims: record.claims,
    recordId,
    issuedAt: envelope.issuedAt,
    expiresAt: record.expiresAt,
  });

  logger.info('Verifiable credential issued (user-signed)', {
    component: 'civic.credential',
    issuerUserId,
    holderUserId,
    recordId,
  });

  return { ok: true, credential };
}

/** Input for the app/org-issued (Oxy-custodial) credential seam. */
export interface IssueOrgCredentialInput {
  /** The holder's DID (`did:web:oxy.so:u:<userId>`). */
  holderDid: string;
  types: string[];
  claims: Record<string, unknown>;
  /** AtProto-style record key — MUST be unique per credential. */
  rkey: string;
  expiresAt?: number;
  /** Optional Application id the Oxy key issues on behalf of (recorded in claims). */
  onBehalfOfApplicationId?: string;
}

/**
 * APP/ORG-ISSUED seam: mint a credential signed by the Oxy CUSTODIAL key on
 * behalf of an Application DID, anchored on the HOLDER's chain (`subject ===
 * holderDid`, `issuer === OXY_DID`). Mirrors `attestation.service.attestAward`:
 * reads the holder's chain head, signs the v2 envelope server-side, retries the
 * multi-writer race, and projects the row. Skipped (returns
 * `oxy_key_unconfigured`) when no Oxy key is configured (dev / pre-prod).
 *
 * This is NOT exposed on the public route — only the server can produce an
 * Oxy-signed envelope. It is the clean seam for verified org/app credentials.
 */
export async function issueOrgCredential(input: IssueOrgCredentialInput): Promise<CredentialIssueResult> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    return { ok: false, reason: 'oxy_key_unconfigured' };
  }

  if (!input.types.includes(CREDENTIAL_BASE_TYPE)) {
    return { ok: false, reason: 'missing_base_type' };
  }

  const holderUserId = parseUserDid(input.holderDid);
  if (!holderUserId) {
    return { ok: false, reason: 'invalid_holder' };
  }
  if (input.expiresAt !== undefined && input.expiresAt <= Date.now()) {
    return { ok: false, reason: 'invalid_expiry' };
  }
  if (!(await userExists(holderUserId))) {
    return { ok: false, reason: 'holder_not_found' };
  }

  const claims: Record<string, unknown> = input.onBehalfOfApplicationId
    ? { ...input.claims, onBehalfOf: input.onBehalfOfApplicationId }
    : { ...input.claims };

  for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
    const head = await getHead(holderUserId);
    const seq = head ? head.seq + 1 : 0;
    const prev = head ? head.headRecordId : null;

    const record: Record<string, unknown> = {
      about: input.holderDid,
      types: input.types,
      claims,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    const fields: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 2,
      type: 'credential',
      subject: input.holderDid,
      issuer: OXY_DID,
      record,
      issuedAt: Date.now(),
      seq,
      prev,
      collection: CREDENTIAL_COLLECTION,
      rkey: input.rkey,
      publicKey,
      alg: ALG,
    };
    const signature = SignatureService.signMessage(signedRecordSigningInput(fields), privateKey);
    const envelope: SignedRecordEnvelope = { ...fields, signature };

    // The holder account's VMs are NOT consulted for a custodial record (the
    // issuer is OXY_DID); the resolver resolves the subject either way.
    const stored = await verifyAndStoreRecord(envelope, holderUserId);
    if (stored.ok) {
      const recordId = stored.record.recordId;
      const credential = await persistCredentialRow({
        holderUserId,
        holderDid: input.holderDid,
        issuerDid: OXY_DID,
        types: input.types,
        claims,
        recordId,
        issuedAt: envelope.issuedAt,
        expiresAt: input.expiresAt,
      });
      logger.info('Verifiable credential issued (org/custodial)', {
        component: 'civic.credential',
        holderUserId,
        recordId,
        onBehalfOf: input.onBehalfOfApplicationId,
      });
      return { ok: true, credential };
    }

    // A concurrent writer advanced the holder's chain head — re-read + retry.
    if (stored.reason === 'chain_conflict' || stored.reason === 'bad_seq' || stored.reason === 'chain_fork') {
      continue;
    }
    return { ok: false, reason: stored.reason };
  }

  return { ok: false, reason: 'chain_conflict' };
}

/**
 * Assemble the {@link DidUserInput} `buildDidDocument` needs for an account.
 *
 * The Mongoose document carried `authMethods[]` and `verifiedDomains[]` as
 * embedded arrays; both are child tables now, so the three reads are explicit.
 * Only the fields the DID document is built from are selected — the rest of the
 * users row (including its protected columns) never enters this path.
 */
async function loadDidUser(userId: string): Promise<DidUserInput | null> {
  const [user] = await getDb()
    .select({
      id: users.id,
      publicKey: users.publicKey,
      username: users.username,
      type: users.type,
      federationDomain: users.federationDomain,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    return null;
  }

  const [authMethods, verifiedDomains] = await Promise.all([
    getDb()
      .select({ type: userAuthMethods.type, methodPublicKey: userAuthMethods.methodPublicKey })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, userId)),
    getDb()
      .select({ domain: userVerifiedDomains.domain })
      .from(userVerifiedDomains)
      .where(eq(userVerifiedDomains.userId, userId)),
  ]);

  return {
    _id: user.id,
    publicKey: user.publicKey,
    username: user.username,
    type: user.type,
    federation: user.federationDomain ? { domain: user.federationDomain } : null,
    authMethods: authMethods.map((method) => ({
      type: method.type,
      metadata: { publicKey: method.methodPublicKey },
    })),
    verifiedDomains,
  };
}

/** Whether an account exists. */
async function userExists(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row !== undefined;
}

/** List a holder's credentials, newest first, optionally filtered by stored status. */
export async function listCredentialsForHolder(
  holderUserId: string,
  options: { status?: CredentialStatus } = {},
): Promise<VerifiableCredentialResponse[]> {
  const rows = await getDb()
    .select()
    .from(verifiableCredentials)
    .where(
      options.status
        ? and(
            eq(verifiableCredentials.holderUserId, holderUserId),
            eq(verifiableCredentials.status, options.status),
          )
        : eq(verifiableCredentials.holderUserId, holderUserId),
    )
    .orderBy(desc(verifiableCredentials.issuedAt));
  return rows.map(serializeCredential);
}

/**
 * Resolve the issuer DID's CURRENT verification-method public keys. Returns the
 * key list (possibly empty) or `null` when the issuer DID cannot be resolved to
 * a known account. For `OXY_DID` the keys come from the Oxy organisation DID
 * document (the custodial key); for a user DID they come from the account's
 * derived DID document (primary + identity keys, reflecting any rotation).
 */
async function resolveIssuerVmKeys(issuerDid: string): Promise<string[] | null> {
  if (issuerDid === OXY_DID) {
    return secp256k1KeysOf(buildOxyDidDocument());
  }
  const issuerUserId = parseUserDid(issuerDid);
  if (!issuerUserId) {
    return null;
  }
  const issuer = await loadDidUser(issuerUserId);
  if (!issuer) {
    return null;
  }
  return secp256k1KeysOf(buildDidDocument(issuer));
}

/**
 * The hex public keys of a DID document's secp256k1 verification methods. The
 * atproto `Multikey` VM carries the SAME key in multibase form (not hex), so it
 * is intentionally excluded — credential signatures verify against the hex key.
 */
function secp256k1KeysOf(document: DidDocument): string[] {
  return document.verificationMethod
    .filter((vm): vm is Secp256k1VerificationMethod => vm.type === 'EcdsaSecp256k1VerificationKey2019')
    .map((vm) => vm.publicKeyHex);
}

/** Best-effort lazy flip of an expired credential's status (never throws). */
async function markExpired(id: string): Promise<void> {
  try {
    await getDb()
      .update(verifiableCredentials)
      .set({ status: 'expired' })
      .where(
        and(eq(verifiableCredentials.id, id), eq(verifiableCredentials.status, 'active')),
      );
  } catch (error) {
    logger.warn('Credential lazy-expire failed (non-fatal)', {
      component: 'civic.credential',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Verify a credential by its signed-record id (preferred) or its credential id.
 *
 * Recomputes the canonical signing input from the STORED envelope and verifies
 * the signature against a CURRENT verification method of the ISSUER DID (so a
 * credential signed with a key the issuer has since rotated away no longer
 * verifies), then checks the credential is neither revoked nor expired. The
 * denormalized projection claims are never trusted — the signed envelope is the
 * source of truth, so any tampering of the signed bytes fails the signature.
 */
export async function verifyCredential(idOrRecordId: string): Promise<CredentialVerification> {
  // Two lookups because the argument is EITHER a content address or a row id;
  // the Mongo version needed an `isValidObjectId` guard before the second so
  // Mongoose would not throw a `CastError`, and a text id simply matches no row.
  const [byRecordId] = await getDb()
    .select()
    .from(verifiableCredentials)
    .where(eq(verifiableCredentials.recordId, idOrRecordId))
    .limit(1);
  let vc: VerifiableCredentialRow | undefined = byRecordId;
  if (!vc) {
    [vc] = await getDb()
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.id, idOrRecordId))
      .limit(1);
  }
  if (!vc) {
    return { valid: false, reason: 'not_found', credential: null };
  }

  const env = await oxyRecordStore.envelopeByRecordId(vc.recordId);
  if (!env) {
    return { valid: false, reason: 'record_missing', credential: serializeCredential(vc) };
  }

  const issuerVmKeys = await resolveIssuerVmKeys(env.issuer);
  if (issuerVmKeys === null) {
    return { valid: false, reason: 'issuer_not_found', credential: serializeCredential(vc) };
  }
  if (!issuerVmKeys.includes(env.publicKey)) {
    return { valid: false, reason: 'issuer_key_not_current', credential: serializeCredential(vc) };
  }
  if (!(await verifyEnvelopeSignature(env))) {
    return { valid: false, reason: 'bad_signature', credential: serializeCredential(vc) };
  }

  // Lazy expiry: flip an active-but-past-expiry row before reporting it.
  const now = Date.now();
  if (vc.status === 'active' && vc.expiresAt && vc.expiresAt.getTime() <= now) {
    await markExpired(vc.id);
    vc = { ...vc, status: 'expired' };
  }

  if (vc.status === 'revoked') {
    return { valid: false, reason: 'revoked', credential: serializeCredential(vc) };
  }
  if (effectiveStatus(vc, now) === 'expired') {
    return { valid: false, reason: 'expired', credential: serializeCredential(vc) };
  }

  return { valid: true, credential: serializeCredential(vc) };
}

/**
 * Revoke a credential — only the ORIGINAL user issuer may revoke. Flips the row
 * to `revoked` + stamps `revokedAt`; the append-only signed record is untouched
 * (a future signed revocation record is a documented seam, intentionally not
 * implemented here to keep the flow simple). App/org-issued credentials (no
 * `issuerUserId`) are not revocable via this user path — that is a separate
 * admin concern owned by the org seam.
 */
export async function revokeCredential(id: string, issuerUserId: string): Promise<CredentialRevokeResult> {
  const [vc] = await getDb()
    .select()
    .from(verifiableCredentials)
    .where(eq(verifiableCredentials.id, id))
    .limit(1);
  if (!vc) {
    return { ok: false, reason: 'not_found' };
  }
  if (!vc.issuerUserId || vc.issuerUserId !== issuerUserId) {
    return { ok: false, reason: 'not_issuer' };
  }
  if (vc.status === 'revoked') {
    return { ok: false, reason: 'already_revoked' };
  }

  // `status` and `revoked_at` move in ONE statement because the table's
  // revocation CHECK requires them to agree — Mongo could store a revocation
  // date on an active credential, and `verifyCredential` reads only the status.
  const [revoked] = await getDb()
    .update(verifiableCredentials)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(eq(verifiableCredentials.id, vc.id), eq(verifiableCredentials.status, vc.status)),
    )
    .returning();
  if (!revoked) {
    return { ok: false, reason: 'already_revoked' };
  }

  logger.info('Verifiable credential revoked', {
    component: 'civic.credential',
    issuerUserId,
    credentialId: id,
    recordId: revoked.recordId,
  });

  return { ok: true, credential: serializeCredential(revoked) };
}

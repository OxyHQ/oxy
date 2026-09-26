/**
 * `oxy.identity` — the self-sovereign identity layer.
 *
 *  - DID resolution (`did:web:oxy.so:u:<userId>`, derived on demand by the API).
 *  - The auth-method ↔ DID verification-method mapping (`GET /auth/methods`)
 *    and key rotation. A root is linked by the holder flows (ADR 0024) and
 *    never unlinked; it is replaced by rotation.
 *  - Identity links (`identity.links`): Commons' root joined to an account.
 *  - Verified-domain badges (`identity.domains`): prove ownership of `nate.com`.
 *  - The encrypted off-device key backup (`identity.backup`).
 *  - The signed data-export ("credible exit") bundle (`identity.export`).
 *
 * Wire shapes come from `@oxy.so/contracts` — the single source of truth the API
 * validates its output against, so producer and consumer cannot drift.
 *
 * Signing is NATIVE-ONLY: the private key lives in native secure storage, so
 * everything that signs throws on web. The crypto modules (key manager, BIP-39,
 * AEAD, signatures) load on first use, never with the client itself.
 */
import {
  IDENTITY_PROOF_ACTIONS,
  identityLinkCreateResponseSchema,
  identityLinkStateSchema,
  safeParseContract,
} from '@oxy.so/contracts';
import type {
  AuthMethodsResponse,
  BackupStatusResponse,
  BackupUploadRequest,
  ChainHeadResponse,
  DidDocument,
  DomainVerificationInstructions,
  EncryptedBackupEnvelope,
  ExportBundle,
  IdentityLinkCreateResponse,
  IdentityLinkState,
  IdentityRootStatus,
  OxySignedRecordType,
  RotateKeyChallengeResponse,
  RotateKeyCompleteResponse,
  SignedRecordEnvelope,
  VerifiedDomain,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { PendingIdentityResult } from '../crypto/recoveryPhrase';
import { isWeb } from '../utils/platform';
import { logger } from '../logger';

/** Short-TTL read cache for public identity reads. */
const SHORT_TTL = 60 * 1000;

/**
 * Registrable apex the Oxy DID method is anchored on. A user's DID is
 * `did:web:<OXY_IDENTITY_APEX>:u:<userId>`, anchored on the stable account id
 * (NOT the keypair).
 */
const OXY_IDENTITY_APEX = 'oxy.so';

/** Result of a successful domain verification (`POST /identity/domains/:domain/verify`). */
export interface VerifyDomainResult {
  verified: boolean;
  domain: VerifiedDomain;
}

/** Result of removing a verified domain (`DELETE /identity/domains/:domain`). */
export interface RemoveDomainResult {
  success: boolean;
}

/** How the caller proves control of the CURRENT key during a key rotation. */
export type RotateKeyProof = 'device' | 'phrase';

/** Options for {@link IdentityApi.rotateKey}. */
export interface RotateKeyOptions {
  /**
   * How to prove control of the CURRENT key:
   *  - `'device'`: sign with the on-device SecureStore key (native-only).
   *  - `'phrase'`: re-derive the current key from the entered recovery `phrase`
   *    and sign with it. This works even when the device holds NO SecureStore
   *    copy of the key — it is how the LAST remaining credential is replaced.
   */
  proof: RotateKeyProof;
  /** The CURRENT identity's recovery phrase. Required when `proof: 'phrase'`. */
  phrase?: string;
  /**
   * When true, all OTHER active sessions are revoked after a successful
   * rotation (the rotating device stays signed in). Use it when the old key is
   * presumed compromised.
   */
  signOutEverywhere?: boolean;
  /**
   * A pre-derived NEW identity to rotate to (from
   * `RecoveryPhraseService.derivePendingIdentity`). Pass it when the UI derived +
   * SHOWED the new phrase to the user BEFORE committing, so the SAME identity is
   * the one rotated in. When omitted, a fresh identity is derived internally and
   * its phrase is returned in the result.
   */
  pendingIdentity?: PendingIdentityResult;
}

/** Result of a successful key rotation. */
export interface RotateKeyResult {
  /** The account's new (rotated) public key. */
  newPublicKey: string;
  /**
   * The NEW identity's recovery phrase. It MUST be surfaced to the user so they
   * can back up the rotated key — if lost, the new identity is unrecoverable.
   */
  newPhrase: string;
  /** The recovery phrase split into its individual words. */
  words: string[];
  /**
   * Present (and `true`) only when the server rotated successfully but the new
   * key could NOT be persisted on-device. The account key IS the new one
   * server-side, so the user must re-import it from `newPhrase`; the caller
   * should surface a recovery prompt. Omitted on full success.
   */
  localPersistFailed?: true;
}

/**
 * Derive a user's Oxy DID from their stable account id.
 * `did:web:oxy.so:u:<userId>`.
 */
export function buildUserDid(userId: string): string {
  return `did:web:${OXY_IDENTITY_APEX}:u:${userId}`;
}

/**
 * Sign a self-issued v2 signed-record envelope on the CURRENT user's own
 * per-subject hash chain. Fetches the chain head fresh (uncached, so `seq`/`prev`
 * are never stale → no `bad_seq`/`chain_fork`) and signs with the on-device key.
 *
 * Shared by `oxy.civic` and `oxy.nodes`; not part of the public surface.
 * NATIVE-ONLY. Throws before any network call when no user is signed in.
 */
export async function signOwnChainRecord(
  ctx: OxyContext,
  type: OxySignedRecordType,
  record: Record<string, unknown>,
  key: { collection: string; rkey: string },
): Promise<SignedRecordEnvelope> {
  const userId = ctx.oxy.session.userId;
  if (!userId) {
    throw new Error('No authenticated user — cannot sign a record.');
  }
  const head = await ctx.request<ChainHeadResponse>(
    'GET',
    `/identity/records/${encodeURIComponent(userId)}/chain/head`,
    undefined,
    { cache: false },
  );
  const { SignatureService } = await import('../crypto/internal');
  return SignatureService.signRecordV2(type, buildUserDid(userId), record, {
    seq: head.seq + 1,
    prev: head.headRecordId,
    collection: key.collection,
    rkey: key.rkey,
  });
}

export class IdentityApi {
  /** Identity links: Commons' root joined to an account (ADR 0029 D3). */
  readonly links: IdentityLinksApi;
  /** Verified-domain badges. */
  readonly domains: IdentityDomainsApi;
  /** The encrypted off-device key backup. */
  readonly backup: IdentityBackupApi;

  constructor(private readonly ctx: OxyContext) {
    const invalidate = () => this.invalidate(this.ctx.oxy.session.userId);
    this.links = new IdentityLinksApi(ctx, invalidate);
    this.domains = new IdentityDomainsApi(ctx, invalidate);
    this.backup = new IdentityBackupApi(ctx);
  }

  /**
   * The signed-in user's DID (`did:web:oxy.so:u:<userId>`), derived locally from
   * the access token. Throws when signed out.
   */
  get did(): string {
    const userId = this.ctx.oxy.session.userId;
    if (!userId) {
      throw new Error('No authenticated user — cannot derive DID.');
    }
    return buildUserDid(userId);
  }

  /**
   * Resolve the W3C DID document for any user. The API derives it on demand
   * from the account's `authMethods` + `publicKey` — there is no stored
   * document. Public (no auth required); short-TTL cached.
   */
  async resolveDid(userId: string): Promise<DidDocument> {
    return this.ctx.request<DidDocument>('GET', `/u/${encodeURIComponent(userId)}/did.json`, undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
  }

  /**
   * The signed-in user's linked authentication methods plus their DID. Each
   * `identity` method carries a `verificationMethodId` linking it to its DID
   * verification-method fragment.
   */
  async authMethods(): Promise<AuthMethodsResponse> {
    return this.ctx.request<AuthMethodsResponse>('GET', '/auth/methods', undefined, { cache: true, cacheTTL: SHORT_TTL });
  }

  /**
   * How the signed-in account is kept (ADR 0029 D3): whether Commons' root is
   * linked (self-custody), or the email of an account without a key.
   */
  async rootStatus(): Promise<IdentityRootStatus> {
    return this.ctx.request<IdentityRootStatus>('GET', '/identity/root-status', undefined, { cache: false });
  }

  /**
   * Rotate the account's identity key: derive a brand-new keypair, prove
   * control of the CURRENT key, and have the server ATOMICALLY replace the old
   * key with the new one.
   *
   * The rotation is an atomic REPLACE on the server (never remove-then-add), so
   * it never passes through a zero-auth-method state. Because control of the
   * current key is PROVEN (from SecureStore in `'device'` mode, or a
   * recovery-phrase re-derivation in `'phrase'` mode), even the LAST remaining
   * credential can be replaced.
   *
   * Ordering (safety-critical): the new key is persisted on-device ONLY AFTER
   * the server confirms the swap. Persisting earlier would clobber the local
   * key while the server still trusts the old one, locking the device out.
   *
   * Ambiguous-network-failure guard: if the `complete` response is lost
   * (request sent, no reply), the swap may already have applied server-side.
   * Before surfacing the error we reconcile against the derived DID document —
   * if it already advertises the new key, the rotation is treated as done.
   *
   * The UI is responsible for showing `newPhrase` to the user. For a
   * "show-phrase-first" flow, derive the identity up front via
   * `RecoveryPhraseService.derivePendingIdentity`, display it, then pass it back
   * as `options.pendingIdentity` so the SAME identity is committed.
   *
   * @throws when no user is authenticated, when `proof: 'phrase'` is given
   *   without a `phrase`, when `proof: 'device'` runs with no on-device key,
   *   or when the rotation does not complete.
   */
  async rotateKey(options: RotateKeyOptions): Promise<RotateKeyResult> {
    const userId = this.ctx.oxy.session.userId;
    if (!userId) {
      throw new Error('No authenticated user — sign in before rotating your key.');
    }

    const { KeyManager, RecoveryPhraseService, SignatureService, signMessage } = await import('../crypto/internal');

    // 1. The NEW identity (in memory only). The UI may pre-derive + pre-show
    //    it and pass it back here so the phrase shown === the phrase committed.
    const pending = options.pendingIdentity ?? (await RecoveryPhraseService.derivePendingIdentity());
    const newPublicKey = pending.publicKey;

    // 2. Resolve the OLD signing capability from the chosen proof mode.
    let oldPublicKey: string;
    let signWithOldKey: (message: string) => Promise<string>;
    if (options.proof === 'phrase') {
      const phrase = options.phrase?.trim();
      if (!phrase) {
        throw new Error('A recovery phrase is required for phrase-proof rotation.');
      }
      const oldPrivateKey = await RecoveryPhraseService.derivePrivateKeyFromPhrase(phrase);
      oldPublicKey = KeyManager.derivePublicKey(oldPrivateKey);
      signWithOldKey = (message) => signMessage(message, oldPrivateKey);
    } else {
      const currentPublicKey = await KeyManager.getPublicKey();
      if (!currentPublicKey) {
        throw new Error('No on-device identity found. Use the recovery-phrase option to rotate your key.');
      }
      oldPublicKey = currentPublicKey;
      signWithOldKey = (message) => SignatureService.sign(message);
    }

    // 3. Request a single-use rotate_key challenge (bearer).
    const { challenge } = await this.ctx.request<RotateKeyChallengeResponse>('POST', '/auth/rotate/challenge', undefined, {
      cache: false,
    });

    // 4. Sign the rotation proofs. The OLD key proves control of the key being
    //    replaced; the NEW key proves possession of the key being rotated in.
    //    Both signed byte strings MUST match the server's reconstruction exactly
    //    (this key order). The old key is canonicalized so legacy compressed
    //    encodings still verify.
    const timestamp = Date.now();
    const canonicalOldPublicKey = KeyManager.canonicalPublicKey(oldPublicKey);
    const message = JSON.stringify({
      action: 'rotate_key',
      userId,
      oldPublicKey: canonicalOldPublicKey,
      newPublicKey,
      challenge,
      timestamp,
    });
    const signature = await signWithOldKey(message);
    const newKeyMessage = JSON.stringify({
      action: 'rotate_key_new',
      userId,
      newPublicKey,
      challenge,
      timestamp,
    });
    const newKeyProof = await signMessage(newKeyMessage, pending.privateKey);

    // 5. Complete the rotation. On an AMBIGUOUS failure, reconcile against the
    //    DID before deciding the rotation failed.
    let applied = false;
    try {
      const result = await this.ctx.request<RotateKeyCompleteResponse>(
        'POST',
        '/auth/rotate/complete',
        {
          newPublicKey,
          challenge,
          signature,
          newKeyProof,
          timestamp,
          ...(options.signOutEverywhere ? { signOutEverywhere: true } : {}),
        },
        { cache: false },
      );
      applied = result.success && result.publicKey.toLowerCase() === newPublicKey.toLowerCase();
    } catch (error) {
      if (!(await this.rotationAlreadyApplied(userId, newPublicKey))) {
        throw error;
      }
      applied = true;
    }

    if (!applied) {
      throw new Error('Key rotation did not complete — your previous key is unchanged.');
    }

    // 6. ONLY after the server confirms the swap, persist the new key locally.
    //    Native-only — on web the key never lived in SecureStore.
    //
    //    If this local write fails the server key is ALREADY the new one, so we
    //    must NOT throw and swallow the phrase — the caller needs it to re-import
    //    the now-live key (`localPersistFailed: true`).
    //
    //    The SHARED slot is written FIRST, and that order is load-bearing: every
    //    cross-app reader takes the shared slot before the primary
    //    (`deriveScopedSeed`, which is where Peable's FairCoin wallet comes from).
    //    Leaving the replaced key there was silent money loss — payers derive the
    //    recipient's address from the key in the DID (now the new one) while the
    //    recipient's wallet still watches addresses from the old one. Shared first
    //    means a crash between the two writes fails LOUDLY on the next signature
    //    instead of quietly misdirecting funds; `syncSharedIdentity` repairs it.
    let localPersistFailed = false;
    if (!isWeb()) {
      try {
        if (await KeyManager.hasSharedIdentity()) {
          await KeyManager.importSharedIdentity(pending.privateKey);
        }
        await KeyManager.importKeyPair(pending.privateKey, { overwrite: true });
      } catch (persistError) {
        localPersistFailed = true;
        logger.warn(
          'Key rotated on the server but persisting the new key on-device failed; returning the new phrase so it can be re-imported.',
          { component: 'oxy.identity', method: 'rotateKey' },
          persistError,
        );
      }
    }

    this.invalidate(userId);

    return localPersistFailed
      ? { newPublicKey, newPhrase: pending.phrase, words: pending.words, localPersistFailed: true }
      : { newPublicKey, newPhrase: pending.phrase, words: pending.words };
  }

  /**
   * The signed-in user's signed, open-format data-export bundle
   * (`GET /users/me/export`) — the "credible exit" snapshot. Always carries an
   * Oxy provenance `attestation`; carries an optional client `proof` when the
   * account holds its own key.
   */
  async export(): Promise<ExportBundle> {
    return this.ctx.request<ExportBundle>('GET', '/users/me/export', undefined, { cache: false });
  }

  /**
   * Reconciliation probe for the rotation ambiguous-failure guard: whether the
   * account's derived DID document (uncached) already advertises `newPublicKey`.
   * A failed probe returns `false`, so the caller surfaces the original error.
   *
   * Uses the DID document rather than `GET /auth/methods` because the latter
   * intentionally does NOT expose raw public keys, whereas the DID's
   * `verificationMethod[].publicKeyHex` reflects a completed rotation at once.
   */
  private async rotationAlreadyApplied(userId: string, newPublicKey: string): Promise<boolean> {
    return this.ctx
      .request<DidDocument>('GET', `/u/${encodeURIComponent(userId)}/did.json`, undefined, { cache: false })
      .then((doc) =>
        doc.verificationMethod.some(
          (vm) =>
            'publicKeyHex' in vm &&
            typeof vm.publicKeyHex === 'string' &&
            vm.publicKeyHex.toLowerCase() === newPublicKey.toLowerCase(),
        ),
      )
      .catch(() => false);
  }

  /**
   * Bust the cached reads an identity mutation invalidates: the current user
   * (`/users/me*`), the auth-methods list, the verified-domains list, and the
   * user's derived DID document (which embeds auth methods + verified domains).
   */
  private invalidate(userId: string | null): void {
    const keys = ['GET:/auth/methods', 'GET:/identity/domains'];
    if (userId) keys.push(`GET:/u/${encodeURIComponent(userId)}/did.json`);
    this.ctx.http.invalidateCache({ keys, prefixes: ['GET:/users/me'] });
  }
}

/** `oxy.identity.links` — joining Commons' root to an account (ADR 0029 D3). */
export class IdentityLinksApi {
  constructor(
    private readonly ctx: OxyContext,
    private readonly invalidate: () => void,
  ) {}

  /**
   * Open a request to link Commons to the signed-in account.
   * The "Link Commons" panel shows its `qrPayload`; Commons scans it and signs with `sign`.
   */
  async create(): Promise<IdentityLinkCreateResponse> {
    const res = await this.ctx.request<unknown>('POST', '/identity/link', undefined, { cache: false });
    const parsed = safeParseContract(identityLinkCreateResponseSchema, res);
    if (!parsed) throw new Error('identity/link returned an unexpected response shape');
    return parsed;
  }

  /** Where a link request stands. Both devices poll it; it needs no session. */
  async get(linkId: string): Promise<IdentityLinkState> {
    const res = await this.ctx.request<unknown>('GET', `/identity/link/${encodeURIComponent(linkId)}`, undefined, {
      cache: false,
      skipAuth: true,
    });
    const parsed = safeParseContract(identityLinkStateSchema, res);
    if (!parsed) throw new Error('identity/link returned an unexpected response shape');
    return parsed;
  }

  /**
   * Commons' half: sign the scanned request's `link_identity` proof with THIS
   * device's identity key and post it. NATIVE-ONLY. Resolves to the key and the
   * 6-digit code the other screen will show for it, for the person to compare.
   */
  async sign(linkId: string, challenge: string): Promise<{ publicKey: string; code: string; username: string | null }> {
    const { KeyManager, signIdentityProof, deriveIdentityLinkCode } = await import('../crypto/internal');
    const [privateKey, publicKey] = await Promise.all([KeyManager.getPrivateKey(), KeyManager.getPublicKey()]);
    if (!privateKey || !publicKey) {
      throw new Error('No identity on this device to link');
    }
    const root = publicKey.trim().toLowerCase();
    const state = await this.get(linkId);
    const proof = await signIdentityProof(
      { privateKey, publicKey: root },
      {
        action: IDENTITY_PROOF_ACTIONS.link,
        subject: state.userId,
        actor: state.userId,
        rootPublicKey: root,
        payloadDigest: null,
        expectedRevision: null,
        audience: state.audience,
        challenge,
        expiresAt: state.expiresAt,
      },
    );
    await this.ctx.request<unknown>(
      'POST',
      `/identity/link/${encodeURIComponent(linkId)}/proof`,
      { publicKey: root, proof },
      { cache: false, skipAuth: true },
    );
    return { publicKey: root, code: deriveIdentityLinkCode(linkId, root), username: state.username };
  }

  /**
   * Complete a link with a code just sent to the account's email
   * (`oxy.auth.requestReauthCode`) — plus its authenticator code when it has
   * one. The account gains Commons' root and loses its email; every other
   * session of the account is signed out.
   */
  async complete(
    linkId: string,
    reauth: { emailCode: { verificationId: string; code: string }; totpCode?: string },
  ): Promise<{ success: true }> {
    const result = await this.ctx.request<{ success: true }>(
      'POST',
      `/identity/link/${encodeURIComponent(linkId)}/complete`,
      { reauth },
      { cache: false },
    );
    this.invalidate();
    return result;
  }

  /** Withdraw a link request that has not completed. */
  async cancel(linkId: string): Promise<void> {
    await this.ctx.request<unknown>('DELETE', `/identity/link/${encodeURIComponent(linkId)}`, undefined, { cache: false });
  }
}

/** `oxy.identity.domains` — verified-domain badges (prove ownership of `nate.com`). */
export class IdentityDomainsApi {
  constructor(
    private readonly ctx: OxyContext,
    private readonly invalidate: () => void,
  ) {}

  /**
   * Start verifying ownership of a domain. Returns the instructions: publish
   * EITHER the DNS-TXT record OR the `/.well-known/oxy-domain` file, then call
   * `verify`.
   */
  async requestVerification(domain: string): Promise<DomainVerificationInstructions> {
    return this.ctx.request<DomainVerificationInstructions>('POST', '/identity/domains', { domain }, { cache: false });
  }

  /**
   * Complete domain verification: the server checks the DNS-TXT record or
   * well-known file and, on success, attaches the domain to the account
   * (surfaced in the DID's `alsoKnownAs` and the user's `verifiedDomains`).
   */
  async verify(domain: string): Promise<VerifyDomainResult> {
    const result = await this.ctx.request<VerifyDomainResult>(
      'POST',
      `/identity/domains/${encodeURIComponent(domain)}/verify`,
      undefined,
      { cache: false },
    );
    this.invalidate();
    return result;
  }

  /** The signed-in user's verified domains. */
  async list(): Promise<VerifiedDomain[]> {
    const res = await this.ctx.request<{ domains?: VerifiedDomain[] }>('GET', '/identity/domains', undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
    return res.domains ?? [];
  }

  /** Remove a verified domain from the signed-in account. */
  async remove(domain: string): Promise<RemoveDomainResult> {
    const result = await this.ctx.request<RemoveDomainResult>(
      'DELETE',
      `/identity/domains/${encodeURIComponent(domain)}`,
      undefined,
      { cache: false },
    );
    this.invalidate();
    return result;
  }
}

// ── Encrypted backup ───────────────────────────────────────────────────────

/** Envelope/KDF version — bump only on a breaking scheme change. */
const BACKUP_ENVELOPE_VERSION = 1;
/** The AEAD the backup is sealed with. Pinned so a mismatched decryptor fails loudly. */
const BACKUP_ALGORITHM = 'xchacha20poly1305' as const;
/**
 * Length (hex chars) of the public-key HINT stored/echoed with a backup — enough
 * to recognise WHICH identity a backup belongs to, but only a prefix.
 */
const PUBLIC_KEY_HINT_LENGTH = 16;

/** The decrypted backup payload. */
interface BackupPayload {
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

/** Encode bytes as lowercase hex (cross-platform, no Buffer dependency). */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Decode a hex string to bytes. Throws on malformed input. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('Malformed hex in encrypted backup envelope.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The AEAD associated data binds the ciphertext to its `{version, publicKeyHint}`
 * context, so a mismatched version or hint (an envelope re-stamped by a
 * tamperer) fails the Poly1305 check. Both sides build the SAME object literal,
 * so `JSON.stringify` yields identical bytes.
 */
function buildBackupAad(version: number, publicKeyHint: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version, publicKeyHint }));
}

/**
 * `oxy.identity.backup` — an ENCRYPTED copy of the self-custody key, stored
 * off-device so a lost device can be recovered from the recovery phrase alone,
 * while the platform never sees the phrase, the derived key, or the plaintext.
 *
 * Key schedule (from the recovery phrase; `RecoveryPhraseService.deriveBackupMaterial`):
 *   seed      = mnemonicToSeed(phrase)
 *   backupKey = HKDF(seed, 'oxy-identity-backup-v1', 'oxy-backup-encryption-key')
 *   lookupId  = HKDF(seed, 'oxy-identity-backup-v1', 'oxy-backup-lookup-id')
 *
 * Both need the FULL seed, so leaking only the raw private key can neither
 * locate nor decrypt the backup. Persisting a restored key is NATIVE-ONLY.
 */
export class IdentityBackupApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * Encrypt the identity derived from `phrase` and upload the ciphertext + raw
   * `lookupId` (`POST /identity/backup`). The server stores only
   * `sha256(lookupId)` + the ciphertext. A re-upload REPLACES the prior backup.
   * Works cross-platform: the identity is derived from the phrase, not read
   * from SecureStore.
   */
  async create(phrase: string): Promise<BackupStatusResponse> {
    const { KeyManager, RecoveryPhraseService, BACKUP_KDF_ENCRYPTION_INFO, encryptAead } = await import('../crypto/internal');
    const { backupKey, lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);
    const privateKey = await RecoveryPhraseService.derivePrivateKeyFromPhrase(phrase);
    const publicKey = KeyManager.derivePublicKey(privateKey);
    const createdAt = new Date().toISOString();
    const publicKeyHint = publicKey.slice(0, PUBLIC_KEY_HINT_LENGTH);

    const payload: BackupPayload = { privateKey, publicKey, createdAt };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const aad = buildBackupAad(BACKUP_ENVELOPE_VERSION, publicKeyHint);
    const { nonce, ciphertext } = encryptAead(backupKey, plaintext, aad);

    const body: BackupUploadRequest = {
      version: BACKUP_ENVELOPE_VERSION,
      algorithm: BACKUP_ALGORITHM,
      kdfInfo: BACKUP_KDF_ENCRYPTION_INFO,
      nonce: toHex(nonce),
      ciphertext: toHex(ciphertext),
      publicKeyHint,
      createdAt,
      lookupId,
    };

    return this.ctx.request<BackupStatusResponse>('POST', '/identity/backup', body, { cache: false });
  }

  /**
   * Whether the signed-in user has a stored backup, plus its non-sensitive hint
   * and timestamp. Returns no ciphertext and no locator.
   */
  async status(): Promise<BackupStatusResponse> {
    return this.ctx.request<BackupStatusResponse>('GET', '/identity/backup/status', undefined, { cache: false });
  }

  /** Delete the signed-in user's stored backup. Idempotent. */
  async delete(): Promise<{ success: boolean }> {
    return this.ctx.request<{ success: boolean }>('DELETE', '/identity/backup', undefined, { cache: false });
  }

  /**
   * Restore an identity from its encrypted backup using ONLY the recovery
   * phrase: re-derive `{backupKey, lookupId}`, fetch the envelope by `lookupId`
   * (PUBLIC — the 256-bit locator is the protection), decrypt + authenticate
   * locally, then persist the key.
   *
   * NATIVE-ONLY persistence. Refuses to clobber a DIFFERENT existing on-device
   * identity unless `overwrite: true` — the `IdentityAlreadyExistsError`
   * propagates so the UI can confirm before overwriting.
   *
   * @returns The restored identity's public key.
   * @throws if the phrase is invalid, no backup exists (404), the ciphertext
   *   fails authentication (tamper), or an existing identity blocks the import.
   */
  async restore(phrase: string, options?: { overwrite?: boolean }): Promise<string> {
    const { KeyManager, RecoveryPhraseService, decryptAead } = await import('../crypto/internal');
    const { backupKey, lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);

    const envelope = await this.ctx.request<EncryptedBackupEnvelope>(
      'GET',
      `/identity/backup/${encodeURIComponent(lookupId)}`,
      undefined,
      { cache: false },
    );

    if (envelope.algorithm !== BACKUP_ALGORITHM) {
      throw new Error(`Unsupported backup algorithm: ${envelope.algorithm}`);
    }

    const aad = buildBackupAad(envelope.version, envelope.publicKeyHint);
    const plaintext = decryptAead(backupKey, fromHex(envelope.nonce), fromHex(envelope.ciphertext), aad);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as BackupPayload;

    if (!payload.privateKey || !payload.publicKey) {
      throw new Error('Backup payload is missing key material');
    }

    const phrasePk = (await RecoveryPhraseService.derivePublicKeyFromPhrase(phrase)).toLowerCase();
    const payloadPk = payload.publicKey.toLowerCase();
    const privatePk = KeyManager.derivePublicKey(payload.privateKey).toLowerCase();
    if (phrasePk !== payloadPk || privatePk !== payloadPk) {
      throw new Error('Backup payload does not match the recovery phrase');
    }

    return KeyManager.importKeyPair(payload.privateKey, { overwrite: options?.overwrite === true });
  }
}

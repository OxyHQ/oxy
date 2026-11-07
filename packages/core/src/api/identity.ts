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
  checkContract,
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  identityLinkCreateResponseCheck,
  identityLinkStateCheck,
} from '@oxy.so/contracts/client';
import {
  IDENTITY_KEY_HISTORY_CLAIM_ACTION,
  identityKeyHistoryCheck,
  type IdentityKeyHistory,
} from '@oxy.so/contracts/client';
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
  ReauthProof,
  RotateKeyChallengeResponse,
  RotateKeyCompleteResponse,
  SignedRecordEnvelope,
  VerifiedDomain,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { PendingIdentityResult } from '../crypto/recoveryPhrase';
import { isAndroid, isWeb } from '../utils/platform';
import { logger } from '../logger';
import { extractErrorStatus } from '../utils/errorUtils';

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

/** Options for {@link IdentityApi.resolveDid}. */
export interface ResolveDidOptions {
  /**
   * Read the document from the origin now, never from a cache. Required when
   * `#key-1` decides where money goes (deriving a Peable receive address): the
   * key changes on a rotation or an organization key replacement.
   */
  fresh?: boolean;
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
  /**
   * The person's choice, in the rotation flow, about an encrypted backup when
   * they have none of the current key (owner's decision, 2026-11-07). Only
   * `true` creates one, sent as their `optIn`; `false` uploads nothing and
   * marks nothing owed:
   *  - they DELETED theirs (`backup.status().optedOut`): absent is `false`;
   *  - they have none on record (never made one, or deleted it before
   *    deletions were recorded, which look the same): REQUIRED. Absent, the
   *    rotation is refused before anything changes: a choice the person was
   *    never shown (a screen whose own status read failed) is never taken as
   *    "create". Show them the choice before the swap.
   * Ignored when they have a backup (current or superseded): it is re-sealed
   * so it keeps every key (points 5 and 8 of ADR 0061 D7).
   */
  createBackup?: boolean;
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
  /**
   * Whether the encrypted identity backup was re-created under the NEW phrase,
   * carrying the retired ring with the key just replaced (R4-4) and every key
   * the previous backup carried (R5-6). The server deletes the old backup in
   * the rotation's transaction; `false` (the upload failed) means the caller
   * should offer "Create backup" again — `oxy.identity.backup.isOwed()` stays
   * `true` until one is sealed — or the replaced key lives only on this phone.
   * Absent when the person had no backup and did not choose one
   * (`backupOptedOut`).
   */
  backupRefreshed?: boolean;
  /**
   * `true` when the person has no encrypted backup by their own choice (they
   * deleted it, or declined one in this rotation; owner's decision,
   * 2026-11-07): nothing was uploaded and no backup is owed. The replaced key
   * is kept on this phone for spending; off this phone it is recoverable only
   * with its own recovery phrase, which the person must keep.
   */
  backupOptedOut?: true;
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
  const { SignatureService } = await import('../crypto/index');
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
   *
   * `{ fresh: true }` reads the document as it is NOW: it skips (and drops)
   * this client's cached copy, is not joined to an in-flight read, and sends
   * `Cache-Control: no-cache` so no HTTP cache on the way answers for the
   * origin. Use it whenever the answer decides where money goes: `#key-1` is
   * the account's Peable receive key and changes on a rotation or an
   * organization key replacement, and a cached copy would derive an address
   * from the previous key for up to the cache TTL.
   */
  async resolveDid(userId: string, options: ResolveDidOptions = {}): Promise<DidDocument> {
    const path = `/u/${encodeURIComponent(userId)}/did.json`;
    if (options.fresh) {
      this.ctx.http.invalidateCache({ keys: [`GET:${path}`] });
      return this.ctx.request<DidDocument>('GET', path, undefined, {
        cache: false,
        deduplicate: false,
        headers: { 'Cache-Control': 'no-cache' },
      });
    }
    return this.ctx.request<DidDocument>('GET', path, undefined, {
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
    return this.ctx.request<AuthMethodsResponse>('GET', '/auth/methods', undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
  }

  /**
   * How the signed-in account is kept (ADR 0029 D3): whether Commons' root is
   * linked (self-custody), or the email of an account without a key.
   */
  async rootStatus(): Promise<IdentityRootStatus> {
    return this.ctx.request<IdentityRootStatus>('GET', '/identity/root-status', undefined, {
      cache: false,
    });
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

    const {
      KeyManager,
      RecoveryPhraseService,
      SignatureService,
      signMessage,
      retireIdentityKey,
      quarantineRetiredIdentityKey,
    } = await import('../crypto/index');
    const proofPhrase = options.proof === 'phrase' ? options.phrase?.trim() : undefined;

    // 1. The NEW identity (in memory only). The UI may pre-derive + pre-show
    //    it and pass it back here so the phrase shown === the phrase committed.
    const pending =
      options.pendingIdentity ?? (await RecoveryPhraseService.derivePendingIdentity());
    const newPublicKey = pending.publicKey;

    // 2. Resolve the OLD signing capability from the chosen proof mode.
    let oldPublicKey: string;
    let signWithOldKey: (message: string) => Promise<string>;
    let oldPrivateKeyForRing: string | null;
    if (options.proof === 'phrase') {
      const phrase = options.phrase?.trim();
      if (!phrase) {
        throw new Error('A recovery phrase is required for phrase-proof rotation.');
      }
      const oldPrivateKey = await RecoveryPhraseService.derivePrivateKeyFromPhrase(phrase);
      oldPublicKey = KeyManager.derivePublicKey(oldPrivateKey);
      signWithOldKey = (message) => signMessage(message, oldPrivateKey);
      oldPrivateKeyForRing = oldPrivateKey;
    } else {
      const currentPublicKey = await KeyManager.getPublicKey();
      if (!currentPublicKey) {
        throw new Error(
          'No on-device identity found. Use the recovery-phrase option to rotate your key.',
        );
      }
      oldPublicKey = currentPublicKey;
      signWithOldKey = (message) => SignatureService.sign(message);
      oldPrivateKeyForRing = isWeb() ? null : await KeyManager.getPrivateKey();
    }

    // 2a. On a phone, the account's own key history (R6-10): the key being
    //     replaced must be the account's CURRENT root (a phrase for any other
    //     key would bind that key to this account in the ring), and every
    //     other key a slot holds is bound to this account only when the
    //     history names it. Unreadable: nothing changes.
    let history: IdentityKeyHistory | null = null;
    if (!isWeb()) {
      try {
        history = await this.keyHistory();
      } catch (historyError) {
        throw new Error(
          `Your key history could not be read, so your key was not rotated. Nothing changed. (${historyError instanceof Error ? historyError.message : 'unknown'})`,
        );
      }
      const current = history.publicKey?.toLowerCase() ?? null;
      if (current !== KeyManager.canonicalPublicKey(oldPublicKey).toLowerCase()) {
        throw new Error(
          'That is not the current key of this account, so it was not rotated. Nothing changed.',
        );
      }
    }
    const namedByHistory = new Set(
      [history?.publicKey ?? null, ...(history?.retired ?? []).map((entry) => entry.publicKey)]
        .filter((key): key is string => key !== null)
        .map((key) => key.toLowerCase()),
    );

    // 2b. Keep the key being replaced in the retired ring BEFORE anything
    //     changes (oxy ADR 0061 D7 as amended, Peable ADR 0002): coins keep
    //     arriving under it after the swap, and the Peable wallet spends them
    //     through the `publicKey` selector of `deriveScopedSeed` /
    //     `signSocialReceive`. A device that cannot keep it does not rotate:
    //     the phrase would become the only way to those coins. Native only —
    //     on web no key is stored. Idempotent, so a retried rotation is fine.
    if (!isWeb()) {
      try {
        if (!oldPrivateKeyForRing) throw new Error('no readable private key');
        await retireIdentityKey(
          { privateKey: oldPrivateKeyForRing, publicKey: oldPublicKey },
          { ownerAccountId: userId },
        );
      } catch (retainError) {
        logger.warn(
          'Could not keep the current key as a retired key; not rotating.',
          { component: 'oxy.identity', method: 'rotateKey' },
          retainError,
        );
        throw new Error(
          'Your current key could not be kept on this device, so it was not rotated. Nothing changed.',
        );
      }
    }

    // 2c. The rotation deletes the encrypted backup in its transaction. Read it
    //     first, with the CURRENT phrase, so the re-seal under the new phrase
    //     carries every key it carried (R5-6): its retired keys and the key
    //     being replaced. A backup that exists but cannot be read here stops
    //     the rotation with nothing changed — sealing without it would drop
    //     keys only that backup holds.
    const previousBackup = await this.backup.readBeforeRotation(
      async () =>
        proofPhrase ?? (isWeb() ? null : await KeyManager.getRecoveryMnemonicForCurrentIdentity()),
    );
    // The person DELETED their backup (owner's decision, 2026-11-07): never
    // re-upload one silently. Only their explicit choice in this flow
    // (`createBackup`) seals one, and sends their opt-in with it. Otherwise
    // nothing is uploaded and nothing is owed: the replaced key stays on this
    // phone (2b) and, off it, only its own phrase recovers it.
    // A person with no backup on record (never made, or deleted before
    // deletions were recorded) is shown the same choice, and must have made
    // it: without one the rotation stops here, before the challenge, so a
    // screen that could not show it never rotates as "create". Oxy refuses an
    // upload without `optIn` where the account has no backup row anyway.
    const optedOut = previousBackup.optedOut === true;
    const noneOnRecord = !optedOut && !previousBackup.existed && previousBackup.superseded !== true;
    if (noneOnRecord && options.createBackup === undefined) {
      throw new Error(
        'Choose whether to create an encrypted backup before rotating: you have none. Your key was not rotated. Nothing changed.',
      );
    }
    const optIn = (optedOut || noneOnRecord) && options.createBackup === true;
    const declined = noneOnRecord && options.createBackup === false;
    const noBackupByChoice = (optedOut && !optIn) || declined;
    const resealBackup = noBackupByChoice ? false : optIn || !isWeb() || previousBackup.existed;

    // 2d. The keys that backup carries go into this device's ring NOW, before
    //     the server swap supersedes it (security review R7-2): the new
    //     phrase cannot open it, so a re-seal that fails after the swap would
    //     otherwise leave them in memory only. Each is bound to this account
    //     when its key history names it, kept quarantined otherwise (R6-10);
    //     the key being replaced was kept in 2b. A key that cannot be kept
    //     stops the rotation with nothing changed on the server.
    if (!isWeb() && previousBackup.carried.length > 0) {
      const replaced = KeyManager.canonicalPublicKey(oldPublicKey).toLowerCase();
      for (const key of previousBackup.carried) {
        const id = key.publicKey.toLowerCase();
        if (id === replaced) continue;
        const pair = { privateKey: key.privateKey, publicKey: key.publicKey };
        try {
          if (namedByHistory.has(id)) {
            await retireIdentityKey(pair, { ownerAccountId: userId });
          } else {
            await quarantineRetiredIdentityKey(pair, undefined, { exempt: true });
          }
        } catch (keepError) {
          logger.warn(
            'Could not keep a key the encrypted backup carries; not rotating.',
            { component: 'oxy.identity', method: 'rotateKey' },
            keepError,
          );
          throw new Error(
            'A previous key your encrypted backup holds could not be kept on this device, so your key was not rotated. Nothing changed.',
          );
        }
      }
    }

    // 3. Request a single-use rotate_key challenge (bearer).
    const { challenge } = await this.ctx.request<RotateKeyChallengeResponse>(
      'POST',
      '/auth/rotate/challenge',
      undefined,
      {
        cache: false,
      },
    );

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

    // 4b. The new backup is owed from the moment the swap may happen until
    //     one is sealed and the server CONFIRMED it (R5-9, R6-9): a crash, a
    //     failed or ambiguous upload, a lost response or a closed app in
    //     between leaves the flag, and Commons keeps asking
    //     (`backup.isOwed()`). Marked only now, after every step that cannot
    //     change anything server-side.
    //     The entry also keeps the previous backup's locator (R7-2): this
    //     device carried its keys into the ring in 2d, so the next seal may
    //     replace it once the swap superseded it. What was owed BEFORE this
    //     attempt is snapshotted, and put back when the server refuses (R7-10).
    const owedBefore = isWeb() ? null : await KeyManager.backupOwedEntry(userId);
    if (resealBackup && !isWeb()) {
      const owedWith = {
        ...(previousBackup.replacesLookupId
          ? { supersededLookupId: previousBackup.replacesLookupId }
          : {}),
        ...(optIn ? { optIn: true } : {}),
      };
      await KeyManager.markBackupOwed(
        userId,
        Object.keys(owedWith).length > 0 ? owedWith : undefined,
      );
    }

    // 5. Complete the rotation. On an AMBIGUOUS failure, reconcile against the
    //    DID before deciding the rotation failed.
    let applied = false;
    const notRotated = async (error: unknown, definitive: boolean): Promise<never> => {
      // Only a definitive refusal (the server answered 4xx: its checks and
      // its transaction refused, nothing changed and the old backup still
      // exists) clears the owed flag. Anything ambiguous (no response, a 5xx
      // that may have come after the commit, an unreadable DID) keeps it: an
      // owed backup that was not needed costs one prompt; one cleared while
      // the swap went through costs the backup (R6-9). A refusal puts back
      // what was owed before this attempt, never less (R7-10).
      if (definitive && resealBackup && !isWeb()) {
        await KeyManager.restoreBackupOwed(userId, owedBefore);
      }
      throw error;
    };
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
        const status = extractErrorStatus(error);
        await notRotated(error, status !== undefined && status >= 400 && status < 500);
      }
      applied = true;
    }

    if (!applied) {
      await notRotated(
        new Error('Key rotation did not complete — your previous key is unchanged.'),
        false,
      );
    }

    // 6. ONLY after the server confirms the swap, persist the new key locally.
    //    Native-only — on web the key never lived in SecureStore.
    //
    //    If this local write fails the server key is ALREADY the new one, so we
    //    must NOT throw and swallow the phrase — the caller needs it to re-import
    //    the now-live key (`localPersistFailed: true`).
    //
    //    The SHARED slot is written FIRST, and that order is load-bearing: it is
    //    what every other Oxy app is served (iOS: the keychain group; Android:
    //    the signer store Commons' identity host answers from), including
    //    `deriveScopedSeed`, which is where Peable's FairCoin wallet comes from.
    //    Leaving the replaced key there was silent money loss — payers derive the
    //    recipient's address from the key in the DID (now the new one) while the
    //    recipient's wallet still watches addresses from the old one. Shared first
    //    means a crash between the two writes fails LOUDLY on the next signature
    //    instead of quietly misdirecting funds; `syncSharedIdentity` repairs it.
    let localPersistFailed = false;
    if (!isWeb()) {
      try {
        // No slot write drops a key (R4-12): a key a slot holds that is
        // neither the one just replaced (kept in 2b) nor the new one — an
        // older identity this phone still had — is kept in the ring first.
        // When that cannot be confirmed nothing is overwritten
        // (`localPersistFailed`: the user re-imports from the phrase shown).
        const keep = new Set([
          KeyManager.canonicalPublicKey(oldPublicKey).toLowerCase(),
          KeyManager.canonicalPublicKey(newPublicKey).toLowerCase(),
        ]);
        for (const held of await KeyManager.heldIdentityPrivateKeys()) {
          const heldPublic = KeyManager.derivePublicKey(held).toLowerCase();
          if (keep.has(heldPublic)) continue;
          // Bound to this account only when its history names the key
          // (R6-10); any other is kept quarantined, for whichever account's
          // history later names it.
          if (namedByHistory.has(heldPublic)) {
            await retireIdentityKey(
              { privateKey: held, publicKey: heldPublic },
              { ownerAccountId: userId },
            );
          } else {
            // A key this phone held itself: kept whatever a planted shared
            // group put in the quarantine (R7-5).
            await quarantineRetiredIdentityKey(
              { privateKey: held, publicKey: heldPublic },
              undefined,
              { exempt: true },
            );
          }
        }
        const holdsSharedSlot = isAndroid()
          ? KeyManager.hasIdentitySignerStore()
          : await KeyManager.hasSharedIdentity();
        if (holdsSharedSlot) {
          // Marked first: if the primary write below fails, the next launch's
          // `syncSharedIdentity` knows the shared slot holds the CURRENT key
          // (the server's) and finishes the rotation from it, instead of
          // "repairing" it back to the replaced one.
          await KeyManager.beginKeyRotation(newPublicKey);
          await KeyManager.importSharedIdentity(pending.privateKey);
        }
        await KeyManager.importKeyPair(pending.privateKey, { overwrite: true });
        await KeyManager.completeKeyRotation();
      } catch (persistError) {
        localPersistFailed = true;
        logger.warn(
          'Key rotated on the server but persisting the new key on-device failed; returning the new phrase so it can be re-imported.',
          { component: 'oxy.identity', method: 'rotateKey' },
          persistError,
        );
      }

      // 7. The new phrase is now THE recovery phrase. Store it so Settings can
      //    reveal it and the device backup carries it; the slot otherwise keeps
      //    the replaced key's phrase, which recovers nothing. When the key itself
      //    could not be persisted the user re-imports from the phrase on screen,
      //    and that import stores it.
      //    Best-effort: the rotation already succeeded and the phrase is on
      //    screen. When it cannot be stored, the replaced phrase is deleted
      //    instead, so the slot never holds a phrase that recovers nothing.
      if (!localPersistFailed) {
        try {
          await KeyManager.storeRecoveryMnemonic(pending.phrase);
        } catch (storeError) {
          logger.warn(
            'Key rotated, but the new recovery phrase could not be stored for re-reveal; clearing the replaced one.',
            { component: 'oxy.identity', method: 'rotateKey' },
            storeError,
          );
          try {
            await KeyManager.deleteRecoveryMnemonic();
          } catch (deleteError) {
            logger.warn(
              'Could not clear the replaced recovery phrase after a key rotation.',
              { component: 'oxy.identity', method: 'rotateKey' },
              deleteError,
            );
          }
        }
      }
    }

    // 8. The rotation deleted the encrypted backup (it was sealed under the
    //    replaced phrase). Seal a new one under the new phrase, carrying the
    //    retired ring — now with the key just replaced — and everything the
    //    previous backup carried, so the coins under them survive a lost phone
    //    as long as the NEW phrase does (R4-4, R5-6). On a phone always, not
    //    only when one existed: after a rotation it is the only copy of the
    //    replaced key off this phone; on web only when there was one.
    //    Best-effort: the rotation already succeeded, and the owed flag stays
    //    set until a backup is sealed.
    let backupRefreshed: boolean | undefined;
    if (resealBackup && !localPersistFailed) {
      try {
        await this.backup.seal(pending.phrase, previousBackup.carried, {
          replacesLookupId: previousBackup.replacesLookupId,
          ...(optIn ? { optIn: true } : {}),
        });
        backupRefreshed = true;
      } catch (backupError) {
        backupRefreshed = false;
        logger.warn(
          'Key rotated, but the encrypted backup could not be re-created under the new phrase.',
          { component: 'oxy.identity', method: 'rotateKey' },
          backupError,
        );
      }
    }

    this.invalidate(userId);

    return {
      newPublicKey,
      newPhrase: pending.phrase,
      words: pending.words,
      ...(localPersistFailed ? { localPersistFailed: true as const } : {}),
      ...(backupRefreshed === undefined ? {} : { backupRefreshed }),
      ...(noBackupByChoice ? { backupOptedOut: true as const } : {}),
    };
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
      .request<DidDocument>('GET', `/u/${encodeURIComponent(userId)}/did.json`, undefined, {
        cache: false,
      })
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

  /**
   * The signed-in personal account's current root (`null` without one) and
   * every root a rotation replaced, oldest first, all canonical (uncompressed,
   * lowercase). Commons reads it to accept a previous recovery phrase only when
   * it derives a key that WAS this account's root. A retired root is never any
   * account's again. First-party only; a non-personal account is refused
   * (`IDENTITY_NOT_PERSONAL_ACCOUNT`).
   */
  async keyHistory(): Promise<IdentityKeyHistory> {
    const res = await this.ctx.request<unknown>('GET', '/identity/key-history', undefined, {
      cache: false,
    });
    const parsed = checkContract(identityKeyHistoryCheck, res);
    if (!parsed) throw new Error('identity/key-history returned an unexpected response shape');
    return parsed;
  }

  /**
   * Commons (security review R6-5): ask Oxy to add to the signed-in account's
   * key history the QUARANTINED personal keys this device holds that the
   * history does not name yet — a root replaced before Oxy kept a key history
   * (migration 0235), which the access-group migration or an older Commons
   * left in the ring without an owner. Each claim proves POSSESSION (a
   * signature by that key over `{ action: 'claim_retired_identity_key',
   * userId, publicKey, timestamp }`, the private key never leaves the ring),
   * and Oxy adds the key only when ITS OWN records prove it was this
   * account's root (`POST /identity/key-history/claim`); a claim alone proves
   * nothing. Resolves the history after the claims (`history` when nothing
   * changed). At most {@link MAX_KEY_CLAIMS_PER_RUN} keys per call, each tried
   * once per process. Then bind with `claimRetiredIdentityKeys` as before.
   * Never throws for a key Oxy cannot prove (404) or that is another
   * account's (409).
   */
  async claimQuarantinedKeys(history?: IdentityKeyHistory): Promise<IdentityKeyHistory> {
    let current = history ?? (await this.keyHistory());
    const userId = this.ctx.oxy.session.userId;
    if (isWeb() || !userId) return current;
    const { listQuarantinedIdentityKeys, signWithQuarantinedIdentityKey } = await import(
      '../crypto/index'
    );
    const named = new Set(
      [current.publicKey, ...current.retired.map((entry) => entry.publicKey)]
        .filter((key): key is string => typeof key === 'string')
        .map((key) => key.toLowerCase()),
    );
    const candidates = (await listQuarantinedIdentityKeys())
      .filter((key) => !named.has(key) && !triedKeyClaims.has(`${userId}|${key}`))
      .slice(0, MAX_KEY_CLAIMS_PER_RUN);
    for (const publicKey of candidates) {
      if (this.ctx.oxy.session.userId !== userId) break;
      triedKeyClaims.add(`${userId}|${publicKey}`);
      const timestamp = Date.now();
      const signature = await signWithQuarantinedIdentityKey(
        publicKey,
        JSON.stringify({ action: IDENTITY_KEY_HISTORY_CLAIM_ACTION, userId, publicKey, timestamp }),
      );
      if (!signature) continue;
      try {
        const res = await this.ctx.request<unknown>(
          'POST',
          '/identity/key-history/claim',
          { publicKey, signature, timestamp },
          { cache: false },
        );
        const parsed = checkContract(identityKeyHistoryCheck, res);
        if (parsed) current = parsed;
      } catch (error) {
        const status = extractErrorStatus(error);
        if (status === 404 || status === 409) continue;
        // Anything else (offline, rate-limited): try again on a later run.
        triedKeyClaims.delete(`${userId}|${publicKey}`);
        logger.warn(
          'Could not ask Oxy about a kept previous key',
          { component: 'oxy.identity', method: 'claimQuarantinedKeys', status },
          error,
        );
        break;
      }
    }
    return current;
  }
}

/** At most this many quarantined keys are put to Oxy per {@link IdentityApi.claimQuarantinedKeys} call. */
export const MAX_KEY_CLAIMS_PER_RUN = 8;

/** `<userId>|<publicKey>` pairs already put to Oxy in this process (answered 404 or 409). */
const triedKeyClaims = new Set<string>();

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
    const res = await this.ctx.request<unknown>('POST', '/identity/link', undefined, {
      cache: false,
    });
    const parsed = checkContract(identityLinkCreateResponseCheck, res);
    if (!parsed) throw new Error('identity/link returned an unexpected response shape');
    return parsed;
  }

  /** Where a link request stands. Both devices poll it; it needs no session. */
  async get(linkId: string): Promise<IdentityLinkState> {
    const res = await this.ctx.request<unknown>(
      'GET',
      `/identity/link/${encodeURIComponent(linkId)}`,
      undefined,
      {
        cache: false,
        skipAuth: true,
      },
    );
    const parsed = checkContract(identityLinkStateCheck, res);
    if (!parsed) throw new Error('identity/link returned an unexpected response shape');
    return parsed;
  }

  /**
   * Commons' half: sign the scanned request's `link_identity` proof with THIS
   * device's identity key and post it. NATIVE-ONLY. Resolves to the key and the
   * 6-digit code the other screen will show for it, for the person to compare.
   */
  async sign(
    linkId: string,
    challenge: string,
  ): Promise<{ publicKey: string; code: string; username: string | null }> {
    const { KeyManager, signIdentityProof, deriveIdentityLinkCode } = await import(
      '../crypto/index'
    );
    const [privateKey, publicKey] = await Promise.all([
      KeyManager.getPrivateKey(),
      KeyManager.getPublicKey(),
    ]);
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
    return {
      publicKey: root,
      code: deriveIdentityLinkCode(linkId, root),
      username: state.username,
    };
  }

  /**
   * Complete a link with a code just sent to the account's email
   * (`oxy.auth.requestReauthCode`), or its password when it has no email —
   * plus its authenticator code when it has one. The account gains Commons'
   * root and loses its email, password and authenticator; every other session
   * of the account is signed out.
   */
  async complete(linkId: string, reauth: ReauthProof): Promise<{ success: true }> {
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
    await this.ctx.request<unknown>(
      'DELETE',
      `/identity/link/${encodeURIComponent(linkId)}`,
      undefined,
      { cache: false },
    );
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
    return this.ctx.request<DomainVerificationInstructions>(
      'POST',
      '/identity/domains',
      { domain },
      { cache: false },
    );
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
    const res = await this.ctx.request<{ domains?: VerifiedDomain[] }>(
      'GET',
      '/identity/domains',
      undefined,
      {
        cache: true,
        cacheTTL: SHORT_TTL,
      },
    );
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

/** The server's code for an upload over the person's deletion without their opt-in. */
const IDENTITY_BACKUP_OPTED_OUT_CODE = IDENTITY_ERROR_CODES.backupOptedOut;

/**
 * `backup.create` (or a rotation's re-seal) was refused because the person
 * DELETED their encrypted backup and this upload is not their explicit choice
 * to create one again (owner's decision, 2026-11-07). Nothing was stored.
 * Create it from a control the person pressed, with `{ optIn: true }`.
 */
export class IdentityBackupOptedOutError extends Error {
  readonly code = IDENTITY_BACKUP_OPTED_OUT_CODE;

  constructor() {
    super(
      'You deleted your encrypted backup, so a new one was not created. Create one in Backup & recovery if you want one.',
    );
    this.name = 'IdentityBackupOptedOutError';
  }
}

/** The server's code for an upload creating a backup the account has none of, without an opt-in. */
const IDENTITY_BACKUP_OPT_IN_REQUIRED_CODE = IDENTITY_ERROR_CODES.backupOptInRequired;

/**
 * `backup.create` (or a rotation's re-seal) was refused because the account
 * has NO backup on record and this upload is not the person's explicit
 * choice to create one (owner's decision, 2026-11-07). Nothing was stored.
 * Create it from a control the person pressed, with `{ optIn: true }`. An
 * owed backup stays owed, so the person is asked.
 */
export class IdentityBackupOptInRequiredError extends Error {
  readonly code = IDENTITY_BACKUP_OPT_IN_REQUIRED_CODE;

  constructor() {
    super(
      'You have no encrypted backup, so one was not created without your choice. Create one in Backup & recovery if you want one.',
    );
    this.name = 'IdentityBackupOptInRequiredError';
  }
}

/** The server's code for an unacknowledged upload over a superseded backup (R7-2). */
const IDENTITY_BACKUP_SUPERSEDED_CODE = IDENTITY_ERROR_CODES.backupSuperseded;

/**
 * `backup.create` was refused because the account's stored backup is one a key
 * rotation SUPERSEDED (security review R7-2): it holds keys under the previous
 * recovery phrase, which the new phrase cannot open, so it is never replaced
 * without its acknowledgement. Nothing changed. Create the backup again with
 * `{ previousPhrase }`, or add the previous phrase as a previous key first
 * (`restoreRetiredKeys`), which records the acknowledgement on this device.
 */
export class IdentityBackupSupersededError extends Error {
  override readonly name = 'IdentityBackupSupersededError';
  readonly code = IDENTITY_BACKUP_SUPERSEDED_CODE;
  constructor() {
    super(
      'Your previous encrypted backup holds keys from before your last key change. Add your previous recovery phrase to replace it. Nothing changed.',
    );
  }
}

/**
 * Envelope/payload version. 2 (core 7.34.0): the payload carries the retired
 * ring and every writer merges the previous backup's keys. The server refuses
 * (409) an upload whose version is LOWER than the stored one, so an older
 * Commons can no longer replace a backup with one that drops `retiredKeys`
 * (R5-9). Readers accept every version (the AAD binds it).
 */
const BACKUP_ENVELOPE_VERSION = 2;
/** The AEAD the backup is sealed with. Pinned so a mismatched decryptor fails loudly. */
const BACKUP_ALGORITHM = 'xchacha20poly1305' as const;
/**
 * Length (hex chars) of the public-key HINT stored/echoed with a backup — enough
 * to recognise WHICH identity a backup belongs to, but only a prefix.
 */
const PUBLIC_KEY_HINT_LENGTH = 16;

/** One retired key carried in the backup (R4-4). */
interface BackupRetiredKey {
  privateKey: string;
  publicKey: string;
  retiredAt: number;
}

/**
 * The decrypted backup payload. `retiredKeys` (since core 2026-11, optional,
 * ignored by older readers) carries the person's retired ring, so the CURRENT
 * phrase restores the keys their earlier coins sit under (ADR 0061 D7 as
 * amended): a lost phone then costs no more than the current phrase does.
 */
interface BackupPayload {
  privateKey: string;
  publicKey: string;
  createdAt: string;
  retiredKeys?: BackupRetiredKey[];
}

/**
 * The well-formed pairs among keys a backup carried (or a rotation carries
 * over): the private key must derive the public key; `currentPublicKey`, the
 * key being sealed as the current one, is left out. Deduplicated, canonical.
 */
async function healthyCarried(
  keys: readonly unknown[],
  currentPublicKey: string | null,
): Promise<BackupRetiredKey[]> {
  const { KeyManager } = await import('../crypto/index');
  const current = currentPublicKey?.toLowerCase() ?? null;
  const out = new Map<string, BackupRetiredKey>();
  for (const value of keys) {
    const key = value as Partial<BackupRetiredKey> | null;
    if (typeof key?.privateKey !== 'string' || typeof key.publicKey !== 'string') continue;
    let publicKey: string;
    try {
      if (!KeyManager.isValidPrivateKey(key.privateKey)) continue;
      publicKey = KeyManager.derivePublicKey(key.privateKey).toLowerCase();
      if (publicKey !== KeyManager.canonicalPublicKey(key.publicKey).toLowerCase()) continue;
    } catch {
      continue;
    }
    if (publicKey === current || out.has(publicKey)) continue;
    out.set(publicKey, {
      privateKey: key.privateKey.toLowerCase(),
      publicKey,
      retiredAt: typeof key.retiredAt === 'number' ? key.retiredAt : Date.now(),
    });
  }
  return [...out.values()];
}

/** Whether a request error is the restore lookup's constant-shape 404. */
function isNotFound(error: unknown): boolean {
  return extractErrorStatus(error) === 404;
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
   * `sha256(lookupId)` + the ciphertext. A re-upload REPLACES the prior backup,
   * so it never drops a key the prior one carried (R5-6): the backup this
   * phrase already has is opened first and its retired keys are kept (in this
   * device's ring, and in the new payload). Works cross-platform: the identity
   * is derived from the phrase, not read from SecureStore.
   *
   * A backup a key rotation SUPERSEDED (`status().superseded`, R7-2) holds
   * keys under the previous phrase, and is replaced only with its
   * acknowledgement: this device keeps it after a rotation it made, or after
   * {@link restoreRetiredKeys} opened it; otherwise pass `previousPhrase`, and
   * its keys are carried into the new backup (and kept in this device's ring
   * where one is held).
   *
   * @throws when the existing backup cannot be read (anything but "none"),
   *   when this device's ring cannot be read, or when a key the previous
   *   backup carried would be missing from the new one — nothing is uploaded.
   *   {@link IdentityBackupSupersededError} when a superseded backup was not
   *   acknowledged. {@link IdentityBackupOptedOutError} when the person
   *   deleted their backup and `optIn` was not given;
   *   {@link IdentityBackupOptInRequiredError} when the account has no
   *   backup on record and `optIn` was not given.
   *
   * `optIn`: the person pressed "Create backup" (owner's decision,
   * 2026-11-07). An account with no backup (deleted, or none on record) gets
   * one only with it; replacing a backup it has needs none. Pass it only from
   * a control the person pressed, never from an automatic re-seal.
   */
  async create(
    phrase: string,
    options?: { previousPhrase?: string; optIn?: boolean },
  ): Promise<BackupStatusResponse> {
    const previousPhrase = options?.previousPhrase?.trim();
    const optIn = options?.optIn === true ? { optIn: true } : {};
    if (!previousPhrase) return this.seal(phrase, [], optIn);
    const { RecoveryPhraseService } = await import('../crypto/index');
    const ownerAccountId = this.ctx.oxy.session.userId;
    this.assertRestoreOwner(ownerAccountId);
    const previous = await this.open(previousPhrase, true);
    if (!previous?.superseded) {
      throw new Error(
        'That recovery phrase does not open a previous backup of this account. Nothing changed.',
      );
    }
    // Every key it holds is carried into the new backup, and `seal` refuses to
    // upload unless each one is sealed there (and keeps them in the ring where
    // one is held).
    const carried = await healthyCarried(
      [
        ...(Array.isArray(previous.retiredKeys) ? previous.retiredKeys : []),
        {
          privateKey: previous.privateKey,
          publicKey: previous.publicKey,
          retiredAt: Date.parse(previous.createdAt) || Date.now(),
        },
      ],
      null,
    );
    const { lookupId } = await RecoveryPhraseService.deriveBackupMaterial(previousPhrase);
    return this.seal(phrase, carried, { replacesLookupId: lookupId, ...optIn });
  }

  /**
   * {@link create}, also carrying `carried` (a rotation's previous backup,
   * sealed under the replaced phrase, which the server supersedes), and
   * acknowledging a superseded backup with `replacesLookupId` (else the owed
   * entry's, R7-2), and sending the person's `optIn` (else the owed entry's)
   * over a backup they deleted. @internal
   */
  async seal(
    phrase: string,
    carried: readonly BackupRetiredKey[],
    options?: { replacesLookupId?: string; optIn?: boolean },
  ): Promise<BackupStatusResponse> {
    const { KeyManager, RecoveryPhraseService, BACKUP_KDF_ENCRYPTION_INFO, encryptAead } =
      await import('../crypto/index');
    const userId = this.ctx.oxy.session.userId;
    if (!userId) throw new Error('No authenticated user — sign in before backing up.');
    const { backupKey, lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);
    const privateKey = await RecoveryPhraseService.derivePrivateKeyFromPhrase(phrase);
    const publicKey = KeyManager.derivePublicKey(privateKey);
    const createdAt = new Date().toISOString();
    const publicKeyHint = publicKey.slice(0, PUBLIC_KEY_HINT_LENGTH);

    // Only under the account's CURRENT key (R6-9): a phrase left over from a
    // replaced key (a re-reveal slot a rotation could not update, a phrase
    // typed from paper) would seal a backup of a retired key, clear the owed
    // flag, and leave the account with no backup of the key it signs with.
    // The server refuses it too; this says why before anything is opened.
    const history = await this.readHistory();
    if (history.publicKey?.toLowerCase() !== publicKey.toLowerCase()) {
      throw new Error(
        'The encrypted backup was not created: this recovery phrase is not the current key of the signed-in account.',
      );
    }

    // The backup this phrase already has (404: none). Any other failure throws:
    // a re-seal never replaces a backup it could not read.
    const previous = await this.open(phrase, true);
    const mustCarry = await healthyCarried(
      [...(Array.isArray(previous?.retiredKeys) ? previous.retiredKeys : []), ...carried],
      publicKey,
    );
    if (mustCarry.length > 0) await this.keepInRing(mustCarry, userId, history);

    const retiredKeys = await this.retiredKeysToCarry(publicKey, mustCarry, history);
    const sealed = new Set(retiredKeys.map((key) => key.publicKey.toLowerCase()));
    if (mustCarry.some((key) => !sealed.has(key.publicKey.toLowerCase()))) {
      throw new Error(
        'The encrypted backup was not replaced: a previous key it carried is not one this account retired.',
      );
    }
    const payload: BackupPayload = {
      privateKey,
      publicKey,
      createdAt,
      ...(retiredKeys.length > 0 ? { retiredKeys } : {}),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const aad = buildBackupAad(BACKUP_ENVELOPE_VERSION, publicKeyHint);
    const { nonce, ciphertext } = encryptAead(backupKey, plaintext, aad);

    // The acknowledgement of a superseded backup (R7-2): the caller's, else the
    // one this device kept when it carried that backup's keys into the ring.
    const owed = isWeb() ? null : await KeyManager.backupOwedEntry(userId);
    const replacesLookupId = options?.replacesLookupId ?? owed?.supersededLookupId;
    // The person's choice to have a backup again (2026-11-07): this call's,
    // else the one the rotation flow recorded in the owed entry.
    const optIn = options?.optIn === true || owed?.optIn === true;
    const body: BackupUploadRequest = {
      version: BACKUP_ENVELOPE_VERSION,
      algorithm: BACKUP_ALGORITHM,
      kdfInfo: BACKUP_KDF_ENCRYPTION_INFO,
      nonce: toHex(nonce),
      ciphertext: toHex(ciphertext),
      publicKeyHint,
      createdAt,
      lookupId,
      ...(replacesLookupId ? { replacesLookupId } : {}),
      ...(optIn ? { optIn: true } : {}),
    };

    let status: BackupStatusResponse;
    try {
      status = await this.ctx.request<BackupStatusResponse>('POST', '/identity/backup', body, {
        cache: false,
      });
    } catch (error) {
      if (
        extractErrorStatus(error) === 409 &&
        (error as { code?: unknown } | null)?.code === IDENTITY_BACKUP_SUPERSEDED_CODE
      ) {
        throw new IdentityBackupSupersededError();
      }
      if (
        extractErrorStatus(error) === 409 &&
        (error as { code?: unknown } | null)?.code === IDENTITY_BACKUP_OPTED_OUT_CODE
      ) {
        // The person deleted their backup (from any device) and did not
        // choose one: nothing is owed any more, so nothing nags them.
        if (owed !== null && !optIn) await KeyManager.clearBackupOwed(userId);
        throw new IdentityBackupOptedOutError();
      }
      if (
        extractErrorStatus(error) === 409 &&
        (error as { code?: unknown } | null)?.code === IDENTITY_BACKUP_OPT_IN_REQUIRED_CODE
      ) {
        throw new IdentityBackupOptInRequiredError();
      }
      throw error;
    }
    // Cleared only on the server's confirmation of THIS upload (R6-9): any
    // failure, including a lost response, threw above and leaves it owed. Only
    // this account's entry (R7-10).
    if (status?.exists === true && owed !== null) {
      await KeyManager.clearBackupOwed(userId);
    }
    return status;
  }

  /** The signed-in account's key history, checked against its contract. */
  private async readHistory(): Promise<IdentityKeyHistory> {
    const history = await this.ctx.request<unknown>('GET', '/identity/key-history', undefined, {
      cache: false,
    });
    const parsed = checkContract(identityKeyHistoryCheck, history);
    if (!parsed) throw new Error('identity/key-history returned an unexpected response shape');
    return parsed;
  }

  /**
   * Keep `keys` in this device's ring for `ownerAccountId` (R6-10): bound to
   * the account only when its key history names the key; any other key is
   * kept QUARANTINED (it may be money, but nothing proved whose), for the
   * history that later names it (`claimRetiredIdentityKeys`). Without a
   * history every key is quarantined. Never the history's current key.
   * Resolves how many are now held; a key that fails is skipped.
   */
  private async keepForAccount(
    keys: readonly BackupRetiredKey[],
    ownerAccountId: string,
    history: IdentityKeyHistory | null,
    method: string,
  ): Promise<{ kept: number; bound: number; total: number }> {
    const { holdsRetiredRing, retireIdentityKey, quarantineRetiredIdentityKey } = await import(
      '../crypto/index'
    );
    const named = new Set((history?.retired ?? []).map((entry) => entry.publicKey.toLowerCase()));
    const current = history?.publicKey?.toLowerCase() ?? null;
    const total = keys.filter((key) => key.publicKey.toLowerCase() !== current).length;
    if (!(await holdsRetiredRing())) return { kept: 0, bound: 0, total };
    let kept = 0;
    let bound = 0;
    for (const key of keys) {
      const pair = { privateKey: key.privateKey, publicKey: key.publicKey };
      const id = key.publicKey.toLowerCase();
      if (id === current) continue;
      try {
        if (named.has(id)) {
          this.assertRestoreOwner(ownerAccountId);
          await retireIdentityKey(pair, { ownerAccountId });
          bound += 1;
        } else {
          // From a backup the phrase opened: never refused by the bound that
          // keeps out a planted shared group (R7-5).
          await quarantineRetiredIdentityKey(pair, undefined, { exempt: true });
        }
        kept += 1;
      } catch (error) {
        logger.warn(
          'Could not keep a previous key from the encrypted backup in the ring',
          { component: 'oxy.identity', method },
          error,
        );
      }
    }
    return { kept, bound, total };
  }

  /**
   * Whether the signed-in account's encrypted backup is OWED on this device
   * (R5-9): a key rotation deleted the previous one and no new one has been
   * sealed yet (an upload that failed, a crash or a closed app after the
   * swap). Commons asks the person to create it until this is `false`. Always
   * `false` on web. Never throws.
   *
   * Never for a person who DELETED their backup (owner's decision,
   * 2026-11-07), on any device: an entry this device holds is checked against
   * the account's `status().optedOut`, and dropped when the person deleted it
   * and did not choose one here since (`optIn`). When the status cannot be
   * read, the entry stands.
   */
  async isOwed(): Promise<boolean> {
    if (isWeb()) return false;
    const userId = this.ctx.oxy.session.userId;
    if (!userId) return false;
    const { KeyManager } = await import('../crypto/index');
    const entry = await KeyManager.backupOwedEntry(userId);
    if (entry === null) return false;
    if (entry.optIn) return true;
    try {
      const status = await this.status();
      if (status.optedOut === true && this.ctx.oxy.session.userId === userId) {
        await KeyManager.clearBackupOwed(userId);
        return false;
      }
    } catch {
      // Unknown now: still owed as far as this device can tell.
    }
    return true;
  }

  /**
   * Before a rotation (R5-6): the backup the account has now, opened with the
   * CURRENT phrase, and the keys a re-seal must carry — every retired key it
   * carried and the key it backed up (the one being replaced). `existed` is
   * whether the account has a backup. THROWS (nothing has changed yet) when a
   * backup exists but cannot be read: no phrase on this device, or a failure
   * other than "no backup for this phrase". `currentPhrase` is asked only
   * when a backup exists. `optedOut`: the person deleted their backup
   * (owner's decision, 2026-11-07). @internal
   */
  async readBeforeRotation(currentPhrase: () => Promise<string | null>): Promise<{
    existed: boolean;
    carried: BackupRetiredKey[];
    replacesLookupId?: string;
    optedOut?: boolean;
    superseded?: boolean;
  }> {
    let status: BackupStatusResponse;
    try {
      status = await this.status();
    } catch (error) {
      throw new Error(
        `Your encrypted backup could not be checked, so your key was not rotated. Nothing changed. (${error instanceof Error ? error.message : 'unknown'})`,
      );
    }
    const existed = status.exists;
    // The person deleted their backup: nothing to carry, and nothing is
    // re-uploaded without their choice.
    if (!existed && status.optedOut === true) return { existed, carried: [], optedOut: true };
    if (!existed) {
      // A backup an EARLIER rotation superseded (R7-2) stays superseded: its
      // keys are in this device's ring when this device made that rotation,
      // and the owed entry kept its acknowledgement for the next seal.
      if (status.superseded !== true) return { existed, carried: [] };
      if (isWeb()) return { existed, carried: [], superseded: true };
      const userId = this.ctx.oxy.session.userId;
      const { KeyManager } = await import('../crypto/index');
      const owed = userId ? await KeyManager.backupOwedEntry(userId) : null;
      return owed?.supersededLookupId
        ? {
            existed,
            carried: [],
            superseded: true,
            replacesLookupId: owed.supersededLookupId,
          }
        : { existed, carried: [], superseded: true };
    }
    let phrase: string | null;
    try {
      phrase = await currentPhrase();
    } catch {
      phrase = null;
    }
    if (!phrase) {
      throw new Error(
        'Your encrypted backup cannot be read without your current recovery phrase, so your key was not rotated. Nothing changed. Rotate with your recovery phrase instead.',
      );
    }
    let previous: BackupPayload | null;
    try {
      previous = await this.open(phrase, true);
    } catch (error) {
      throw new Error(
        `Your encrypted backup could not be read, so your key was not rotated. Nothing changed. (${error instanceof Error ? error.message : 'unknown'})`,
      );
    }
    // 404: the account's backup is not this phrase's; it carries nothing of this key.
    if (!previous) return { existed, carried: [] };
    // Its locator: the acknowledgement that replaces it once the swap has
    // superseded it (R7-2), because its keys are carried.
    const { RecoveryPhraseService } = await import('../crypto/index');
    const { lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);
    const carried = [
      ...(previous.retiredKeys ?? []),
      {
        privateKey: previous.privateKey,
        publicKey: previous.publicKey,
        retiredAt: Date.parse(previous.createdAt) || Date.now(),
      },
    ];
    return {
      existed,
      carried: await healthyCarried(carried, null),
      replacesLookupId: lookupId.toLowerCase(),
    };
  }

  /**
   * Keep keys a backup carried in this device's ring (R5-6): for the signed-in
   * account when its history names them, quarantined otherwise (R6-10).
   * Best-effort where a ring is held (they are also sealed into the new
   * payload); a no-op where none is.
   */
  private async keepInRing(
    keys: readonly BackupRetiredKey[],
    ownerAccountId: string,
    history: IdentityKeyHistory,
  ): Promise<void> {
    await this.keepForAccount(keys, ownerAccountId, history, 'backup.create');
  }

  /**
   * The retired keys the new payload carries: this device's ring for the
   * person (where one is held) and `carried`, limited to keys Oxy's key
   * history names as THIS account's retired keys (the ring's iOS group is
   * writable by the wallet app too, and a previous person's ring can outlive
   * a "Start over"). STRICT (R5-6): a ring that cannot be read throws — only
   * an app that holds no ring at all (`holdsRetiredRing()`) contributes none —
   * and so does a history that cannot be read while there is anything to
   * carry.
   */
  private async retiredKeysToCarry(
    currentPublicKey: string,
    carried: readonly BackupRetiredKey[],
    parsed: IdentityKeyHistory,
  ): Promise<BackupRetiredKey[]> {
    const { exportRetiredIdentityKeys, holdsRetiredRing } = await import('../crypto/index');
    const userId = this.ctx.oxy.session.userId;
    if (!userId) throw new Error('No authenticated user — sign in before backing up.');
    const held: BackupRetiredKey[] =
      !isWeb() && (await holdsRetiredRing())
        ? await exportRetiredIdentityKeys({ ownerAccountId: userId })
        : [];
    const byKey = new Map<string, BackupRetiredKey>();
    for (const key of [...held, ...carried]) {
      const id = key.publicKey.toLowerCase();
      if (!byKey.has(id)) byKey.set(id, key);
    }
    if (byKey.size === 0) return [];
    const retired = new Set(parsed.retired.map((entry) => entry.publicKey.toLowerCase()));
    const current = currentPublicKey.toLowerCase();
    return [...byKey.values()].filter(
      (key) => key.publicKey.toLowerCase() !== current && retired.has(key.publicKey.toLowerCase()),
    );
  }

  /**
   * Fetch and open the backup the phrase locates, checking it is the phrase's
   * own identity. With `missingIsNull`, `null` when there is none (404);
   * otherwise the request's own error propagates.
   */
  private async open(
    phrase: string,
    missingIsNull = false,
  ): Promise<(BackupPayload & { superseded?: true }) | null> {
    const { KeyManager, RecoveryPhraseService, decryptAead } = await import('../crypto/index');
    const { backupKey, lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);
    let envelope: EncryptedBackupEnvelope;
    try {
      envelope = await this.ctx.request<EncryptedBackupEnvelope>(
        'GET',
        `/identity/backup/${encodeURIComponent(lookupId)}`,
        undefined,
        { cache: false },
      );
    } catch (error) {
      if (missingIsNull && isNotFound(error)) return null;
      throw error;
    }
    if (envelope.algorithm !== BACKUP_ALGORITHM) {
      throw new Error(`Unsupported backup algorithm: ${envelope.algorithm}`);
    }
    const aad = buildBackupAad(envelope.version, envelope.publicKeyHint);
    const plaintext = decryptAead(
      backupKey,
      fromHex(envelope.nonce),
      fromHex(envelope.ciphertext),
      aad,
    );
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
    // A rotation by a client that could not re-seal kept this backup instead
    // of deleting it (R6-8): its key is no longer the account's root.
    return (envelope as { superseded?: unknown }).superseded === true
      ? { ...payload, superseded: true }
      : payload;
  }

  /**
   * Keep every retired key a backup carries in this device's ring. Each pair
   * must be healthy and must not be the current key; the envelope itself is
   * authenticated by the phrase. Commons only (the ring refuses elsewhere).
   * Resolves how many keys are now held; a key that fails is skipped.
   */
  private async keepCarriedRetiredKeys(
    payload: BackupPayload & { superseded?: true },
    ownerAccountId: string,
  ): Promise<number> {
    return (await this.keepCarriedRetiredKeysStrict(payload, ownerAccountId)).kept;
  }

  /**
   * {@link keepCarriedRetiredKeys}, also saying how many keys there were to
   * keep (the account's current key excluded), so a caller about to replace
   * the backup they came from can tell "all kept" from "some failed".
   */
  private async keepCarriedRetiredKeysStrict(
    payload: BackupPayload & { superseded?: true },
    ownerAccountId: string,
  ): Promise<{ kept: number; bound: number; total: number }> {
    const { KeyManager } = await import('../crypto/index');
    // The phrase opened the backup, but that does not make its keys the
    // signed-in account's (R6-10): each is bound to it only when the
    // account's own key history names it, and kept quarantined otherwise.
    this.assertRestoreOwner(ownerAccountId);
    const keys: BackupRetiredKey[] = [];
    for (const key of Array.isArray(payload.retiredKeys) ? payload.retiredKeys : []) {
      try {
        if (typeof key?.privateKey !== 'string' || typeof key.publicKey !== 'string') continue;
        if (key.publicKey.toLowerCase() === payload.publicKey.toLowerCase()) continue;
        if (
          KeyManager.derivePublicKey(key.privateKey).toLowerCase() !== key.publicKey.toLowerCase()
        ) {
          continue;
        }
        keys.push({ privateKey: key.privateKey, publicKey: key.publicKey, retiredAt: 0 });
      } catch {
        // Not a key: skipped.
      }
    }
    // A superseded backup (R6-8) is a replaced root's: its own key is money too.
    if (payload.superseded) {
      keys.push({ privateKey: payload.privateKey, publicKey: payload.publicKey, retiredAt: 0 });
    }
    if (keys.length === 0) return { kept: 0, bound: 0, total: 0 };
    let history: IdentityKeyHistory | null = null;
    try {
      history = await this.readHistory();
    } catch (error) {
      logger.warn(
        'Key history unreadable; keys from the encrypted backup are kept quarantined',
        { component: 'oxy.identity', method: 'backup.restoreRetiredKeys' },
        error,
      );
    }
    this.assertRestoreOwner(ownerAccountId);
    return this.keepForAccount(keys, ownerAccountId, history, 'backup.restoreRetiredKeys');
  }

  private assertRestoreSession(ownerAccountId: string | null): void {
    if (this.ctx.oxy.session.userId !== ownerAccountId) {
      throw new Error('The signed-in account changed — restart identity restoration.');
    }
  }

  private assertRestoreOwner(ownerAccountId: string | null): asserts ownerAccountId is string {
    if (!ownerAccountId || this.ctx.oxy.session.userId !== ownerAccountId) {
      throw new Error('The signed-in account changed — restart identity restoration.');
    }
  }

  /**
   * Restore ONLY the retired keys the phrase's backup carries into this
   * device's ring (Commons, after a phrase import or a silent device-backup
   * restore). Resolves how many were kept; 0 when there is no backup.
   */
  async restoreRetiredKeys(phrase: string): Promise<number> {
    const ownerAccountId = this.ctx.oxy.session.userId;
    this.assertRestoreOwner(ownerAccountId);
    const payload = await this.open(phrase, true);
    this.assertRestoreOwner(ownerAccountId);
    if (!payload) return 0;
    const { kept, bound, total } = await this.keepCarriedRetiredKeysStrict(payload, ownerAccountId);
    // The account's SUPERSEDED backup, every key of it now in the ring and
    // bound to the account (R7-2), so the next backup carries each of them:
    // this device may replace it. Its locator becomes the acknowledgement the
    // next `create` sends. Only the account's own stored backup (its hint),
    // and never when a key could not be kept or stays quarantined.
    if (payload.superseded && total > 0 && bound === total && !isWeb()) {
      try {
        const status = await this.status();
        const hint = status.publicKeyHint?.toLowerCase() ?? '';
        if (
          status.superseded === true &&
          hint.length >= PUBLIC_KEY_HINT_LENGTH &&
          payload.publicKey.toLowerCase().startsWith(hint)
        ) {
          const { KeyManager, RecoveryPhraseService } = await import('../crypto/index');
          const { lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);
          this.assertRestoreOwner(ownerAccountId);
          await KeyManager.markBackupOwed(ownerAccountId, {
            supersededLookupId: lookupId.toLowerCase(),
          });
        }
      } catch (error) {
        logger.warn(
          'Could not record the previous backup as replaceable',
          { component: 'oxy.identity', method: 'backup.restoreRetiredKeys' },
          error,
        );
      }
    }
    return kept;
  }

  /**
   * Whether the signed-in user has a stored backup, plus its non-sensitive hint
   * and timestamp. Returns no ciphertext and no locator.
   */
  async status(): Promise<BackupStatusResponse> {
    return this.ctx.request<BackupStatusResponse>('GET', '/identity/backup/status', undefined, {
      cache: false,
    });
  }

  /**
   * Delete the signed-in user's stored backup. Idempotent. The PERSON's act:
   * Oxy records it on the account (`status().optedOut`), and from then on no
   * device uploads a backup without their explicit `optIn` (owner's
   * decision, 2026-11-07): a key rotation does not, and this device's owed
   * backup (a rotation's re-seal that had not finished) is dropped. Keys a
   * rotation retired are then recoverable off this phone only with their own
   * recovery phrases.
   */
  async delete(): Promise<{ success: boolean }> {
    const userId = this.ctx.oxy.session.userId;
    const result = await this.ctx.request<{ success: boolean }>(
      'DELETE',
      '/identity/backup',
      undefined,
      { cache: false },
    );
    if (!isWeb() && userId && result?.success === true) {
      const { KeyManager } = await import('../crypto/index');
      await KeyManager.clearBackupOwed(userId);
    }
    return result;
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
    const ownerAccountId = this.ctx.oxy.session.userId;
    const { KeyManager } = await import('../crypto/index');
    const payload = await this.open(phrase);
    if (!payload) throw new Error('No encrypted backup was found for this recovery phrase.');
    if (payload.superseded) {
      // The phrase's key was replaced by a rotation (R6-8): importing it as
      // THE identity would sign in with a retired root. Its coins are still
      // reachable: add it as a previous key (`restoreRetiredKeys`).
      throw new Error(
        'This recovery phrase belongs to a key that was replaced. Restore with your current phrase, then add this one as a previous key.',
      );
    }
    this.assertRestoreSession(ownerAccountId);
    const publicKey = await KeyManager.importKeyPair(payload.privateKey, {
      overwrite: options?.overwrite === true,
    });
    this.assertRestoreSession(ownerAccountId);
    // Phrase-only recovery can precede sign-in; never assign its ring to a
    // different account that appeared while the backup was opening.
    if (ownerAccountId) {
      this.assertRestoreOwner(ownerAccountId);
      await this.keepCarriedRetiredKeys(payload, ownerAccountId);
    }
    return publicKey;
  }
}

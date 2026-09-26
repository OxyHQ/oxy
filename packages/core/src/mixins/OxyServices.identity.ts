/**
 * Identity Methods Mixin (self-sovereign identity layer)
 *
 * Provides typed access to Oxy's AtProto/Bluesky-flavoured identity &
 * portability layer:
 *  - DID resolution (`did:web:oxy.so:u:<userId>`, derived on demand by the API).
 *  - The auth-method ↔ DID verification-method mapping (`GET /auth/methods`). A
 *    root is linked by the holder flows (ADR 0024) and never unlinked; it is
 *    replaced by rotation.
 *  - Signed records: clients sign an envelope with their own cryptographic key
 *    (`SignatureService.signRecord` + the shared `canonicalize`) and publish it;
 *    anyone can fetch and verify it.
 *  - The signed data-export ("credible exit") bundle.
 *  - Verified-domain badges (prove ownership of `nate.com`).
 *
 * Wire shapes come from `@oxy.so/contracts` (`DidDocument`,
 * `SignedRecordEnvelope`, `AuthMethodsResponse`, `VerifiedDomain`,
 * `DomainVerificationInstructions`, `ExportBundle`) — the single source of truth
 * the API validates its output against, so producer and consumer cannot drift.
 *
 * Identity signing is NATIVE-ONLY: the private key lives in native secure
 * storage, so `signRecord` and `publishRecord` require an
 * on-device identity and throw on web (where `KeyManager.getPublicKey()` is
 * always `null`).
 */
import {
  IDENTITY_PROOF_ACTIONS,
  identityLinkCreateResponseSchema,
  identityLinkStateSchema,
  safeParseContract,
} from '@oxy.so/contracts';
import type {
  AuthMethodsResponse,
  IdentityLinkCreateResponse,
  IdentityLinkState,
  IdentityRootStatus,
  DidDocument,
  DomainVerificationInstructions,
  ExportBundle,
  OxySignedRecordType,
  RotateKeyChallengeResponse,
  RotateKeyCompleteResponse,
  SignedRecordEnvelope,
  VerifiedDomain,
} from '@oxy.so/contracts';
import { signMessage } from '@oxy.so/protocol';
import type { OxyServicesBase } from '../OxyServices.base';
import { KeyManager } from '../crypto/keyManager';
import { deriveIdentityLinkCode } from '../crypto/identityLink';
import { signIdentityProof } from '../crypto/identityProof';
import { SignatureService } from '../crypto/signatureService';
import { RecoveryPhraseService, type PendingIdentityResult } from '../crypto/recoveryPhrase';
import { isWeb } from '../utils/platform';
import { logger } from '../logger';
import { CACHE_TIMES } from './mixinHelpers';

/**
 * Registrable apex the Oxy DID method is anchored on. A user's DID is
 * `did:web:<OXY_IDENTITY_APEX>:u:<userId>`, anchored on the stable account id
 * (NOT the keypair).
 */
const OXY_IDENTITY_APEX = 'oxy.so';

/**
 * Record categories a client may sign and publish to the Oxy store. The base
 * envelope `type` is now an open string (any app may define its own records on
 * the shared grammar); the Oxy identity store re-narrows it to the closed Oxy
 * record set.
 */
export type IdentityRecordType = OxySignedRecordType;

/**
 * Result of publishing a signed record (`POST /identity/records`). Echoes the
 * stored envelope plus the server's verification verdict.
 */
export interface PublishRecordResult {
  envelope: SignedRecordEnvelope;
  verified: boolean;
}

/**
 * Result of verifying a stored record (`GET /identity/records/:userId/:type/verify`).
 * `verified` is the server's verdict; `reason` is present when it is `false`.
 */
export interface VerifyRecordResult {
  verified: boolean;
  reason?: string;
}

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

/** Options for {@link OxyServicesIdentityMixin.rotateKey}. */
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
   * {@link RecoveryPhraseService.derivePendingIdentity}). Pass it when the UI
   * derived + SHOWED the new phrase to the user BEFORE committing, so the SAME
   * identity is the one rotated in. When omitted, a fresh identity is derived
   * internally and its phrase is returned in the result.
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

export function OxyServicesIdentityMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Resolve the W3C DID document for any user. The API derives it on demand
     * from the account's `authMethods` + `publicKey` — there is no stored
     * document. Public (no auth required); short-TTL cached.
     *
     * @param userId - The account's Mongo `_id`. URL-encoded into the path.
     */
    async resolveDid(userId: string): Promise<DidDocument> {
      try {
        return await this.makeRequest<DidDocument>(
          'GET',
          `/u/${encodeURIComponent(userId)}/did.json`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * The current user's DID (`did:web:oxy.so:u:<userId>`), derived locally from
     * the access token's user id. Throws if no user is authenticated.
     */
    getMyDid(): string {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot derive DID.');
      }
      return buildUserDid(userId);
    }

    /** Resolve the current user's DID document. Requires an authenticated session. */
    async getMyDidDocument(): Promise<DidDocument> {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new Error('No authenticated user — cannot resolve DID document.');
      }
      return this.resolveDid(userId);
    }

    /**
     * List the current user's linked authentication methods plus their DID.
     * Each `identity` method carries a `verificationMethodId` linking it to its
     * DID verification-method fragment.
     */
    async listAuthMethods(): Promise<AuthMethodsResponse> {
      try {
        return await this.makeRequest<AuthMethodsResponse>(
          'GET',
          '/auth/methods',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * How the signed-in account is kept (ADR 0029 D3): whether Commons' root is
     * linked (self-custody), or the email of an account without a key. Any
     * first-party surface may read it to recommend linking Commons.
     */
    async getIdentityRootStatus(): Promise<IdentityRootStatus> {
      try {
        return await this.makeRequest<IdentityRootStatus>('GET', '/identity/root-status', undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Open a request to link Commons to the signed-in account (ADR 0029 D3). The
     * "Link Commons" panel shows its `qrPayload`; Commons scans it and signs with
     * {@link signIdentityLink}.
     */
    async createIdentityLink(): Promise<IdentityLinkCreateResponse> {
      try {
        const res = await this.makeRequest<unknown>('POST', '/identity/link', undefined, { cache: false });
        const parsed = safeParseContract(identityLinkCreateResponseSchema, res);
        if (!parsed) throw new Error('identity/link returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Where a link request stands. Both devices poll it; it needs no session. */
    async getIdentityLink(linkId: string): Promise<IdentityLinkState> {
      try {
        const res = await this.makeRequest<unknown>('GET', `/identity/link/${encodeURIComponent(linkId)}`, undefined, {
          cache: false,
          skipAuth: true,
        });
        const parsed = safeParseContract(identityLinkStateSchema, res);
        if (!parsed) throw new Error('identity/link returned an unexpected response shape');
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Commons' half: sign the scanned request's `link_identity` proof with THIS
     * device's identity key and post it. NATIVE-ONLY (the key lives in native
     * secure storage). Resolves to the key and the 6-digit code the other screen will
     * show for it, for the person to compare.
     */
    async signIdentityLink(linkId: string, challenge: string): Promise<{ publicKey: string; code: string; username: string | null }> {
      try {
        const [privateKey, publicKey] = await Promise.all([KeyManager.getPrivateKey(), KeyManager.getPublicKey()]);
        if (!privateKey || !publicKey) {
          throw new Error('No identity on this device to link');
        }
        const root = publicKey.trim().toLowerCase();
        const state = await this.getIdentityLink(linkId);
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
        await this.makeRequest<unknown>(
          'POST',
          `/identity/link/${encodeURIComponent(linkId)}/proof`,
          { publicKey: root, proof },
          { cache: false, skipAuth: true },
        );
        return { publicKey: root, code: deriveIdentityLinkCode(linkId, root), username: state.username };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Complete a link with a code just sent to the account's email
     * (`requestReauthEmailCode`) — plus its authenticator code when it has one.
     * The account gains Commons' root and loses its email; every other session
     * of the account is signed out.
     */
    async completeIdentityLinkWithEmailCode(
      linkId: string,
      reauth: { emailCode: { verificationId: string; code: string }; totpCode?: string },
    ): Promise<{ success: true }> {
      try {
        const result = await this.makeRequest<{ success: true }>(
          'POST',
          `/identity/link/${encodeURIComponent(linkId)}/complete`,
          { reauth },
          { cache: false },
        );
        this._invalidateIdentityCaches(this.getCurrentUserId());
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Withdraw a link request that has not completed. */
    async cancelIdentityLink(linkId: string): Promise<void> {
      try {
        await this.makeRequest<unknown>('DELETE', `/identity/link/${encodeURIComponent(linkId)}`, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Rotate the account's identity key: derive a brand-new keypair, prove
     * control of the CURRENT key, and have the server ATOMICALLY replace the old
     * key with the new one.
     *
     * The rotation is an atomic REPLACE on the server (never remove-then-add), so
     * it never passes through a zero-auth-method state and is independent of the
     * unlink guards. Because control of the current key is PROVEN (from
     * SecureStore in `'device'` mode, or a recovery-phrase re-derivation in
     * `'phrase'` mode), even the LAST remaining credential can be replaced.
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
     * NOTE: the UI is responsible for showing `newPhrase` to the user. For a
     * "show-phrase-first" flow, derive the identity up front via
     * {@link RecoveryPhraseService.derivePendingIdentity}, display it, then pass
     * it back as `options.pendingIdentity` so the SAME identity is committed.
     *
     * @throws when no user is authenticated, when `proof: 'phrase'` is given
     *   without a `phrase`, when `proof: 'device'` runs with no on-device key,
     *   or when the rotation does not complete.
     */
    async rotateKey(options: RotateKeyOptions): Promise<RotateKeyResult> {
      try {
        const userId = this.getCurrentUserId();
        if (!userId) {
          throw new Error('No authenticated user — sign in before rotating your key.');
        }

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
        const { challenge } = await this.makeRequest<RotateKeyChallengeResponse>(
          'POST',
          '/auth/rotate/challenge',
          undefined,
          { cache: false },
        );

        // 4. Sign the rotation proofs. The OLD key proves control of the key being
        //    replaced; the NEW key proves possession of the key being rotated in
        //    (so the server never accepts a re-encoding of a key the caller does
        //    not control). Both signed byte strings MUST match the server's
        //    reconstruction exactly (this key order). The old key is canonicalized
        //    so legacy compressed encodings in Mongo still verify.
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
          const result = await this.makeRequest<RotateKeyCompleteResponse>(
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
          const reconciled = await this._rotationAlreadyApplied(userId, newPublicKey);
          if (!reconciled) {
            throw error;
          }
          applied = true;
        }

        if (!applied) {
          throw new Error('Key rotation did not complete — your previous key is unchanged.');
        }

        // 6. ONLY after the server confirms the swap, persist the new key locally,
        //    overwriting the old one. `importKeyPair({ overwrite: true })` uses the
        //    atomic persist path (backs the previous key up first). Native-only —
        //    on web the key never lived in SecureStore, so there is nothing to
        //    persist locally.
        //
        //    If this local write fails the server key is ALREADY the new one, so
        //    we must NOT throw and swallow the phrase — the caller needs it to
        //    re-import the now-live key. Surface the result with
        //    `localPersistFailed: true` (mirrors the pendingIdentity
        //    show-phrase-first path, where the caller already holds the phrase).
        //    The SHARED slot is written FIRST, and that order is load-bearing.
        //    Every cross-app reader takes the shared slot before the primary —
        //    `deriveScopedSeed` does, which is where Peable's FairCoin wallet
        //    comes from. Leaving the replaced key there was silent money loss:
        //    payers derive the recipient's address from the key in the DID (now
        //    the new one) while the recipient's wallet still watches addresses
        //    derived from the old one, so payments land where nobody looks.
        //    Writing shared first means a crash between the two writes leaves
        //    the money path already on the new key and the primary stale, which
        //    fails LOUDLY on the next signature instead of quietly misdirecting
        //    funds. `syncSharedIdentity` repairs that case on the next boot.
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
              { component: 'OxyServices.identity', method: 'rotateKey' },
              persistError,
            );
          }
        }

        this._invalidateIdentityCaches(userId);

        return localPersistFailed
          ? { newPublicKey, newPhrase: pending.phrase, words: pending.words, localPersistFailed: true }
          : { newPublicKey, newPhrase: pending.phrase, words: pending.words };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Reconciliation probe for the rotation ambiguous-failure guard: fetch the
     * account's derived DID document (uncached) and report whether it already
     * advertises `newPublicKey` as a verification method — i.e. whether the swap
     * already landed server-side. A failed probe returns `false` (unconfirmed),
     * so the caller surfaces the original network error.
     *
     * Uses the DID document rather than `GET /auth/methods` because the latter
     * intentionally does NOT expose raw public keys, whereas the DID's
     * `verificationMethod[].publicKeyHex` is derived live from the account's
     * current key — so it reflects a completed rotation immediately.
     *
     * Internal helper (leading underscore); public rather than `private` for the
     * same TS4094 reason as {@link _invalidateIdentityCaches}.
     */
    async _rotationAlreadyApplied(userId: string, newPublicKey: string): Promise<boolean> {
      return this.makeRequest<DidDocument>(
        'GET',
        `/u/${encodeURIComponent(userId)}/did.json`,
        undefined,
        { cache: false },
      )
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
     * Sign a record with the on-device identity key, WITHOUT publishing it.
     * The subject is the current user's DID. NATIVE-ONLY (requires a stored
     * key). Use {@link publishRecord} to sign and store in one step.
     *
     * @param type - The record category.
     * @param record - The arbitrary record payload to attest to.
     */
    async signRecord(
      type: IdentityRecordType,
      record: Record<string, unknown>,
    ): Promise<SignedRecordEnvelope> {
      const subject = this.getMyDid();
      return SignatureService.signRecord(type, subject, record);
    }

    /**
     * Sign a record and publish it to the append-only record store
     * (`POST /identity/records`). NATIVE-ONLY (requires a stored key).
     *
     * @param type - The record category.
     * @param record - The arbitrary record payload to attest to.
     */
    async publishRecord(
      type: IdentityRecordType,
      record: Record<string, unknown>,
    ): Promise<PublishRecordResult> {
      try {
        const envelope = await this.signRecord(type, record);
        return await this.makeRequest<PublishRecordResult>(
          'POST',
          '/identity/records',
          envelope,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch a user's most recent signed record of a given type. Public (no auth
     * required); short-TTL cached.
     *
     * @param userId - The subject account's Mongo `_id`.
     * @param type - The record category to fetch.
     */
    async getRecord(userId: string, type: IdentityRecordType): Promise<SignedRecordEnvelope> {
      try {
        const res = await this.makeRequest<{ record: SignedRecordEnvelope }>(
          'GET',
          `/identity/records/${encodeURIComponent(userId)}/${encodeURIComponent(type)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.record;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Ask the server to verify a user's stored record: it recomputes the
     * canonical signing input, checks the signature, and asserts the signing key
     * is a current verification method on the subject's DID.
     *
     * @param userId - The subject account's Mongo `_id`.
     * @param type - The record category to verify.
     */
    async verifyRecord(userId: string, type: IdentityRecordType): Promise<VerifyRecordResult> {
      try {
        return await this.makeRequest<VerifyRecordResult>(
          'GET',
          `/identity/records/${encodeURIComponent(userId)}/${encodeURIComponent(type)}/verify`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Download the current user's signed, open-format data-export bundle
     * (`GET /users/me/export`) — the "credible exit" snapshot. Always carries an
     * Oxy provenance `attestation`; carries an optional client `proof` when the
     * account holds its own key.
     */
    async exportMyData(): Promise<ExportBundle> {
      try {
        return await this.makeRequest<ExportBundle>(
          'GET',
          '/users/me/export',
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Start verifying ownership of a domain. Returns the instructions: publish
     * EITHER the DNS-TXT record OR the `/.well-known/oxy-domain` file, then call
     * {@link verifyDomain}.
     *
     * @param domain - The domain to claim (e.g. `nate.com`).
     */
    async requestDomainVerification(domain: string): Promise<DomainVerificationInstructions> {
      try {
        return await this.makeRequest<DomainVerificationInstructions>(
          'POST',
          '/identity/domains',
          { domain },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Complete domain verification: the server checks the DNS-TXT record or
     * well-known file and, on success, attaches the domain to the account
     * (surfaced in the DID's `alsoKnownAs` and the user's `verifiedDomains`).
     *
     * @param domain - The domain previously requested via
     *   {@link requestDomainVerification}.
     */
    async verifyDomain(domain: string): Promise<VerifyDomainResult> {
      try {
        const result = await this.makeRequest<VerifyDomainResult>(
          'POST',
          `/identity/domains/${encodeURIComponent(domain)}/verify`,
          undefined,
          { cache: false },
        );
        this._invalidateIdentityCaches(this.getCurrentUserId());
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** List the current user's verified domains. */
    async listDomains(): Promise<VerifiedDomain[]> {
      try {
        const res = await this.makeRequest<{ domains?: VerifiedDomain[] }>(
          'GET',
          '/identity/domains',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.domains ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Remove a verified domain from the current account.
     * @param domain - The verified domain to remove.
     */
    async removeDomain(domain: string): Promise<RemoveDomainResult> {
      try {
        const result = await this.makeRequest<RemoveDomainResult>(
          'DELETE',
          `/identity/domains/${encodeURIComponent(domain)}`,
          undefined,
          { cache: false },
        );
        this._invalidateIdentityCaches(this.getCurrentUserId());
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Bust the cached reads that an identity mutation invalidates: the current
     * user (`/users/me*`), the linked auth-methods list, the verified-domains
     * list, and the user's derived DID document (which embeds auth methods +
     * verified domains, so it goes stale on link/unlink/domain changes).
     *
     * Internal helper (leading underscore); not part of the supported public
     * surface. Public rather than `private` because mixins compose into an
     * exported anonymous class, where TypeScript cannot represent a private
     * member in the emitted declaration file (TS4094).
     */
    _invalidateIdentityCaches(userId: string | null): void {
      this.clearCacheByPrefix('GET:/users/me');
      this.clearCacheEntry('GET:/auth/methods');
      this.clearCacheEntry('GET:/identity/domains');
      if (userId) {
        this.clearCacheEntry(`GET:/u/${encodeURIComponent(userId)}/did.json`);
      }
    }
  };
}

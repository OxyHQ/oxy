/**
 * The RSA key pairs Oxy signs ActivityPub requests with — for its own actors and,
 * sign-on-behalf, for relying apps such as Mention. The private half never
 * leaves this module.
 *
 * ## A user key belongs to one account lifetime
 *
 * A keyId (`https://<domain>/ap/users/<handle>#main-key`) names a HANDLE, and a
 * handle outlives its account: once the account is deleted or renamed away,
 * somebody else can register it. Keyed by handle alone, the newcomer inherited
 * the old private key — signing as the previous actor to every server that still
 * cached it, and verifying the previous actor's signed material as its own.
 *
 * So a user key is minted only for an account that holds the handle and is
 * bound to that account's id (`federation_key_pairs.oxy_user_id`), and every
 * read checks the binding against the account holding the handle NOW. When they
 * differ, the row is replaced with a fresh pair for the current holder: the old
 * private key is destroyed, and remote servers whose cached key no longer
 * verifies refetch the actor and get the new one.
 *
 * When NO account holds the handle the key is left as it is. That is the state
 * right after a deletion, and the relying app still signs the actor's `Delete`
 * (and that Delete's retries) with it; the next account to claim the handle
 * replaces it.
 *
 * The instance actor's key is no account's and is exempt. A row from before the
 * binding existed (`oxy_user_id` null) is served as it is until
 * `scripts/reconcile-federation-key-owners.ts` binds or replaces it — guessing an
 * owner here would bind an inherited key to its inheritor.
 */

import crypto from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { INSTANCE_ACTOR_USERNAME } from '@oxy.so/federation';
import { getDb } from '../../config/postgres';
import { federationKeyPairs } from '../../db/schema/federationKeyPairs';
import { users } from '../../db/schema/users';
import { logger } from '../../utils/logger';

/**
 * The key-pair columns this module works in.
 *
 * `private_key_pem` is a PROTECTED column (`db/schema/protectedColumns.ts`), so
 * naming it here is a deliberate opt-in — this module is the only one that may
 * hold a private signing key, because it is the only one that signs. Every
 * other reader goes through {@link getPublicKeyForKeyId} / {@link getUserPublicKey}.
 */
const KEY_PAIR_COLUMNS = {
  keyId: federationKeyPairs.keyId,
  publicKeyPem: federationKeyPairs.publicKeyPem,
  privateKeyPem: federationKeyPairs.privateKeyPem,
  oxyUserId: federationKeyPairs.oxyUserId,
} as const;

export interface KeyPairDoc {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  /** The account the key was minted for; null for the instance actor and legacy rows. */
  oxyUserId: string | null;
}

/** The public half of a key pair — safe to return over the wire. */
export interface PublicKeyDoc {
  keyId: string;
  publicKeyPem: string;
}

/**
 * How long a resolved key is used before its binding is checked again. Every
 * oxy-api task caches keys, and only a re-read notices that another task (or the
 * reconciliation one-shot) replaced one, so this bounds how long a handle that
 * just changed hands can still sign with the key it had.
 */
const KEY_RECHECK_MS = 60_000;

const _keyPairCache = new Map<string, { pair: KeyPairDoc; checkedAt: number }>();

/**
 * The canonical `#main-key` keyId for a (username, domain) pair. It embeds BOTH
 * the handle and the serving domain, so `bob@mention.earth` and `bob` on oxy.so
 * are distinct keys by construction.
 */
export function composeUserKeyId(username: string, domain: string): string {
  return `https://${domain}/ap/users/${username.trim().toLowerCase()}#main-key`;
}

/** The instance-actor keyId for a domain. */
export function composeInstanceKeyId(domain: string): string {
  return `https://${domain}/ap/users/${INSTANCE_ACTOR_USERNAME}#main-key`;
}

/**
 * The handle a user keyId names, or null for the instance actor and for anything
 * not shaped like a user key — neither belongs to an account.
 */
export function handleOfKeyId(keyId: string): string | null {
  let url: URL;
  try {
    url = new URL(keyId);
  } catch {
    return null;
  }
  const match = /^\/ap\/users\/([^/]+)$/.exec(url.pathname);
  if (url.hash !== '#main-key' || !match) return null;
  const handle = match[1].toLowerCase();
  return handle === INSTANCE_ACTOR_USERNAME ? null : handle;
}

/** The account holding `handle` now, or null when none does. */
export async function findHandleHolder(
  handle: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await getDb()
    .select({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${handle}))`)
    .limit(1);
  return row ?? null;
}

/** Read one key pair by its keyId, or null when none exists. No binding check. */
export async function findKeyPair(keyId: string): Promise<KeyPairDoc | null> {
  const [row] = await getDb()
    .select(KEY_PAIR_COLUMNS)
    .from(federationKeyPairs)
    .where(eq(federationKeyPairs.keyId, keyId))
    .limit(1);
  return row ?? null;
}

function generateRsaPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

type Executor = Pick<ReturnType<typeof getDb>, 'insert' | 'select'>;

/**
 * Insert a fresh pair for `keyId`, or adopt the one a concurrent writer inserted
 * first. `on conflict do nothing` on the unique `key_id`, then a read: a
 * read-then-create would let two simultaneous first signatures both generate a
 * key, and a signature made with the loser would fail remote verification.
 */
async function insertKeyPair(
  db: Executor,
  keyId: string,
  oxyUserId: string | null,
): Promise<KeyPairDoc> {
  const [inserted] = await db
    .insert(federationKeyPairs)
    .values({ keyId, oxyUserId, ...generateRsaPair() })
    .onConflictDoNothing({ target: federationKeyPairs.keyId })
    .returning(KEY_PAIR_COLUMNS);
  if (inserted) return inserted;
  const [existing] = await db
    .select(KEY_PAIR_COLUMNS)
    .from(federationKeyPairs)
    .where(eq(federationKeyPairs.keyId, keyId))
    .limit(1);
  if (!existing) {
    throw new Error(`Federation key pair for ${keyId} could not be created or resolved`);
  }
  return existing;
}

/**
 * Destroy `stale` and mint a fresh pair for `holderId` under the same keyId, in
 * one transaction, so a reader sees the old row or the new one and never none.
 * The delete is conditional on the stale owner: a concurrent replacement for
 * the same holder deletes nothing and adopts the winner's row.
 */
export async function replaceKeyPair(
  stale: Pick<KeyPairDoc, 'keyId' | 'oxyUserId'>,
  holderId: string,
): Promise<KeyPairDoc> {
  const pair = await getDb().transaction(async (tx) => {
    await tx
      .delete(federationKeyPairs)
      .where(
        and(
          eq(federationKeyPairs.keyId, stale.keyId),
          stale.oxyUserId === null
            ? isNull(federationKeyPairs.oxyUserId)
            : eq(federationKeyPairs.oxyUserId, stale.oxyUserId),
        ),
      );
    return insertKeyPair(tx, stale.keyId, holderId);
  });
  _keyPairCache.delete(stale.keyId);
  logger.info('federation: a handle changed accounts, so its signing key was replaced', {
    keyId: stale.keyId,
  });
  return pair;
}

/**
 * The key pair `keyId` signs with, bound to the account holding its handle now
 * (see the header). With `mint`, a missing pair is created — for a user key only
 * when an account holds the handle, so no key exists before its owner does.
 */
async function resolveKeyPair(keyId: string, mint: boolean): Promise<KeyPairDoc | null> {
  const cached = _keyPairCache.get(keyId);
  if (cached && Date.now() - cached.checkedAt < KEY_RECHECK_MS) return cached.pair;

  const handle = handleOfKeyId(keyId);
  const [stored, holder] = await Promise.all([
    findKeyPair(keyId),
    handle === null ? null : findHandleHolder(handle),
  ]);

  let pair = stored;
  if (stored && holder && stored.oxyUserId !== null && stored.oxyUserId !== holder.id) {
    pair = await replaceKeyPair(stored, holder.id);
  } else if (!stored && mint && (handle === null || holder)) {
    pair = await insertKeyPair(getDb(), keyId, holder?.id ?? null);
  }

  if (pair) _keyPairCache.set(keyId, { pair, checkedAt: Date.now() });
  else _keyPairCache.delete(keyId);
  return pair;
}

/** The instance actor's key pair for a domain, minted on first use. */
export async function getInstanceKeyPair(domain: string): Promise<KeyPairDoc> {
  const pair = await resolveKeyPair(composeInstanceKeyId(domain), true);
  if (!pair) throw new Error(`Instance key pair for ${domain} could not be resolved`);
  return pair;
}

/**
 * The key pair of `username`'s actor on `domain`, minted on first use, or null
 * when no account holds that handle and none was ever minted for it.
 */
export async function getUserKeyPair(username: string, domain: string): Promise<KeyPairDoc | null> {
  return resolveKeyPair(composeUserKeyId(username, domain), true);
}

/**
 * The public half of `username`'s key on `domain`, minted on first use — what a
 * relying app publishes in the actor's `publicKey` block without ever receiving
 * the private key. Null when no account holds the handle and no key exists.
 */
export async function getUserPublicKey(
  username: string,
  domain: string,
): Promise<PublicKeyDoc | null> {
  const pair = await getUserKeyPair(username, domain);
  return pair ? { keyId: pair.keyId, publicKeyPem: pair.publicKeyPem } : null;
}

/**
 * The PUBLIC half of an existing key pair, or null. Never mints and never
 * exposes the private key.
 */
export async function getPublicKeyForKeyId(keyId: string): Promise<PublicKeyDoc | null> {
  const pair = await resolveKeyPair(keyId, false);
  return pair ? { keyId: pair.keyId, publicKeyPem: pair.publicKeyPem } : null;
}

/**
 * Sign an HTTP-Signature signing string with the private key behind `keyId`.
 * Only the base64 RSA-SHA256 signature leaves this process. Never mints: a sign
 * request for a keyId with no key pair returns null and the route answers 404
 * (callers publish the public key first, which mints it).
 */
export async function signWithKeyId(keyId: string, signingString: string): Promise<string | null> {
  const pair = await resolveKeyPair(keyId, false);
  if (!pair) return null;
  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  signer.end();
  return signer.sign(pair.privateKeyPem, 'base64');
}

/**
 * `federation_key_pairs` — the RSA key pairs Oxy signs ActivityPub requests with.
 *
 * ## `key_id` is the identity, and it is not a row id
 *
 * A keyId is the canonical `https://<domain>/ap/users/<username>#main-key` URI.
 * It embeds BOTH the actor and the serving domain, so one unique index on it
 * enforces "one key pair per (username, domain)" with no separate compound
 * column — a key minted for `bob@mention.earth` is a different row from `bob` on
 * `oxy.so`, by construction. It is registered in
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY`: it names an ActivityPub actor on some
 * domain, which may not be an Oxy account at all (Oxy signs on behalf of
 * relying apps such as Mention), so there is nothing to reference.
 *
 * ## `oxy_user_id` is the account lifetime the key belongs to
 *
 * A keyId names a HANDLE, and a handle outlives an account: once its account is
 * deleted (or renamed away), somebody else can register it. The keyId cannot
 * change — it is the actor's published key URI — so the row says whose key it
 * is instead. A user key is minted only for an account that holds the handle,
 * bound to that account's id, and when a different account holds the handle the
 * row is replaced with a fresh pair (`federation.service.ts`, `resolveKeyPair`).
 * The new account therefore never signs with, nor publishes, its predecessor's
 * key.
 *
 * Deliberately NOT a foreign key (`ID_COLUMNS_WITHOUT_FOREIGN_KEY`): the row
 * must outlive the account it names. A deleted account's relying apps still
 * sign its actor `Delete` with this key after the user row is gone, and the id
 * left behind is what tells a later holder of the handle apart from it. Null
 * only for the instance actor, which no account owns, and for rows that
 * predate the column until `scripts/reconcile-federation-key-owners.ts` binds
 * or replaces them.
 *
 * ## `private_key_pem` is a PROTECTED column
 *
 * It is the live signing key for a federated identity. Hand-picking fields at
 * every call site — including `getPublicKeyForKeyId`, which exists precisely to
 * return the public half — is not a guard, because Drizzle's `select()` does
 * not hand-pick, so the guard lives in `protectedColumns.ts` where a read that
 * wants it has to name it.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';

export const federationKeyPairs = pgTable(
  'federation_key_pairs',
  {
    id: generatedId(),
    /**
     * The canonical `https://<domain>/ap/users/<username>#main-key` URI. Unique:
     * it is how every read addresses a key, and the uniqueness is what makes
     * "get or create" idempotent under concurrency.
     */
    keyId: text().notNull(),
    /** SPKI PEM. Published in the actor document and to relying apps. */
    publicKeyPem: text().notNull(),
    /** PKCS#8 PEM. A live signing key — never leaves this process. */
    privateKeyPem: text().notNull(),
    /** The account this key was minted for — see the header. No foreign key. */
    oxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('federation_key_pairs_key_id_key').on(t.keyId)],
);

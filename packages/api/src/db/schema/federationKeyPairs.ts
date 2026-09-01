/**
 * `federation_key_pairs` — the RSA key pairs Oxy signs ActivityPub requests with.
 *
 * Ported from an INLINE Mongoose model that lived in
 * `services/federation.service.ts` (`mongoose.model('FederationKeyPair', …,
 * 'federation_keypairs')`) rather than in `models/`, which is why it is the one
 * table with no counterpart file there.
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
 * ## `private_key_pem` is a PROTECTED column
 *
 * It is the live signing key for a federated identity. Mongoose left it fully
 * selectable and the service only avoided leaking it by hand-picking fields at
 * every call site — including `getPublicKeyForKeyId`, which exists precisely to
 * return the public half. Drizzle's `select()` does not hand-pick, so the guard
 * moves into `protectedColumns.ts` where a read that wants it has to name it.
 *
 * ## The collection name did NOT travel
 *
 * Mongo's was `federation_keypairs` (an explicit third argument to
 * `mongoose.model`). The table is `federation_key_pairs`, per the snake_case
 * convention — nothing reads a collection name, and the call sites are being
 * rewritten rather than shimmed.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('federation_key_pairs_key_id_key').on(t.keyId)]
);

/**
 * `verifiable_credentials` — the holder-collectible index over signed credentials.
 *
 * Ported from `models/VerifiableCredential.ts`. The CANONICAL proof is the
 * signed `credential` record on the ledger; this row is its queryable
 * projection, so a holder can list what they hold and anyone can verify one by
 * content address. `types` and `claims` are denormalised for display, and
 * verification ALWAYS recomputes the canonical signing input from the stored
 * envelope — never from this projection.
 *
 * Two issuance modes populate it, and they put the signed record on DIFFERENT
 * chains: a user-issued credential is self-issued on the ISSUER's chain, an
 * org-issued one is custodially signed onto the HOLDER's chain. That asymmetry
 * is why `record_id` cascades and `issuer_user_id` does not — see below.
 *
 * Rows are mutated only to flip `status`; the signed record behind them is
 * append-only.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { signedRecords } from './signedRecords';
import { users } from './users';

/** Credential lifecycle, mirroring the `CredentialStatus` contract union. */
export const CREDENTIAL_STATUSES = ['active', 'revoked', 'expired'] as const;

export const verifiableCredentials = pgTable(
  'verifiable_credentials',
  {
    id: generatedId(),
    /** The account holding the credential. `CASCADE` — it is a claim about them. */
    holderUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The holder's DID — the W3C `credentialSubject.id`. */
    holderDid: text().notNull(),
    /**
     * The issuing account, for a user-issued credential. Absent when Oxy signed
     * custodially on behalf of an Application.
     *
     * `SET NULL`, not `CASCADE`: an issuer erasing their own account must not
     * silently delete a THIRD PARTY's credential row. `issuer_did` still records
     * who signed, and NULL here already means "not a user-issued credential" to
     * every reader.
     */
    issuerUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** The issuer's DID — whose CURRENT verification method must verify the proof. */
    issuerDid: text().notNull(),
    /** VC type tags, e.g. `['VerifiableCredential', 'EmploymentCredential']`. */
    types: text().array().notNull(),
    /**
     * The issuer-asserted claim set. Genuinely shape-less — every issuer defines
     * its own vocabulary — so `jsonb` is the intended use, and the authoritative
     * copy is the signed envelope on the ledger either way.
     */
    claims: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Content address of the signed `credential` record — the cryptographic proof.
     *
     * `CASCADE`: a credential whose proof is gone can never be verified again,
     * so keeping the projection would advertise a claim nobody can check. Note
     * the reach: for a USER-issued credential the record lives on the ISSUER's
     * chain, so an issuer's erasure removes the holder's row too. That is the
     * honest outcome — `verifyCredential` would fail on it from that moment on —
     * and the alternative (`RESTRICT`) would block a GDPR erasure outright.
     */
    recordId: text()
      .notNull()
      .unique()
      .references(() => signedRecords.recordId, { onDelete: 'cascade' }),
    status: text({ enum: CREDENTIAL_STATUSES }).notNull().default('active'),
    /** When the issuer signed it. Part of the signed bytes. */
    issuedAt: timestamptz().notNull(),
    /** Optional expiry. Part of the signed bytes. */
    expiresAt: timestamptz(),
    /** When the issuer revoked it, if revoked. */
    revokedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The Commons "my credentials" view: a holder's credentials by status.
    index('verifiable_credentials_holder_status_idx').on(t.holderUserId, t.status),
    // "Everything this issuer has attested" — the revocation and audit direction.
    index('verifiable_credentials_issuer_did_idx').on(t.issuerDid),

    check(
      'verifiable_credentials_status_check',
      sql`${t.status} in (${sql.raw(inList(CREDENTIAL_STATUSES))})`
    ),
    // `revoked_at` and the `revoked` status are one fact. Mongo could store a
    // revocation date on an active credential, and `verifyCredential` reads only
    // the status — so the date would be an invisible, contradicted record.
    check(
      'verifiable_credentials_revocation_check',
      sql`(${t.status} = 'revoked' and ${t.revokedAt} is not null) or (${t.status} <> 'revoked' and ${t.revokedAt} is null)`
    ),
    check(
      'verifiable_credentials_expiry_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.issuedAt}`
    ),
  ]
);

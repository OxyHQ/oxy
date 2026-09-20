/**
 * `application_workload_identities` — which running workload IS which
 * application.
 *
 * The binding that lets a first-party service authenticate with no credential
 * at all: it presents a proof issued by the infrastructure it runs on (see
 * `services/workloadAttestation.service.ts`), and this table says which
 * application that proof belongs to.
 *
 * ## Why a row rather than a naming convention
 *
 * Deriving the application from the workload's name — `oxy-mention-task` is
 * Mention — needs no table, and was rejected. It makes the identity of an
 * application a property of whatever anyone happens to name an IAM role, so
 * creating a role with the right name is enough to become that application, and
 * renaming one silently unmakes it. A row is an explicit allow-list, it is
 * auditable, and removing it is how a compromised workload is cut off.
 *
 * It is NOT a registration ritual for the app team: rows are created by the
 * platform when a service is deployed, carry no secret, and nothing about them
 * is copied into a parameter store. That is the whole point — the thing being
 * recorded is a fact about our infrastructure, not a shared secret somebody has
 * to keep.
 *
 * ## Third parties are deliberately absent
 *
 * A third-party application runs on infrastructure we cannot attest to, so it
 * has nothing to put here and keeps the credential path. The `applications`
 * row's trust classification is checked at mint time as well, so a third-party
 * application that somehow acquired a row here still cannot mint a service
 * token.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxy.so/db';

import { APPLICATION_SCOPES } from '../../utils/applicationScopes';
import { applications } from './applications';

/**
 * Where a workload can prove what it is. One value per attestation verifier.
 *
 * Kept as a CHECK-free text column on purpose: the vocabulary belongs to
 * `services/workloadAttestation.service.ts`, which is where a new provider is
 * actually implemented, and a second copy in a constraint is a migration that
 * has to ship in lockstep with code for no gain — an unknown provider resolves
 * to no verifier and is refused there.
 */
export const applicationWorkloadIdentities = pgTable(
  'application_workload_identities',
  {
    id: generatedId(),

    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /** `aws-iam`, `kubernetes`, … — the verifier that can check this subject. */
    provider: text().notNull(),

    /**
     * The identity the provider vouches for, verbatim: an IAM role ARN, a
     * Kubernetes service-account URI, a certificate subject.
     *
     * Stored exactly as the provider states it and compared exactly. Not parsed,
     * not normalised, not pattern-matched here — every one of those is a way for
     * two different workloads to resolve to one application.
     *
     * Reducing a provider's per-invocation identity to the one stable form that
     * belongs in this column happens once, in that provider's verifier
     * (`canonicalAwsSubject` on AWS). Both the writer
     * (`services/workloadIdentityBinding.service.ts`) and the reader
     * (`services/workloadIdentity.service.ts`) work from its output, so a
     * subject an operator supplies and a subject an attestation proves are the
     * same string or the binding is refused before it is written.
     */
    subject: text().notNull(),

    /** Free text for whoever reads this table a year from now. */
    description: text(),

    /**
     * Scopes this binding may mint, or empty for "names none".
     *
     * Same column shape, same default and the same CHECK as
     * `application_credentials.scopes`, because it plays the same part: the
     * mint intersects it with the owning application's scopes
     * (`intersectScopes`), so a binding can never exceed its application's
     * authority, and empty means the legacy answer — the application's
     * non-privileged grants.
     *
     * ## Why a binding may name authority when a bare attestation may not
     *
     * An attestation says WHAT is calling and nothing about what it may do, so
     * it can never widen an application's authority. That rule is unchanged.
     * This column is not the attestation: it is a row staff wrote, naming one
     * IAM role and one application, with a human-authored `description` beside
     * it — the attestation path's equivalent of an `ApplicationCredential`, and
     * gated the same way when it is written
     * (`services/workloadIdentityBinding.service.ts`). Privileged authority is
     * therefore still named on something a human granted deliberately; the only
     * change is which deliberate thing.
     *
     * Empty was the whole vocabulary before this column existed, and it still
     * means exactly what the mint did then — so every binding written before it
     * keeps behaving identically without a backfill.
     */
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * When set, the binding stops working at this instant.
     *
     * Present so a workload being retired can be wound down on a schedule rather
     * than by deleting a row at the moment the last task stops — the same
     * reasoning as a credential's rotation grace window.
     */
    expiresAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * One subject belongs to at most one application.
     *
     * The uniqueness is the security property, not a tidiness rule: two rows for
     * one subject would make "which application is this workload?" ambiguous,
     * and the resolver would answer with whichever row the planner returned
     * first.
     */
    unique('application_workload_identities_provider_subject_key').on(table.provider, table.subject),
    index('application_workload_identities_application_idx').on(table.applicationId),
    /**
     * Only real scopes, mirroring `application_credentials_scopes_check`.
     *
     * The mint drops an unknown scope anyway (`intersectScopes` refuses
     * anything outside the vocabulary), so this is not what makes the mint
     * safe. What it prevents is the row: a typo'd scope written here would sit
     * in the table reading as granted, and the failure would surface as a 403
     * from some other service with nothing pointing back at this row.
     */
    check(
      'application_workload_identities_scopes_check',
      sql`${table.scopes} <@ ${sql.raw(textArrayLiteral(APPLICATION_SCOPES))}`
    ),
  ],
);

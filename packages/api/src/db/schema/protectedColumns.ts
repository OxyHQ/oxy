/**
 * Columns That Must Not Reach a Client
 *
 * Mongoose had `select: false`: a column so marked was absent from every query
 * result unless a caller asked for it BY NAME. Eleven columns across `User` and
 * `Message` relied on it, and two of them (`hashedEmail`, `hashedPhone`) carried
 * a SECOND guard — a `delete` in both `toJSON` transforms.
 *
 * Drizzle enumerates columns explicitly, so a naive port keeps NEITHER guard:
 * `db.select().from(users)` returns the raw phone number, the contact-discovery
 * hashes and the refresh token. This module holds THIS schema's registry —
 * decided once for every table and every repo rather than per model. The
 * mechanism that reads it (`publicColumns`, the implicit-whole-row-read
 * scanner) is shared plumbing with no opinion on which columns to protect, so
 * it lives in `@oxyhq/db/assert` instead of here.
 *
 * ## The mechanism
 *
 * 1. **The registry is data** (`PROTECTED_COLUMNS_BY_TABLE`), one entry per
 *    column with the reason it is protected — the same shape as
 *    `deferredForeignKeys.ts`, and for the same reason: a rule written only in a
 *    comment is a rule nothing checks.
 *
 * 2. **`publicColumns(table, PROTECTED_COLUMNS_BY_TABLE)` is the sanctioned
 *    read**, imported from `@oxyhq/db/assert`.
 *    `db.select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users)`
 *    omits every protected column AT THE TYPE LEVEL — the resulting row type
 *    has no `phone` property at all, so a serializer that tries to read one
 *    fails `tsc` rather than shipping it. That is the part a convention
 *    cannot give you.
 *
 * 3. **Opting in is explicit and greppable.** A path that legitimately needs a
 *    protected column names it:
 *    `db.select({ id: users.id, phone: users.phone }).from(users)`. There is
 *    deliberately no helper for this — the whole point is that it reads
 *    differently from an ordinary select.
 *
 * 4. **`__tests__/protectedColumns.test.ts` is the gate.** It holds the `users`
 *    entry against the exact set Mongoose marked `select: false`, refuses a
 *    stale entry, checks the runtime filter, and calls
 *    `@oxyhq/db/assert`'s `findImplicitWholeRowReads` to scan `src/` for the
 *    two shapes that return every column implicitly — a bare `select()` and
 *    the relational `db.query.<table>` API — against any table in this
 *    registry.
 *
 * ## Scope: the title, not the Mongoose keyword
 *
 * `select: false` is where this started, and `users` is held to that exact set.
 * It is not the boundary. The subject is the module title, and a column can
 * qualify without Mongoose ever having marked it — `sessions.access_token` and
 * `auth_sessions.session_token` are live bearer credentials that Mongoose left
 * fully selectable, and Mongo's call sites only avoided leaking them by
 * hand-building each DTO field by field. Drizzle's `select()` does not, so the
 * port is where the guard has to be added rather than inherited. Each entry
 * below says which it is.
 *
 * ## What this does NOT replace
 *
 * The `toJSON` transform is the API RESPONSE contract (`ret.id = _id`, and the
 * deletes of `password`, `_id`, `hashedEmail`, `hashedPhone`). It must be
 * reproduced at the serializer, and it is the second of the two guards
 * `hashedEmail` / `hashedPhone` have always had. This module restores the first.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { authSessions } from './authSessions';
import { federationKeyPairs } from './federationKeyPairs';
import { inferenceDeployments } from './inferenceDeployments';
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
} from './inferenceDeploymentRoutingScores';
import {
  GPAI_DOCUMENTATION_INTERNAL_COLUMNS,
  inferenceModelGpaiDocumentation,
} from './inferenceModelGpaiDocumentation';
import { messages } from './messages';
import { sessions } from './sessions';
import { users } from './users';

/**
 * `users` columns that were `select: false` in `models/User.ts`.
 *
 * TypeScript PROPERTY names, because that is what a drizzle selection object is
 * keyed by — `sqlColumnName` is for talking to the catalogue, not for this.
 */
export const USERS_PROTECTED_COLUMNS = [
  'phone',
  'hashedEmail',
  'hashedPhone',
  'refreshToken',
  'emailSignature',
  'autoForwardTo',
  'autoForwardKeepCopy',
] as const;

/**
 * `sessions` columns holding a LIVE BEARER CREDENTIAL.
 *
 * These were NOT `select: false` in Mongoose — nothing was, on that model — and
 * they are here anyway, because the registry's subject is the module title
 * ("columns that must not reach a client"), not the Mongoose keyword that used
 * to approximate it. `users.refresh_token` is already protected for exactly this
 * reason ("a bearer credential; serializing it hands over the account"); the
 * same value on `sessions` is the same credential.
 *
 * The reason this matters MORE after the port than before: the Mongo call sites
 * build device DTOs field by field from a `Session` document
 * (`devices.controller.ts:73-90`), and the natural drizzle transliteration of
 * that is `db.select().from(sessions)` followed by a `.map(...)` — which now
 * carries two live tokens into whatever the mapper forgets to drop.
 */
export const SESSIONS_PROTECTED_COLUMNS = [
  'accessToken',
  'refreshToken',
  'previousRefreshToken',
] as const;

/**
 * `auth_sessions` columns holding a LIVE BEARER CREDENTIAL.
 *
 * `session_token` is the 128-bit secret the originating client alone holds, and
 * `POST /auth/session/claim` takes NO bearer — possession of this value is the
 * whole authorization. The sibling `authorize_code` is deliberately absent from
 * this list: it is the PUBLIC handle that travels in the QR, and approving with
 * it is separately key-signed.
 */
export const AUTH_SESSIONS_PROTECTED_COLUMNS = ['sessionToken'] as const;

/**
 * `federation_key_pairs` columns holding a LIVE SIGNING KEY.
 *
 * Not `select: false` in the inline Mongoose model this table replaces —
 * nothing was — and here anyway, for the same reason `sessions` is: the
 * subject is the module title, not the Mongoose keyword. Possession of
 * `private_key_pem` lets the holder sign ActivityPub activities AS the actor it
 * belongs to, on Oxy's own domain or on a relying app's. The one route that
 * publishes key material (`GET /federation/public-key/:username`) returns the
 * PUBLIC half by name, so nothing legitimate loses a field.
 */
export const FEDERATION_KEY_PAIRS_PROTECTED_COLUMNS = ['privateKeyPem'] as const;

/**
 * `messages` columns that must not reach a client.
 *
 * The first four were `select: false` in `models/Message.ts`. The fifth was
 * not, and could not have been — Mongo's text index was a separate structure,
 * not a field on the document. `search_vector` is GENERATED from `text`, and a
 * `tsvector` stores every lexeme with its position, so returning it hands back a
 * largely reconstructable copy of the very body the other four entries exist to
 * withhold. A protection that covers the source but not its derivative is not a
 * protection.
 */
export const MESSAGES_PROTECTED_COLUMNS = [
  'text',
  'html',
  'headers',
  'encryptedBody',
  'searchVector',
] as const;

/**
 * `inference_deployments` columns that must never reach a customer.
 *
 * The serving boundary (ADR 0008, epic workstream 5) says Oxy exposes the
 * customer-safe catalogue and pricing view, and never upstream provider
 * secrets, internal route ids or internal wholesale costs. These are the second
 * category and the third.
 *
 * This registry is the BACKSTOP here, not the primary mechanism. The customer
 * projection is built from an explicit allow-list
 * (`CUSTOMER_SAFE_DEPLOYMENT_COLUMNS` in
 * `services/inferenceCatalogue.service.ts`), which is default-DENY: a column
 * added to that table tomorrow is invisible to customers until somebody names
 * it. A protected-column registry is default-ALLOW by construction, so on its
 * own it would let a future unsafe column through. What it adds is the
 * implicit-whole-row-read scan over `src/`, which the allow-list cannot give,
 * and a second, independent statement of which columns are dangerous.
 */
export const INFERENCE_DEPLOYMENTS_PROTECTED_COLUMNS = [
  'internalRouteId',
  'legalReviewEvidenceRef',
  'upstreamWholesaleCostAmount',
  'upstreamWholesaleCostCurrency',
  'upstreamWholesaleCostUnit',
  'upstreamWholesaleCostPer',
] as const;

/** Internal routing decisions and their staff-only provenance. */
export const INFERENCE_ROUTING_SCORES_PROTECTED_COLUMNS = [
  'deploymentId',
  'priceScore',
  'priceSource',
  'priceEvidenceRef',
  'priceVersionId',
  'latencyScore',
  'latencySource',
  'latencyEvidenceRef',
  'latencyMeasurementWindowStart',
  'latencyMeasurementWindowEnd',
  'latencyValidUntil',
  'throughputScore',
  'throughputSource',
  'throughputEvidenceRef',
  'throughputMeasurementWindowStart',
  'throughputMeasurementWindowEnd',
  'throughputValidUntil',
  'balancedScore',
  'balancedSource',
  'balancedEvidenceRef',
  'balancedFormulaRef',
  'balancedValidUntil',
  'reason',
  'changedByUserId',
  'changedAt',
  'createdAt',
  'updatedAt',
] as const;

/** The immutable staff audit is internal in its entirety. */
export const INFERENCE_ROUTING_SCORE_EVENTS_PROTECTED_COLUMNS = [
  'id',
  'deploymentId',
  'priceScore',
  'priceSource',
  'priceEvidenceRef',
  'priceVersionId',
  'latencyScore',
  'latencySource',
  'latencyEvidenceRef',
  'latencyMeasurementWindowStart',
  'latencyMeasurementWindowEnd',
  'latencyValidUntil',
  'throughputScore',
  'throughputSource',
  'throughputEvidenceRef',
  'throughputMeasurementWindowStart',
  'throughputMeasurementWindowEnd',
  'throughputValidUntil',
  'balancedScore',
  'balancedSource',
  'balancedEvidenceRef',
  'balancedFormulaRef',
  'balancedValidUntil',
  'reason',
  'changedByUserId',
  'createdAt',
] as const;

/**
 * `inference_model_gpai_documentation` columns that are documentation for an
 * AUTHORITY rather than for a downstream developer.
 *
 * The EU AI Act itself draws this line, which is why the split is a registry
 * entry and not a preference. Annex XI is technical documentation a provider
 * keeps and provides to the AI Office and national competent authorities on
 * request; Annex XII is information a provider MAKES AVAILABLE to downstream
 * providers. The four columns below are Annex XI Section 2 and Article 55(1)(a);
 * everything else on that table is Annex XII or Article 53(1)(c)/(d), which are
 * public by their own terms.
 *
 * The set is imported from the table module rather than restated, so a column
 * added to the internal group has one place to be added and cannot become
 * customer-visible by being forgotten here.
 *
 * As on `inference_deployments`, this registry is the BACKSTOP: the customer
 * projection is `modelDownstreamDocumentationSchema`, which is `.strict()` and
 * therefore default-DENY. What the registry adds is the implicit-whole-row-read
 * scan over `src/`, which a projection cannot give.
 */
export const INFERENCE_GPAI_DOCUMENTATION_PROTECTED_COLUMNS =
  GPAI_DOCUMENTATION_INTERNAL_COLUMNS;

/**
 * The registry, keyed by SQL table name. Declared `as const` and passed
 * straight through to `@oxyhq/db/assert`'s `publicColumns` at every call
 * site — that is what keeps the type-level guarantee (see that function's
 * own doc comment for exactly what widening it would cost).
 */
export const PROTECTED_COLUMNS_BY_TABLE = {
  users: USERS_PROTECTED_COLUMNS,
  sessions: SESSIONS_PROTECTED_COLUMNS,
  auth_sessions: AUTH_SESSIONS_PROTECTED_COLUMNS,
  federation_key_pairs: FEDERATION_KEY_PAIRS_PROTECTED_COLUMNS,
  messages: MESSAGES_PROTECTED_COLUMNS,
  inference_deployments: INFERENCE_DEPLOYMENTS_PROTECTED_COLUMNS,
  inference_deployment_routing_scores: INFERENCE_ROUTING_SCORES_PROTECTED_COLUMNS,
  inference_deployment_routing_score_events:
    INFERENCE_ROUTING_SCORE_EVENTS_PROTECTED_COLUMNS,
  inference_model_gpai_documentation: INFERENCE_GPAI_DOCUMENTATION_PROTECTED_COLUMNS,
} as const;

/** A protected column, with the reason it is one. */
export interface ProtectedColumn {
  readonly table: PgTable;
  readonly column: PgColumn;
  /** Why it must not appear in a default read, in one line. */
  readonly reason: string;
}

/**
 * The same registry as objects, with reasons — what the gate reports and what a
 * reader consults. `PROTECTED_COLUMNS_BY_TABLE` is the machine-readable half;
 * the test asserts the two agree, so neither can drift.
 */
export const PROTECTED_COLUMNS: readonly ProtectedColumn[] = [
  {
    table: users,
    column: users.phone,
    reason:
      'The raw phone number. Private to its owner; public profile endpoints ' +
      'match on the hash instead and must never see this.',
  },
  {
    table: users,
    column: users.hashedEmail,
    reason:
      'Contact-discovery matching token. Returning it would turn every ' +
      'profile response into an offline dictionary attack on the email.',
  },
  {
    table: users,
    column: users.hashedPhone,
    reason:
      'Same as the email hash, and worse — the phone number space is small ' +
      'enough to enumerate outright.',
  },
  {
    table: users,
    column: users.refreshToken,
    reason: 'A bearer credential. Serializing it hands over the account.',
  },
  {
    table: users,
    column: users.emailSignature,
    reason:
      "The owner's private mail configuration. Visible to them, never on " +
      'anyone else\'s view of the profile.',
  },
  {
    table: users,
    column: users.autoForwardTo,
    reason:
      'Discloses a second address the owner controls, and that their mail is ' +
      'being forwarded at all.',
  },
  {
    table: users,
    column: users.autoForwardKeepCopy,
    reason:
      'Only meaningful next to `auto_forward_to`, and leaks the same fact — ' +
      'that forwarding is configured.',
  },
  {
    table: sessions,
    column: sessions.accessToken,
    reason:
      "This session's live bearer token. Serializing it hands the account to " +
      'whoever reads the response.',
  },
  {
    table: sessions,
    column: sessions.refreshToken,
    reason:
      'The refresh half of the same credential, and the longer-lived one — it ' +
      'mints fresh access tokens for as long as the session lives.',
  },
  {
    table: sessions,
    column: sessions.previousRefreshToken,
    reason:
      'Still accepted during the rotation grace window, so it is a live ' +
      'credential too — being superseded is not being revoked.',
  },
  {
    table: authSessions,
    column: authSessions.sessionToken,
    reason:
      'The secret claim credential for a pending authorization. ' +
      '`POST /auth/session/claim` requires no bearer, so this value alone ' +
      "exchanges an approved request for the approving account's access token.",
  },
  {
    table: federationKeyPairs,
    column: federationKeyPairs.privateKeyPem,
    reason:
      'The live RSA signing key for a federated actor. Whoever reads it can ' +
      "sign ActivityPub activities as that actor, on Oxy's domain or a " +
      "relying app's. Only the public half is ever published.",
  },
  {
    table: messages,
    column: messages.text,
    reason:
      'The plain-text body. A list view returns hundreds of rows and needs ' +
      'none of it; shipping it turns every inbox page into a full mail export.',
  },
  {
    table: messages,
    column: messages.html,
    reason: 'The HTML body — same exposure as the plain-text one, same size problem.',
  },
  {
    table: messages,
    column: messages.headers,
    reason:
      'Every header as received, including the third-party SMTP `Received:` ' +
      'IPs this column is the one sanctioned place to retain. Never a default read.',
  },
  {
    table: messages,
    column: messages.encryptedBody,
    reason:
      'Body ciphertext. Handing it out gives an offline target to anyone who ' +
      'later obtains the recipient key.',
  },
  {
    table: messages,
    column: messages.searchVector,
    reason:
      'Generated FROM `text`. A tsvector carries every lexeme with its ' +
      'position, so returning it largely reconstructs the body the entry above withholds.',
  },
  {
    table: inferenceDeployments,
    column: inferenceDeployments.internalRouteId,
    reason:
      "The data plane's own identifier for this route. Naming the serving " +
      'PROVIDER is the attribution the serving boundary permits; naming the ' +
      'internal route is a map of the infrastructure behind it.',
  },
  {
    table: inferenceDeployments,
    column: inferenceDeployments.legalReviewEvidenceRef,
    reason:
      'A pointer into the contract register. The catalogue deliberately holds ' +
      'no confidential contract, and publishing the pointer would disclose ' +
      'which commercial agreements exist and roughly when they were signed.',
  },
  {
    table: inferenceDeployments,
    column: inferenceDeployments.upstreamWholesaleCostAmount,
    reason:
      'What Oxy pays upstream. The serving boundary names internal wholesale ' +
      'cost as one of three things a customer must never see; it is also the ' +
      "provider's commercial terms, which are not Oxy's to publish.",
  },
  {
    table: inferenceDeployments,
    column: inferenceDeployments.upstreamWholesaleCostCurrency,
    reason: 'Half of the wholesale cost above; useless alone and disclosing beside it.',
  },
  {
    table: inferenceDeployments,
    column: inferenceDeployments.upstreamWholesaleCostUnit,
    reason:
      'The unit the wholesale cost is quoted per. With the amount it is the ' +
      'rate; without it, it still discloses how a contract is metered.',
  },
  {
    table: inferenceDeployments,
    column: inferenceDeployments.upstreamWholesaleCostPer,
    reason:
      'The denominator of the wholesale rate. Protected with the rest of the ' +
      'group so no subset of it can be reassembled from a default read.',
  },
  ...Object.values(getTableColumns(inferenceDeploymentRoutingScores)).map((column) => ({
    table: inferenceDeploymentRoutingScores,
    column,
    reason:
      'Internal traffic-order input or staff provenance. Customers receive the ' +
      'resolved provider attribution, never scores, topology, evidence or actor data.',
  })),
  ...Object.values(getTableColumns(inferenceDeploymentRoutingScoreEvents)).map((column) => ({
    table: inferenceDeploymentRoutingScoreEvents,
    column,
    reason:
      'Immutable staff audit of internal traffic-order decisions. It is an ' +
      'operations record and never part of a customer response.',
  })),
  {
    table: inferenceModelGpaiDocumentation,
    column: inferenceModelGpaiDocumentation.trainingComputeFlops,
    reason:
      'Annex XI Section 2(b) of the EU AI Act — documentation for the AI Office ' +
      'and national competent authorities, not the Annex XII set a downstream ' +
      'provider is entitled to. It is also the figure Article 51(2) reads.',
  },
  {
    table: inferenceModelGpaiDocumentation,
    column: inferenceModelGpaiDocumentation.trainingTimeHours,
    reason:
      'Annex XI Section 2(b), beside the compute figure and disclosing the same ' +
      'thing about how a release was produced.',
  },
  {
    table: inferenceModelGpaiDocumentation,
    column: inferenceModelGpaiDocumentation.energyConsumptionMwh,
    reason:
      'Annex XI Section 2(c). Protected with the rest of the Section 2 group so ' +
      'no subset of it reaches a default read.',
  },
  {
    table: inferenceModelGpaiDocumentation,
    column: inferenceModelGpaiDocumentation.adversarialTestingReportUrl,
    reason:
      "Article 55(1)(a): the systemic-risk model evaluation, including " +
      'adversarial testing. A red-team report is a map of what a model can be ' +
      'made to do, and the Act asks for it as documentation for an authority.',
  },
];

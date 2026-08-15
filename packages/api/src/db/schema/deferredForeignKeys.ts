/**
 * Foreign Keys This Schema Cannot Declare Yet
 *
 * The migration is landing table by table, so a table can arrive before its
 * parent does — `push_tokens.application_id` points at `applications`, which no
 * module in this schema defines yet. Drizzle cannot express a forward reference,
 * so the column ships without its constraint.
 *
 * "Add the FK when `users` lands" written in a comment is a convention nothing
 * checks, and those get violated. So it is written HERE as data, and
 * `__tests__/foreignKeys.test.ts` turns it into a gate: the moment the parent
 * table appears in the schema barrel, the test fails and names the exact column
 * whose constraint is now missing. The ledger deletes itself as the port
 * completes — an empty `DEFERRED_FOREIGN_KEYS` is the finish line.
 *
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` is the separate, PERMANENT list: `*_id`
 * columns that will never carry a constraint, each with the reason. Between the
 * two lists plus the real constraints, every id-shaped column in the schema is
 * classified — which is what lets `foreignKeys.test.ts` fail on a NEW one
 * nobody decided about.
 *
 * Both lists are this schema's own DATA — they name this schema's tables and
 * columns, so they have no home in `@oxyhq/db`. The `DeferredForeignKey` shape
 * itself is no longer declared here, though: it is identical to
 * `@oxyhq/db/assert`'s own export of the same name (the gate that walks this
 * list, `findIdColumnViolations`, now lives there too), so this file imports
 * the type rather than keeping a second copy that could drift from it.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DeferredForeignKey } from '@oxyhq/db/assert';
import { appAffinitySeenEvents } from './appAffinitySeenEvents';
import { appEndorsementEdges } from './appEndorsementEdges';
import { appUpdates } from './appUpdates';
import { authCodes } from './authCodes';
import { authSessions } from './authSessions';
import { billingSubscriptions } from './billingSubscriptions';
import { billingTransactions } from './billingTransactions';
import { followEvents } from './followEvents';
import { bookmarks } from './bookmarks';
import { conductStrikes } from './conductStrikes';
import { deviceAccountContexts } from './deviceAccountContexts';
import { devicePairingSessions } from './devicePairingSessions';
import { devicePrincipalBackfillConflicts } from './devicePrincipalBackfillConflicts';
import { devicePrincipals } from './devicePrincipals';
import { deviceSessionAccounts } from './deviceSessionAccounts';
import { deviceSessions } from './deviceSessions';
import { federationKeyPairs } from './federationKeyPairs';
import { fileLinks } from './fileLinks';
import { identityBindings } from './identityBindings';
import { inferenceUsageEvents } from './inferenceUsageEvents';
import { messageAttachments } from './messageAttachments';
import { messages } from './messages';
import { moderationEffects } from './moderationEffects';
import { notifications } from './notifications';
import { pushTokens } from './pushTokens';
import { reputationTransactions } from './reputationTransactions';
import { securityActivities } from './securityActivities';
import { sessions } from './sessions';
import { signedRecords } from './signedRecords';
import { transactions } from './transactions';
import { transparencyCheckpointSnapshotEntries } from './transparencyCheckpoints';
import { usageReceipts } from './usageReceipts';
import { usageRefunds } from './usageRefunds';
import { usageReservations } from './usageReservations';
import { userAuthMethods } from './userAuthMethods';
import { userCredits } from './userCredits';
import { userLocations } from './userLocations';
import { users } from './users';
import { validationRequests } from './validationRequests';
import { webauthnCredentials } from './webauthnCredentials';

/** An id-shaped column that will never carry a foreign key. */
export interface IdColumnWithoutForeignKey {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly reason: string;
}

/**
 * `users` landed, so every entry that owed it a constraint has been converted to
 * a real `.references()` and deleted from this list — `blocks.user_id`,
 * `blocks.blocked_id`, `bookmarks.user_id`, `push_tokens.user_id`,
 * `labels.user_id` and `webauthn_credentials.user_id`. What remains is owed to
 * `applications`, which has not landed yet.
 */

export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [
];

export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly IdColumnWithoutForeignKey[] = [
  {
    table: followEvents,
    column: followEvents.relationshipId,
    reason:
      'The outbox has to OUTLIVE what it describes. `follow.removed` is an event about a ' +
      'relationship that no longer exists, so a foreign key would delete the record of the ' +
      'removal at the exact moment a consumer — federation teardown, a notification ' +
      'projection — needs to read it. The id is kept as a plain column deliberately.',
  },
  {
    table: followEvents,
    column: followEvents.eventId,
    reason:
      'Not a reference at all despite the name: it is this event\u2019s OWN public, ' +
      'deterministic identity, which consumers dedupe redeliveries on. There is nothing ' +
      'for it to point at.',
  },
  {
    table: bookmarks,
    column: bookmarks.postId,
    reason:
      '`Post` is Mention\'s model in Mention\'s database. There is no local ' +
      'table to reference, and the relation is enforced by neither store today.',
  },
  {
    table: pushTokens,
    column: pushTokens.deviceId,
    reason:
      'A central DEVICE id (the `DeviceSession.deviceId` id space), not the ' +
      'primary key of any row. Nothing to reference.',
  },
  {
    table: webauthnCredentials,
    column: webauthnCredentials.credentialID,
    reason:
      'The browser-supplied base64url WebAuthn credential handle. Id-shaped by ' +
      'name only — it identifies an authenticator credential, not an Oxy row.',
  },
  {
    table: federationKeyPairs,
    column: federationKeyPairs.keyId,
    reason:
      'An ActivityPub keyId URI (`https://<domain>/ap/users/<name>#main-key`). ' +
      'It names an actor on some domain — often a relying app Oxy signs for, ' +
      'not an Oxy account — so there is no local row to reference.',
  },
  {
    table: appAffinitySeenEvents,
    column: appAffinitySeenEvents.eventId,
    reason:
      'An id minted by the CONSUMING application for its own event. Oxy stores ' +
      'it to dedupe and never resolves it to anything.',
  },
  {
    table: users,
    column: users.federationActorId,
    reason:
      "`FederatedActor._id` in the CONSUMING app's database (Mention's), not " +
      'in this one. Oxy stores it and never resolves it.',
  },
  {
    table: userAuthMethods,
    column: userAuthMethods.methodCredentialId,
    reason:
      'The browser-supplied base64url WebAuthn credential handle, mirrored ' +
      'from `webauthn_credentials.credential_id`. It identifies an ' +
      'authenticator credential, not an Oxy row.',
  },
  {
    table: userLocations,
    column: userLocations.placeId,
    reason:
      "A third-party geocoder's identifier for a place (Nominatim, Google " +
      'Places). Opaque, external, and never dereferenced by Oxy.',
  },
  {
    table: userLocations,
    column: userLocations.osmId,
    reason:
      'An OpenStreetMap element id, meaningful only together with `osm_type`. ' +
      'External to Oxy entirely.',
  },
  {
    table: sessions,
    column: sessions.sessionId,
    reason:
      "(a) This row's own public handle — the UUID minted for it and embedded " +
      'in every access token. Other tables reference it; it references nothing.',
  },
  {
    table: sessions,
    column: sessions.deviceId,
    reason:
      '(b) The central DEVICE id space (`device_sessions.device_id`), not the ' +
      'primary key of any row. A session is routinely created before that ' +
      'device has a `device_sessions` row at all.',
  },
  {
    table: sessions,
    column: sessions.clientId,
    reason:
      '(c) The OAuth `client_id` — an `application_credentials.public_key`, ' +
      'which is that table\'s natural key and not its primary key, so there is ' +
      'nothing for a foreign key to point at. It records WHICH credential ' +
      'obtained this session, and must survive that credential being rotated ' +
      'or revoked: revocation is meant to stop new exchanges, not to erase the ' +
      'provenance of sessions already issued. The enforceable half of the ' +
      'binding is `application_id` beside it, which IS a foreign key and does ' +
      'CASCADE.',
  },
  {
    table: deviceSessions,
    column: deviceSessions.deviceId,
    reason:
      "(a) The device's own identifier — per web origin, per native app group. " +
      'It is this row\'s natural key, which is why it is UNIQUE here and a ' +
      'loose value everywhere else.',
  },
  {
    table: deviceSessionAccounts,
    column: deviceSessionAccounts.sessionId,
    reason:
      '(c) Names a `sessions` row by its natural key, with lifecycles that are ' +
      'independent BY DESIGN: the application never deletes a session (only ' +
      'the expiry sweep does), and when one goes the entry must SURVIVE so the ' +
      'mint path answers "dead session" instead of the device\'s account set ' +
      'silently shrinking — a shrink that would also skip the `revision` bump ' +
      'every real membership change makes. CASCADE would cause exactly that ' +
      'shrink; RESTRICT would stop the sweep.',
  },
  {
    table: devicePrincipals,
    column: devicePrincipals.personalSessionId,
    reason:
      '(c) The `sessions.session_id` minted when this PERSON authenticated on ' +
      'this device. Same independent lifecycle as ' +
      '`device_session_accounts.session_id`: the sweep deletes the session, the ' +
      'principal must survive it so the mint path answers "dead session" rather ' +
      'than the person vanishing from the device.',
  },
  {
    table: deviceAccountContexts,
    column: deviceAccountContexts.sessionId,
    reason:
      '(c) Names a `sessions` row by its natural key, and NULL additionally ' +
      'means "reachable, never yet used here" — a state no constraint can ' +
      'express. Same independent lifecycle as ' +
      '`device_session_accounts.session_id`: CASCADE would shrink the device set ' +
      'silently, RESTRICT would stop the expiry sweep.',
  },
  {
    table: devicePrincipalBackfillConflicts,
    column: devicePrincipalBackfillConflicts.deviceId,
    reason:
      '(b) Central device id of the device the backfill could not map cleanly. ' +
      'Not a row id, and deliberately unconstrained so the report outlives its ' +
      'subject — a CASCADE would delete exactly the evidence.',
  },
  {
    table: devicePrincipalBackfillConflicts,
    column: devicePrincipalBackfillConflicts.subjectId,
    reason:
      '(b) The account or user a backfill conflict is about, recorded as a bare ' +
      'id for the same reason as `device_id` above: a report that disappears ' +
      'when its subject does cannot answer "did the backfill lose anything?".',
  },
  {
    table: authCodes,
    column: authCodes.deviceId,
    reason:
      '(b) Central device id, threaded so the token exchange lands on the ' +
      'device the flow started from. Not a row id.',
  },
  {
    table: authSessions,
    column: authSessions.deviceId,
    reason:
      '(b) Central device id of the browser that STARTED the request, resolved ' +
      'from an optional device token. Not a row id.',
  },
  {
    table: authSessions,
    column: authSessions.authorizedSessionId,
    reason:
      '(c) The `sessions.session_id` of the session minted on approval. Same ' +
      'independent lifecycle as `device_session_accounts.session_id`, on a row ' +
      'that is itself swept an hour later.',
  },
  {
    table: authSessions,
    column: authSessions.finalizedAuthCodeId,
    reason:
      '(c) A RESERVATION, not a reference: `finalizeCommonsOAuth` mints the id ' +
      'and writes it in the SAME atomic update that spends the request, before ' +
      'the `auth_codes` row exists — and the mint may then fail, leaving an id ' +
      'that never becomes a row. A constraint would reject that write and ' +
      'destroy the single-use guarantee; SET NULL would be worse, resurrecting ' +
      "a spent request as un-finalized when the code's own 5-minute sweep ran " +
      'and letting it mint a SECOND authorization code.',
  },
  {
    table: devicePairingSessions,
    column: devicePairingSessions.pairingId,
    reason:
      "(a) This row's own single-use QR handle, which doubles as the HKDF salt " +
      'for the transfer key. Id-shaped by name only.',
  },
  {
    table: identityBindings,
    column: identityBindings.localPrincipalId,
    reason:
      "The APPLICATION's own identifier for a person, in the application's own " +
      'id space. Oxy stores it to match a claim against a binding and never ' +
      'resolves it to anything local.',
  },
  {
    table: securityActivities,
    column: securityActivities.deviceId,
    reason:
      '(b) Central device id the event happened on. An audit trail must keep ' +
      'naming the device that was removed, which is precisely one of the ' +
      'events it records.',
  },
  {
    table: transactions,
    column: transactions.itemId,
    reason:
      'What was purchased, in the CONSUMING application\'s id space. There is ' +
      'no local table to reference, and `item_type` — also free-form — is what ' +
      'names the space it belongs to.',
  },
  {
    table: userCredits,
    column: userCredits.stripeCustomerId,
    reason:
      "Stripe's identifier for the customer. Oxy stores it to talk to Stripe " +
      'and resolves it only back to this same row.',
  },
  {
    table: billingSubscriptions,
    column: billingSubscriptions.stripeCustomerId,
    reason: "Stripe's identifier for the customer. Not a row in this database.",
  },
  {
    table: billingSubscriptions,
    column: billingSubscriptions.stripeSubscriptionId,
    reason:
      "Stripe's identifier for the subscription. This table IS the local " +
      'mirror of it; the authority is Stripe.',
  },
  {
    table: billingSubscriptions,
    column: billingSubscriptions.stripePriceId,
    reason:
      "Stripe's identifier for the price. The catalogue it belongs to is a code " +
      'constant (`billing.ts:74`), not a table.',
  },
  {
    table: billingTransactions,
    column: billingTransactions.stripeCustomerId,
    reason: "Stripe's identifier for the customer. Not a row in this database.",
  },
  {
    table: billingTransactions,
    column: billingTransactions.stripePaymentIntentId,
    reason:
      "Stripe's identifier for the payment intent. Not a row in this database.",
  },
  {
    table: billingTransactions,
    column: billingTransactions.stripeSubscriptionId,
    // This one COULD be a foreign key — `billing_subscriptions.stripe_subscription_id`
    // is unique, and Postgres will reference a unique column. It deliberately is
    // not: `billing_subscriptions` is a MIRROR that may legitimately be missing a
    // subscription (one created before the mirror existed, or under a price id
    // this deployment does not recognise), and a record of money actually
    // charged must never be refused because a local mirror is incomplete.
    reason:
      "Stripe's identifier for the subscription this payment covers. Pointing " +
      'it at the local mirror would let an incomplete mirror reject a real ' +
      'payment record; Stripe is the authority for both.',
  },
  {
    table: notifications,
    column: notifications.entityId,
    reason:
      'Polymorphic, discriminated by `entity_type`. Two of the three types ' +
      '(`post`, `reply`) name rows in MENTION\'s database; the third ' +
      '(`profile`) names a user, but a foreign key cannot be conditional on a ' +
      'sibling column\'s value.',
  },
  {
    table: moderationEffects,
    column: moderationEffects.eventId,
    reason:
      "The emitting moderation system's transport event id. Oxy stores it to " +
      'answer a redelivery and never resolves it to a row here.',
  },
  {
    table: moderationEffects,
    column: moderationEffects.incidentId,
    reason:
      'The CROSS-TENANT incident id. The incident is the moderation service\'s ' +
      'own unit and has no table in this database — that is the point of it ' +
      'being cross-tenant.',
  },
  {
    table: moderationEffects,
    column: moderationEffects.caseId,
    reason: "A case in the moderation service's own store. Not a row here.",
  },
  {
    table: moderationEffects,
    column: moderationEffects.decisionId,
    reason:
      'The published decision. Its CONTENTS are deliberately not stored here — ' +
      '`proof_hash` is the provenance — so there is nothing to reference.',
  },
  {
    table: conductStrikes,
    column: conductStrikes.incidentId,
    reason: 'Same cross-tenant incident id as on `moderation_effects`.',
  },
  {
    table: conductStrikes,
    column: conductStrikes.decisionId,
    reason: 'Same external decision id as on `moderation_effects`.',
  },
  {
    table: messages,
    column: messages.messageId,
    reason:
      'The RFC 5322 `Message-ID` header, minted by whichever server sent the ' +
      'mail. It identifies a MESSAGE in the global email namespace, not a row ' +
      'here — most values name mail this database has never held.',
  },
  {
    table: messageAttachments,
    column: messageAttachments.contentId,
    reason:
      'The MIME `Content-ID` header, which an HTML body references as `cid:`. ' +
      'Scoped to one message and id-shaped by name only.',
  },
  {
    table: fileLinks,
    column: fileLinks.entityId,
    reason:
      "The entity's id in the CONSUMING application's database (a Mention " +
      'post, an Alia thread). Meaningful only together with `app` and ' +
      '`entity_type`, and never resolvable here.',
  },
  {
    table: signedRecords,
    column: signedRecords.recordId,
    reason:
      'The content address of the record ITSELF (sha256 of its canonical ' +
      'signing input) — the TARGET five other tables reference, not a ' +
      'reference of its own. Id-shaped because it identifies this row.',
  },
  {
    table: reputationTransactions,
    column: reputationTransactions.sourceActionId,
    reason:
      'The idempotency key the REPORTING system minted for its own action. Oxy ' +
      'stores it to deduplicate awards and never resolves it to anything.',
  },
  {
    table: validationRequests,
    column: validationRequests.sourceActionId,
    reason:
      'Same key space as `reputation_transactions.source_action_id` — the ' +
      "opening system's own action id, used only to dedupe an open jury.",
  },
  {
    table: reputationTransactions,
    column: reputationTransactions.targetEntityId,
    reason:
      'The id of whatever the action was ABOUT — a post, a report, a purchase ' +
      "— in the SOURCE application's id space. `target_entity_type` says which " +
      'space; none of them is a table in this database.',
  },
  {
    table: transparencyCheckpointSnapshotEntries,
    column: transparencyCheckpointSnapshotEntries.headRecordId,
    reason:
      'A value the checkpoint COMMITTED to under a signed Merkle root, not a ' +
      'live pointer. Any ON DELETE action would let an unrelated erasure alter ' +
      'published evidence, which is the exact tampering the log exists to ' +
      'detect — so the reference is deliberately unenforced and the row is ' +
      'immutable by trigger instead.',
  },
  {
    table: appUpdates,
    column: appUpdates.updateId,
    reason:
      "The update's OWN public handle — the UUID served as the expo-updates " +
      'manifest `id`, not a reference to another row. It is the TARGET of ' +
      '`app_updates.promoted_from_update_id`, which does carry a constraint.',
  },
  {
    table: appEndorsementEdges,
    column: appEndorsementEdges.sourceId,
    reason:
      "The consuming application's own key for the object the endorsement came " +
      'from (a list id, a pack id). Opaque to Oxy, part of the idempotency key ' +
      'only, and never dereferenced.',
  },

  // --- the inference ledger and its telemetry (#972 workstreams 7 and 8) ----
  //
  // Three shapes, and the reasons differ per shape rather than per column, so
  // each is spelled out once below and cross-referenced.

  {
    table: usageReservations,
    column: usageReservations.delegatedUserId,
    reason:
      '(d) The end user a first-party service acted FOR (ADR 0007). Attribution ' +
      'only — it is never the payer. Deliberately unconstrained in BOTH ' +
      'directions: `RESTRICT` would let an unrelated application’s spend ' +
      'block that person’s own account erasure, and `SET NULL` is worse, ' +
      'because NULL here already MEANS "no delegated user", so an erasure would ' +
      'silently reclassify a delegated request as a direct one on a financial ' +
      'record. A dangling id names who it was at the time, which is what an ' +
      'audit trail is for; scrubbing it is an explicit erasure decision, never ' +
      'a cascade.',
  },
  {
    table: usageReceipts,
    column: usageReceipts.delegatedUserId,
    reason: '(d) Same as `usage_reservations.delegated_user_id`.',
  },
  {
    table: inferenceUsageEvents,
    column: inferenceUsageEvents.delegatedUserId,
    reason: '(d) Same as `usage_reservations.delegated_user_id`.',
  },

  {
    table: usageReservations,
    column: usageReservations.requestId,
    reason:
      '(e) The edge’s correlation key for one inference request (ADR 0007), ' +
      'generated before authentication completes so a REJECTED request is still ' +
      'traceable. It identifies a request across the edge, the data plane, this ' +
      'ledger and the customer receipt — there is no request table here for ' +
      'it to point at, and there must not be one.',
  },
  {
    table: usageReceipts,
    column: usageReceipts.requestId,
    reason: '(e) Same as `usage_reservations.request_id`.',
  },
  {
    table: usageRefunds,
    column: usageRefunds.requestId,
    reason: '(e) Same as `usage_reservations.request_id`.',
  },
  {
    table: inferenceUsageEvents,
    column: inferenceUsageEvents.requestId,
    reason: '(e) Same as `usage_reservations.request_id`.',
  },

  {
    table: usageReceipts,
    column: usageReceipts.generationId,
    reason:
      '(f) One generated output within a request, allocated by the DATA PLANE ' +
      '— Oxy stores it opaquely and serves it back through ' +
      '`GET /v1/generations/:id`. It names a row in no database of ours.',
  },
  {
    table: inferenceUsageEvents,
    column: inferenceUsageEvents.generationId,
    reason: '(f) Same as `usage_receipts.generation_id`.',
  },
  {
    table: inferenceUsageEvents,
    column: inferenceUsageEvents.deploymentId,
    reason:
      '(f) The data plane’s endpoint identity. Operational detail belonging ' +
      'to Relay, stored opaquely for attribution and never dereferenced here.',
  },
];

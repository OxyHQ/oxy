/**
 * The write path an Oxy app uses to append a record to a PERSON's chain.
 *
 * Until now only the subject could write to their own chain: `POST
 * /identity/records` binds `env.subject` to the authenticated caller, which is
 * exactly right for a user signing on their own device and leaves no door at all
 * for an app publishing on a user's behalf. This is that door, and it is narrow
 * on purpose.
 *
 * ## Oxy signs, apps do not
 *
 * The envelope is issued by `OXY_DID` and signed with `OXY_PRIVATE_KEY`. Apps do
 * not carry their own issuer DID on the shared chain, because the protocol does
 * not allow it: `ResolvedVerificationMethods` (`@oxyhq/protocol`) declares
 * `custodialIssuer`/`custodialPublicKey` in the SINGULAR, and `isAuthorizedKey`
 * accepts exactly two shapes — `issuer === subject` with the subject's own keys,
 * or that one custodial issuer. Admitting per-app issuers would mean widening a
 * shared package's core type and maintaining a trust list; routing the signature
 * through Oxy needs neither, and mirrors how federation keys already work
 * (`POST /federation/sign`).
 *
 * The cost, stated rather than hidden: a record signed under an app's OWN issuer
 * DID — as Mention's existing chain is — cannot be moved here without re-signing,
 * and re-signing changes the content address. A record signed by the USER on
 * their device cannot be re-signed by anyone at all.
 *
 * ## What authorizes the write
 *
 * A service credential proves which APP is calling. It does not prove the person
 * asked for anything, and nothing here pretends otherwise. Three independent gates
 * stand between a credential and someone's chain:
 *
 *  1. the `chains:write` scope on the service token,
 *  2. the subject's revocable OAuth grant of `chains:write` to the app, and
 *  3. the collection falling under one of the application's own
 *     `chainNamespaces` prefixes.
 *
 * The third is the namespace boundary: it is what stops an app with a valid
 * credential writing `app.someoneelse.*` records into every account it can name.
 * An application with no granted namespace can write nothing — the empty list
 * authorizes nothing rather than everything.
 *
 * Publishability is NOT decided here. Writing under your own namespace does not
 * make a collection readable by others; that stays
 * `config/chainCollectionPolicy.ts`, so a new private collection is private on
 * the read side the moment it exists.
 *
 * ## Inert without the custodial key
 *
 * With `OXY_PRIVATE_KEY` unset this refuses rather than pretending: an
 * environment that cannot sign must not accept writes it will silently drop.
 */

import { and, eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { appGrants } from '../db/schema/appGrants';
import { buildUserDid, OXY_DID } from './did.service';
import { oxyRecordStore } from './oxyRecordStore';
import { signRecordEnvelope, verifyAndStoreRecord, type StoredRecordRef } from './signedRecord.service';

/** The scope a service credential must carry to append on someone's behalf. */
export const CHAINS_WRITE_SCOPE = 'chains:write';

/**
 * Signature algorithm identifier for the custodial key. Matches what
 * `signRecordEnvelope` produces and what the resolver checks.
 */
const CUSTODIAL_ALG = 'ES256K-DER-SHA256';

/**
 * A concurrent writer can take the `seq` this call just read. The store answers
 * that as `chain_conflict`; re-reading the head and rebuilding is the fix, and
 * three attempts is what Mention's equivalent settled on.
 */
const MAX_APPEND_ATTEMPTS = 3;

/** Outcomes a caller has to distinguish. Never thrown — every one maps to a status. */
export type AppChainWriteResult =
  | { ok: true; record: StoredRecordRef }
  | {
      ok: false;
      reason:
        | 'namespace_forbidden'
        | 'subject_forbidden'
        | 'signing_disabled'
        | 'unknown_application'
        | 'rejected';
      detail?: string;
    };

/** The namespace prefixes an application may write under, or `null` if unknown. */
export async function chainNamespacesForApplication(appId: string): Promise<string[] | null> {
  const [row] = await getDb()
    .select({ chainNamespaces: applications.chainNamespaces })
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  return row ? row.chainNamespaces : null;
}

/**
 * Whether `collection` falls under one of `namespaces`.
 *
 * Prefix matching on a DOT boundary, not a bare `startsWith`: a grant of
 * `app.mention.` must not authorize `app.mentionother.feed.post`. Callers grant
 * prefixes with the trailing dot, and one is appended when a grant omits it so a
 * hand-entered `app.mention` cannot silently widen to a neighbouring namespace.
 */
export function collectionIsWithinNamespaces(collection: string, namespaces: readonly string[]): boolean {
  return namespaces.some((raw) => {
    const prefix = raw.endsWith('.') ? raw : `${raw}.`;
    return collection.startsWith(prefix) && collection.length > prefix.length;
  });
}

/**
 * Append `record` to `oxyUserId`'s chain under `collection`/`rkey`, issued and
 * signed by Oxy on `appId`'s behalf.
 *
 * `issuedAt` is the SERVER's clock, which is the one thing that separates this
 * from an ingest path: an app cannot assert when its own record happened, so
 * there is no self-asserted timestamp to clamp here.
 */
export async function appendAppRecord(args: {
  appId: string;
  oxyUserId: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}): Promise<AppChainWriteResult> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    return { ok: false, reason: 'signing_disabled' };
  }

  const namespaces = await chainNamespacesForApplication(args.appId);
  if (namespaces === null) {
    return { ok: false, reason: 'unknown_application' };
  }
  if (!collectionIsWithinNamespaces(args.collection, namespaces)) {
    return { ok: false, reason: 'namespace_forbidden', detail: args.collection };
  }

  const [grant] = await getDb()
    .select({ scopes: appGrants.scopes })
    .from(appGrants)
    .where(and(eq(appGrants.applicationId, args.appId), eq(appGrants.userId, args.oxyUserId)))
    .limit(1);
  if (!grant?.scopes.includes(CHAINS_WRITE_SCOPE)) {
    return { ok: false, reason: 'subject_forbidden' };
  }

  const subject = buildUserDid(args.oxyUserId);

  let lastReason = 'chain_conflict';
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const head = await oxyRecordStore.getHead(subject);
    const fields: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 2,
      type: 'app_record',
      subject,
      issuer: OXY_DID,
      record: args.record,
      issuedAt: Date.now(),
      seq: head ? head.seq + 1 : 0,
      prev: head ? head.headRecordId : null,
      collection: args.collection,
      rkey: args.rkey,
      publicKey,
      alg: CUSTODIAL_ALG,
    };

    const envelope = signRecordEnvelope(fields, privateKey);
    const outcome = await verifyAndStoreRecord(envelope, args.oxyUserId);
    if (outcome.ok) {
      return { ok: true, record: outcome.record };
    }

    lastReason = outcome.reason;
    // Only a lost race is worth retrying — every other rejection is a property
    // of the envelope and would be rebuilt identically.
    if (outcome.reason !== 'chain_conflict' && outcome.reason !== 'bad_seq') {
      return { ok: false, reason: 'rejected', detail: outcome.reason };
    }
  }

  return { ok: false, reason: 'rejected', detail: lastReason };
}

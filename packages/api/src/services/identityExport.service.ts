/**
 * Identity Export Service (self-sovereign identity layer — B6, "credible exit")
 *
 * Assembles the signed, open-format data-export bundle a user can download to
 * take a portable, verifiable snapshot of their Oxy account: DID document,
 * profile (secrets stripped exactly like `formatUserResponse`), verified
 * domains, auth methods (no secrets), published signed records, per-app data,
 * social graph, and what the account was charged — sealed with an Oxy provenance
 * attestation.
 *
 * ## The financial section (#972 section 12)
 *
 * `DELETE /users/me` retains financial records by law while erasing everything
 * optional, and this export disclosed none of them: a person exercising a
 * subject-access request learned nothing about what they had been charged unless
 * they also happened to be an account administrator with access to the enterprise
 * reporting route. {@link readFinancialSection} is the other half of that
 * checkbox — read-only, scoped to the caller's own account, and additive to the
 * contract.
 *
 * The attestation is an `ES256K-DER-SHA256` signature over the canonical-JSON of
 * the bundle WITHOUT the attestation, produced with the server-held Oxy key
 * (`OXY_PRIVATE_KEY` / `OXY_PUBLIC_KEY`). When that key is not configured the
 * bundle is still served with `attestation: null` and a warning is logged — the
 * export must never crash on a missing key.
 *
 * ## Storage (Postgres) — six tables where Mongo had one document plus two
 *
 * `verifiedDomains[]`, `authMethods[]`, `following[]` and `followers[]` were all
 * embedded arrays on the Mongo user document. Three are child tables now
 * (`user_verified_domains`, `user_auth_methods`) and the social graph is
 * `user_follows`, which `schema/CONVENTIONS.md` makes the SINGLE authority — the
 * embedded id arrays are deleted, so reading them is the only correct port.
 *
 * **Every read is ORDERED, and that is load-bearing here rather than tidiness.**
 * The bundle's bytes are the SIGNING INPUT of the Oxy attestation, so an
 * unordered read (Postgres heap order) would let two exports of an unchanged
 * account produce different bytes and different signatures. Each ordering is the
 * faithful analogue of what Mongo returned:
 *
 * | section | ordering | why it is the same order Mongo gave |
 * |---|---|---|
 * | `verifiedDomains` | `created_at, id` | array insertion order; re-verifying updated the entry in place |
 * | `authMethods` | `linked_at, id` | array insertion order, as `routes/authLinking.ts` also reads it |
 * | `appData` | `namespace, key` | Mongo served `find({userId})` from the `{userId, namespace, key}` unique index |
 * | `social.*` | `created_at, id` | the order edges were pushed onto the arrays |
 *
 * ## Secrets
 *
 * The profile comes from `UserService.readAccountDocument`, which selects
 * `publicColumns(users)` — the `select: false` replacement
 * (`db/schema/protectedColumns.ts`). That is STRICTLY stronger than the Mongoose
 * projection it replaces: the old `.select('-password …')` string never excluded
 * `phone`, and relied on `formatUserResponse`'s explicit field list to keep it
 * out of the bundle. Now the column cannot be read at all — the row type has no
 * `phone` property, so a serializer that reached for one would fail `tsc`.
 * `formatUserResponse` remains the second, independent gate.
 */

import { eq } from 'drizzle-orm';
import { canonicalize } from '@oxyhq/protocol';
import type {
  ExportBundle,
  ExportAttestation,
  ExportFinancialSection,
  VerifiedDomain,
  SignedRecordEnvelope,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { billingLedgerEntries } from '../db/schema/billingLedgerEntries';
import { usageReceipts } from '../db/schema/usageReceipts';
import { usageReservations } from '../db/schema/usageReservations';
import { userAppData } from '../db/schema/userAppData';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { userFollows } from '../db/schema/userFollows';
import { users } from '../db/schema/users';
import { userVerifiedDomains } from '../db/schema/userVerifiedDomains';
import SignatureService from './signature.service';
import { buildUserDid, buildDidDocument, OXY_DID } from './did.service';
import { getLatestRecord } from './signedRecord.service';
import { userService } from './user.service';
import { buildAuthMethodEntries } from '../utils/authMethodEntries';
import { formatUserResponse } from '../utils/userTransform';
import { logger } from '../utils/logger';

/** Versioned schema id for the export envelope. */
const EXPORT_SCHEMA_URL = 'https://oxy.so/schemas/identity-export/v1';
const ALG = 'ES256K-DER-SHA256' as const;

/** The bundle as assembled BEFORE the attestation is computed/appended. */
export type ExportBundleWithoutAttestation = Omit<ExportBundle, 'attestation' | 'proof'>;

export interface ExportBundleResult {
  /** The bundle. `attestation` is null when the Oxy signing key is unconfigured. */
  bundle: ExportBundleWithoutAttestation & { attestation: ExportAttestation | null };
  attestationMissing: boolean;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * What this account was charged, for the subject-access export (#972 section 12).
 *
 * ## Scoped to the caller's OWN account, and to nothing else
 *
 * Every one of the three tables is keyed on `account_id`, and every read below
 * filters on the caller's id — never on an application, never on a delegated
 * user, never on an organization the caller belongs to. An account this person
 * merely has a membership in has its own subject and its own export;
 * `GET /inference/reporting/accounts/:accountId/charges/export` is the
 * enterprise surface for that, with its own authorization.
 *
 * `__tests__/identityExport.financial.test.ts` asserts the isolation in both
 * directions against a real database: A's export carries A's rows and none of
 * B's, in the same bundle.
 *
 * ## Read-only, and ORDERED for the same reason every other section is
 *
 * The bundle's bytes are the signing input of the Oxy attestation, so an
 * unordered read would let two exports of an unchanged account produce different
 * signatures. Each ordering leads with the natural time column and breaks ties on
 * the id, which is total.
 *
 * ## The projection is deliberately narrow
 *
 * A receipt carries Oxy's own commercial position — the price version it was
 * computed from, the routing policy revision, the internal usage source. What a
 * person is owed is what they were charged, for which request, when, and in what
 * currency. `resolvedModelReference` and `servingProvider` are included because
 * they are already customer-visible on the receipt read.
 *
 * Amounts are carried as the exact decimal STRINGS the ledger stores. A JSON
 * number cannot represent them and a rounded bill is a wrong bill.
 *
 * ## Unbounded, and that is a stated property
 *
 * There is no cap: a truncated subject-access export would be a worse defect than
 * a large one, and the route's `?format=ndjson` arm exists for the accounts where
 * size becomes the problem. The route is rate-limited to 5/hour per user.
 */
async function readFinancialSection(accountId: string): Promise<ExportFinancialSection> {
  const db = getDb();

  const [receiptRows, ledgerRows, reservationRows] = await Promise.all([
    db
      .select({
        receiptId: usageReceipts.id,
        requestId: usageReceipts.requestId,
        settledAt: usageReceipts.settledAt,
        billedAmount: usageReceipts.billedAmount,
        currency: usageReceipts.currency,
        outcome: usageReceipts.outcome,
        resolvedModelReference: usageReceipts.resolvedModelReference,
        servingProvider: usageReceipts.servingProvider,
        platformFeeOnly: usageReceipts.platformFeeOnly,
      })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, accountId))
      .orderBy(usageReceipts.settledAt, usageReceipts.id),
    db
      .select({
        entryId: billingLedgerEntries.id,
        kind: billingLedgerEntries.kind,
        currency: billingLedgerEntries.currency,
        createdAt: billingLedgerEntries.createdAt,
      })
      .from(billingLedgerEntries)
      .where(eq(billingLedgerEntries.accountId, accountId))
      .orderBy(billingLedgerEntries.createdAt, billingLedgerEntries.id),
    db
      .select({
        reservationId: usageReservations.id,
        requestId: usageReservations.requestId,
        status: usageReservations.status,
        reservedAmount: usageReservations.reservedAmount,
        currency: usageReservations.currency,
        createdAt: usageReservations.createdAt,
        expiresAt: usageReservations.expiresAt,
      })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, accountId))
      .orderBy(usageReservations.createdAt, usageReservations.id),
  ]);

  return {
    receipts: receiptRows.map((row) => ({
      receiptId: row.receiptId,
      requestId: row.requestId,
      settledAt: toIsoString(row.settledAt),
      billedAmount: row.billedAmount,
      currency: row.currency,
      outcome: row.outcome,
      resolvedModelReference: row.resolvedModelReference,
      servingProvider: row.servingProvider,
      platformFeeOnly: row.platformFeeOnly,
    })),
    ledgerEntries: ledgerRows.map((row) => ({
      entryId: row.entryId,
      kind: row.kind,
      currency: row.currency,
      createdAt: toIsoString(row.createdAt),
    })),
    reservations: reservationRows.map((row) => ({
      reservationId: row.reservationId,
      requestId: row.requestId,
      status: row.status,
      reservedAmount: row.reservedAmount,
      currency: row.currency,
      createdAt: toIsoString(row.createdAt),
      expiresAt: toIsoString(row.expiresAt),
    })),
  };
}

/**
 * Sign the assembled bundle with the Oxy custodial key. Returns null (and logs)
 * when `OXY_PRIVATE_KEY`/`OXY_PUBLIC_KEY` are not configured.
 */
function signBundle(bundle: ExportBundleWithoutAttestation): ExportAttestation | null {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    logger.warn(
      'Identity export attestation omitted: OXY_PRIVATE_KEY/OXY_PUBLIC_KEY not configured',
      { component: 'identityExport' },
    );
    return null;
  }
  const signature = SignatureService.signMessage(canonicalize(bundle), privateKey);
  return { issuer: OXY_DID, publicKey, alg: ALG, signature, signedAt: Date.now() };
}

/**
 * Build the signed export bundle for `userId`, or null when the user is absent.
 *
 * Secrets (password, refresh token, 2FA material, contact hashes, raw phone,
 * email forwarding/signature) are excluded at the QUERY level by
 * `publicColumns(users)` and again by `formatUserResponse`, which emits only an
 * explicit, secret-free field set. `user_auth_methods` is read as the three
 * non-secret columns the DID mapping needs — never the whole row.
 */
export async function buildExportBundle(userId: string): Promise<ExportBundleResult | null> {
  const db = getDb();

  // Two reads of the same `users` row, deliberately. `readAccountDocument`
  // assembles the whole account — including the 23 privacy toggles, locations,
  // link metadata and the folded theme preference that `formatUserResponse`
  // emits — and returns it as an `AccountDocument`, whose index signature types
  // every field `unknown`. The DID document and the auth-method entries need
  // TYPED values (`publicKey`, `createdAt`, …), and narrowing them back out of
  // `unknown` would be a cast; selecting the five identity columns explicitly is
  // both honest and cheaper than duplicating that assembly here.
  const [identity, account, domainRows, authMethodRows] = await Promise.all([
    db
      .select({
        publicKey: users.publicKey,
        username: users.username,
        type: users.type,
        federationDomain: users.federationDomain,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    userService.readAccountDocument(userId),
    db
      .select({
        domain: userVerifiedDomains.domain,
        verifiedAt: userVerifiedDomains.verifiedAt,
        method: userVerifiedDomains.method,
      })
      .from(userVerifiedDomains)
      .where(eq(userVerifiedDomains.userId, userId))
      .orderBy(userVerifiedDomains.createdAt, userVerifiedDomains.id),
    db
      .select({
        type: userAuthMethods.type,
        linkedAt: userAuthMethods.linkedAt,
        methodPublicKey: userAuthMethods.methodPublicKey,
        methodCredentialId: userAuthMethods.methodCredentialId,
        methodName: userAuthMethods.methodName,
      })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, userId))
      .orderBy(userAuthMethods.linkedAt, userAuthMethods.id),
  ]);
  const self = identity[0];
  if (!self || !account) {
    return null;
  }

  const did = buildUserDid(userId);
  const didDocument = buildDidDocument({
    _id: userId,
    publicKey: self.publicKey,
    username: self.username,
    // `buildAuthMethodEntries` and `buildDidDocument` both still read the
    // `metadata.*` shape the Mongo subdocument had; the child-table columns are
    // adapted to it HERE rather than by changing helpers other routes share.
    authMethods: authMethodRows.map((method) => ({
      type: method.type,
      metadata: { publicKey: method.methodPublicKey },
    })),
    verifiedDomains: domainRows,
    type: self.type,
    federation: self.federationDomain ? { domain: self.federationDomain } : null,
    node: null,
  });

  // formatUserResponse returns ONLY explicitly-picked, secret-free fields. The
  // account document is handed the ORDERED domain rows so the profile section
  // and the bundle's own `verifiedDomains` cannot disagree on order — two
  // renderings of one fact inside a single signed artifact.
  const profile = (formatUserResponse({ ...account, verifiedDomains: domainRows }) ?? {}) as Record<string, unknown>;

  const verifiedDomains: VerifiedDomain[] = domainRows.map((domain) => ({
    domain: domain.domain,
    verifiedAt: toIsoString(domain.verifiedAt),
    method: domain.method,
  }));

  const authMethods = buildAuthMethodEntries({
    publicKey: self.publicKey,
    authMethods: authMethodRows.map((method) => ({
      type: method.type,
      linkedAt: method.linkedAt,
      metadata: { credentialID: method.methodCredentialId, name: method.methodName },
    })),
    createdAt: self.createdAt,
  });

  // Latest identity + profile signed records (the published envelopes), through
  // the same accessor the public record route uses so the export can never serve
  // a different "latest" than `GET /identity/records/:userId/:type`.
  const latest = await Promise.all(
    (['identity', 'profile'] as const).map((type) => getLatestRecord(userId, type)),
  );
  const signedRecords: SignedRecordEnvelope[] = latest
    .filter((record): record is { envelope: SignedRecordEnvelope } => record !== null)
    .map((record) => record.envelope);

  const [appDataRows, followingRows, followerRows, financial] = await Promise.all([
    db
      .select({ namespace: userAppData.namespace, key: userAppData.key, value: userAppData.value })
      .from(userAppData)
      .where(eq(userAppData.userId, userId))
      .orderBy(userAppData.namespace, userAppData.key),
    db
      .select({ id: userFollows.followedId })
      .from(userFollows)
      .where(eq(userFollows.followerId, userId))
      .orderBy(userFollows.createdAt, userFollows.id),
    db
      .select({ id: userFollows.followerId })
      .from(userFollows)
      .where(eq(userFollows.followedId, userId))
      .orderBy(userFollows.createdAt, userFollows.id),
    readFinancialSection(userId),
  ]);

  const appData: Record<string, unknown>[] = appDataRows.map((row) => ({
    namespace: row.namespace,
    key: row.key,
    value: row.value,
  }));

  // Social graph as portable DIDs.
  const following = followingRows.map((row) => buildUserDid(row.id));
  const followers = followerRows.map((row) => buildUserDid(row.id));

  const bundleWithoutAttestation: ExportBundleWithoutAttestation = {
    '$schema': EXPORT_SCHEMA_URL,
    exportedAt: new Date().toISOString(),
    did,
    didDocument,
    profile,
    verifiedDomains,
    authMethods,
    signedRecords,
    appData,
    social: { following, followers },
    financial,
  };

  const attestation = signBundle(bundleWithoutAttestation);
  return {
    bundle: { ...bundleWithoutAttestation, attestation },
    attestationMissing: attestation === null,
  };
}

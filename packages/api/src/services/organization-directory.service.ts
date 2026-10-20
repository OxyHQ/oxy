import { alias } from 'drizzle-orm/pg-core';
import userCache from '../utils/userCache';
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type {
  SafetyOrganizationsInput,
  SafetyOrganizationIdentity,
  CreateOrganization,
  Organization,
  OrganizationClaim,
  OrganizationClaimDetail,
  OrganizationClaimListQuery,
  OrganizationImportBatch,
  OrganizationCuration,
  OrganizationExternalInput,
  OrganizationSearch,
  UpdateOrganization,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { insertNeutralOrganizations, neutralOrganizationId } from './accountCreation.service';
import {
  users,
  blocks,
  files,
  applications,
  billingProfiles,
  sessions,
  deviceAccountContexts,
  userPasswords,
  userAuthMethods,
  userVerifiedDomains,
  accountMembers,
  organizationProfiles,
  organizationExternalIds,
  organizationClaims,
  organizationDirectoryAudit,
  organizationSearchTerms,
} from '../db/schema';

export class OrganizationDirectoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'bad_request' | 'forbidden' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
const missing = () => new OrganizationDirectoryError(404, 'not_found', 'Organization not found');
const columns = {
  accountId: users.id,
  username: users.username,
  name: users.nameDisplay,
  avatar: users.avatar,
  organizationType: organizationProfiles.organizationType,
  legalName: organizationProfiles.legalName,
  websiteUrl: organizationProfiles.websiteUrl,
  countryCode: organizationProfiles.countryCode,
  aliases: organizationProfiles.aliases,
  claimStatus: organizationProfiles.claimStatus,
  status: organizationProfiles.status,
  mergedIntoAccountId: organizationProfiles.mergedIntoAccountId,
  createdAt: organizationProfiles.createdAt,
  updatedAt: organizationProfiles.updatedAt,
};
function publicRows(db: DatabaseOrTransaction) {
  return db
    .select(columns)
    .from(organizationProfiles)
    .innerJoin(users, eq(users.id, organizationProfiles.accountId));
}
type DirectoryRow = Awaited<ReturnType<ReturnType<typeof publicRows>['where']>>[number];
async function presentMany(
  db: DatabaseOrTransaction,
  rows: DirectoryRow[],
): Promise<Organization[]> {
  if (!rows.length) return [];
  const domains = await db
    .select({ userId: userVerifiedDomains.userId, domain: userVerifiedDomains.domain })
    .from(userVerifiedDomains)
    .where(
      inArray(
        userVerifiedDomains.userId,
        rows.map((row) => row.accountId),
      ),
    );
  const byAccount = new Map<string, string[]>();
  for (const domain of domains) {
    const current = byAccount.get(domain.userId) ?? [];
    current.push(domain.domain);
    byAccount.set(domain.userId, current);
  }
  return rows.map((row) => ({
    ...row,
    name: row.name ?? row.username ?? '',
    verifiedDomains: (byAccount.get(row.accountId) ?? []).sort(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** Redirects are flattened on merge, so every batch needs at most two identity queries. */
async function batchOrganizationRows(ids: string[], db: DatabaseOrTransaction, extra?: SQL) {
  const unique = [...new Set(ids)];
  if (!unique.length) return { items: [], missingIds: [] };
  const initial = await publicRows(db).where(
    and(
      inArray(users.id, unique),
      eq(users.kind, 'organization'),
      ne(users.accountStatus, 'archived'),
      eq(users.privacyIsPrivateAccount, false),
      ne(organizationProfiles.status, 'suppressed'),
      extra,
    ),
  );
  const redirects = initial.flatMap((row) =>
    row.mergedIntoAccountId ? [row.mergedIntoAccountId] : [],
  );
  const targets = redirects.length
    ? await publicRows(db).where(
        and(
          inArray(users.id, redirects),
          eq(users.kind, 'organization'),
          ne(users.accountStatus, 'archived'),
          eq(users.privacyIsPrivateAccount, false),
          inArray(organizationProfiles.status, ['active', 'inactive']),
          extra,
        ),
      )
    : [];
  const byId = new Map([...initial, ...targets].map((row) => [row.accountId, row]));
  const items: { requestedAccountId: string; organization: DirectoryRow }[] = [];
  const missingIds: string[] = [];
  for (const requestedAccountId of unique) {
    const original = byId.get(requestedAccountId);
    const resolved = original?.mergedIntoAccountId
      ? byId.get(original.mergedIntoAccountId)
      : original;
    if (!resolved || resolved.status === 'merged') missingIds.push(requestedAccountId);
    else items.push({ requestedAccountId, organization: resolved });
  }
  return { items, missingIds };
}
export async function batchOrganizations(ids: string[], db: DatabaseOrTransaction = getDb()) {
  const resolved = await batchOrganizationRows(ids, db);
  const identities = new Map(
    (
      await presentMany(
        db,
        resolved.items.map((item) => item.organization),
      )
    ).map((row) => [row.accountId, row]),
  );
  return {
    items: resolved.items.map((item) => {
      const organization = identities.get(item.organization.accountId);
      if (!organization) throw missing();
      return { requestedAccountId: item.requestedAccountId, organization };
    }),
    missingIds: resolved.missingIds,
  };
}
export async function getOrganization(
  accountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Organization> {
  const result = await batchOrganizations([accountId], db);
  if (!result.items[0]) throw missing();
  return result.items[0].organization;
}

async function searchOrganizationRows(
  input: OrganizationSearch,
  extra?: SQL,
  safetyActor?: string,
) {
  const query = (input.query ?? '').trim().toLowerCase();
  const limit = Number(input.limit ?? 20);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([query, input.organizationType ?? null]))
    .digest('hex');
  let after = '';
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        cursor.kind !== 'organizations' ||
        cursor.fingerprint !== fingerprint ||
        typeof cursor.after !== 'string' ||
        cursor.after.length > 128
      )
        throw new Error('invalid');
      after = cursor.after;
    } catch {
      throw new OrganizationDirectoryError(
        400,
        'bad_request',
        'Cursor belongs to another list or is invalid',
      );
    }
  }
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const sourceIdentity = alias(users, 'organization_search_source');
  const matchingAccounts = getDb()
    .select({
      accountId: sql<string>`coalesce(${organizationProfiles.mergedIntoAccountId},${organizationSearchTerms.accountId})`,
    })
    .from(organizationSearchTerms)
    .innerJoin(
      organizationProfiles,
      eq(organizationProfiles.accountId, organizationSearchTerms.accountId),
    )
    .innerJoin(sourceIdentity, eq(sourceIdentity.id, organizationSearchTerms.accountId))
    .where(
      and(
        sql`${organizationSearchTerms.term} like ${`${escaped}%`}`,
        ne(organizationProfiles.status, 'suppressed'),
        eq(sourceIdentity.privacyIsPrivateAccount, false),
        ne(sourceIdentity.accountStatus, 'archived'),
        safetyActor
          ? and(
              eq(sourceIdentity.accountStatus, 'active'),
              eq(sourceIdentity.privacyProfileVisibility, true),
              ne(sourceIdentity.reputationTier, 'restricted'),
              inArray(organizationProfiles.status, ['active', 'merged']),
              sql`not exists (select 1 from ${blocks} b where (b.user_id = ${safetyActor} and b.blocked_id = ${sourceIdentity.id}) or (b.blocked_id = ${safetyActor} and b.user_id = ${sourceIdentity.id}))`,
            )
          : undefined,
      ),
    );
  const rows = await publicRows(getDb())
    .where(
      and(
        eq(users.kind, 'organization'),
        ne(users.accountStatus, 'archived'),
        eq(users.privacyIsPrivateAccount, false),
        inArray(organizationProfiles.status, ['active', 'inactive']),
        extra,
        input.organizationType
          ? eq(organizationProfiles.organizationType, input.organizationType)
          : undefined,
        query ? inArray(users.id, matchingAccounts) : undefined,
        after ? gt(users.id, after) : undefined,
      ),
    )
    .orderBy(asc(users.id))
    .limit(limit + 1);
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    items: visible,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ kind: 'organizations', fingerprint, after: last.accountId }),
          ).toString('base64url')
        : null,
  };
}

export async function searchOrganizations(input: OrganizationSearch) {
  const result = await searchOrganizationRows(input);
  return { ...result, items: await presentMany(getDb(), result.items) };
}
/** Same indexed directory and flattened redirects, with a strict safety identity projection. */
export async function safetyOrganizationIdentities(actor: string, input: SafetyOrganizationsInput) {
  const available = and(
    eq(users.accountStatus, 'active'),
    eq(users.privacyProfileVisibility, true),
    ne(users.reputationTier, 'restricted'),
    inArray(organizationProfiles.status, ['active', 'merged']),
    sql`not exists (select 1 from ${blocks} b where (b.user_id = ${actor} and b.blocked_id = ${users.id}) or (b.blocked_id = ${actor} and b.user_id = ${users.id}))`,
  );
  const identity = (row: DirectoryRow): SafetyOrganizationIdentity => ({
    accountId: row.accountId,
    username: row.username,
    name: row.name ?? row.username ?? '',
    organizationType: row.organizationType,
  });
  if ('ids' in input) {
    const result = await batchOrganizationRows(input.ids, getDb(), available);
    return {
      items: result.items.map((item) => ({
        requestedAccountId: item.requestedAccountId,
        organization: identity(item.organization),
      })),
      missingIds: result.missingIds,
    };
  }
  const result = await searchOrganizationRows(
    { query: input.query, limit: input.limit ?? 20 },
    available,
    actor,
  );
  return {
    items: result.items.map((row) => ({
      requestedAccountId: row.accountId,
      organization: identity(row),
    })),
    missingIds: [],
  };
}

async function insertNeutral(
  db: DatabaseOrTransaction,
  organization: CreateOrganization,
  avatar?: string,
): Promise<string> {
  const accountId = neutralOrganizationId();
  await insertNeutralOrganizations(db, [{ accountId, organization, avatar }]);
  return accountId;
}
export async function createNeutralOrganization(input: CreateOrganization): Promise<Organization> {
  return getDb().transaction(async (tx) => getOrganization(await insertNeutral(tx, input), tx));
}

export async function updateOrganization(
  accountId: string,
  input: UpdateOrganization,
): Promise<Organization> {
  const organization = await getDb().transaction(async (tx) => {
    const [profile] = await tx
      .select({
        claimStatus: organizationProfiles.claimStatus,
        status: organizationProfiles.status,
      })
      .from(organizationProfiles)
      .where(eq(organizationProfiles.accountId, accountId))
      .for('update');
    if (!profile) throw missing();
    if (profile.claimStatus !== 'claimed' || profile.status !== 'active')
      throw new OrganizationDirectoryError(
        403,
        'forbidden',
        'Only an active claimed organization may be edited',
      );
    if (input.name !== undefined)
      await tx
        .update(users)
        .set({ nameDisplay: input.name, updatedAt: new Date() })
        .where(eq(users.id, accountId));
    await tx
      .update(organizationProfiles)
      .set({
        organizationType: input.organizationType,
        legalName: input.legalName,
        websiteUrl: input.websiteUrl,
        countryCode: input.countryCode,
        aliases: input.aliases,
        updatedAt: new Date(),
      })
      .where(eq(organizationProfiles.accountId, accountId));
    return getOrganization(accountId, tx);
  });
  userCache.invalidate(accountId);
  return organization;
}

const claimColumns = {
  id: organizationClaims.id,
  accountId: organizationClaims.accountId,
  claimantUserId: organizationClaims.claimantUserId,
  status: organizationClaims.status,
  createdAt: organizationClaims.createdAt,
};
const claimDetailColumns = {
  ...claimColumns,
  evidenceReference: organizationClaims.evidenceReference,
  reviewEvidenceReference: organizationClaims.reviewEvidenceReference,
  reviewedAt: organizationClaims.reviewedAt,
};
function presentClaim(row: {
  id: string;
  accountId: string;
  claimantUserId: string;
  status: OrganizationClaim['status'];
  createdAt: Date;
}): OrganizationClaim {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
function presentClaimDetail(
  row: Omit<OrganizationClaimDetail, 'createdAt' | 'reviewedAt'> & {
    createdAt: Date;
    reviewedAt: Date | null;
  },
): OrganizationClaimDetail {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}
/** A null claimant is reserved for the route's fresh staff authority check. */
export async function listOrganizationClaims(
  claimantUserId: string | null,
  input: OrganizationClaimListQuery,
) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([claimantUserId, input.status ?? null]))
    .digest('hex');
  let after = '';
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        cursor.kind !== 'organization_claims' ||
        cursor.fingerprint !== fingerprint ||
        typeof cursor.after !== 'string' ||
        cursor.after.length > 128
      )
        throw new Error('invalid');
      after = cursor.after;
    } catch {
      throw new OrganizationDirectoryError(
        400,
        'bad_request',
        'Cursor belongs to another list or is invalid',
      );
    }
  }
  const limit = Number(input.limit ?? 20);
  const rows = await getDb()
    .select(claimDetailColumns)
    .from(organizationClaims)
    .where(
      and(
        claimantUserId ? eq(organizationClaims.claimantUserId, claimantUserId) : undefined,
        input.status ? eq(organizationClaims.status, input.status) : undefined,
        after ? gt(organizationClaims.id, after) : undefined,
      ),
    )
    .orderBy(asc(organizationClaims.id))
    .limit(limit + 1);
  const visible = rows.slice(0, limit),
    last = visible[visible.length - 1];
  return {
    items: visible.map(presentClaimDetail),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ kind: 'organization_claims', fingerprint, after: last.id }),
          ).toString('base64url')
        : null,
  };
}
export async function getOrganizationClaim(claimId: string, claimantUserId: string | null) {
  const [claim] = await getDb()
    .select(claimDetailColumns)
    .from(organizationClaims)
    .where(
      and(
        eq(organizationClaims.id, claimId),
        claimantUserId ? eq(organizationClaims.claimantUserId, claimantUserId) : undefined,
      ),
    );
  if (!claim) throw new OrganizationDirectoryError(404, 'not_found', 'Claim not found');
  return presentClaimDetail(claim);
}

export async function submitOrganizationClaim(
  accountId: string,
  claimantUserId: string,
  evidenceReference: string,
): Promise<OrganizationClaim> {
  return getDb().transaction(async (tx) => {
    const [profile] = await tx
      .select({
        status: organizationProfiles.status,
        claimStatus: organizationProfiles.claimStatus,
      })
      .from(organizationProfiles)
      .where(eq(organizationProfiles.accountId, accountId))
      .for('update');
    const organization = await getOrganization(accountId, tx);
    if (
      !profile ||
      organization.accountId !== accountId ||
      profile.claimStatus !== 'unclaimed' ||
      profile.status !== 'active'
    )
      throw new OrganizationDirectoryError(409, 'conflict', 'This organization cannot be claimed');
    const [existing] = await tx
      .select(claimColumns)
      .from(organizationClaims)
      .where(
        and(
          eq(organizationClaims.accountId, accountId),
          eq(organizationClaims.claimantUserId, claimantUserId),
          eq(organizationClaims.status, 'pending'),
        ),
      );
    if (existing) return presentClaim(existing);
    const [claim] = await tx
      .insert(organizationClaims)
      .values({ accountId, claimantUserId, evidenceReference })
      .returning(claimColumns);
    if (!claim) throw new Error('Claim insert returned no row');
    return presentClaim(claim);
  });
}

export async function reviewOrganizationClaim(
  claimId: string,
  reviewerId: string,
  decision: 'approved' | 'rejected',
  evidenceReference: string,
): Promise<OrganizationClaim> {
  return getDb().transaction(async (tx) => {
    const [claim] = await tx
      .select({
        id: organizationClaims.id,
        accountId: organizationClaims.accountId,
        claimantUserId: organizationClaims.claimantUserId,
        status: organizationClaims.status,
        createdAt: organizationClaims.createdAt,
      })
      .from(organizationClaims)
      .where(eq(organizationClaims.id, claimId))
      .for('update');
    if (!claim) throw new OrganizationDirectoryError(404, 'not_found', 'Claim not found');
    if (claim.status !== 'pending')
      throw new OrganizationDirectoryError(409, 'conflict', 'Claim has already been reviewed');
    if (claim.claimantUserId === reviewerId)
      throw new OrganizationDirectoryError(403, 'forbidden', 'Claims require independent review');
    const [profile] = await tx
      .select({
        status: organizationProfiles.status,
        claimStatus: organizationProfiles.claimStatus,
      })
      .from(organizationProfiles)
      .where(eq(organizationProfiles.accountId, claim.accountId))
      .for('update');
    if (profile?.status !== 'active' || profile.claimStatus !== 'unclaimed')
      throw new OrganizationDirectoryError(
        409,
        'conflict',
        'Organization is no longer available to claim',
      );
    const [person] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, claim.claimantUserId),
          eq(users.kind, 'personal'),
          ne(users.accountStatus, 'archived'),
        ),
      );
    if (!person)
      throw new OrganizationDirectoryError(409, 'conflict', 'Claimant is no longer eligible');
    if (decision === 'approved') {
      await tx
        .update(organizationProfiles)
        .set({ claimStatus: 'claimed', updatedAt: new Date() })
        .where(eq(organizationProfiles.accountId, claim.accountId));
      await tx.insert(accountMembers).values({
        accountId: claim.accountId,
        memberUserId: claim.claimantUserId,
        role: 'owner',
        status: 'active',
        inherit: true,
        joinedAt: new Date(),
        invitedByUserId: reviewerId,
      });
    }
    await tx
      .update(organizationClaims)
      .set({
        status: decision,
        reviewedByUserId: reviewerId,
        reviewEvidenceReference: evidenceReference,
        reviewedAt: new Date(),
      })
      .where(eq(organizationClaims.id, claim.id));
    await tx.insert(organizationDirectoryAudit).values({
      accountId: claim.accountId,
      actorUserId: reviewerId,
      action: `claim_${decision}`,
      evidenceReference,
      relatedAccountId: claim.claimantUserId,
    });
    return { ...claim, status: decision, createdAt: claim.createdAt.toISOString() };
  });
}

export async function resolveOrganizationExternal(namespace: string, externalId: string) {
  const [mapping] = await getDb()
    .select({ accountId: organizationExternalIds.accountId })
    .from(organizationExternalIds)
    .where(
      and(
        eq(organizationExternalIds.namespace, namespace),
        eq(organizationExternalIds.externalId, externalId),
      ),
    );
  if (!mapping) throw missing();
  return { accountId: (await getOrganization(mapping.accountId)).accountId };
}
export async function importOrganizationExternal(
  input: OrganizationExternalInput,
  actorUserId: string,
) {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organizations:${input.namespace}`}, 0))`,
    );
    const [existing] = await tx
      .select({ accountId: organizationExternalIds.accountId })
      .from(organizationExternalIds)
      .where(
        and(
          eq(organizationExternalIds.namespace, input.namespace),
          eq(organizationExternalIds.externalId, input.externalId),
        ),
      );
    if (existing) {
      const accountId = (await getOrganization(existing.accountId, tx)).accountId;
      if (input.accountId && (await getOrganization(input.accountId, tx)).accountId !== accountId)
        throw new OrganizationDirectoryError(
          409,
          'conflict',
          'External identity already maps to another organization',
        );
      return { accountId, created: false };
    }
    if (input.avatarFileId) {
      const [asset] = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.id, input.avatarFileId),
            eq(files.status, 'active'),
            eq(files.visibility, 'public'),
            sql`${files.mime} like 'image/%'`,
          ),
        );
      if (!asset)
        throw new OrganizationDirectoryError(
          409,
          'conflict',
          'Imported avatar must be an existing public image asset',
        );
    }
    const accountId = input.accountId
      ? (await getOrganization(input.accountId, tx)).accountId
      : await insertNeutral(tx, input.organization, input.avatarFileId);
    await tx
      .insert(organizationExternalIds)
      .values({ namespace: input.namespace, externalId: input.externalId, accountId });
    await tx.insert(organizationDirectoryAudit).values({
      accountId,
      actorUserId,
      action: 'external_identity_linked',
      evidenceReference: input.evidenceReference,
    });
    return { accountId, created: !input.accountId };
  });
}

/** Only neutral identities can be merged; never transfer account capabilities via a merge. */
export async function mergeOrganizations(
  sourceId: string,
  targetId: string,
  actorUserId: string,
  evidenceReference: string,
): Promise<Organization> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .select({
        accountId: organizationProfiles.accountId,
        status: organizationProfiles.status,
        claimStatus: organizationProfiles.claimStatus,
        mergedIntoAccountId: organizationProfiles.mergedIntoAccountId,
      })
      .from(organizationProfiles)
      .where(inArray(organizationProfiles.accountId, [sourceId, targetId]))
      .orderBy(asc(organizationProfiles.accountId))
      .for('update');
    const source = rows.find((row) => row.accountId === sourceId),
      target = rows.find((row) => row.accountId === targetId);
    if (!source || !target) throw missing();
    if (
      sourceId === targetId ||
      source.claimStatus !== 'unclaimed' ||
      source.status !== 'active' ||
      !['active', 'inactive'].includes(target.status)
    )
      throw new OrganizationDirectoryError(
        409,
        'conflict',
        'Only an unclaimed organization may merge into a canonical organization',
      );
    const [member, app, billing, session, context, password, child, authMethod, pendingClaim] =
      await Promise.all([
        tx
          .select({ id: accountMembers.id })
          .from(accountMembers)
          .where(eq(accountMembers.accountId, sourceId))
          .limit(1),
        tx
          .select({ id: applications.id })
          .from(applications)
          .where(eq(applications.ownerAccountId, sourceId))
          .limit(1),
        tx
          .select({ id: billingProfiles.accountId })
          .from(billingProfiles)
          .where(eq(billingProfiles.accountId, sourceId))
          .limit(1),
        tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, sourceId)).limit(1),
        tx
          .select({ id: deviceAccountContexts.id })
          .from(deviceAccountContexts)
          .where(eq(deviceAccountContexts.accountId, sourceId))
          .limit(1),
        tx
          .select({ id: userPasswords.userId })
          .from(userPasswords)
          .where(eq(userPasswords.userId, sourceId))
          .limit(1),
        tx.select({ id: users.id }).from(users).where(eq(users.parentAccountId, sourceId)).limit(1),
        tx
          .select({ userId: userAuthMethods.userId })
          .from(userAuthMethods)
          .where(eq(userAuthMethods.userId, sourceId))
          .limit(1),
        tx
          .select({ id: organizationClaims.id })
          .from(organizationClaims)
          .where(
            and(
              eq(organizationClaims.accountId, sourceId),
              eq(organizationClaims.status, 'pending'),
            ),
          )
          .limit(1),
      ]);
    const [sourceIdentity] = await tx
      .select({
        publicKey: users.publicKey,
        email: users.email,
        parentAccountId: users.parentAccountId,
        rootAccountId: users.rootAccountId,
      })
      .from(users)
      .where(eq(users.id, sourceId));
    if (
      [member, app, billing, session, context, password, child, authMethod, pendingClaim].some(
        (rows) => rows.length,
      ) ||
      sourceIdentity?.publicKey ||
      sourceIdentity?.email ||
      sourceIdentity?.parentAccountId ||
      sourceIdentity?.rootAccountId
    )
      throw new OrganizationDirectoryError(
        409,
        'conflict',
        'An operating account cannot be merged through the directory',
      );
    await tx
      .update(organizationProfiles)
      .set({ status: 'merged', mergedIntoAccountId: targetId, updatedAt: new Date() })
      .where(eq(organizationProfiles.accountId, sourceId));
    await tx
      .update(organizationProfiles)
      .set({ mergedIntoAccountId: targetId, updatedAt: new Date() })
      .where(eq(organizationProfiles.mergedIntoAccountId, sourceId));
    await tx.insert(organizationDirectoryAudit).values({
      accountId: sourceId,
      actorUserId,
      action: 'merged',
      evidenceReference,
      relatedAccountId: targetId,
    });
    return getOrganization(targetId, tx);
  });
}

/** One bounded transaction and bulk writes; namespace lock makes retries and concurrent ingestion idempotent. */
export async function importOrganizationBatch(
  input: OrganizationImportBatch,
  actor: { applicationId: string; ownerAccountId: string },
) {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 524288)
    throw new OrganizationDirectoryError(400, 'bad_request', 'Organization batch exceeds 512 KiB');
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organizations:${input.namespace}`},0))`,
    );
    const mappings = await tx
      .select({
        externalId: organizationExternalIds.externalId,
        accountId: organizationExternalIds.accountId,
      })
      .from(organizationExternalIds)
      .where(
        and(
          eq(organizationExternalIds.namespace, input.namespace),
          inArray(
            organizationExternalIds.externalId,
            input.items.map((item) => item.externalId),
          ),
        ),
      );
    const existing = new Map(mappings.map((item) => [item.externalId, item.accountId]));
    const unresolved = await batchOrganizations(
      mappings.map((item) => item.accountId),
      tx,
    );
    if (unresolved.missingIds.length)
      throw new OrganizationDirectoryError(
        409,
        'conflict',
        'An imported organization is unavailable for reuse',
      );
    const canonical = new Map(
      unresolved.items.map((item) => [item.requestedAccountId, item.organization.accountId]),
    );
    const missing = input.items.filter((item) => !existing.has(item.externalId));
    const avatars = [
      ...new Set(missing.flatMap((item) => (item.avatarFileId ? [item.avatarFileId] : []))),
    ];
    if (avatars.length) {
      const assets = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            inArray(files.id, avatars),
            eq(files.ownerUserId, actor.ownerAccountId),
            eq(files.status, 'active'),
            eq(files.visibility, 'public'),
            sql`${files.mime} like 'image/%'`,
          ),
        );
      if (assets.length !== avatars.length)
        throw new OrganizationDirectoryError(
          403,
          'forbidden',
          'Imported images must be public assets owned by the importing application account',
        );
    }
    const additions = missing.map((item) => ({ ...item, accountId: neutralOrganizationId() }));
    if (additions.length) {
      await insertNeutralOrganizations(
        tx,
        additions.map((item) => ({
          accountId: item.accountId,
          organization: item.organization,
          avatar: item.avatarFileId,
        })),
      );
      await tx.insert(organizationExternalIds).values(
        additions.map((item) => ({
          namespace: input.namespace,
          externalId: item.externalId,
          accountId: item.accountId,
        })),
      );
      await tx.insert(organizationDirectoryAudit).values(
        additions.map((item) => ({
          accountId: item.accountId,
          actorApplicationId: actor.applicationId,
          action: 'external_neutral_created',
          evidenceReference: item.evidenceReference,
        })),
      );
    }
    const created = new Map(additions.map((item) => [item.externalId, item.accountId]));
    return {
      items: input.items.map((item) => {
        const previous = existing.get(item.externalId),
          createdId = created.get(item.externalId);
        const accountId = previous ? canonical.get(previous) : createdId;
        if (!accountId) throw new Error('Import mapping was not produced');
        return { externalId: item.externalId, accountId, created: createdId !== undefined };
      }),
    };
  });
}

export async function curateOrganization(
  accountId: string,
  input: OrganizationCuration,
  reviewerId: string,
) {
  const result = await getDb().transaction(async (tx) => {
    const [profile] = await tx
      .select({
        claimStatus: organizationProfiles.claimStatus,
        status: organizationProfiles.status,
      })
      .from(organizationProfiles)
      .where(eq(organizationProfiles.accountId, accountId))
      .for('update');
    if (!profile) throw missing();
    if (profile.status === 'merged')
      throw new OrganizationDirectoryError(
        409,
        'conflict',
        'A merged organization must be curated through its canonical identity',
      );
    if (input.changes && profile.claimStatus !== 'unclaimed')
      throw new OrganizationDirectoryError(
        403,
        'forbidden',
        'Claimed organization facts are managed by the organization',
      );
    const changes = input.changes;
    if (changes?.name !== undefined)
      await tx
        .update(users)
        .set({ nameDisplay: changes.name, updatedAt: new Date() })
        .where(eq(users.id, accountId));
    const [updated] = await tx
      .update(organizationProfiles)
      .set({
        organizationType: changes?.organizationType,
        legalName: changes?.legalName,
        websiteUrl: changes?.websiteUrl,
        countryCode: changes?.countryCode,
        aliases: changes?.aliases,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(organizationProfiles.accountId, accountId))
      .returning({
        accountId: organizationProfiles.accountId,
        status: organizationProfiles.status,
      });
    if (!updated) throw missing();
    await tx.insert(organizationDirectoryAudit).values({
      accountId,
      actorUserId: reviewerId,
      action: 'curated',
      evidenceReference: input.evidenceReference,
    });
    return updated;
  });
  userCache.invalidate(accountId);
  return result;
}

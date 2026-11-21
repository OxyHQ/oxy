/**
 * The organization directory: organizations (`Organization`, by account id),
 * the directory search, the signed-in person's organization claims and the
 * staff review queue (`OrganizationClaim`, by claim id), and the writes on
 * them. Every organization a read or a write returns goes into `Organization`,
 * so one copy serves the search, the settings and every claim row.
 *
 * Reads are not retried: a directory answer is cheap to ask for again, and a
 * claim or review answer is the person's to retry.
 */
import { action, currentStore, entity, list, source, withStore } from '@oxy.so/bloom-data';
import type { OxyServices } from '@oxy.so/core';
import type {
  CreateOrganization,
  Organization as OrganizationRecord,
  OrganizationClaimDetail,
  OrganizationClaimInput,
  OrganizationClaimReview,
  UpdateOrganization,
} from '@oxy.so/contracts';
import { answerSource } from './answer';
import { sdkRead } from './readOptions';

const MINUTE = 60_000;
const PAGE_SIZE = 20;
/** The batch lookup takes at most this many account ids per request. */
const BATCH_SIZE = 100;

/** The SDK's directory read: fresh for 5 minutes, never retried. */
const directoryRead = { ...sdkRead, retry: 0, stale: 5 * MINUTE, gcTime: 30 * MINUTE } as const;
/** A claim read: as a directory read, and dropped once no screen shows it. */
const claimRead = { ...directoryRead, gcTime: 0 } as const;

export const Organization = entity<OrganizationRecord>('oxy.organization', {
  id: (organization) => organization.accountId,
});

export const OrganizationClaim = entity<OrganizationClaimDetail>('oxy.organization-claim', {
  id: (claim) => claim.id,
});

/** One organization. */
export const organization = source(Organization, {
  ...directoryRead,
  key: (_oxy: OxyServices, accountId: string) => accountId,
  load: (_request, oxy, accountId) => oxy.organizations.get(accountId),
});

/** The directory search, by query, paged. */
export const OrganizationSearch = list('oxy.organization-search', { of: Organization });

export const organizationSearch = source(OrganizationSearch, {
  ...directoryRead,
  key: (_oxy: OxyServices, query: string) => query,
  load: async ({ cursor }, oxy, query) => {
    const page = await oxy.organizations.search({
      query,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    return { items: page.items, next: page.nextCursor };
  },
});

/** A claim list keeps the account ids its claims name, in order (`extra`), to look their organizations up. */
type ClaimedAccountIds = readonly string[];

const claimListOptions = {
  ...claimRead,
  fold: (
    current: ClaimedAccountIds | undefined,
    extra: ClaimedAccountIds | undefined,
    mode: 'first' | 'next',
  ) => (mode === 'first' ? (extra ?? []) : [...(current ?? []), ...(extra ?? [])]),
} as const;

const claimPage = (page: { items: OrganizationClaimDetail[]; nextCursor: string | null }) => ({
  items: page.items,
  next: page.nextCursor,
  extra: page.items.map((claim) => claim.accountId) as ClaimedAccountIds,
});

/** The signed-in person's organization claims, by account. */
export const MyOrganizationClaims = list<ClaimedAccountIds>('oxy.organization-claims.mine', {
  of: OrganizationClaim,
});

export const myOrganizationClaims = source(MyOrganizationClaims, {
  ...claimListOptions,
  key: (_oxy: OxyServices, accountId: string) => accountId,
  load: async ({ cursor }, oxy, _accountId) =>
    claimPage(
      await oxy.organizations.myClaims({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
    ),
});

/** The pending claims a staff member may review, by the reviewer's account. */
export const ReviewOrganizationClaims = list<ClaimedAccountIds>('oxy.organization-claims.review', {
  of: OrganizationClaim,
});

export const reviewOrganizationClaims = source(ReviewOrganizationClaims, {
  ...claimListOptions,
  key: (_oxy: OxyServices, accountId: string) => accountId,
  load: async ({ cursor }, oxy, _accountId) =>
    claimPage(
      await oxy.organizations.reviewClaims({
        status: 'pending',
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
    ),
});

/** One claim as its reviewer reads it, read afresh each time it is opened. */
export const reviewClaimDetail = answerSource('oxy.organization-claim.review-detail', {
  ...claimRead,
  key: (_oxy: OxyServices, claimId: string) => claimId,
  load: (_request, oxy, claimId) => oxy.organizations.reviewClaimDetail(claimId),
});

/**
 * The organizations of these account ids (sorted), looked up in batches of
 * `BATCH_SIZE`: the answer maps each requested account id to the account id
 * of its organization (a merged one names its survivor), and the
 * organizations go into `Organization`.
 */
export const organizationsByAccount = answerSource('oxy.organizations-by-account', {
  ...directoryRead,
  key: (_oxy: OxyServices, accountIds: readonly string[]) => accountIds.join(','),
  load: async (_request, oxy, accountIds): Promise<Readonly<Record<string, string>>> => {
    const store = currentStore();
    const batches = [];
    for (let offset = 0; offset < accountIds.length; offset += BATCH_SIZE) {
      batches.push(oxy.organizations.batch({ ids: accountIds.slice(offset, offset + BATCH_SIZE) }));
    }
    const items = (await Promise.all(batches)).flatMap((batch) => batch.items);
    withStore(store, () => Organization.put(items.map((item) => item.organization)));
    return Object.fromEntries(
      items.map((item) => [item.requestedAccountId, item.organization.accountId]),
    );
  },
});

/**
 * Reads the claim lists the store holds again (each is dropped once no screen
 * shows it, so what is held is what is shown): after a write that changes a
 * claim.
 */
export function refreshOrganizationClaims(oxy: OxyServices): Promise<unknown> {
  return Promise.all([
    ...MyOrganizationClaims.keys().map((key) => myOrganizationClaims.refresh(oxy, key)),
    ...ReviewOrganizationClaims.keys().map((key) => reviewOrganizationClaims.refresh(oxy, key)),
  ]);
}

/*
 * The writes. Each takes the call's arguments as `prepare`, run when the call
 * runs: it throws (failing the call) when the call may no longer be made, such
 * as when the session that started it has changed.
 */

export const claimOrganization = action({
  run: (oxy: OxyServices, prepare: () => { accountId: string; input: OrganizationClaimInput }) => {
    const { accountId, input } = prepare();
    return oxy.organizations.claim(accountId, input);
  },
});

export const createOrganization = action({
  run: (oxy: OxyServices, prepare: () => CreateOrganization) => oxy.organizations.create(prepare()),
  settle: (created) => Organization.put(created),
});

export const updateOrganization = action({
  run: (oxy: OxyServices, prepare: () => { accountId: string; input: UpdateOrganization }) => {
    const { accountId, input } = prepare();
    return oxy.organizations.update(accountId, input);
  },
  settle: (updated) => Organization.put(updated),
});

export const reviewOrganizationClaim = action({
  run: (oxy: OxyServices, prepare: () => { claimId: string; input: OrganizationClaimReview }) => {
    const { claimId, input } = prepare();
    return oxy.organizations.reviewClaim(claimId, input);
  },
  settle: (reviewed) => {
    OrganizationClaim.merge(reviewed.id, reviewed);
  },
});

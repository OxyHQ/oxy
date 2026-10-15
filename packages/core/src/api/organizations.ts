import {
  organizationSchema,
  organizationListSchema,
  organizationBatchSchema,
  organizationClaimSchema,
  organizationExternalSchema,
  organizationExternalResolutionSchema,
  organizationImportBatchResultSchema,
  organizationCurationResultSchema,
  type OrganizationCuration,
  type OrganizationImportBatch,
  organizationClaimListSchema,
  organizationClaimDetailSchema,
  type OrganizationClaimListQuery,
  type CreateOrganization,
  type OrganizationSearch,
  type UpdateOrganization,
  type OrganizationClaimInput,
  type OrganizationClaimReview,
  type OrganizationExternalInput,
  type OrganizationMerge,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import { evictOxyIdentityCache } from '../utils/identityCacheSweep';

/** The public canonical organization directory. Claiming changes authority, never identity. */
export class OrganizationsApi {
  constructor(private readonly ctx: OxyContext) {}
  async search(input: OrganizationSearch) {
    return organizationListSchema.parse(
      await this.ctx.request('GET', '/organizations', input, { cache: false, skipAuth: true }),
    );
  }
  async get(accountId: string) {
    return organizationSchema.parse(
      await this.ctx.request('GET', `/organizations/${encodeURIComponent(accountId)}`, undefined, {
        cache: false,
        skipAuth: true,
      }),
    );
  }
  async batch(input: { ids: string[] }) {
    return organizationBatchSchema.parse(
      await this.ctx.request('POST', '/organizations/batch', input, {
        cache: false,
        skipAuth: true,
      }),
    );
  }
  async create(input: CreateOrganization) {
    return organizationSchema.parse(
      await this.ctx.request('POST', '/organizations', input, { cache: false }),
    );
  }
  async update(accountId: string, input: UpdateOrganization) {
    const result = organizationSchema.parse(
      await this.ctx.request('PATCH', `/organizations/${encodeURIComponent(accountId)}`, input, {
        cache: false,
      }),
    );

    evictOxyIdentityCache(this.ctx.http, accountId);
    return result;
  }
  async claim(accountId: string, input: OrganizationClaimInput) {
    return organizationClaimSchema.parse(
      await this.ctx.request(
        'POST',
        `/organizations/${encodeURIComponent(accountId)}/claims`,
        input,
        { cache: false },
      ),
    );
  }
  async myClaims(input: OrganizationClaimListQuery = {}) {
    return organizationClaimListSchema.parse(
      await this.ctx.request('GET', '/organizations/claims/mine', input, { cache: false }),
    );
  }
  async myClaim(claimId: string) {
    return organizationClaimDetailSchema.parse(
      await this.ctx.request(
        'GET',
        `/organizations/claims/mine/${encodeURIComponent(claimId)}`,
        undefined,
        { cache: false },
      ),
    );
  }
  async reviewClaims(input: OrganizationClaimListQuery = {}) {
    return organizationClaimListSchema.parse(
      await this.ctx.request('GET', '/organizations/claims/review', input, { cache: false }),
    );
  }
  async reviewClaimDetail(claimId: string) {
    return organizationClaimDetailSchema.parse(
      await this.ctx.request(
        'GET',
        `/organizations/claims/review/${encodeURIComponent(claimId)}`,
        undefined,
        { cache: false },
      ),
    );
  }
  async reviewClaim(claimId: string, input: OrganizationClaimReview) {
    const result = organizationClaimSchema.parse(
      await this.ctx.request(
        'POST',
        `/organizations/claims/${encodeURIComponent(claimId)}/review`,
        input,
        { cache: false },
      ),
    );

    evictOxyIdentityCache(this.ctx.http, result.accountId);
    return result;
  }
  async importBatch(input: OrganizationImportBatch) {
    if (!this.ctx.service?.available)
      throw new Error('Organization batch import requires an OxyServer service identity');
    return organizationImportBatchResultSchema.parse(
      await this.ctx.service.request('POST', '/organizations/external/batch', input, {
        cache: false,
      }),
    );
  }
  async importExternal(input: OrganizationExternalInput) {
    return organizationExternalSchema.parse(
      await this.ctx.request('POST', '/organizations/external', input, { cache: false }),
    );
  }
  async resolveExternal(input: { namespace: string; externalId: string }) {
    return organizationExternalResolutionSchema.parse(
      await this.ctx.request(
        'GET',
        `/organizations/external/${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.externalId)}`,
        undefined,
        { cache: false },
      ),
    );
  }
  async curate(accountId: string, input: OrganizationCuration) {
    const result = organizationCurationResultSchema.parse(
      await this.ctx.request(
        'POST',
        `/organizations/${encodeURIComponent(accountId)}/curation`,
        input,
        { cache: false },
      ),
    );

    evictOxyIdentityCache(this.ctx.http, accountId);
    return result;
  }
  async merge(accountId: string, input: OrganizationMerge) {
    const result = organizationSchema.parse(
      await this.ctx.request(
        'POST',
        `/organizations/${encodeURIComponent(accountId)}/merge`,
        input,
        { cache: false },
      ),
    );

    evictOxyIdentityCache(this.ctx.http, accountId);
    evictOxyIdentityCache(this.ctx.http, result.accountId);
    return result;
  }
  async *iterate(input: OrganizationSearch) {
    let cursor = input.cursor;
    const seen = new Set<string>();
    do {
      const page = await this.search({ ...input, cursor });
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Organization directory repeated a cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
}

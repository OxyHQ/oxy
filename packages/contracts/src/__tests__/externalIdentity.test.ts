import { resolveExternalIdentityRequestSchema, resolveExternalIdentityResponseSchema } from '../externalIdentity';

const source = { canonicalAcct: 'alice@x.com', network: 'x.com', protocol: 'activitypub',
  actorUri: 'https://bird.makeup/users/alice', transportAcct: 'alice@bird.makeup', sourceUserId: 'user-1' };
const response = { user: { id: 'user-1', name: {}, username: 'alice@x.com', externalIdentities: [source], redirectedUserIds: [] },
  externalIdentity: { ...source, userId: 'user-1' }, externalIdentities: [source], redirectedUserIds: [] };

describe('external identity boundary', () => {
  it('requires one source reference, and accepts handles or profile URLs', () => {
    expect(resolveExternalIdentityRequestSchema.safeParse({ handle: 'https://x.com/alice' }).success).toBe(true);
    expect(resolveExternalIdentityRequestSchema.safeParse({ actorUri: source.actorUri }).success).toBe(true);
    expect(resolveExternalIdentityRequestSchema.safeParse({ actorUri: source.actorUri, handle: 'alice@x.com' }).success).toBe(false);
    expect(resolveExternalIdentityRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a coherent canonical profile and distinct source reference', () => {
    expect(resolveExternalIdentityResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a successful-looking response without a usable canonical profile id', () => {
    expect(resolveExternalIdentityResponseSchema.safeParse({ ...response, user: { ...response.user, id: undefined } }).success).toBe(false);
    expect(resolveExternalIdentityResponseSchema.safeParse({ ...response, user: { ...response.user, username: '' } }).success).toBe(false);
  });

  it('rejects source/user and source/alias mismatches', () => {
    expect(resolveExternalIdentityResponseSchema.safeParse({ ...response, externalIdentity: { ...response.externalIdentity, userId: 'other' } }).success).toBe(false);
    expect(resolveExternalIdentityResponseSchema.safeParse({ ...response, externalIdentities: [] }).success).toBe(false);
  });
});

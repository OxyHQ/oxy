import { createDomainPolicy, extractActorUriFromActivityId } from '../index';

const policy = createDomainPolicy({
  domain: 'mention.earth',
  identityApex: 'oxy.so',
  blockedDomains: ['spam.example'],
});

describe('createDomainPolicy.isBlockedDomain', () => {
  it('blocks our own federation domain and the Oxy identity apex (case-insensitively)', () => {
    expect(policy.isBlockedDomain('mention.earth')).toBe(true);
    expect(policy.isBlockedDomain('www.mention.earth')).toBe(true);
    expect(policy.isBlockedDomain('oxy.so')).toBe(true);
    expect(policy.isBlockedDomain('OXY.SO')).toBe(true);
  });

  it('blocks an explicitly-configured domain', () => {
    expect(policy.isBlockedDomain('spam.example')).toBe(true);
  });

  it('does not block legitimate remote domains (substring-safe)', () => {
    expect(policy.isBlockedDomain('mastodon.social')).toBe(false);
    expect(policy.isBlockedDomain('threads.net')).toBe(false);
    expect(policy.isBlockedDomain('oxy.so.evil.example')).toBe(false);
    expect(policy.isBlockedDomain('notoxy.so')).toBe(false);
  });
});

describe('createDomainPolicy.extractLocalPostId', () => {
  it('extracts the post id from one of our own AP object URIs', () => {
    expect(policy.extractLocalPostId('https://mention.earth/ap/users/nate/posts/abc123')).toBe(
      'abc123',
    );
    expect(policy.extractLocalPostId('https://mention.earth/ap/users/nate/posts/abc123/')).toBe(
      'abc123',
    );
  });

  it('returns null for a remote URI or a non-matching path', () => {
    expect(policy.extractLocalPostId('https://mastodon.social/users/alice/statuses/1')).toBeNull();
    expect(policy.extractLocalPostId('https://mention.earth/@nate')).toBeNull();
    expect(policy.extractLocalPostId('not a url')).toBeNull();
  });
});

describe('extractActorUriFromActivityId', () => {
  it('trims from the first post-path segment to yield the actor uri', () => {
    expect(
      extractActorUriFromActivityId('https://mastodon.social/users/alice/statuses/12345'),
    ).toBe('https://mastodon.social/users/alice');
  });

  it('returns null when malformed or no post-path segment is present', () => {
    expect(extractActorUriFromActivityId('https://mastodon.social/users/alice')).toBeNull();
    expect(extractActorUriFromActivityId('garbage')).toBeNull();
  });
});

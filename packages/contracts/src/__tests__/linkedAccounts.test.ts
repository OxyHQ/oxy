import {
  OXY_NOTIFICATION_TYPES,
  completeLinkedAccountResponseSchema,
  createOxyNotificationRequestSchema,
  linkedAccountSchema,
  serviceLinkedAccountSchema,
  startLinkedAccountRequestSchema,
} from '../index';

const LINK = {
  id: 'link-1',
  network: 'activitypub',
  accountKey: 'nate@mastodon.social',
  actorUri: 'https://mastodon.social/users/nate',
  handle: '@nate@mastodon.social',
  host: 'mastodon.social',
  proofMethod: 'oauth',
  verifiedAt: '2026-09-25T00:00:00.000Z',
  createdAt: '2026-09-25T00:00:00.000Z',
};

describe('linked accounts contract', () => {
  it('requires a clientId and a returnTo', () => {
    expect(startLinkedAccountRequestSchema.safeParse({ instance: 'mastodon.social' }).success).toBe(false);
    expect(startLinkedAccountRequestSchema.safeParse({ instance: 'm.s', returnTo: 'https://move.oxy.so/linked' }).success).toBe(false);
    expect(
      startLinkedAccountRequestSchema.safeParse({ instance: 'm.s', returnTo: 'https://move.oxy.so/linked', clientId: 'oxy_dk_x' }).success,
    ).toBe(true);
  });

  it('has no room for a token on any linked-account shape', () => {
    expect(linkedAccountSchema.safeParse(LINK).success).toBe(true);
    expect(linkedAccountSchema.safeParse({ ...LINK, accessToken: 'secret' }).success).toBe(false);
    expect(serviceLinkedAccountSchema.safeParse({ ...LINK, federatedUserId: null, refreshToken: 'x' }).success).toBe(false);
    expect(completeLinkedAccountResponseSchema.safeParse({ linkedAccount: LINK }).success).toBe(true);
    expect(completeLinkedAccountResponseSchema.safeParse({ linkedAccount: { ...LINK, accessToken: 'secret' } }).success).toBe(false);
  });
});

describe('notification types', () => {
  it('include system, for a message from an Oxy service about the recipient\'s own account', () => {
    expect(OXY_NOTIFICATION_TYPES).toContain('system');
    expect(
      createOxyNotificationRequestSchema.safeParse({
        recipientId: 'u1',
        actorId: 'u1',
        type: 'system',
        entityId: 'job-1',
        entityType: 'profile',
        title: 'Your move is complete',
        message: 'Twelve posts came over.',
        url: 'https://move.oxy.so/jobs/job-1',
      }).success,
    ).toBe(true);
    // A system notification without words renders as nothing, so it is refused.
    expect(
      createOxyNotificationRequestSchema.safeParse({ recipientId: 'u1', actorId: 'u1', type: 'system', entityId: 'j', entityType: 'profile' }).success,
    ).toBe(false);
    // It is about the recipient's own account, so the recipient is the actor.
    expect(
      createOxyNotificationRequestSchema.safeParse({ recipientId: 'u1', actorId: 'u2', type: 'system', entityId: 'j', entityType: 'profile', title: 't', message: 'm' }).success,
    ).toBe(false);
    // An app-namespaced entity (a job id) is valid for system, and only for system.
    expect(
      createOxyNotificationRequestSchema.safeParse({ recipientId: 'u1', actorId: 'u1', type: 'system', entityId: 'job-9', entityType: 'app', title: 't', message: 'm' }).success,
    ).toBe(true);
    expect(
      createOxyNotificationRequestSchema.safeParse({ recipientId: 'u1', actorId: 'a', type: 'like', entityId: 'job-9', entityType: 'app' }).success,
    ).toBe(false);
    // A deep link is a system-notification field only.
    expect(
      createOxyNotificationRequestSchema.safeParse({ recipientId: 'u1', actorId: 'a', type: 'follow', entityId: 'u1', entityType: 'profile', url: 'https://oxy.so' }).success,
    ).toBe(false);
    expect(createOxyNotificationRequestSchema.safeParse({ recipientId: 'u1', actorId: 'u1', type: 'promo', entityId: 'u1', entityType: 'profile' }).success).toBe(false);
  });
});

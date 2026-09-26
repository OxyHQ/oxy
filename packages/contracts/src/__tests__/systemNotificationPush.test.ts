/**
 * Wire contract of the push that announces a `system` notification.
 */

import {
  OXY_ACCOUNT_PUSH_CHANNEL,
  OXY_SYSTEM_NOTIFICATION_PUSH_TYPE,
  oxySystemNotificationPushDataSchema,
} from '../notifications';

describe('system notification push contract', () => {
  it('pins the Android channel id and the payload discriminator', () => {
    expect(OXY_ACCOUNT_PUSH_CHANNEL).toBe('account');
    expect(OXY_SYSTEM_NOTIFICATION_PUSH_TYPE).toBe('oxy_system_notification');
  });

  it('accepts the id-only payload', () => {
    expect(
      oxySystemNotificationPushDataSchema.safeParse({
        type: OXY_SYSTEM_NOTIFICATION_PUSH_TYPE,
        notificationId: '0192f0c4-7b1e-7000-8000-000000000001',
      }).success,
    ).toBe(true);
  });

  it('refuses another push type and an empty id', () => {
    expect(
      oxySystemNotificationPushDataSchema.safeParse({ type: 'oxy_inbox_new_message', notificationId: 'n1' }).success,
    ).toBe(false);
    expect(
      oxySystemNotificationPushDataSchema.safeParse({ type: OXY_SYSTEM_NOTIFICATION_PUSH_TYPE, notificationId: '' }).success,
    ).toBe(false);
  });
});

/**
 * PUT /email/reminders/:id takes the fields a reminder has. It used to accept
 * only an unused `status` and strip `completed`, `pinned` and `snoozedUntil`
 * (validation replaces the body with its parse result), so completing a
 * reminder from Inbox answered 200 and changed nothing.
 */

import { createReminderSchema, updateEmailSettingsSchema, updateReminderSchema } from '../email.schemas';

describe('updateReminderSchema', () => {
  it('keeps completed, pinned and snoozedUntil', () => {
    expect(
      updateReminderSchema.parse({ completed: true, pinned: false, snoozedUntil: '2026-10-11T09:00:00.000Z' }),
    ).toEqual({ completed: true, pinned: false, snoozedUntil: '2026-10-11T09:00:00.000Z' });
  });

  it('clears a snooze with null', () => {
    expect(updateReminderSchema.parse({ snoozedUntil: null })).toEqual({ snoozedUntil: null });
  });

  it('refuses a date that is not one', () => {
    expect(updateReminderSchema.safeParse({ remindAt: 'tomorrow-ish' }).success).toBe(false);
    expect(createReminderSchema.safeParse({ text: 'Call', remindAt: 'nope' }).success).toBe(false);
  });
});

describe('updateEmailSettingsSchema', () => {
  it('keeps the vacation window as dates', () => {
    const parsed = updateEmailSettingsSchema.parse({
      autoReply: { enabled: true, startDate: '2026-12-20T00:00:00.000Z', endDate: null },
    });
    expect(parsed.autoReply?.startDate).toEqual(new Date('2026-12-20T00:00:00.000Z'));
    expect(parsed.autoReply?.endDate).toBeUndefined();
  });

  it('refuses a forwarding address that is not one, and lets it be cleared', () => {
    expect(updateEmailSettingsSchema.safeParse({ autoForwardTo: 'not an address' }).success).toBe(false);
    expect(updateEmailSettingsSchema.parse({ autoForwardTo: '' })).toEqual({ autoForwardTo: '' });
  });
});

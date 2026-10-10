/**
 * PUT /email/reminders/:id takes the fields a reminder has. It used to accept
 * only an unused `status` and strip `completed`, `pinned` and `snoozedUntil`
 * (validation replaces the body with its parse result), so completing a
 * reminder from Inbox answered 200 and changed nothing.
 */

import { createReminderSchema, updateReminderSchema } from '../email.schemas';

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

import {
  inboxComposeRequestSchema,
  inboxDailyBriefRequestSchema,
  inboxInferenceStreamEventSchema,
  inboxMessageInferenceParamsSchema,
  inboxNaturalSearchResponseSchema,
} from '../index';

describe('Inbox point-inference contracts', () => {
  it('accepts only server-owned compose operations and bounded input', () => {
    expect(inboxComposeRequestSchema.parse({
      operation: 'draft', prompt: 'Confirm the meeting', tone: 'professional', stream: true,
    })).toMatchObject({ operation: 'draft', stream: true });
    expect(inboxComposeRequestSchema.safeParse({
      operation: 'draft', prompt: 'x', tone: 'professional', model: 'first',
    }).success).toBe(false);
    expect(inboxComposeRequestSchema.safeParse({
      operation: 'draft', prompt: 'x'.repeat(20_001), tone: 'professional',
    }).success).toBe(false);
  });

  it('requires an exact message id and never admits lookup selectors', () => {
    expect(inboxMessageInferenceParamsSchema.parse({ messageId: 'msg_exact_01' }))
      .toEqual({ messageId: 'msg_exact_01' });
    expect(inboxMessageInferenceParamsSchema.safeParse({ messageId: 'msg', name: 'first' }).success)
      .toBe(false);
  });

  it.each([
    ['ordinary 24-hour day', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z'],
    ['23-hour DST day', '2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z'],
    ['25-hour DST day', '2026-10-25T00:00:00.000Z', '2026-10-26T01:00:00.000Z'],
  ])('accepts client-computed UTC bounds for an %s', (_label, startAt, endAt) => {
    expect(inboxDailyBriefRequestSchema.parse({ startAt, endAt, stream: true }))
      .toEqual({ startAt, endAt, stream: true });
  });

  it.each([
    ['missing start', { endAt: '2026-09-03T00:00:00.000Z' }],
    ['missing end', { startAt: '2026-09-02T00:00:00.000Z' }],
    ['offset instead of Z', {
      startAt: '2026-09-02T00:00:00+02:00', endAt: '2026-09-03T00:00:00+02:00',
    }],
    ['malformed timestamp', {
      startAt: 'not-a-date', endAt: '2026-09-03T00:00:00.000Z',
    }],
    ['equal bounds', {
      startAt: '2026-09-02T00:00:00.000Z', endAt: '2026-09-02T00:00:00.000Z',
    }],
    ['reversed bounds', {
      startAt: '2026-09-03T00:00:00.000Z', endAt: '2026-09-02T00:00:00.000Z',
    }],
    ['shorter than 23 hours', {
      startAt: '2026-09-02T00:00:00.000Z', endAt: '2026-09-02T22:59:59.999Z',
    }],
    ['longer than 25 hours', {
      startAt: '2026-09-02T00:00:00.000Z', endAt: '2026-09-03T01:00:00.001Z',
    }],
    ['unknown selector', {
      startAt: '2026-09-02T00:00:00.000Z', endAt: '2026-09-03T00:00:00.000Z',
      timezone: 'Europe/Bucharest',
    }],
  ])('fails closed for %s', (_label, input) => {
    expect(inboxDailyBriefRequestSchema.safeParse(input).success).toBe(false);
  });

  it('rejects unknown structured-search keys and malformed stream frames', () => {
    expect(inboxNaturalSearchResponseSchema.safeParse({
      query: { unread: true, provider: 'alia' }, interpretation: 'Unread mail',
    }).success).toBe(false);
    expect(inboxInferenceStreamEventSchema.safeParse({ type: 'delta', text: '' }).success)
      .toBe(false);
  });
});

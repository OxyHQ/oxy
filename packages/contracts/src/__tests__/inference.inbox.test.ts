import {
  inboxComposeRequestSchema,
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

  it('rejects unknown structured-search keys and malformed stream frames', () => {
    expect(inboxNaturalSearchResponseSchema.safeParse({
      query: { unread: true, provider: 'alia' }, interpretation: 'Unread mail',
    }).success).toBe(false);
    expect(inboxInferenceStreamEventSchema.safeParse({ type: 'delta', text: '' }).success)
      .toBe(false);
  });
});

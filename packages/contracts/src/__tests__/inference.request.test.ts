import {
  clientRequestMetadataSchema,
  inferenceInputSchema,
  inferenceMessageSchema,
  inferenceRequestSchema,
  safeParseContract,
} from '../index';

const attribution = {
  principal: {
    billing: { accountId: 'acc_1' },
    applicationId: 'app_1',
    credentialId: 'cred_1',
    environment: 'production' as const,
    inferenceScopes: ['inference:invoke'],
  },
  requestId: 'req_1',
};

const request = {
  schemaVersion: 1 as const,
  attribution,
  target: { kind: 'model' as const, modelReference: 'openai/gpt-5' },
  modality: 'text' as const,
  input: {
    format: 'messages' as const,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  },
  stream: false,
  sampling: {},
  tools: [],
  client: {
    apiFormat: 'chat_completions' as const,
    endpoint: '/v1/chat/completions',
    receivedAt: '2026-08-15T09:41:00.000Z',
  },
  routingPolicy: { routingPolicyId: 'rp_1', policyVersion: 3 },
};

describe('inferenceRequestSchema', () => {
  it('parses a minimal normalized request', () => {
    expect(inferenceRequestSchema.safeParse(request).success).toBe(true);
  });

  it('distinguishes "serve this model" from "choose one for me"', () => {
    const concrete = inferenceRequestSchema.parse(request);
    expect(concrete.target.kind).toBe('model');

    const profile = inferenceRequestSchema.parse({
      ...request,
      target: { kind: 'routing_profile', routingProfile: 'auto' },
    });
    expect(profile.target.kind).toBe('routing_profile');

    // Neither arm accepts the other's field, so intent cannot be lost in transit.
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: 'model', routingProfile: 'auto' },
      }).success,
    ).toBe(false);
  });

  it('rejects a target that is neither a model nor a profile', () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: 'whatever_is_cheapest' },
      }).success,
    ).toBe(false);
  });

  it('requires the exact routing policy revision the request was served under', () => {
    const { routingPolicy, ...withoutPolicy } = request;
    expect(routingPolicy.policyVersion).toBe(3);
    expect(inferenceRequestSchema.safeParse(withoutPolicy).success).toBe(false);
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        routingPolicy: { routingPolicyId: 'rp_1', policyVersion: 0 },
      }).success,
    ).toBe(false);
  });

  it('rejects a tool choice with nothing to choose from', () => {
    expect(inferenceRequestSchema.safeParse({ ...request, toolChoice: 'auto' }).success).toBe(
      false,
    );
  });

  it('rejects duplicate tool names in one request', () => {
    const tool = { type: 'function', name: 'lookup', parameters: { type: 'object' } };
    expect(
      inferenceRequestSchema.safeParse({ ...request, tools: [tool, { ...tool }] }).success,
    ).toBe(false);
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        tools: [tool, { ...tool, name: 'lookup_other' }],
        toolChoice: { type: 'function', name: 'lookup' },
      }).success,
    ).toBe(true);
  });

  it('rejects a fractional or negative output-token ceiling', () => {
    expect(inferenceRequestSchema.safeParse({ ...request, maxOutputTokens: 1.5 }).success).toBe(
      false,
    );
    expect(inferenceRequestSchema.safeParse({ ...request, maxOutputTokens: 0 }).success).toBe(
      false,
    );
  });
});

describe('clientRequestMetadataSchema', () => {
  it('records which public dialect the customer called', () => {
    expect(
      safeParseContract(clientRequestMetadataSchema, request.client)?.apiFormat,
    ).toBe('chat_completions');
  });

  it('refuses to carry a client IP, country or user agent', () => {
    // Owner-mandated privacy invariant: no user IP is ever persisted, raw,
    // hashed or geo-derived. `.strict()` is what makes that unbypassable here
    // rather than a rule somebody has to remember when adding a field.
    for (const forbidden of [
      { ip: '203.0.113.7' },
      { ipAddress: '203.0.113.7' },
      { country: 'ES' },
      { userAgent: 'curl/8.5.0' },
      { forwardedFor: '203.0.113.7' },
    ]) {
      expect(
        clientRequestMetadataSchema.safeParse({ ...request.client, ...forbidden }).success,
      ).toBe(false);
    }
  });
});

describe('inferenceMessageSchema', () => {
  const userMessage = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] };

  it('parses each role with content parts', () => {
    for (const role of ['system', 'developer', 'user', 'assistant'] as const) {
      expect(inferenceMessageSchema.safeParse({ ...userMessage, role }).success).toBe(true);
    }
  });

  it('requires a tool message to name the call it answers', () => {
    expect(inferenceMessageSchema.safeParse({ ...userMessage, role: 'tool' }).success).toBe(
      false,
    );
    expect(
      inferenceMessageSchema.safeParse({ ...userMessage, role: 'tool', toolCallId: 'call_1' })
        .success,
    ).toBe(true);
  });

  it('refuses role-specific fields on the wrong role', () => {
    expect(
      inferenceMessageSchema.safeParse({ ...userMessage, toolCallId: 'call_1' }).success,
    ).toBe(false);
    expect(
      inferenceMessageSchema.safeParse({
        ...userMessage,
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{}' }],
      }).success,
    ).toBe(false);
    expect(
      inferenceMessageSchema.safeParse({
        ...userMessage,
        role: 'assistant',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{}' }],
      }).success,
    ).toBe(true);
  });

  it('keeps tool-call arguments as text a model may have malformed', () => {
    const parsed = inferenceMessageSchema.parse({
      ...userMessage,
      role: 'assistant',
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"id":' }],
    });
    expect(parsed.toolCalls?.[0].arguments).toBe('{"id":');
  });
});

describe('inferenceInputSchema', () => {
  it('keeps a batch of strings distinct from a one-message conversation', () => {
    expect(inferenceInputSchema.parse({ format: 'text_batch', texts: ['a', 'b'] })).toEqual({
      format: 'text_batch',
      texts: ['a', 'b'],
    });
    expect(inferenceInputSchema.safeParse({ format: 'text_batch', texts: [] }).success).toBe(
      false,
    );
    expect(inferenceInputSchema.safeParse({ format: 'messages', messages: [] }).success).toBe(
      false,
    );
  });

  it('parses multimodal content parts from either source', () => {
    const parsed = inferenceInputSchema.parse({
      format: 'messages',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } },
            {
              type: 'audio',
              source: { kind: 'inline', mediaType: 'audio/wav', data: 'UklGRg==' },
            },
          ],
        },
      ],
    });
    expect(parsed.format).toBe('messages');
  });
});

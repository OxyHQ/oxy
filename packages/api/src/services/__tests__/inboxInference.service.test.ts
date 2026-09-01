import { OxyServices } from '@oxyhq/core';
import { inboxInferenceRequestSchema } from '../../schemas/inboxInference.schemas';
import {
  buildInboxInferenceRequest,
  resetInboxInferenceClientForTests,
  runInboxInference,
  streamInboxInference,
} from '../inboxInference.service';

const originalFetch = global.fetch;
const originalEnvironment = {
  apiKey: process.env.INBOX_INFERENCE_SERVICE_API_KEY,
  apiSecret: process.env.INBOX_INFERENCE_SERVICE_API_SECRET,
  baseURL: process.env.INBOX_INFERENCE_EDGE_BASE_URL,
};

function responseBody() {
  return {
    schemaVersion: 1,
    requestId: 'req_1',
    model: 'openai/gpt-5@2026-06-01',
    servingProvider: 'openai',
    finishReason: 'stop',
    output: [{ role: 'assistant', content: [{ type: 'text', text: 'Draft' }] }],
    usage: [],
    routingPolicy: { routingPolicyId: 'inbox-default', policyVersion: 1 },
  };
}

beforeEach(() => {
  process.env.INBOX_INFERENCE_SERVICE_API_KEY = 'oxy_dk_inbox';
  process.env.INBOX_INFERENCE_SERVICE_API_SECRET = 'service-secret';
  process.env.INBOX_INFERENCE_EDGE_BASE_URL = 'https://api.test.invalid';
  resetInboxInferenceClientForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  for (const [name, value] of Object.entries({
    INBOX_INFERENCE_SERVICE_API_KEY: originalEnvironment.apiKey,
    INBOX_INFERENCE_SERVICE_API_SECRET: originalEnvironment.apiSecret,
    INBOX_INFERENCE_EDGE_BASE_URL: originalEnvironment.baseURL,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetInboxInferenceClientForTests();
});

describe('Inbox inference BFF policy', () => {
  it.each([
    'userId',
    'model',
    'routingProfile',
    'systemPrompt',
    'prompts',
    'labels',
    'maxOutputTokens',
    'temperature',
    'conversationId',
    'agentId',
    'tools',
    'memory',
  ])(
    'strictly rejects client-owned %s',
    (field) => {
      const result = inboxInferenceRequestSchema.safeParse({
        feature: 'compose-draft',
        prompt: 'Reply about the meeting',
        tone: 'professional',
        [field]: field === 'labels' ? { product: 'attacker' } : 'attacker-choice',
      });

      expect(result.success).toBe(false);
    },
  );

  it('builds instructions, limits and labels server-side without a model or profile', () => {
    const parsed = inboxInferenceRequestSchema.parse({
      feature: 'compose-draft',
      prompt: 'Reply about the meeting',
      tone: 'professional',
    });
    const built = buildInboxInferenceRequest(parsed);

    expect(built.request).toEqual(
      expect.objectContaining({
        labels: { product: 'inbox', feature: 'compose-draft' },
        maxOutputTokens: 800,
        temperature: 0.7,
      }),
    );
    expect(built.request).not.toHaveProperty('model');
    expect(built.request).not.toHaveProperty('routingProfile');
    expect(built.request.input[0]).toEqual(expect.objectContaining({ role: 'system' }));
  });

  it('asks for an object when JSON-object mode is selected for smart replies', () => {
    const parsed = inboxInferenceRequestSchema.parse({
      feature: 'smart-replies',
      message: { sender: 'Alice', subject: 'Hello', body: 'Can you join?' },
    });
    const built = buildInboxInferenceRequest(parsed);

    expect(built.request.responseFormat).toEqual({ type: 'json_object' });
    expect(JSON.stringify(built.request.input)).toContain('replies');
    expect(JSON.stringify(built.request.input)).not.toContain('only the JSON array');
  });
});

describe('Inbox inference service identity', () => {
  it('delegates the authenticated user, re-mints once after 401, and never puts identity in the body', async () => {
    const getToken = jest
      .spyOn(OxyServices.prototype, 'getServiceToken')
      .mockResolvedValueOnce('stale-service-token')
      .mockResolvedValueOnce('fresh-service-token');
    const invalidate = jest.spyOn(OxyServices.prototype, 'invalidateServiceToken');
    const calls: Array<{
      authorization: string | null;
      userId: string | null;
      body: unknown;
    }> = [];
    global.fetch = jest.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        authorization: headers.get('authorization'),
        userId: headers.get('x-oxy-user-id'),
        body: JSON.parse(String(init?.body)),
      });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            code: 'authentication_failed',
            message: 'Expired service token',
            retryable: false,
            requestId: 'req_401',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await runInboxInference(
      { feature: 'compose-polish', text: 'hello' },
      'authenticated-user',
      new AbortController().signal,
    );

    expect(result).toEqual({ text: 'Draft', requestId: 'req_1' });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer stale-service-token',
      'Bearer fresh-service-token',
    ]);
    expect(calls.map((call) => call.userId)).toEqual(['authenticated-user', 'authenticated-user']);
    for (const call of calls) {
      expect(call.body).not.toHaveProperty('userId');
      expect(call.body).not.toHaveProperty('model');
      expect(call.body).not.toHaveProperty('routingProfile');
    }
  });

  it('re-mints the service credential once when a stream is refused with 401 before opening', async () => {
    const getToken = jest
      .spyOn(OxyServices.prototype, 'getServiceToken')
      .mockResolvedValueOnce('stale-stream-token')
      .mockResolvedValueOnce('fresh-stream-token');
    const invalidate = jest.spyOn(OxyServices.prototype, 'invalidateServiceToken');
    const authorizations: Array<string | null> = [];
    global.fetch = jest.fn(async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      if (authorizations.length === 1) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            code: 'authentication_failed',
            message: 'Expired service token',
            retryable: false,
            requestId: 'req_stream_401',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const events = [
        {
          schemaVersion: 1,
          type: 'start',
          requestId: 'req_stream',
          sequence: 0,
          resolvedModelReference: 'openai/gpt-5@2026-06-01',
          servingProvider: 'openai',
          startedAt: '2026-09-02T12:00:00.000Z',
        },
        {
          schemaVersion: 1,
          type: 'done',
          requestId: 'req_stream',
          sequence: 1,
          finishReason: 'stop',
          completedAt: '2026-09-02T12:00:01.000Z',
        },
      ];
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    const events = [];
    for await (const event of streamInboxInference(
      { feature: 'compose-draft', prompt: 'hello', tone: 'professional' },
      'authenticated-user',
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(authorizations).toEqual(['Bearer stale-stream-token', 'Bearer fresh-stream-token']);
  });

  it('never exposes an upstream credential in the mapped error', async () => {
    const secret = 'credential-sensitive-provider-value';
    jest.spyOn(OxyServices.prototype, 'getServiceToken').mockResolvedValue('service-token');
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            code: 'provider_error',
            message: `provider echoed ${secret}`,
            retryable: true,
            requestId: 'req_secret',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const error = await runInboxInference(
      { feature: 'compose-polish', text: 'hello' },
      'authenticated-user',
      new AbortController().signal,
    ).catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Inbox inference is temporarily unavailable',
      }),
    );
  });

  it('rejects credential-bearing or cleartext edge URLs without reflecting them', async () => {
    const secret = 'credential-sensitive-url-value';
    process.env.INBOX_INFERENCE_EDGE_BASE_URL = `http://user:${secret}@example.com`;

    const error = await runInboxInference(
      { feature: 'compose-polish', text: 'hello' },
      'authenticated-user',
      new AbortController().signal,
    ).catch((thrown: unknown) => thrown);

    expect(String(error)).toContain('edge URL is invalid');
    expect(String(error)).not.toContain(secret);
  });
});

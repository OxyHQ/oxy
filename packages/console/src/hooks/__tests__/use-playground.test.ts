import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MutationFunctionContext } from '@tanstack/react-query';
import { playgroundReceiptOptions, playgroundRunOptions } from '@/hooks/use-playground';
import config from '@/lib/config';

/**
 * How the playground talks to the public inference edge.
 *
 * The load-bearing claim is a NEGATIVE one — the signed-in user's device-first
 * session bearer is not on this request — and a negative claim needs a positive
 * control beside it, or "the header is absent" and "no request was made at all"
 * are the same observation. So every case asserts the request WAS issued and that
 * `Authorization` carries the pasted key, and the header set is asserted EXACTLY
 * rather than by absence: an edit that added `credentials: 'include'` or a second
 * auth header fails here instead of quietly putting the ambient session back on
 * the inference lane ADR 0010 removed.
 *
 * These call the REAL `mutationFn` off the exported options — the same object
 * `usePlaygroundRun` hands to `useMutation` — rather than rendering a component
 * around it. Nothing is re-implemented here; a test that had to mount React to
 * observe a `fetch` would be measuring React as much as the request.
 */

const API_KEY = `oxy_sk_0123456789abcdef_${'a'.repeat(64)}`;

/** The last `fetch` call, as `[url, init]`. */
function lastFetchCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('fetch was never called');
  }
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const COMPLETION_BODY = {
  schemaVersion: 1,
  requestId: 'req_01HZY',
  model: 'anthropic/claude-sonnet@2026-05-01',
  servingProvider: 'bedrock',
  finishReason: 'stop',
  output: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
  usage: [{ unit: 'input_tokens', quantity: 12 }],
  routingPolicy: { routingPolicyId: 'rp_default', policyVersion: 3 },
};

/**
 * The context TanStack passes a `mutationFn`.
 *
 * Built here rather than stubbed with a cast, so the call below is the call the
 * library makes. Neither `mutationFn` reads it — which is itself worth being able
 * to see: nothing in either request depends on the client or on mutation meta.
 */
function mutationContext(
  mutationKey: ReadonlyArray<unknown> | undefined
): MutationFunctionContext {
  return { client: new QueryClient(), meta: undefined, mutationKey };
}

/** The run's `mutationFn`, which `mutationOptions` types as possibly absent. */
function runPlayground(variables: { apiKey: string; model: string; input: string }) {
  const mutationFn = playgroundRunOptions.mutationFn;
  if (mutationFn === undefined) {
    throw new Error('the run options carry no mutationFn');
  }
  return mutationFn(variables, mutationContext(playgroundRunOptions.mutationKey));
}

function fetchReceipt(variables: { apiKey: string; requestId: string }) {
  const mutationFn = playgroundReceiptOptions.mutationFn;
  if (mutationFn === undefined) {
    throw new Error('the receipt options carry no mutationFn');
  }
  return mutationFn(variables, mutationContext(playgroundReceiptOptions.mutationKey));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the playground run', () => {
  it('never retries, because a refused call would re-send the secret', () => {
    // `retry: false` is not a preference here. The default policy retries a 5xx,
    // and the refusal these deployments actually produce is a 503 — so a default
    // would put the customer's credential back on the wire three more times over
    // the following seconds.
    expect(playgroundRunOptions.retry).toBe(false);
    expect(playgroundReceiptOptions.retry).toBe(false);
  });

  it('does not put the credential in the mutation key, which is cached', () => {
    // A mutation key is held in the query cache and shown by the devtools. The
    // key is a constant, and the secret travels only in the variables.
    expect(playgroundRunOptions.mutationKey).toEqual(['playground-run']);
    expect(JSON.stringify(playgroundRunOptions.mutationKey)).not.toContain('oxy_sk');
  });

  it('sends the pasted credential and nothing else that could authenticate', async () => {
    const fetchMock = stubFetch(200, COMPLETION_BODY);

    await runPlayground({ apiKey: API_KEY, model: 'anthropic/claude-sonnet', input: 'hi' });

    // POSITIVE CONTROL: the request happened. Without it, every assertion about
    // what the request does NOT carry would hold vacuously.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toBe(`${config.oxyUrl}/v1/responses`);
    expect(init.method).toBe('POST');

    // The header set, EXACTLY. Asserting the keys rather than only the absence of
    // a cookie is what makes a future addition visible.
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    });

    // No ambient credentials: the edge takes the credential from the header, and
    // an included cookie would put this call back on the session lane.
    expect(init.credentials).toBeUndefined();

    expect(JSON.parse(String(init.body))).toEqual({
      model: 'anthropic/claude-sonnet',
      input: 'hi',
    });
  });

  it('reports the body’s own fields and a round trip measured in the browser', async () => {
    stubFetch(200, COMPLETION_BODY);

    const result = await runPlayground({
      apiKey: API_KEY,
      model: 'anthropic/claude-sonnet',
      input: 'hi',
    });
    if (result.status !== 'completed') {
      throw new Error(`expected a completed run, got ${result.status}`);
    }

    // Read from the BODY, not from `X-Oxy-*` headers: a browser gets `null` from
    // `headers.get()` for a header CORS does not expose, silently and with no
    // error to notice.
    expect(result.run.requestId).toBe('req_01HZY');
    expect(result.run.model).toBe('anthropic/claude-sonnet@2026-05-01');
    expect(result.run.servingProvider).toBe('bedrock');
    expect(result.run.routingPolicy).toEqual({
      routingPolicyId: 'rp_default',
      policyVersion: 3,
    });
    expect(result.run.usage).toEqual([{ unit: 'input_tokens', quantity: 12 }]);
    expect(typeof result.run.roundTripMs).toBe('number');
    expect(result.run.roundTripMs).toBeGreaterThanOrEqual(0);
  });

  it('RESOLVES a refusal instead of throwing it away', async () => {
    // The refusal the edge actually produces today, with no data plane
    // configured. Resolving rather than throwing is what keeps the code, the
    // retryability and above all the request id renderable — a refusal a customer
    // cannot quote is one they have to reproduce in order to report.
    const refusal = {
      schemaVersion: 1,
      code: 'service_unavailable',
      message: 'No data plane is configured.',
      retryable: true,
      requestId: 'req_refused',
    };
    stubFetch(503, refusal);

    await expect(
      runPlayground({ apiKey: API_KEY, model: 'anthropic/claude-sonnet', input: 'hi' })
    ).resolves.toEqual({ status: 'refused', error: refusal });
  });

  it('throws for a non-OK body that is not the edge’s error shape', async () => {
    // A gateway or proxy answer. Reported as itself rather than dressed up as an
    // inference refusal it cannot describe — it carries no request id at all, so
    // presenting it as one would show an empty field where the id belongs.
    stubFetch(502, { message: 'bad gateway' });

    await expect(
      runPlayground({ apiKey: API_KEY, model: 'anthropic/claude-sonnet', input: 'hi' })
    ).rejects.toThrow('502');
  });
});

describe('the playground receipt', () => {
  const RECEIPT = {
    receiptId: 'rcpt_1',
    requestId: 'req_01HZY',
    environment: 'development',
    outcome: 'completed',
    usageSource: 'provider_reported',
    resolvedModelReference: 'anthropic/claude-sonnet@2026-05-01',
    servingProvider: 'bedrock',
    billedAmount: '0.000036000000',
    currency: 'USD',
    platformFeeOnly: false,
    settledAt: '2026-08-17T10:00:00.000Z',
    priceSnapshot: {
      priceVersionId: 'pv_2026_08',
      currency: 'USD',
      unitPrices: [
        { unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000, currency: 'USD' },
      ],
    },
  };

  it('unwraps the { data } envelope and carries the exact decimal through', async () => {
    const fetchMock = stubFetch(200, { data: RECEIPT });

    const result = await fetchReceipt({ apiKey: API_KEY, requestId: 'req_01HZY' });

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toBe(`${config.oxyUrl}/v1/generations/req_01HZY`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });

    if (result.status !== 'found') {
      throw new Error('expected a receipt');
    }
    // The amount stays the STRING the ledger sent. A `Number()` anywhere on this
    // path would render a per-request charge of 0.000036 as 0.00 — a wrong figure
    // that still looks like money.
    expect(result.receipt.billedAmount).toBe('0.000036000000');
    expect(result.receipt.priceSnapshot.priceVersionId).toBe('pv_2026_08');
  });

  it('treats a 404 as “no receipt”, never as an error', async () => {
    // The normal outcome today: under shadow metering no receipt is written for
    // any request at all. The refusal arrives as `model_not_found` because the
    // closed error vocabulary has no generic not-found and that is its only 404 —
    // so this must not reject, and the message must never reach the screen, where
    // it would tell the user their MODEL was not found.
    stubFetch(404, {
      schemaVersion: 1,
      code: 'model_not_found',
      message: 'No generation receipt with that id is available to you.',
      retryable: false,
      requestId: 'req_lookup',
    });

    await expect(
      fetchReceipt({ apiKey: API_KEY, requestId: 'req_01HZY' })
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('percent-encodes the request id rather than interpolating it raw', async () => {
    const fetchMock = stubFetch(404, { code: 'model_not_found', requestId: 'x' });

    await fetchReceipt({ apiKey: API_KEY, requestId: '../generations/other' });

    const [url] = lastFetchCall(fetchMock);
    expect(url).toBe(`${config.oxyUrl}/v1/generations/..%2Fgenerations%2Fother`);
  });
});

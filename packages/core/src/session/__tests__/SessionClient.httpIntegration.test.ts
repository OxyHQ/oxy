import type { DeviceSessionState } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { SessionClient } from '../SessionClient';
import { createSessionClientHost } from '../sessionClientHost';

/**
 * Real-stack integration test: a genuine `HttpService` (via `OxyServices`) →
 * `createSessionClientHost` → `SessionClient`, with `global.fetch` stubbed to
 * return the EXACT wire body the server sends for `GET /session/device/state`:
 * `{ data: { state, activeToken } }`.
 *
 * This is the test that would have caught the P0: `HttpService.unwrapResponse`
 * strips the outer `{ data }` envelope, so `makeRequest` already returns
 * `{ state, activeToken }`. If `SessionClient` reads `.data` a SECOND time (or
 * if `HttpService` stops unwrapping), the sync silently discards and neither
 * the state nor the token reach the client — exactly the prod symptom.
 */
const WIRE_STATE: DeviceSessionState = {
  deviceId: 'device-real',
  accounts: [{ accountId: 'acct-1', sessionId: 'sess-1', authuser: 0 }],
  activeAccountId: 'acct-1',
  revision: 42,
  updatedAt: 1720000000000,
};

const ROUTE_BODY = {
  data: {
    state: WIRE_STATE,
    activeToken: { accessToken: 'planted-access-token', expiresAt: '2026-01-01T00:00:00.000Z' },
  },
};

describe('SessionClient over a real HttpService (unwrap contract)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('bootstrap() applies the server state and plants the active token through the real unwrap path', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify(ROUTE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const oxy = new OxyServices({ baseURL: 'http://api.test.invalid' });
    const host = createSessionClientHost(oxy);
    const client = new SessionClient(host);

    await client.bootstrap();

    // The exact URL the server route serves.
    const calledUrl = String((fetchMock.mock.calls[0] ?? [])[0]);
    expect(calledUrl).toContain('/session/device/state');

    // State reached the client (would be null if `.data` were read twice).
    expect(client.getState()).toEqual(WIRE_STATE);

    // Active token planted host-side (would be absent on a discarded sync).
    expect(oxy.getAccessToken()).toBe('planted-access-token');
  });
});

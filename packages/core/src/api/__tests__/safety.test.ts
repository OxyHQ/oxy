import { OxyServices } from '../../OxyServices';
import { OxyServer } from '../../server/OxyServer';
const decision = { allowed: false, reason: 'private', policyVersion: '1' };
describe('canonical profile access context', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify(decision), { headers: { 'content-type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });
  it('requires explicit requester context on a server and never silently substitutes service identity', async () => {
    const oxy = new OxyServer({
      baseURL: 'http://test.invalid',
      serviceAuth: { apiKey: 'test-service-key', apiSecret: 'test-service-secret' },
    });
    await expect(oxy.safety.profileAccess({ subjectAccountId: 'subject' })).rejects.toThrow(
      'explicit requester',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const service = jest.spyOn(oxy, 'serviceRequest').mockResolvedValue(decision);
    expect(
      await oxy.safety.profileAccess({ subjectAccountId: 'subject' }, { accessToken: null }),
    ).toEqual(decision);
    expect(service).toHaveBeenCalledWith(
      'POST',
      '/safety/service/profile-access',
      { input: { subjectAccountId: 'subject' }, requester: { accessToken: null } },
      expect.objectContaining({ cache: false, retry: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('forwards exactly the original bearer when supplied and does not refresh into another account', async () => {
    const oxy = new OxyServer({
      baseURL: 'http://test.invalid',
      serviceAuth: { apiKey: 'test-service-key', apiSecret: 'test-service-secret' },
    });
    const service = jest.spyOn(oxy, 'serviceRequest').mockResolvedValue(decision);
    expect(
      await oxy.safety.profileAccess(
        { subjectAccountId: 'subject' },
        { accessToken: 'original-bearer' },
      ),
    ).toEqual(decision);
    expect(service).toHaveBeenCalledWith(
      'POST',
      '/safety/service/profile-access',
      { input: { subjectAccountId: 'subject' }, requester: { accessToken: 'original-bearer' } },
      expect.any(Object),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects caller-selected viewer IDs and malformed policy answers', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    await expect(
      oxy.safety.profileAccess({ subjectAccountId: 'subject', viewerId: 'forged' } as never, {
        accessToken: null,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ allowed: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      oxy.safety.profileAccess({ subjectAccountId: 'subject' }, { accessToken: null }),
    ).rejects.toThrow();
  });
  it('sends bounded message batches with original proof and delivery batches with service authority only', async () => {
    const oxy = new OxyServer({
      baseURL: 'http://test.invalid',
      serviceAuth: { apiKey: 'key', apiSecret: 'secret' },
    });
    const items = [{ resourceId: 'self', participantAccountIds: ['person'] }];
    const response = {
      items: [
        { resourceId: 'self', decision: { allowed: true, reason: 'allowed', policyVersion: '2' } },
      ],
    };
    const service = jest.spyOn(oxy, 'serviceRequest').mockResolvedValue(response);
    expect(await oxy.safety.messageAccessBatch({ items }, { accessToken: 'original' })).toEqual(
      response,
    );
    expect(service).toHaveBeenLastCalledWith(
      'POST',
      '/safety/service/message-access-batch',
      { input: { items }, requester: { accessToken: 'original' } },
      expect.objectContaining({ serviceTokenScopes: ['safety:decide'], cache: false }),
    );
    await oxy.safety.deliveryAccessBatch({
      items: items.map((item) => ({ ...item, senderAccountId: 'person' })),
    });
    expect(service).toHaveBeenLastCalledWith(
      'POST',
      '/safety/service/delivery-access-batch',
      { items: [{ ...items[0], senderAccountId: 'person' }] },
      expect.objectContaining({ cache: false }),
    );
    service.mockResolvedValueOnce({ items: [{ resourceId: 'self', decision: { allowed: true } }] });
    await expect(
      oxy.safety.messageAccessBatch({ items }, { accessToken: 'original' }),
    ).rejects.toThrow();
  });
  it('uses the reviewed service lane for socket proof batches without anonymous fallback', async () => {
    const oxy = new OxyServer({
      baseURL: 'http://test.invalid',
      serviceAuth: { apiKey: 'key', apiSecret: 'secret' },
    });
    const input = { items: [{ requestId: 'socket', accessToken: 'original' }] };
    const service = jest
      .spyOn(oxy, 'serviceRequest')
      .mockResolvedValue({ items: [{ requestId: 'socket', allowed: false }] });
    expect(await oxy.safety.messagingSessions(input)).toEqual({
      items: [{ requestId: 'socket', allowed: false }],
    });
    expect(service).toHaveBeenCalledWith(
      'POST',
      '/safety/service/messaging-sessions',
      input,
      expect.objectContaining({
        serviceTokenScopes: ['safety:decide'],
        cache: false,
        retry: false,
      }),
    );
    service.mockRejectedValueOnce(new Error('authority unavailable'));
    await expect(oxy.safety.messagingSessions(input)).rejects.toThrow('authority unavailable');
  });
});

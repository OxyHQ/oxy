import { ContractCheckError } from '@oxy.so/contracts/client';
import { stubbedClient } from './helpers';

const WRITE = { cache: false, retry: false };
const READ = { cache: false };
const ID = '0190a5b2-0000-7000-8000-000000000001';

const state = { vault: null, roster: [], members: [], self: null };
const wrap = {
  recipient: 'recovery',
  generation: 1,
  epk: 'e',
  nonce: 'n',
  ciphertext: 'c',
  signer: ID,
  signature: 's',
};
const enrollment = {
  id: ID,
  vaultId: ID,
  member: { id: ID, name: 'Phone', platform: 'ios', signingKey: 'k', boxKey: 'b' },
  commitment: 'c',
  approverNonce: null,
  approverMemberId: null,
  deviceNonce: null,
  status: 'pending',
  expiresAt: '2026-11-07T12:10:00.000Z',
  createdAt: '2026-11-07T12:00:00.000Z',
};
const item = {
  id: ID,
  revision: 3,
  generation: 1,
  nonce: 'n',
  ciphertext: 'c',
  deletedAt: null,
  updatedAt: '2026-11-07T12:00:00.000Z',
};

describe('oxy.keychain', () => {
  it('maps every route, never caching and never retrying a write', async () => {
    const { oxy, request } = stubbedClient();
    const k = oxy.keychain;

    request.mockResolvedValueOnce(state);
    await expect(k.state()).resolves.toEqual(state);
    expect(request).toHaveBeenLastCalledWith('GET', '/keychain', undefined, READ);

    const genesis = { body: '{}', signatures: [] };
    request.mockResolvedValueOnce(state);
    await k.create({ genesis, wraps: [wrap] });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/keychain',
      { genesis, wraps: [wrap] },
      WRITE,
    );

    request.mockResolvedValueOnce(state);
    await k.appendRoster({ entries: [genesis] });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/keychain/roster',
      { entries: [genesis], wraps: [] },
      WRITE,
    );

    request.mockResolvedValueOnce({ wrap });
    await expect(k.ownWrap()).resolves.toEqual(wrap);
    expect(request).toHaveBeenLastCalledWith('GET', '/keychain/wrap', undefined, READ);
    request.mockResolvedValueOnce({ wrap });
    await expect(k.recoveryWrap()).resolves.toEqual(wrap);
    expect(request).toHaveBeenLastCalledWith('GET', '/keychain/recovery', undefined, READ);

    request.mockResolvedValueOnce({ enrollment });
    await k.enrollments.create({ member: enrollment.member as never, commitment: 'c' });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/keychain/enrollments',
      { member: enrollment.member, commitment: 'c' },
      WRITE,
    );
    request.mockResolvedValueOnce({ enrollments: [enrollment] });
    await expect(k.enrollments.list()).resolves.toEqual([enrollment]);
    request.mockResolvedValueOnce({ enrollment });
    await k.enrollments.get(ID);
    expect(request).toHaveBeenLastCalledWith('GET', `/keychain/enrollments/${ID}`, undefined, READ);
    request.mockResolvedValueOnce({ enrollment });
    await k.enrollments.postApproverNonce(ID, { memberId: ID, approverNonce: 'a' });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      `/keychain/enrollments/${ID}/approver-nonce`,
      { memberId: ID, approverNonce: 'a' },
      WRITE,
    );
    request.mockResolvedValueOnce({ enrollment });
    await k.enrollments.reveal(ID, { deviceNonce: 'd' });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      `/keychain/enrollments/${ID}/reveal`,
      { deviceNonce: 'd' },
      WRITE,
    );
    request.mockResolvedValueOnce(state);
    await k.enrollments.approve(ID, { entry: genesis, wrap });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      `/keychain/enrollments/${ID}/approve`,
      { entry: genesis, wrap },
      WRITE,
    );
    request.mockResolvedValueOnce(undefined);
    await k.enrollments.cancel(ID);
    expect(request).toHaveBeenLastCalledWith(
      'DELETE',
      `/keychain/enrollments/${ID}`,
      undefined,
      WRITE,
    );

    request.mockResolvedValueOnce({ items: [item], revision: 3, more: false });
    await k.items.list({ since: 2 });
    expect(request).toHaveBeenLastCalledWith('GET', '/keychain/items', { since: 2 }, READ);
    request.mockResolvedValueOnce({ item });
    const put = { baseRevision: null, generation: 1, nonce: 'n', ciphertext: 'c' };
    await k.items.put(ID, put);
    expect(request).toHaveBeenLastCalledWith('PUT', `/keychain/items/${ID}`, put, WRITE);
    request.mockResolvedValueOnce({ item: { ...item, nonce: null, ciphertext: null } });
    await k.items.delete(ID, { baseRevision: 3 });
    expect(request).toHaveBeenLastCalledWith(
      'DELETE',
      `/keychain/items/${ID}`,
      { baseRevision: 3 },
      WRITE,
    );

    request.mockResolvedValueOnce(undefined);
    await k.reset({ reauth: { password: 'pw' } } as never);
    expect(request).toHaveBeenLastCalledWith(
      'DELETE',
      '/keychain',
      { reauth: { password: 'pw' } },
      WRITE,
    );
    oxy.dispose();
  });

  it('refuses an answer that is not the contract', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValueOnce({ vault: null, roster: 'nope', members: [], self: null });
    await expect(oxy.keychain.state()).rejects.toBeInstanceOf(ContractCheckError);
    request.mockResolvedValueOnce({ items: [], revision: -1, more: false });
    await expect(oxy.keychain.items.list()).rejects.toBeInstanceOf(ContractCheckError);
    oxy.dispose();
  });

  it('opens a KeychainClient by loading the crypto entry', async () => {
    const { oxy } = stubbedClient();
    const store = { load: async () => null, save: async () => {}, clear: async () => {} };
    const client = await oxy.keychain.openClient({ store });
    expect(client.constructor.name).toBe('KeychainClient');
    oxy.dispose();
  });
});

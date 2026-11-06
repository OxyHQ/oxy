/**
 * R5-7: organization keys the iOS migration kept quarantined are bound only
 * against the organization's own key history, and the CURRENT one becomes the
 * live pair again; an organization this person cannot read stays quarantined.
 */
const mockList = jest.fn();
const mockClaim = jest.fn();
const mockAdopt = jest.fn();

jest.mock('@oxy.so/core/crypto', () => ({
  listQuarantinedOrganizationKeys: () => mockList(),
  claimRetiredOrganizationKeys: (accountId: string, keys: string[]) => mockClaim(accountId, keys),
  adoptOrganizationKeyFromRing: (accountId: string, publicKey: string) =>
    mockAdopt(accountId, publicKey),
}));

import { bindQuarantinedOrganizationKeys } from '@/lib/organization-wallet/bindQuarantined';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('bindQuarantinedOrganizationKeys', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockClaim.mockReset().mockResolvedValue(1);
    mockAdopt.mockReset().mockResolvedValue(true);
  });

  it('binds against each organization’s history once, and restores its current key', async () => {
    mockList.mockResolvedValue([
      { accountId: ORG_A, publicKey: '04a1' },
      { accountId: ORG_A, publicKey: '04a2' },
      { accountId: ORG_B, publicKey: '04b1' },
    ]);
    const get = jest.fn(async (accountId: string) =>
      accountId === ORG_A
        ? { publicKey: '04a2', keys: [{ publicKey: '04a1' }, { publicKey: '04a2' }] }
        : { publicKey: null, keys: [] },
    );
    await expect(
      bindQuarantinedOrganizationKeys({ accounts: { identityKey: { get } } }),
    ).resolves.toBe(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(mockClaim).toHaveBeenCalledWith(ORG_A, ['04a1', '04a2']);
    expect(mockAdopt).toHaveBeenCalledWith(ORG_A, '04a2');
    // A keyless organization: nothing to make live.
    expect(mockAdopt).not.toHaveBeenCalledWith(ORG_B, expect.anything());
  });

  it('leaves an organization it cannot read quarantined', async () => {
    mockList.mockResolvedValue([{ accountId: ORG_A, publicKey: '04a1' }]);
    const get = jest.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    await expect(
      bindQuarantinedOrganizationKeys({ accounts: { identityKey: { get } } }),
    ).resolves.toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockAdopt).not.toHaveBeenCalled();
  });
});

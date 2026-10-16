import {
  ACCOUNTS_MEMBERSHIP_READ_SCOPE,
  accountAccessVerdictSchema,
  type AccountAccessVerdict,
} from '../index';

const grant = {
  role: 'editor',
  permissions: ['account:read', 'members:read'],
  status: 'active',
  source: 'direct',
} as const;

const member: AccountAccessVerdict = {
  accountId: 'channel-1',
  kind: 'channel',
  access: { ...grant, permissions: [...grant.permissions] },
};

describe('account access verdict contract', () => {
  it('names the scope once', () => {
    expect(ACCOUNTS_MEMBERSHIP_READ_SCOPE).toBe('accounts:membership:read');
  });

  it('accepts a member, an inherited member and the account itself', () => {
    expect(accountAccessVerdictSchema.parse(member)).toEqual(member);
    for (const source of ['inherited', 'self'] as const) {
      const verdict = { ...member, access: { ...grant, source } };
      expect(accountAccessVerdictSchema.safeParse(verdict).success).toBe(true);
    }
  });

  it('accepts a refusal for an existing and for an unknown account', () => {
    expect(accountAccessVerdictSchema.safeParse({ ...member, access: null }).success).toBe(true);
    expect(
      accountAccessVerdictSchema.safeParse({ accountId: 'nope', kind: null, access: null }).success,
    ).toBe(true);
  });

  it('refuses access over an account that does not exist', () => {
    expect(accountAccessVerdictSchema.safeParse({ ...member, kind: null }).success).toBe(false);
  });

  it('refuses a membership that is not active', () => {
    for (const status of ['invited', 'removed']) {
      const verdict = { ...member, access: { ...grant, status } };
      expect(accountAccessVerdictSchema.safeParse(verdict).success).toBe(false);
    }
  });

  it('refuses an unknown kind or source, and a missing field', () => {
    expect(accountAccessVerdictSchema.safeParse({ ...member, kind: 'guild' }).success).toBe(false);
    expect(
      accountAccessVerdictSchema.safeParse({
        ...member,
        access: { ...grant, source: 'delegated' },
      }).success,
    ).toBe(false);
    const { access: _access, ...withoutAccess } = member;
    expect(accountAccessVerdictSchema.safeParse(withoutAccess).success).toBe(false);
  });

  it('keeps reading a role or permission it does not know yet', () => {
    const verdict = {
      ...member,
      access: { ...grant, role: 'moderator', permissions: ['posts:pin'] },
    };
    expect(accountAccessVerdictSchema.safeParse(verdict).success).toBe(true);
  });
});

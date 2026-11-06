import { IDENTITY_ERROR_CODES, ORGANIZATION_KEY_ERROR_CODES } from '@oxy.so/contracts/client';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';
import {
  isRetiredOrganizationKey,
  deviceKeyStatus,
  governedOrganizations,
  organizationKeyErrorKey,
} from '@/lib/organization-wallet';

const KEY = `04${'ab'.repeat(64)}`;
const OTHER = `04${'cd'.repeat(64)}`;

function node(accountId: string, kind: string, role: string | null, status = 'active') {
  return { accountId, kind, callerMembership: role ? { role, status } : null };
}

describe('governedOrganizations', () => {
  it('keeps the organizations this person owns or administers, once each', () => {
    const accounts = [
      node('self', 'personal', null),
      node('org-owner', 'organization', 'owner'),
      node('org-admin', 'organization', 'admin'),
      node('org-editor', 'organization', 'editor'),
      node('org-removed', 'organization', 'owner', 'removed'),
      node('project', 'project', 'owner'),
      node('org-owner', 'organization', 'owner'),
    ];
    expect(governedOrganizations(accounts).map((a) => a.accountId)).toEqual([
      'org-owner',
      'org-admin',
    ]);
  });
});

describe('deviceKeyStatus', () => {
  it('says whether to set up, add or use the wallet', () => {
    expect(deviceKeyStatus(null, null)).toBe('none');
    expect(deviceKeyStatus(null, KEY)).toBe('none');
    expect(deviceKeyStatus(KEY, KEY.toUpperCase())).toBe('held');
    expect(deviceKeyStatus(KEY, OTHER)).toBe('stale');
    expect(deviceKeyStatus(KEY, null)).toBe('elsewhere');
  });
});

describe('isRetiredOrganizationKey', () => {
  const state = {
    keys: [
      { publicKey: `04${'aa'.repeat(64)}`, retiredAt: '2026-11-01T00:00:00.000Z' },
      { publicKey: `04${'bb'.repeat(64)}`, retiredAt: null },
    ],
  };
  it('is true only for a key the organization had and replaced', () => {
    expect(isRetiredOrganizationKey(state, `04${'AA'.repeat(64)}`)).toBe(true);
    expect(isRetiredOrganizationKey(state, `04${'bb'.repeat(64)}`)).toBe(false);
    expect(isRetiredOrganizationKey(state, `04${'cc'.repeat(64)}`)).toBe(false);
    expect(isRetiredOrganizationKey(state, null)).toBe(false);
  });
});

describe('organizationKeyErrorKey', () => {
  function resolve(dict: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((value, segment) => {
      return value && typeof value === 'object'
        ? (value as Record<string, unknown>)[segment]
        : undefined;
    }, dict);
  }

  it('maps every refusal to copy both locales have, never the server text', () => {
    const codes = [
      ORGANIZATION_KEY_ERROR_CODES.forbidden,
      ORGANIZATION_KEY_ERROR_CODES.actorRootRequired,
      ORGANIZATION_KEY_ERROR_CODES.noKey,
      ORGANIZATION_KEY_ERROR_CODES.keyUsed,
      IDENTITY_ERROR_CODES.rootAlreadyLinked,
      IDENTITY_ERROR_CODES.rootLinkedElsewhere,
      IDENTITY_ERROR_CODES.proofInvalid,
      'SOMETHING_ELSE',
    ];
    for (const code of codes) {
      const key = organizationKeyErrorKey({ code, message: 'server prose' });
      expect(typeof resolve(en, key)).toBe('string');
      expect(typeof resolve(es, key)).toBe('string');
    }
    expect(organizationKeyErrorKey(new Error('x'))).toBe('organizationWallet.errors.generic');
    expect(organizationKeyErrorKey({ code: ORGANIZATION_KEY_ERROR_CODES.forbidden })).toBe(
      'organizationWallet.errors.forbidden',
    );
  });
});

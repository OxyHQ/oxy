import type { VerifiableCredentialResponse } from '@oxy.so/contracts';
import {
  CREDENTIAL_BASE_TYPE,
  CREDENTIAL_PRESETS,
  specificCredentialTypes,
  primaryCredentialType,
  humanizeTypeTag,
  deriveCustomTypeTag,
  resolveCredentialTypeTag,
  claimEntries,
  getCredentialStatusMeta,
  canRevokeCredential,
} from '@/lib/civic/credential-display';

function makeCredential(
  overrides: Partial<VerifiableCredentialResponse> = {},
): VerifiableCredentialResponse {
  return {
    id: 'vc1',
    recordId: 'rec1',
    holderUserId: 'holder',
    holderDid: 'did:web:oxy.so:u:holder',
    issuerUserId: 'issuer',
    issuerDid: 'did:web:oxy.so:u:issuer',
    types: [CREDENTIAL_BASE_TYPE, 'EmploymentCredential'],
    claims: { statement: 'Worked here' },
    status: 'active',
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('specificCredentialTypes / primaryCredentialType', () => {
  it('drops the generic VerifiableCredential base type', () => {
    expect(specificCredentialTypes([CREDENTIAL_BASE_TYPE, 'EmploymentCredential'])).toEqual([
      'EmploymentCredential',
    ]);
  });

  it('returns the first specific type as primary', () => {
    expect(primaryCredentialType([CREDENTIAL_BASE_TYPE, 'CourseCredential', 'X'])).toBe(
      'CourseCredential',
    );
  });

  it('returns null when only the base type is present', () => {
    expect(primaryCredentialType([CREDENTIAL_BASE_TYPE])).toBeNull();
  });
});

describe('humanizeTypeTag', () => {
  it.each([
    ['EmploymentCredential', 'Employment'],
    ['CourseCompletionCredential', 'Course Completion'],
    ['membership_card', 'Membership Card'],
    ['Credential', 'Credential'],
  ])('humanizes "%s" → "%s"', (tag, expected) => {
    expect(humanizeTypeTag(tag)).toBe(expected);
  });
});

describe('deriveCustomTypeTag / resolveCredentialTypeTag', () => {
  it('PascalCases a free-form label and appends Credential', () => {
    expect(deriveCustomTypeTag('volunteer of the year')).toBe('VolunteerOfTheYearCredential');
  });

  it('does not double-append Credential', () => {
    expect(deriveCustomTypeTag('Award Credential')).toBe('AwardCredential');
  });

  it('returns empty for a blank custom label', () => {
    expect(deriveCustomTypeTag('   ')).toBe('');
  });

  it('resolves a fixed preset to its tag', () => {
    expect(resolveCredentialTypeTag('employment', '')).toBe('EmploymentCredential');
    expect(resolveCredentialTypeTag('membership', '')).toBe('MembershipCredential');
  });

  it('resolves custom to the derived tag, or null when the label is empty', () => {
    expect(resolveCredentialTypeTag('custom', 'Award')).toBe('AwardCredential');
    expect(resolveCredentialTypeTag('custom', '')).toBeNull();
  });

  it('exposes the four presets in order', () => {
    expect(CREDENTIAL_PRESETS.map((p) => p.id)).toEqual([
      'employment',
      'course',
      'membership',
      'custom',
    ]);
  });
});

describe('claimEntries', () => {
  it('humanizes keys and stringifies values, dropping empties', () => {
    const entries = claimEntries({
      employerName: 'Acme',
      yearsWorked: 4,
      remote: true,
      blank: '',
      missing: null,
    });
    expect(entries).toEqual([
      { key: 'employerName', label: 'Employer Name', value: 'Acme' },
      { key: 'yearsWorked', label: 'Years Worked', value: '4' },
      { key: 'remote', label: 'Remote', value: 'true' },
    ]);
  });

  it('renders a free-text statement claim', () => {
    expect(claimEntries({ statement: 'Met the bar' })).toEqual([
      { key: 'statement', label: 'Statement', value: 'Met the bar' },
    ]);
  });
});

describe('getCredentialStatusMeta', () => {
  it.each([
    ['active', 'positive'],
    ['revoked', 'danger'],
    ['expired', 'caution'],
  ] as const)('maps %s → %s tone', (status, tone) => {
    const meta = getCredentialStatusMeta(status);
    expect(meta.tone).toBe(tone);
    expect(meta.labelKey).toBe(status);
  });
});

describe('canRevokeCredential', () => {
  it('allows the original issuer of an active credential', () => {
    expect(canRevokeCredential(makeCredential(), 'issuer')).toBe(true);
  });

  it('denies a non-issuer (e.g. the holder)', () => {
    expect(canRevokeCredential(makeCredential(), 'holder')).toBe(false);
  });

  it('denies when the viewer id is unknown', () => {
    expect(canRevokeCredential(makeCredential(), null)).toBe(false);
  });

  it('denies a non-active credential even for the issuer', () => {
    expect(canRevokeCredential(makeCredential({ status: 'revoked' }), 'issuer')).toBe(false);
    expect(canRevokeCredential(makeCredential({ status: 'expired' }), 'issuer')).toBe(false);
  });

  it('denies an org-issued credential (no issuerUserId)', () => {
    expect(canRevokeCredential(makeCredential({ issuerUserId: undefined }), 'issuer')).toBe(false);
  });
});

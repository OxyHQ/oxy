/**
 * Unit tests for the dependency-free application-scope authority
 * (`utils/applicationScopes.ts`).
 *
 * The two pure reconcilers under test are the single source of truth for how an
 * application's granted scopes flow into a service token:
 *
 *   - `intersectScopes` — effective credential scopes = credential ∩ app scopes.
 *     A credential can never exceed its app's grant.
 *   - `unionValidScopes` — additive rebuild of an app's scopes from a canonical
 *     (declarative) list. Guards the ROOT CAUSE that dropped Mention's granted,
 *     in-use `signals:write`: a destructive `application.scopes = seedScopes`
 *     rebuild silently revoked an out-of-band grant, and because the mint
 *     intersects credential ∩ app scopes, the credential lost it too.
 */

import {
  intersectScopes,
  unionValidScopes,
  isPaymentsScope,
  isPrivilegedScope,
  isUserConsentRequiredScope,
  isValidApplicationScope,
  userConsentRequiredScopes,
  PAYMENTS_APPLICATION_SCOPES,
  PRIVILEGED_APPLICATION_SCOPES,
  USER_CONSENT_REQUIRED_SCOPES,
} from '../applicationScopes';

describe('intersectScopes (credential ∩ app grant)', () => {
  it('keeps only scopes present on both sides, preserving credential order', () => {
    expect(
      intersectScopes(['signals:write', 'user:read'], ['user:read', 'files:write', 'signals:write'])
    ).toEqual(['signals:write', 'user:read']);
  });

  it('drops a credential scope the app no longer grants', () => {
    // Exactly the failure mode: the app lost signals:write, so the mint drops it.
    expect(intersectScopes(['signals:write', 'user:read'], ['user:read', 'files:write'])).toEqual([
      'user:read',
    ]);
  });

  it('drops unknown scopes and de-duplicates', () => {
    expect(
      intersectScopes(['user:read', 'user:read', 'bogus:scope'], ['user:read', 'bogus:scope'])
    ).toEqual(['user:read']);
  });
});

describe('unionValidScopes (additive canonical rebuild)', () => {
  it('preserves an already-granted scope the canonical list omits', () => {
    // The seed's canonical Mention list historically omitted signals:write; the
    // union must NOT revoke the already-granted, in-use scope.
    expect(
      unionValidScopes(
        ['user:read', 'files:write', 'federation:write'],
        ['user:read', 'files:write', 'federation:write', 'signals:write']
      )
    ).toEqual(['user:read', 'files:write', 'federation:write', 'signals:write']);
  });

  it('adds scopes newly declared in the canonical list', () => {
    expect(unionValidScopes(['user:read', 'files:read'], ['user:read'])).toEqual([
      'user:read',
      'files:read',
    ]);
  });

  it('orders canonical scopes first, then extra granted scopes, de-duplicated', () => {
    expect(
      unionValidScopes(['user:read', 'files:write'], ['signals:write', 'user:read'])
    ).toEqual(['user:read', 'files:write', 'signals:write']);
  });

  it('drops unknown/legacy stored scopes that can never survive a mint', () => {
    expect(unionValidScopes(['user:read'], ['user:read', 'legacy:scope'])).toEqual(['user:read']);
  });

  it('returns the canonical set when there is nothing extra granted', () => {
    expect(unionValidScopes(['user:read', 'files:write'], [])).toEqual(['user:read', 'files:write']);
  });

  it('is a no-op fixed point once the canonical list already contains the grant', () => {
    const canonical = ['user:read', 'files:read', 'files:write', 'federation:write', 'signals:write'];
    expect(unionValidScopes(canonical, canonical)).toEqual(canonical);
  });
});

describe('scope classification helpers', () => {
  it('recognises signals:write as a valid privileged scope', () => {
    expect(isValidApplicationScope('signals:write')).toBe(true);
    expect(isPrivilegedScope('signals:write')).toBe(true);
  });

  /**
   * `accounts:provision` mints accounts under, and grants membership to, users
   * OTHER THAN the caller — an application acting for someone it names, with no
   * bearer of theirs involved. That is authority beyond the app's own tenant, so
   * it must never become self-grantable by an ordinary app owner.
   *
   * Deliberately argued from what the scope DOES, not from it being the only way
   * to create a channel: a user creating one under their own account with their
   * own bearer needs no scope at all, and pinning the rationale to that would
   * make this comment false the moment that route changes.
   */
  it('recognises accounts:provision as a valid privileged scope', () => {
    expect(isValidApplicationScope('accounts:provision')).toBe(true);
    expect(isPrivilegedScope('accounts:provision')).toBe(true);
  });

  it('treats a plain read scope as valid but not privileged', () => {
    expect(isValidApplicationScope('files:read')).toBe(true);
    expect(isPrivilegedScope('files:read')).toBe(false);
  });

  it('rejects an unknown scope', () => {
    expect(isValidApplicationScope('bogus:scope')).toBe(false);
    expect(isPrivilegedScope('bogus:scope')).toBe(false);
  });
});

describe('payments:read / payments:write (F2.0)', () => {
  it('are recognised, non-privileged application scopes', () => {
    expect(isValidApplicationScope('payments:read')).toBe(true);
    expect(isValidApplicationScope('payments:write')).toBe(true);
    expect(isPrivilegedScope('payments:read')).toBe(false);
    expect(isPrivilegedScope('payments:write')).toBe(false);
  });

  it('survive intersectScopes like any other non-privileged scope', () => {
    expect(intersectScopes(['payments:write'], ['payments:write', 'user:read'])).toEqual([
      'payments:write',
    ]);
  });

  it('classifies only the Oxy Pay gateway scopes via isPaymentsScope', () => {
    expect(PAYMENTS_APPLICATION_SCOPES).toEqual(['payments:read', 'payments:write']);
    expect(isPaymentsScope('payments:read')).toBe(true);
    expect(isPaymentsScope('payments:write')).toBe(true);
    expect(isPaymentsScope('user:read')).toBe(false);
    expect(isPaymentsScope('federation:write')).toBe(false);
    expect(isPaymentsScope('bogus:scope')).toBe(false);
  });
});

describe('user-consent scopes: the user grants them, the platform never assumes them', () => {
  /*
   * Written out rather than derived from the constant. Iterating
   * `USER_CONSENT_REQUIRED_SCOPES` to check facts ABOUT it proves nothing:
   * deleting a member makes such a loop iterate less and pass — verified by
   * mutation, which is how this list came to be here.
   */
  const MUST_BE_CONSENTED = [
    'follows:read',
    'follows:write',
    'follows:context:write',
    'follows:manage',
    'follows:events',
    'follow-targets:register',
    'chains:write',
  ] as const;

  it('holds exactly the user-authority scopes, and loses none of them silently', () => {
    expect([...USER_CONSENT_REQUIRED_SCOPES].sort()).toEqual([...MUST_BE_CONSENTED].sort());
  });

  it('treats every one of them as consent-required', () => {
    for (const scope of MUST_BE_CONSENTED) {
      expect(isUserConsentRequiredScope(scope)).toBe(true);
      expect(userConsentRequiredScopes(['user:read', scope])).toEqual([scope]);
    }
  });

  it('recognises every consent-required scope as a valid application scope', () => {
    for (const scope of MUST_BE_CONSENTED) {
      expect(isValidApplicationScope(scope)).toBe(true);
    }
  });

  it('keeps follow scopes OUT of the privileged set', () => {
    // Privileged asks "may the app's owner grant this to themselves?" and its
    // answer is about platform staff. A follow scope's authority comes from the
    // subject user, so staff-gating it would be answering the wrong question —
    // and would block a third-party app the user genuinely authorized.
    for (const scope of MUST_BE_CONSENTED.filter((scope) => scope !== 'chains:write')) {
      expect(isPrivilegedScope(scope)).toBe(false);
    }
  });

  it('requires both staff approval and user consent for chains:write', () => {
    expect(isPrivilegedScope('chains:write')).toBe(true);
    expect(isUserConsentRequiredScope('chains:write')).toBe(true);
  });

  it('does not require user consent for the other privileged scopes', () => {
    for (const scope of PRIVILEGED_APPLICATION_SCOPES.filter((scope) => scope !== 'chains:write')) {
      expect(isUserConsentRequiredScope(scope)).toBe(false);
    }
  });

  it('returns WHICH scopes forced the prompt, not merely that one did', () => {
    // The consent screen has to name what it is asking about; a boolean cannot
    // produce "this app wants to manage who you follow".
    expect(userConsentRequiredScopes(['user:read', 'follows:write', 'files:read'])).toEqual([
      'follows:write',
    ]);
  });

  it('says nothing is required when nothing in the request touches the user graph', () => {
    expect(userConsentRequiredScopes(['user:read', 'files:read'])).toEqual([]);
    expect(userConsentRequiredScopes([])).toEqual([]);
  });

  it('is blind to the application asking — that is the entire point', () => {
    // Same requested scopes must produce the same answer for an official app
    // and a third-party one. The function takes no application at all, which is
    // how that is guaranteed rather than remembered.
    expect(userConsentRequiredScopes.length).toBe(1);
  });
});

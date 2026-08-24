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
  isFollowScope,
  isPaymentsScope,
  isPrivilegedScope,
  isUserConsentRequiredScope,
  isValidApplicationScope,
  userConsentRequiredScopes,
  FOLLOW_APPLICATION_SCOPES,
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

describe('the inference scope family (#972 workstream 3)', () => {
  /*
   * Written out rather than derived from `APPLICATION_SCOPES`, for the reason
   * the follow-scope block below records: a loop over the constant checking
   * facts ABOUT the constant iterates less and still passes when a member is
   * deleted. These names are the contract, so they are spelled here.
   */
  const SELF_GRANTABLE = [
    'inference:invoke',
    'inference:models:read',
    'inference:usage:read',
    'inference:routing:read',
    'inference:providers:read',
  ] as const;

  const STAFF_ONLY = ['inference:routing:write', 'inference:providers:write'] as const;

  /** Removed outright by this change — no alias, no grace, no sunset date. */
  const RETIRED = ['chat:completions', 'models:read'] as const;

  it('recognises every one of the seven inference scopes', () => {
    for (const scope of [...SELF_GRANTABLE, ...STAFF_ONLY]) {
      expect(isValidApplicationScope(scope)).toBe(true);
    }
  });

  it('no longer recognises `chat:completions` or `models:read`', () => {
    for (const scope of RETIRED) {
      expect(isValidApplicationScope(scope)).toBe(false);
      expect(isPrivilegedScope(scope)).toBe(false);
    }
    // Positive control: the validator can still say yes. Without this, a
    // validator that had broken into answering `false` for EVERYTHING would
    // pass the two assertions above and read as a successful retirement.
    expect(isValidApplicationScope('user:read')).toBe(true);
    expect(isValidApplicationScope('inference:invoke')).toBe(true);
  });

  it('staff-gates the two WRITES and leaves the reads and the invoke self-grantable', () => {
    // The asymmetry is the decision: describing where a request would go is not
    // deciding it, and both writes reach catalogue objects the platform serves
    // every tenant from — see the doc comment on PRIVILEGED_APPLICATION_SCOPES.
    for (const scope of STAFF_ONLY) {
      expect(isPrivilegedScope(scope)).toBe(true);
    }
    for (const scope of SELF_GRANTABLE) {
      expect(isPrivilegedScope(scope)).toBe(false);
    }
  });

  it('asks the user to consent to none of them', () => {
    // A different axis: the billing principal on an inference request is the
    // application's OWNER ACCOUNT, never a delegated end user, so no inference
    // scope reaches the user's own data or the user's own money.
    for (const scope of [...SELF_GRANTABLE, ...STAFF_ONLY]) {
      expect(isUserConsentRequiredScope(scope)).toBe(false);
    }
    expect(userConsentRequiredScopes([...SELF_GRANTABLE, ...STAFF_ONLY])).toEqual([]);
    // Positive control on the same call: the function is still capable of
    // returning something.
    expect(userConsentRequiredScopes(['inference:invoke', 'follows:read'])).toEqual([
      'follows:read',
    ]);
  });

  it('strips `inference:providers:write` from a credential whose application lacks it', () => {
    // The escalation this exists to refuse: a credential names the staff-gated
    // provider/BYOK write, its application was never granted it, so the mint
    // hands back an authority the app does not hold — unless intersectScopes
    // drops it, which is the single authority both the credential-create
    // validation and the service-token mint go through.
    expect(
      intersectScopes(
        ['inference:invoke', 'inference:providers:write'],
        ['inference:invoke', 'inference:providers:read']
      )
    ).toEqual(['inference:invoke']);
  });

  it('keeps `inference:providers:write` when the application genuinely holds it', () => {
    // The other direction, so the assertion above is about the INTERSECTION and
    // not about this scope being unmintable.
    expect(
      intersectScopes(['inference:providers:write'], ['user:read', 'inference:providers:write'])
    ).toEqual(['inference:providers:write']);
  });

  it('drops a retired name from BOTH reconcilers, even when both sides still name it', () => {
    // A stored row that predates the migration cannot resurrect the scope: the
    // vocabulary check runs on every path, not only on freshly-requested input.
    expect(intersectScopes([...RETIRED], [...RETIRED])).toEqual([]);
    expect(unionValidScopes([...RETIRED], ['user:read', ...RETIRED])).toEqual(['user:read']);
  });
});

describe('follow scopes: the user grants them, the platform never assumes them', () => {
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
  ] as const;

  it('holds the whole follow family, and loses none of it silently', () => {
    expect([...FOLLOW_APPLICATION_SCOPES].sort()).toEqual([...MUST_BE_CONSENTED].sort());
    for (const scope of MUST_BE_CONSENTED) {
      expect([...USER_CONSENT_REQUIRED_SCOPES]).toContain(scope);
    }
  });

  it('is no longer ONLY the follow family, and the difference is deliberate', () => {
    // Spelled out rather than asserted as a count. The consent-required set now
    // has two members that are not follow scopes, and each is here for a stated
    // reason — so an accidental third addition fails this, and a deliberate one
    // is a line someone has to write.
    const CONSENT_REQUIRED_BEYOND_FOLLOWS = ['acting-as:offline', 'podcasts:write'] as const;
    expect([...USER_CONSENT_REQUIRED_SCOPES].sort()).toEqual(
      [...MUST_BE_CONSENTED, ...CONSENT_REQUIRED_BEYOND_FOLLOWS].sort()
    );
  });

  it('does NOT treat every consent-required scope as a follow scope', () => {
    // `assertFollowScopes` guards the follow authorization path, and it once
    // asked `isUserConsentRequiredScope` because the two sets were identical.
    // The moment they stopped being identical that guard began admitting scopes
    // from other domains while still reading as if it checked something. This is
    // the assertion that would have caught it.
    expect(isFollowScope('acting-as:offline')).toBe(false);
    expect(isFollowScope('podcasts:write')).toBe(false);
    expect(isUserConsentRequiredScope('acting-as:offline')).toBe(true);
    expect(isUserConsentRequiredScope('podcasts:write')).toBe(true);
    for (const scope of MUST_BE_CONSENTED) {
      expect(isFollowScope(scope)).toBe(true);
    }
  });

  it('treats every one of them as consent-required', () => {
    for (const scope of MUST_BE_CONSENTED) {
      expect(isUserConsentRequiredScope(scope)).toBe(true);
      expect(userConsentRequiredScopes(['user:read', scope])).toEqual([scope]);
    }
  });

  it('recognises the whole family as valid application scopes', () => {
    for (const scope of MUST_BE_CONSENTED) {
      expect(isValidApplicationScope(scope)).toBe(true);
    }
  });

  it('keeps them OUT of the privileged set', () => {
    // Privileged asks "may the app's owner grant this to themselves?" and its
    // answer is about platform staff. A follow scope's authority comes from the
    // subject user, so staff-gating it would be answering the wrong question —
    // and would block a third-party app the user genuinely authorized.
    for (const scope of MUST_BE_CONSENTED) {
      expect(isPrivilegedScope(scope)).toBe(false);
    }
  });

  it('lets the two sets overlap only where BOTH questions were deliberately answered', () => {
    // The sets ask different questions — "may the owner grant this to
    // themselves?" and "may the platform decide for the user?" — so an overlap
    // is legal, and for `acting-as:offline` it is the design: staff decide
    // whether an application may ever ASK to act as a user, and the user decides
    // whether it may act as THEM. Neither gate substitutes for the other.
    //
    // Every other overlap is still a mistake, so the exception is named rather
    // than the assertion dropped. Written as a literal, because deriving the
    // expected set from the constants under test would make any edit agree with
    // itself.
    const DELIBERATELY_BOTH = ['acting-as:offline'];
    const overlap = PRIVILEGED_APPLICATION_SCOPES.filter((scope) =>
      isUserConsentRequiredScope(scope)
    );

    expect([...overlap].sort()).toEqual([...DELIBERATELY_BOTH].sort());
  });

  it('keeps the FOLLOW family out of the privileged set, whatever else overlaps', () => {
    // The original property, preserved. A follow scope's authority comes from
    // the subject user, so staff-gating one would answer the wrong question and
    // block a third-party app the user genuinely authorized.
    for (const scope of MUST_BE_CONSENTED) {
      expect(isPrivilegedScope(scope)).toBe(false);
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

/**
 * `resolveEffectivePermissions` — the ONE place a role baseline and a member's
 * own grants/revokes become a permission set.
 *
 * Every account authorization decision reads its output, so the cases below are
 * chosen to distinguish it from the implementations it could plausibly be
 * mistaken for: a role-only lookup, a union that forgets revokes, a revoke that
 * loses to a grant, and a pass-through that would let a retired vocabulary entry
 * keep granting.
 */

import {
  ACCOUNT_PERMISSIONS,
  APPLICATION_PERMISSIONS,
  ROLE_PERMISSIONS,
  appPermissionsForAccountAccess,
  isAccountPermission,
  permissionsForAccountRole,
  resolveEffectivePermissions,
  type AccountPermission,
  type AccountRole,
} from '../accountRoles';

const ACCOUNT_ROLE_NAMES = Object.keys(ROLE_PERMISSIONS) as AccountRole[];

/** The access shape a route hands the derivation, built from a role + deltas. */
function accessWith(
  role: AccountRole,
  deltas: { grants?: AccountPermission[]; revokes?: AccountPermission[] } = {}
) {
  return {
    role,
    permissions: resolveEffectivePermissions(role, deltas.grants ?? [], deltas.revokes ?? []),
  };
}

describe('resolveEffectivePermissions', () => {
  test('with no deltas it is exactly the role baseline', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      expect(resolveEffectivePermissions(role, [], []).sort()).toEqual(
        permissionsForAccountRole(role).sort()
      );
    }
  });

  test('a grant adds a permission the role does not carry', () => {
    // `developer` genuinely lacks `members:read` — asserted rather than assumed,
    // because if the baseline ever gained it this test would pass while testing
    // nothing.
    expect(permissionsForAccountRole('developer')).not.toContain('members:read');

    const effective = resolveEffectivePermissions('developer', ['members:read'], []);
    expect(effective).toContain('members:read');
    // Everything the role already carried survives the addition.
    for (const permission of permissionsForAccountRole('developer')) {
      expect(effective).toContain(permission);
    }
  });

  test('a revoke removes a permission the role does carry', () => {
    expect(permissionsForAccountRole('editor')).toContain('account:act_as');

    expect(resolveEffectivePermissions('editor', [], ['account:act_as'])).not.toContain(
      'account:act_as'
    );
  });

  test('a revoke beats a grant naming the same permission', () => {
    // The safe reading of a contradiction is the narrower one. A union-then-add
    // implementation would return it.
    expect(
      resolveEffectivePermissions('viewer', ['account:delete'], ['account:delete'])
    ).not.toContain('account:delete');
  });

  test('a grant outside the current vocabulary is inert', () => {
    // The failure this guards is a permission RETIRED from ACCOUNT_PERMISSIONS
    // while rows still name it. Stored strings are never scrubbed, so the read
    // path is the only thing standing between a retired string and a live grant.
    const effective = resolveEffectivePermissions('viewer', ['account:retired_capability'], []);
    expect(effective).not.toContain('account:retired_capability');
    expect(effective).toEqual(permissionsForAccountRole('viewer'));
  });

  test('a revoke outside the current vocabulary removes nothing', () => {
    expect(resolveEffectivePermissions('admin', [], ['account:retired_capability'])).toEqual(
      resolveEffectivePermissions('admin', [], [])
    );
  });

  test('every returned permission is in the vocabulary, in declaration order', () => {
    const effective = resolveEffectivePermissions(
      'viewer',
      ['ownership:transfer', 'account:act_as', 'not-a-permission'],
      []
    );
    for (const permission of effective) {
      expect(isAccountPermission(permission)).toBe(true);
    }
    // Ordering is the vocabulary's, not the caller's — so the wire value is
    // deterministic for a given input regardless of what order a client sent.
    const indices = effective.map((permission) => ACCOUNT_PERMISSIONS.indexOf(permission));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('duplicates in a delta list collapse', () => {
    expect(
      resolveEffectivePermissions('viewer', ['account:act_as', 'account:act_as'], [])
    ).toEqual(resolveEffectivePermissions('viewer', ['account:act_as'], []));
  });
});

/**
 * `appPermissionsForAccountAccess` — the ONE bridge between the account and
 * application vocabularies (issue #978).
 *
 * The cases distinguish it from the implementation it replaced (a role-only
 * lookup that could not see a delta at all) and from the two ways a correction
 * could overshoot: narrowing members who carry NO delta, and letting a broader
 * counterpart confer more than it contains.
 */
describe('appPermissionsForAccountAccess', () => {
  test('a member with no deltas is unchanged from the role baseline, for every role', () => {
    // The load-bearing property. The two role maps disagree in places (an
    // account `editor` holds `billing:read`, an application `editor` does not),
    // and this function must not quietly reconcile them: a member who was never
    // adjusted has to get exactly what they got before this existed.
    const baselineByRole: Record<AccountRole, string[]> = {
      owner: [...APPLICATION_PERMISSIONS],
      admin: [
        'app:read',
        'app:update',
        'app:delete',
        'members:read',
        'members:invite',
        'members:update',
        'members:remove',
        'credentials:read',
        'credentials:create',
        'credentials:rotate',
        'credentials:revoke',
        'webhooks:read',
        'webhooks:update',
        'usage:read',
        'billing:read',
        'updates:manage',
      ],
      editor: [
        'app:read',
        'app:update',
        'members:read',
        'credentials:read',
        'webhooks:read',
        'webhooks:update',
        'usage:read',
      ],
      developer: [
        'app:read',
        'credentials:read',
        'credentials:create',
        'credentials:rotate',
        'credentials:revoke',
        'webhooks:read',
        'webhooks:update',
        'usage:read',
        'updates:manage',
      ],
      billing: ['app:read', 'usage:read', 'billing:read', 'billing:manage'],
      viewer: ['app:read', 'members:read', 'usage:read'],
    };

    for (const role of ACCOUNT_ROLE_NAMES) {
      expect(appPermissionsForAccountAccess(accessWith(role)).sort()).toEqual(
        baselineByRole[role].sort()
      );
    }
  });

  test('a REVOKE removes the application permission its counterpart answers for', () => {
    // Non-vacuity: the role has to carry both sides, or the assertion below is
    // about a permission nobody had.
    expect(permissionsForAccountRole('admin')).toContain('credentials:rotate');
    expect(appPermissionsForAccountAccess(accessWith('admin'))).toContain('credentials:rotate');

    const revoked = appPermissionsForAccountAccess(
      accessWith('admin', { revokes: ['credentials:rotate'] })
    );
    expect(revoked).not.toContain('credentials:rotate');
    // Surgical: only the revoked power goes.
    expect(revoked).toContain('credentials:create');
    expect(revoked).toContain('credentials:revoke');
  });

  test('the two vocabularies spell the same power differently, and the revoke still lands', () => {
    // `app:update` is `apps:update` on the account side. A derivation matching
    // on the STRING rather than through the counterpart map would miss this one,
    // which is the whole reason the map exists.
    expect(ACCOUNT_PERMISSIONS).not.toContain('app:update');
    expect(APPLICATION_PERMISSIONS).not.toContain('apps:update');

    expect(
      appPermissionsForAccountAccess(accessWith('admin', { revokes: ['apps:update'] }))
    ).not.toContain('app:update');
  });

  test('revoking a BROADER counterpart withdraws everything it contains', () => {
    // `apps:update` contains `app:update`, `webhooks:update` and
    // `updates:manage` — publishing an OTA update replaces the app's code.
    const revoked = appPermissionsForAccountAccess(
      accessWith('admin', { revokes: ['apps:update'] })
    );
    expect(revoked).not.toContain('app:update');
    expect(revoked).not.toContain('webhooks:update');
    expect(revoked).not.toContain('updates:manage');
    // And nothing that answers to a DIFFERENT counterpart moves.
    expect(revoked).toContain('app:read');
    expect(revoked).toContain('app:delete');
    expect(revoked).toContain('credentials:rotate');
  });

  test('a GRANT adds the application permissions its counterpart answers for', () => {
    expect(permissionsForAccountRole('viewer')).not.toContain('credentials:read');
    expect(appPermissionsForAccountAccess(accessWith('viewer'))).not.toContain('credentials:read');

    expect(
      appPermissionsForAccountAccess(accessWith('viewer', { grants: ['credentials:read'] }))
    ).toContain('credentials:read');
  });

  test('a revoke of something the role never had changes nothing', () => {
    expect(permissionsForAccountRole('viewer')).not.toContain('billing:manage');
    expect(
      appPermissionsForAccountAccess(accessWith('viewer', { revokes: ['billing:manage'] }))
    ).toEqual(appPermissionsForAccountAccess(accessWith('viewer')));
  });

  test('a revoke beats a grant here too, because the account lane resolved it first', () => {
    // This function never sees the raw columns — it reads what
    // `resolveEffectivePermissions` already decided, so the two lanes cannot
    // disagree about a contradictory row.
    expect(
      appPermissionsForAccountAccess(
        accessWith('admin', { grants: ['credentials:rotate'], revokes: ['credentials:rotate'] })
      )
    ).not.toContain('credentials:rotate');
  });

  test('the result is in vocabulary declaration order, whatever the deltas', () => {
    const permissions = appPermissionsForAccountAccess(
      accessWith('viewer', { grants: ['ownership:transfer', 'apps:update'] })
    );
    const indices = permissions.map((permission) => APPLICATION_PERMISSIONS.indexOf(permission));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices).not.toContain(-1);
  });
});

describe('isAccountPermission', () => {
  test('accepts every declared permission and nothing else', () => {
    for (const permission of ACCOUNT_PERMISSIONS) {
      expect(isAccountPermission(permission)).toBe(true);
    }
    expect(isAccountPermission('account:moderate')).toBe(false);
    expect(isAccountPermission('')).toBe(false);
    // Neither a prefix nor a superstring of a real permission passes.
    expect(isAccountPermission('account')).toBe(false);
    expect(isAccountPermission('account:read:all')).toBe(false);
  });
});

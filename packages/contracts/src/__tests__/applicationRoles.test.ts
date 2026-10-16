import {
  APPLICATION_PERMISSIONS_MAX_DECLARED,
  applicationPermissionKeySchema,
  applicationRolesMeSchema,
  createApplicationRoleGrantRequestSchema,
  declareApplicationPermissionsRequestSchema,
  isApplicationPermissionKey,
  listApplicationRoleGrantsQuerySchema,
} from '../applicationRoles';

describe('application permission keys', () => {
  it.each([
    'payments.operate',
    'catalog.operate',
    'guest.operate',
    'catalog.review.publish',
    'a.b.c.d',
    'trust_safety.moderate',
    'v2.read',
  ])('accepts %s', (key) => {
    expect(applicationPermissionKeySchema.safeParse(key).success).toBe(true);
    expect(isApplicationPermissionKey(key)).toBe(true);
  });

  it.each([
    // Oxy's own vocabulary is colon-spelled; an app key never can be.
    'app:update',
    'payments:operate',
    'inference:byok:write',
    // One segment names no action.
    'payments',
    // Case, leading digits, empty or trailing segments, too many segments.
    'Payments.operate',
    'payments.Operate',
    '1payments.operate',
    'payments..operate',
    'payments.operate.',
    '.payments.operate',
    'a.b.c.d.e',
    'payments.operate ',
    'payments-desk.operate',
    '',
    `${'a'.repeat(40)}.${'b'.repeat(30)}`,
  ])('refuses %j', (key) => {
    expect(applicationPermissionKeySchema.safeParse(key).success).toBe(false);
    expect(isApplicationPermissionKey(key)).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isApplicationPermissionKey(42)).toBe(false);
    expect(isApplicationPermissionKey(null)).toBe(false);
  });
});

describe('declaring a vocabulary', () => {
  it('accepts an empty declaration (retire everything)', () => {
    expect(declareApplicationPermissionsRequestSchema.parse({ permissions: [] })).toEqual({
      permissions: [],
    });
  });

  it('refuses a duplicate key, naming its index', () => {
    const result = declareApplicationPermissionsRequestSchema.safeParse({
      permissions: [
        { key: 'payments.operate', description: 'Run the payments desk' },
        { key: 'payments.operate', description: 'Again' },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['permissions', 1, 'key']);
  });

  it('refuses more than the per-application ceiling', () => {
    const permissions = Array.from(
      { length: APPLICATION_PERMISSIONS_MAX_DECLARED + 1 },
      (_, i) => ({
        key: `area${i}.operate`,
        description: 'x',
      }),
    );
    expect(declareApplicationPermissionsRequestSchema.safeParse({ permissions }).success).toBe(
      false,
    );
  });

  it('refuses control characters and unknown fields', () => {
    expect(
      declareApplicationPermissionsRequestSchema.safeParse({
        permissions: [{ key: 'payments.operate', description: 'bad\u0000text' }],
      }).success,
    ).toBe(false);
    expect(
      declareApplicationPermissionsRequestSchema.safeParse({
        permissions: [{ key: 'payments.operate', description: 'ok', grantedTo: ['u1'] }],
      }).success,
    ).toBe(false);
  });
});

describe('granting', () => {
  it('names the grantee with exactly one of userId or username', () => {
    expect(
      createApplicationRoleGrantRequestSchema.safeParse({
        userId: 'u1',
        permission: 'payments.operate',
      }).success,
    ).toBe(true);
    expect(
      createApplicationRoleGrantRequestSchema.safeParse({
        username: 'nate',
        permission: 'payments.operate',
      }).success,
    ).toBe(true);
    expect(
      createApplicationRoleGrantRequestSchema.safeParse({ permission: 'payments.operate' }).success,
    ).toBe(false);
    expect(
      createApplicationRoleGrantRequestSchema.safeParse({
        userId: 'u1',
        username: 'nate',
        permission: 'payments.operate',
      }).success,
    ).toBe(false);
  });

  it('parses the list query, coercing limit and the revoked flag', () => {
    expect(
      listApplicationRoleGrantsQuerySchema.parse({ limit: '20', includeRevoked: 'true' }),
    ).toEqual({ limit: 20, includeRevoked: true });
    expect(listApplicationRoleGrantsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listApplicationRoleGrantsQuerySchema.safeParse({ sort: 'asc' }).success).toBe(false);
  });
});

describe('roles/me', () => {
  it('refuses a malformed key in the answer', () => {
    expect(
      applicationRolesMeSchema.safeParse({
        applicationId: 'app',
        userId: 'u1',
        permissions: ['app:update'],
      }).success,
    ).toBe(false);
  });
});

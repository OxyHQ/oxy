import { publicApplicationSchema, sessionStatusSchema, safeParseContract } from '../index';

/**
 * The canonical contract MUST accept exactly what the API's
 * `GET /auth/session/status/:sessionToken` handler emits.
 *
 * Drift bug: the auth app's LOCAL `sessionStatusSchema` typed `sessionId` as a
 * non-nullable `z.string().optional()`. The producer emits
 * `sessionId: authorizedSessionId || null`, so a PENDING session carries
 * `sessionId: null`. `.optional()` REJECTS `null`, so `safeParse` failed, the
 * whole response collapsed to `null`, and the consent UI showed "Unable to
 * identify the requesting application". These tests reproduce and lock out that
 * drift at the contract level.
 */
describe('sessionStatusSchema', () => {
  it('accepts the PENDING payload (sessionId/publicKey/userId all null) and yields the application', () => {
    const pending = {
      status: 'pending',
      authorized: false,
      sessionToken: 'at_random_4e9c2a1b8e9d3f4a1c2b3d4',
      application: {
        id: '64f7c2a1b8e9d3f4a1c2b3d4',
        name: 'Oxy Accounts',
        type: 'first_party',
        isOfficial: true,
        isInternal: false,
        scopes: ['user:read'],
      },
      expiresAt: '2025-05-25T12:39:56.000Z',
      sessionId: null,
      publicKey: null,
      userId: null,
    };

    const parsed = safeParseContract(sessionStatusSchema, pending);
    expect(parsed).not.toBeNull();
    // The exact bug this guards: the whole payload must NOT collapse to null
    // just because the not-yet-authorized fields are null.
    expect(parsed?.application?.name).toBe('Oxy Accounts');
    expect(parsed?.application?.type).toBe('first_party');
    expect(parsed?.sessionId).toBeNull();
    expect(parsed?.publicKey).toBeNull();
    expect(parsed?.userId).toBeNull();
  });

  it('accepts the AUTHORIZED variant (string ids, third-party app with developerName)', () => {
    const authorized = {
      status: 'authorized',
      authorized: true,
      sessionToken: 'at_random_4e9c2a1b8e9d3f4a1c2b3d4',
      application: {
        id: '64f7c2a1b8e9d3f4a1c2b3d4',
        name: 'Acme Widgets',
        type: 'third_party',
        isOfficial: false,
        isInternal: false,
        scopes: ['files:read', 'user:read'],
        websiteUrl: 'https://acme.example',
        developerName: 'Ada Lovelace',
      },
      expiresAt: '2025-05-25T12:39:56.000Z',
      sessionId: 'sess_64f7c2a1b8e9d3f4a1c2b3d4',
      publicKey: '02a1b2c3d4e5f6',
      userId: '64f7c2a1b8e9d3f4a1c2b3d4',
    };

    const parsed = safeParseContract(sessionStatusSchema, authorized);
    expect(parsed).not.toBeNull();
    expect(parsed?.authorized).toBe(true);
    expect(parsed?.sessionId).toBe('sess_64f7c2a1b8e9d3f4a1c2b3d4');
    expect(parsed?.application?.developerName).toBe('Ada Lovelace');
    expect(parsed?.application?.websiteUrl).toBe('https://acme.example');
  });

  it('accepts a null application (bound app hard-deleted / inactive)', () => {
    const parsed = safeParseContract(sessionStatusSchema, {
      status: 'pending',
      authorized: false,
      sessionToken: 'tok',
      application: null,
      expiresAt: '2025-05-25T12:39:56.000Z',
      sessionId: null,
      publicKey: null,
      userId: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.application).toBeNull();
  });

  it('rejects a malformed payload (missing required status)', () => {
    const parsed = safeParseContract(sessionStatusSchema, {
      authorized: false,
      sessionToken: 'tok',
      application: null,
      sessionId: null,
    });
    expect(parsed).toBeNull();
  });

  it('rejects a malformed payload (wrong type — status as a number)', () => {
    const parsed = safeParseContract(sessionStatusSchema, {
      status: 200,
      authorized: false,
    });
    expect(parsed).toBeNull();
  });
});

describe('publicApplicationSchema', () => {
  it('accepts a minimal official app (no optional display fields)', () => {
    const parsed = safeParseContract(publicApplicationSchema, {
      id: '64f7c2a1b8e9d3f4a1c2b3d4',
      name: 'Oxy Accounts',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      scopes: ['user:read'],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.description).toBeUndefined();
    expect(parsed?.developerName).toBeUndefined();
  });

  it('rejects an unknown application type', () => {
    const parsed = safeParseContract(publicApplicationSchema, {
      id: 'x',
      name: 'Bad',
      type: 'fourth_party',
      isOfficial: false,
      isInternal: false,
      scopes: [],
    });
    expect(parsed).toBeNull();
  });

  it('rejects an application missing a required field (scopes)', () => {
    const parsed = safeParseContract(publicApplicationSchema, {
      id: 'x',
      name: 'NoScopes',
      type: 'internal',
      isOfficial: false,
      isInternal: true,
    });
    expect(parsed).toBeNull();
  });
});

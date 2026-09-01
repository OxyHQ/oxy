/**
 * OAuth2 Authorization Code Service against a REAL Postgres (H6 regression
 * coverage).
 *
 * Exercises:
 *  - happy-path issuance and exchange (PKCE and confidential client variants)
 *  - rejection of replayed codes (single-use guarantee)
 *  - rejection of expired codes
 *  - rejection of mismatched redirectUri / appId / PKCE verifier
 *  - rejection of public clients that present neither secret nor PKCE
 *  - the code id RESERVATION the OAuth-bound AuthSession finalize depends on
 *
 * The suite this replaces mocked `models/AuthCode` with an in-memory `Map`
 * whose `findOneAndUpdate` reimplemented the single-use claim in JavaScript —
 * so the replay test proved that the MOCK was single-use, never that the store
 * was. Here the claim is the real conditional `update ... where used_at is
 * null` and the row is read back.
 *
 * Every test mints its own user and application, so no assertion depends on a
 * table being empty: the suite shares one database with the rest of the run and
 * `auth_codes` carries real foreign keys.
 */

import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { authCodes } from '../../db/schema/authCodes';
import { users } from '../../db/schema/users';
import { base64UrlEncode, exchangeAuthCode, issueAuthCode } from '../oauthCode.service';

const REDIRECT_URI = 'https://app.example/callback';

let USER_ID = '';
let APP_ID = '';

/** A personal `users` row. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A registered application owned by a fresh account. */
async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: 'Acme Widgets',
      ownerAccountId: await account(),
      redirectUris: [REDIRECT_URI],
    })
    .returning({ id: applications.id });
  return row.id;
}

/** The stored row for a raw code, addressed the way the service addresses it. */
async function storedFor(rawCode: string) {
  const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  const [row] = await getDb()
    .select({
      id: authCodes.id,
      codeHash: authCodes.codeHash,
      userId: authCodes.userId,
      applicationId: authCodes.applicationId,
      redirectUri: authCodes.redirectUri,
      codeChallenge: authCodes.codeChallenge,
      codeChallengeMethod: authCodes.codeChallengeMethod,
      scopes: authCodes.scopes,
      deviceId: authCodes.deviceId,
      operatedByUserId: authCodes.operatedByUserId,
      usedAt: authCodes.usedAt,
      expiresAt: authCodes.expiresAt,
    })
    .from(authCodes)
    .where(eq(authCodes.codeHash, codeHash))
    .limit(1);
  return row ?? null;
}

function makePkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

beforeAll(async () => {
  await connectPostgres();
  USER_ID = await account();
  APP_ID = await application();
});

afterAll(async () => {
  await closePostgres();
});

describe('issueAuthCode', () => {
  it('returns a 256-bit base64url code and persists only the hash', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    expect(code).toEqual(expect.any(String));
    expect(code.length).toBeGreaterThanOrEqual(42);

    const stored = await storedFor(code);
    expect(stored).not.toBeNull();
    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.codeHash).not.toBe(code); // raw code never persisted

    // No row holds the raw code as its own verifier either.
    const [rawMatch] = await getDb()
      .select({ id: authCodes.id })
      .from(authCodes)
      .where(eq(authCodes.codeHash, code))
      .limit(1);
    expect(rawMatch).toBeUndefined();
  });

  it('persists deviceId when provided at issue time', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      deviceId: 'shared-device-1',
    });

    expect((await storedFor(code))?.deviceId).toBe('shared-device-1');
  });

  it('stores NULL — never an empty string — for an absent PKCE challenge', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const stored = await storedFor(code);
    // `auth_codes_pkce_pair_check` asserts challenge and method are both
    // present or both absent; `''` is a VALUE that satisfies "present" while
    // verifying nothing, so the distinction is load-bearing rather than tidy.
    expect(stored?.codeChallenge).toBeNull();
    expect(stored?.codeChallengeMethod).toBeNull();
  });

  it('uses a caller-RESERVED code id, so a spent request cannot mint a second code', async () => {
    // The OAuth-bound AuthSession finalize allocates the id inside the same
    // atomic update that spends the request, then hands it here.
    const codeId = uuidv7();

    const { code } = await issueAuthCode({
      codeId,
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    expect((await storedFor(code))?.id).toBe(codeId);
  });

  it('records the OPERATOR of a delegated grant separately from the subject', async () => {
    const operatorId = await account();

    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      operatedByUserId: operatorId,
    });

    const stored = await storedFor(code);
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.operatedByUserId).toBe(operatorId);
  });
});

describe('exchangeAuthCode (H6 — single-use, binding checks)', () => {
  it('rejects an unknown code', async () => {
    const res = await exchangeAuthCode({
      rawCode: 'nope',
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_grant');
  });

  it('succeeds for a confidential-client (no PKCE) exchange', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code.userId).toBe(USER_ID);
      expect(res.code.usedAt).toBeInstanceOf(Date);
    }

    // The claim is PERSISTED, not just reported.
    expect((await storedFor(code))?.usedAt).toBeInstanceOf(Date);
  });

  it('rejects a public client (no PKCE, no client secret)', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_client');

    // A refused exchange must not spend the code.
    expect((await storedFor(code))?.usedAt).toBeNull();
  });

  it('accepts a PKCE exchange with the correct verifier', async () => {
    const { verifier, challenge } = makePkcePair();
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a PKCE exchange with a tampered verifier', async () => {
    const { challenge } = makePkcePair();
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: 'attacker-controlled-verifier-with-wrong-value',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_grant');
    expect((await storedFor(code))?.usedAt).toBeNull();
  });

  it('rejects when the redirectUri does not match', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: 'https://evil.example/callback',
      clientSecretProvided: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_grant');
  });

  it('accepts apex origin with or without a trailing slash', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: 'https://inbox.oxy.so/',
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: 'https://inbox.oxy.so',
      clientSecretProvided: true,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects when the appId does not match', async () => {
    const otherApp = await application();
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: otherApp,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: true,
    });
    expect(res.ok).toBe(false);
  });

  it('rejects replay: second exchange of the same code fails', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const first = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: true,
    });
    expect(first.ok).toBe(true);

    const second = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: true,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('invalid_grant');
  });

  it('lets exactly ONE of two concurrent exchanges win', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
    });

    const exchange = () =>
      exchangeAuthCode({
        rawCode: code,
        appId: APP_ID,
        redirectUri: REDIRECT_URI,
        clientSecretProvided: true,
      });

    // Both racers pass every binding check and reach the claim together; only
    // the conditional `where used_at is null` separates them. A JavaScript-side
    // "read, then write" — which is what the mocked store used to be — lets
    // both through here.
    const [a, b] = await Promise.all([exchange(), exchange()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('rejects an expired code', async () => {
    const { code } = await issueAuthCode({
      userId: USER_ID,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      ttlMs: 10,
    });

    // Wait past TTL.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await exchangeAuthCode({
      rawCode: code,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      clientSecretProvided: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_grant');

    // The ROW is still there. `auth_codes` keeps a 300s retention pad past
    // `expires_at` precisely so a replay of a just-expired code is recognised
    // as a replay rather than answering "no such code"; deleting on the
    // deadline would silently turn one into the other.
    expect(await storedFor(code)).not.toBeNull();
  });
});

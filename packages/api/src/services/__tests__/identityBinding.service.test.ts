/**
 * Identity binding — the primitive "no binding proof, no effect" rests on,
 * against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **A moderation decision must still be applicable for an account created after
 * the Postgres cutover.**
 *
 * The code this replaces guarded every id with
 * `mongoose.Types.ObjectId.isValid`, and `resolveBindingProof` opened with
 *
 * ```ts
 * if (!mongoose.Types.ObjectId.isValid(params.bindingProofId)) {
 *   return { ok: false, reason: 'no_binding_proof' };
 * }
 * ```
 *
 * Every row created since the cutover carries a **uuid v7** id
 * (`@oxyhq/db`'s `generatedId()`), which that regex rejects — so for a
 * post-cutover binding the answer was `no_binding_proof` BEFORE ANY QUERY RAN,
 * and `applyModerationDecision` could apply nothing at all, however real the
 * stored binding. It fails silently by construction: `no_binding_proof` is a
 * legitimate outcome an emitter is meant to record and stop retrying on, so it
 * looks exactly like a genuine miss.
 *
 * The previous suite could not have caught it. It replaced both models with an
 * in-memory store keyed on `new Types.ObjectId()`, so every id in it was 24-hex
 * by construction and the guard was unreachable. Here the ids are the ones the
 * schema actually mints, the bindings are real rows, and the first case asserts
 * they are NOT 24-hex so nothing can pass vacuously. Reinstate either guard and
 * `resolves a binding stored for a post-cutover account` goes red.
 *
 * ## What is still mocked, and why
 *
 * `validateSessionToken` only. It is the existing session layer with its own
 * tests, and what matters here is that a FAILED proof produces no binding at
 * all. Everything else — the grant lookup, the partial unique index, the
 * revoked-at CHECK, the foreign keys — is the real database.
 *
 * The two properties that carry the most weight, and neither is obvious from
 * reading the code:
 *
 *  - `verifiedAt` IS DERIVED, NEVER ACCEPTED. An application cannot make its
 *    binding look older than its evidence, because the only two sources are an
 *    `app_grants` row Oxy itself wrote and the current clock.
 *  - A REFRESH NEVER MOVES `verifiedAt` FORWARD. Re-registering must not
 *    retroactively invalidate the reported actions the original binding already
 *    covered — a subtle way to lose the ability to penalise a real offence by
 *    doing something entirely routine.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const mockValidateSessionToken = jest.fn();
jest.mock('../../middleware/authUtils', () => ({
  validateSessionToken: (...args: unknown[]) => mockValidateSessionToken(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { identityBindings } from '../../db/schema/identityBindings';
import { users } from '../../db/schema/users';
import { registerIdentityBinding, resolveBindingProof } from '../identityBinding.service';

const GRANT_AT = new Date('2026-01-01T00:00:00.000Z');
const ACTION_AT = new Date('2026-06-01T00:00:00.000Z');

let APP_ID: string;
let OTHER_APP_ID: string;
let USER_ID: string;
let OTHER_USER_ID: string;
let CREDENTIAL_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertCredential(applicationId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'service',
      type: 'service',
      environment: 'production',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
    })
    .returning({ id: applicationCredentials.id });
  return row.id;
}

/** Oxy's own record of consent, which the service prefers over the clock. */
async function seedGrant(userId: string, applicationId: string, firstGrantedAt: Date): Promise<void> {
  await getDb().insert(appGrants).values({ userId, applicationId, firstGrantedAt });
}

/** Every binding row for one application + local principal, revoked ones included. */
async function storedBindings(applicationId: string, localPrincipalId: string) {
  return getDb()
    .select()
    .from(identityBindings)
    .where(
      and(
        eq(identityBindings.applicationId, applicationId),
        eq(identityBindings.localPrincipalId, localPrincipalId)
      )
    );
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  // Fresh rows per case: the partial unique index is real here, so a leftover
  // ACTIVE binding from a previous case would decide the next one.
  USER_ID = await insertUser();
  OTHER_USER_ID = await insertUser();
  APP_ID = await insertApplication(USER_ID);
  OTHER_APP_ID = await insertApplication(USER_ID);
  CREDENTIAL_ID = await insertCredential(APP_ID);
  mockValidateSessionToken.mockResolvedValue({ _id: USER_ID });
});

describe('the id format must not decide whether a binding resolves', () => {
  it('mints application, account and binding ids the deleted 24-hex guard would have rejected', async () => {
    // The premise every case below rests on. Without it, reinstating either
    // guard would leave this suite green and prove nothing.
    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    const hex24 = /^[0-9a-f]{24}$/i;
    expect(APP_ID).not.toMatch(hex24);
    expect(USER_ID).not.toMatch(hex24);
    expect(binding.id).not.toMatch(hex24);
  });

  it('resolves a binding stored for a post-cutover account — the decision is applicable', async () => {
    await seedGrant(USER_ID, APP_ID, GRANT_AT);
    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: binding.id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    // The guard answered `no_binding_proof` here without querying, so
    // `applyModerationDecision` skipped the effect entirely.
    expect(result).toEqual({ ok: true, binding: expect.objectContaining({ id: binding.id }) });
  });

  it('registers a binding for a post-cutover application without rejecting its id', async () => {
    // `toObjectId(params.applicationId, 'applicationId')` threw a 400 here: the
    // service credential resolves a real, uuid-v7 application id, and the guard
    // called it malformed.
    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      credentialId: CREDENTIAL_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(binding.applicationId).toBe(APP_ID);
    expect(binding.userId).toBe(USER_ID);
    expect(binding.credentialId).toBe(CREDENTIAL_ID);
  });
});

describe('registerIdentityBinding', () => {
  it('refuses to create anything when the user proof does not resolve', async () => {
    mockValidateSessionToken.mockResolvedValue(null);

    await expect(
      registerIdentityBinding({
        applicationId: APP_ID,
        localPrincipalId: 'local-1',
        userProofToken: 'garbage',
      })
    ).rejects.toThrow(/user proof token/i);

    expect(await storedBindings(APP_ID, 'local-1')).toHaveLength(0);
  });

  it("prefers Oxy's own consent record over the current moment", async () => {
    // An `app_grants` row predates the registration call and the application
    // asserted none of it, so it is both stronger evidence and covers more of
    // the past.
    await seedGrant(USER_ID, APP_ID, GRANT_AT);

    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      credentialId: CREDENTIAL_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(binding.bindingType).toBe('oauth_grant');
    expect(binding.verifiedAt).toEqual(GRANT_AT);
  });

  it("does not borrow another application's grant", async () => {
    // The grant lookup is scoped to (user, application); a grant for a different
    // application must not backdate this binding.
    await seedGrant(USER_ID, OTHER_APP_ID, GRANT_AT);
    const before = Date.now();

    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(binding.bindingType).toBe('session_proof');
    expect(binding.verifiedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('falls back to a session proof when no grant exists', async () => {
    // Trusted first-party applications are auto-approved at authorize time and
    // record NO grant. Without this path, the applications closest to Oxy would
    // be the only ones unable to prove anything.
    const before = Date.now();

    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(binding.bindingType).toBe('session_proof');
    expect(binding.verifiedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a refresh never moves verifiedAt forward', async () => {
    // Re-registering must not retroactively invalidate the reported actions the
    // original binding already covered.
    await seedGrant(USER_ID, APP_ID, GRANT_AT);
    const first = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });
    expect(first.verifiedAt).toEqual(GRANT_AT);

    // Now the grant is gone (revoked and re-consented, say) so the only
    // available proof is "now" — which must NOT overwrite the earlier instant.
    await getDb().delete(appGrants).where(eq(appGrants.userId, USER_ID));
    const refreshed = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.verifiedAt).toEqual(GRANT_AT);
    expect(refreshed.bindingType).toBe('oauth_grant');
    expect(await storedBindings(APP_ID, 'local-1')).toHaveLength(1);
  });

  it('a refresh DOES take an earlier instant when one appears', async () => {
    const first = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });
    expect(first.bindingType).toBe('session_proof');

    // A grant older than the session proof is strictly better evidence: it is
    // Oxy's own record and covers more of the past.
    await seedGrant(USER_ID, APP_ID, GRANT_AT);
    const refreshed = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.verifiedAt).toEqual(GRANT_AT);
    expect(refreshed.bindingType).toBe('oauth_grant');
  });

  it('rebinding a local principal to a different person revokes rather than overwrites', async () => {
    // A past effect references the old row, and its original `verifiedAt` is
    // what made that effect legitimate — so the row has to survive.
    const first = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    mockValidateSessionToken.mockResolvedValue({ _id: OTHER_USER_ID });
    const second = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid-other',
    });

    expect(second.id).not.toBe(first.id);
    expect(second.userId).toBe(OTHER_USER_ID);

    const rows = await storedBindings(APP_ID, 'local-1');
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => row.id === first.id);
    expect(old?.status).toBe('revoked');
    // `status` and `revoked_at` move together or the row fails the
    // `identity_bindings_revoked_at_check` CHECK — Mongo could express neither
    // half, so a row could read `active` while carrying a `revokedAt`.
    expect(old?.revokedAt).toBeInstanceOf(Date);
    expect(old?.verifiedAt).toEqual(first.verifiedAt);
  });

  it('leaves exactly one ACTIVE binding per (application, local principal)', async () => {
    await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });
    mockValidateSessionToken.mockResolvedValue({ _id: OTHER_USER_ID });
    await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid-other',
    });

    const active = (await storedBindings(APP_ID, 'local-1')).filter((row) => row.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].userId).toBe(OTHER_USER_ID);
  });

  it('trims the local principal id, so one person cannot become two bindings', async () => {
    // Mongoose declared the field `trim: true`, which applied to BOTH the write
    // and the query filter it cast. Postgres has no counterpart, so the
    // normalization is re-applied at the call site — otherwise a trailing space
    // creates a SECOND active binding and the partial unique index, which sees
    // two different strings, does not object.
    const first = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });
    const second = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: '  local-1  ',
      userProofToken: 'valid',
    });

    expect(second.id).toBe(first.id);
    expect(second.localPrincipalId).toBe('local-1');
    expect(await storedBindings(APP_ID, 'local-1')).toHaveLength(1);
  });

  it('keeps bindings for the same local principal in different applications apart', async () => {
    const here = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });
    const there = await registerIdentityBinding({
      applicationId: OTHER_APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });

    expect(there.id).not.toBe(here.id);
    expect((await storedBindings(APP_ID, 'local-1'))[0].status).toBe('active');
    expect((await storedBindings(OTHER_APP_ID, 'local-1'))[0].status).toBe('active');
  });
});

describe('resolveBindingProof', () => {
  /** An active binding verified at `GRANT_AT`, before the reported action. */
  async function seedBinding(): Promise<string> {
    await seedGrant(USER_ID, APP_ID, GRANT_AT);
    const binding = await registerIdentityBinding({
      applicationId: APP_ID,
      localPrincipalId: 'local-1',
      userProofToken: 'valid',
    });
    return binding.id;
  }

  it('accepts a binding that was verified before the action', async () => {
    const id = await seedBinding();

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result.ok).toBe(true);
  });

  it('accepts a binding verified at exactly the moment of the action', async () => {
    // "At or before" — the boundary is inclusive, because a binding established
    // during the reported action is a valid proof of presence.
    const id = await seedBinding();
    await getDb()
      .update(identityBindings)
      .set({ verifiedAt: ACTION_AT })
      .where(eq(identityBindings.id, id));

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a binding verified one millisecond after the action', async () => {
    const id = await seedBinding();
    await getDb()
      .update(identityBindings)
      .set({ verifiedAt: new Date(ACTION_AT.getTime() + 1) })
      .where(eq(identityBindings.id, id));

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'binding_after_action' });
  });

  it('rejects a binding that resolves to another person', async () => {
    const id = await seedBinding();

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: id,
      principalId: OTHER_USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'binding_principal_mismatch' });
  });

  it('rejects a revoked binding', async () => {
    const id = await seedBinding();
    await getDb()
      .update(identityBindings)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(identityBindings.id, id));

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'binding_revoked' });
  });

  it("does not find another application's binding", async () => {
    // Scoped lookup: an emitter cannot borrow a proof from a tenant it does not
    // speak for, and from that application's perspective there IS no such binding.
    const id = await seedBinding();

    const result = await resolveBindingProof({
      applicationId: OTHER_APP_ID,
      bindingProofId: id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'no_binding_proof' });
  });

  it('rejects a malformed binding id without throwing', async () => {
    // No shape precheck any more: the id is a bound parameter against a `text`
    // column, so a malformed value is a value that matches no row — the same
    // outcome the deleted guard produced, reached by querying rather than by
    // guessing at the string.
    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: 'not-an-object-id',
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'no_binding_proof' });
  });

  it('rejects a malformed APPLICATION id without throwing', async () => {
    // `toObjectId(params.applicationId, …)` threw a `BadRequestError` from
    // inside a resolver whose whole contract is to return a rejection.
    const id = await seedBinding();

    const result = await resolveBindingProof({
      applicationId: 'not-an-object-id',
      bindingProofId: id,
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'no_binding_proof' });
  });

  it('rejects a malformed PRINCIPAL id as a mismatch rather than throwing', async () => {
    const id = await seedBinding();

    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: id,
      principalId: 'not-an-object-id',
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'binding_principal_mismatch' });
  });

  it('rejects a well-formed binding id that does not exist', async () => {
    const result = await resolveBindingProof({
      applicationId: APP_ID,
      bindingProofId: randomUUID(),
      principalId: USER_ID,
      occurredAt: ACTION_AT,
    });

    expect(result).toEqual({ ok: false, reason: 'no_binding_proof' });
  });
});

/**
 * Present-requester assertions (ADR 0025): the authority logic, against
 * explicit fakes of the platform state it reads.
 *
 * Every refusal the ADR names has its own case. The positive path is asserted
 * once per half; everything else is a way the lane must NOT open: a product that
 * is not a pinned entry point, a binding that lost its authority, the retired
 * Sindi credential, a bearer
 * that is forged, revoked or belongs to another application, an account that
 * was archived, and an assertion that is replayed, redirected or stretched.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { signOxyRequesterAssertion } from '@oxy.so/core/server';
import {
  ALIA_RESOURCE_SERVER_APPLICATION_ID,
  NATIVE_PRODUCT_AGENTS,
} from '../../config/nativeProductAgents';
import { createMemoryRequesterAssertionStore } from '../nativeRequesterAssertion.runtime';
import {
  introspectRequesterAssertion,
  mintRequesterAssertion,
  type LiveSession,
  type LiveWorkloadPrincipal,
  type RequesterAssertionDependencies,
  type RequesterAssertionStore,
  type ValidatedSubjectSession,
} from '../nativeRequesterAssertion.service';
import { workloadAttestationHandle } from '../workloadAttestation.service';

jest.mock('../../config/redis', () => ({ getRedisClient: () => null }));

const HOMIIO = NATIVE_PRODUCT_AGENTS.products.homiio;
const APP = HOMIIO.applicationId;
/**
 * The RETIRED Sindi service credential. Nothing may enter the lane under it:
 * the entry point admits only the Homiio workload.
 */
const RETIRED_CREDENTIAL = HOMIIO.sindiServiceCredential.id;
const AGENT = HOMIIO.aliaAgent.id;
/**
 * The product backend, proving itself by attesting its ECS task role (ADR
 * 0026). The role is what the entry point declares; the handle is derived,
 * exactly as the mint derives it.
 */
const HOMIIO_ROLE = 'arn:aws:iam::237343248947:role/oxy-homiio-task';
const HANDLE = workloadAttestationHandle(HOMIIO_ROLE);
/** A real, valid handle for a DIFFERENT first-party service (`oxy-mention-task`). */
const OTHER_HANDLE = workloadAttestationHandle('arn:aws:iam::237343248947:role/oxy-mention-task');
const USER = '6981c9178fcdefaf81988ffb';
const SESSION = 'session-1';
const HUMAN_BEARER = 'human-access-token';
const ISSUER = 'https://api.oxy.so';
const KEY = generateKeyPairSync('ed25519');
const KEY_ID = 'cap-test';

interface World {
  now: Date;
  /** Binding rows, keyed `applicationId:provider:subject`. */
  workloads: Map<string, LiveWorkloadPrincipal>;
  bearers: Map<string, ValidatedSubjectSession>;
  sessions: Map<string, LiveSession>;
  store: RequesterAssertionStore;
  signingBroken: boolean;
}

function world(): World {
  const now = new Date('2026-09-17T12:00:00.000Z');
  return {
    now,
    workloads: new Map([
      [
        `${APP}:aws-iam:${HOMIIO_ROLE}`,
        {
          applicationId: APP,
          handle: HANDLE,
          scopes: ['inference:invoke', 'acting-as:offline'],
        },
      ],
    ]),
    bearers: new Map([
      [
        HUMAN_BEARER,
        {
          sessionId: SESSION,
          subjectAccountId: USER,
          applicationId: null,
          accountStatus: 'active',
        },
      ],
    ]),
    sessions: new Map([
      [
        SESSION,
        {
          sessionId: SESSION,
          accountId: USER,
          applicationId: null,
          accountStatus: 'active',
        },
      ],
    ]),
    store: createMemoryRequesterAssertionStore(() => now.getTime()),
    signingBroken: false,
  };
}

function deps(state: World): RequesterAssertionDependencies {
  return {
    issuer: ISSUER,
    now: () => state.now,
    signing: () => {
      if (state.signingBroken)
        throw new Error('CAPABILITY_TICKET_SIGNING_KEY_ID is not configured');
      return { keyId: KEY_ID, privateKey: KEY.privateKey, publicKey: KEY.publicKey };
    },
    resolveWorkloadPrincipal: async (applicationId, provider, subject) =>
      state.workloads.get(`${applicationId}:${provider}:${subject}`) ?? null,
    validateSubjectToken: async (token) => state.bearers.get(token) ?? null,
    loadLiveSession: async (sessionId) => state.sessions.get(sessionId) ?? null,
    store: state.store,
  };
}

/** What Homiio's attested service token carries. */
const caller = {
  applicationId: APP,
  credentialId: HANDLE,
  scopes: ['inference:invoke', 'acting-as:offline'],
};
const presenter = { applicationId: APP, credentialId: HANDLE };

async function mint(
  state: World,
  overrides: Partial<Parameters<typeof mintRequesterAssertion>[1]> = {},
) {
  return mintRequesterAssertion(deps(state), {
    caller,
    agentId: AGENT,
    subjectToken: HUMAN_BEARER,
    ...overrides,
  });
}

async function introspect(
  state: World,
  assertion: string,
  overrides: Partial<Parameters<typeof introspectRequesterAssertion>[1]> = {},
) {
  return introspectRequesterAssertion(deps(state), {
    callerApplicationId: ALIA_RESOURCE_SERVER_APPLICATION_ID,
    audienceApplicationId: ALIA_RESOURCE_SERVER_APPLICATION_ID,
    assertion,
    presenter,
    ...overrides,
  });
}

async function mintedAssertion(state: World): Promise<string> {
  const result = await mint(state);
  if (!result.ok) throw new Error(`mint refused: ${result.reason}`);
  return result.assertion;
}

describe('mintRequesterAssertion', () => {
  it('issues a 120-second assertion bound to requester, presenter and agent, with no session id or bearer inside', async () => {
    const state = world();
    const result = await mint(state);
    expect(result).toMatchObject({ ok: true, requesterAccountId: USER, agentId: AGENT });
    if (!result.ok) return;
    const payload = JSON.parse(
      Buffer.from(result.assertion.split('.')[1] as string, 'base64url').toString('utf8'),
    );
    expect(payload).toMatchObject({
      iss: ISSUER,
      aud: 'alia',
      sub: USER,
      azp: APP,
      cid: HANDLE,
      agentId: AGENT,
    });
    expect(payload.exp - payload.iat).toBe(120);
    expect(result.assertion).not.toContain(SESSION);
    expect(JSON.stringify(payload)).not.toContain(HUMAN_BEARER);
    expect(JSON.stringify(payload)).not.toContain(SESSION);
  });

  it('accepts a session bound to the calling application itself', async () => {
    const state = world();
    state.bearers.set(HUMAN_BEARER, { ...state.bearers.get(HUMAN_BEARER)!, applicationId: APP });
    state.sessions.set(SESSION, { ...state.sessions.get(SESSION)!, applicationId: APP });
    expect((await mint(state)).ok).toBe(true);
  });

  it.each([
    [
      'another official application',
      { applicationId: '6a2f851751b784a86fd0e934', credentialId: HANDLE },
    ],
    [
      'another credential of the same application',
      { applicationId: APP, credentialId: 'other-credential' },
    ],
    /**
     * The key pair Sindi's backend used before it attested. It is retired, and
     * the entry point no longer names it at all — so it is refused here, before
     * any liveness question, rather than by whatever state its row is in.
     */
    ['the retired Sindi credential', { applicationId: APP, credentialId: RETIRED_CREDENTIAL }],
  ])('refuses %s: only the pinned entry point may mint', async (_label, identity) => {
    const state = world();
    expect(await mint(state, { caller: { ...caller, ...identity } })).toEqual({
      ok: false,
      reason: 'unknown_entry_point',
    });
  });

  it("refuses an agent that is not the entry point's own agent", async () => {
    const state = world();
    expect(
      await mint(state, { agentId: NATIVE_PRODUCT_AGENTS.products.clarity.aliaAgent.id }),
    ).toEqual({ ok: false, reason: 'unknown_entry_point' });
  });

  it('refuses when the service token lacks inference:invoke', async () => {
    const state = world();
    expect(await mint(state, { caller: { ...caller, scopes: ['acting-as:offline'] } })).toEqual({
      ok: false,
      reason: 'missing_inference_scope',
    });
  });

  it('refuses a forged, expired or unknown bearer', async () => {
    const state = world();
    expect(await mint(state, { subjectToken: 'forged.jwt.value' })).toEqual({
      ok: false,
      reason: 'subject_session_invalid',
    });
  });

  it('refuses a session that was revoked after the per-task cache last saw it', async () => {
    const state = world();
    state.sessions.delete(SESSION);
    expect(await mint(state)).toEqual({ ok: false, reason: 'subject_session_not_live' });
  });

  it('refuses a session another application owns (a third-party OAuth bearer)', async () => {
    const state = world();
    state.bearers.set(HUMAN_BEARER, {
      ...state.bearers.get(HUMAN_BEARER)!,
      applicationId: 'third-party-app',
    });
    expect(await mint(state)).toEqual({ ok: false, reason: 'subject_session_other_application' });
  });

  it('refuses an archived account', async () => {
    const state = world();
    state.bearers.set(HUMAN_BEARER, {
      ...state.bearers.get(HUMAN_BEARER)!,
      accountStatus: 'archived',
    });
    expect(await mint(state)).toEqual({ ok: false, reason: 'subject_account_inactive' });
  });

  /**
   * The handle is DERIVED from the one declared role, so the prefix authorises
   * nothing. `wl_d61be5…` is Mention's real, live handle — a value an attacker
   * holding a valid Mention token genuinely has.
   */
  it.each([
    ["another service's real, valid handle", OTHER_HANDLE],
    ['a wl_-shaped value that is nobody', 'wl_000000000000000000000000'],
    ['the Homiio handle one character off', `${HANDLE.slice(0, -1)}0`],
  ])('refuses an attested caller that is %s', async (_label, credentialId) => {
    const state = world();
    expect(await mint(state, { caller: { ...caller, credentialId } })).toEqual({
      ok: false,
      reason: 'unknown_entry_point',
    });
  });

  /**
   * The binding row is the live ceiling, so an attested token is not the one
   * bearer a staff revocation fails to reach.
   */
  it('refuses an attested caller whose binding was deleted, expired or re-pointed', async () => {
    const state = world();
    state.workloads.clear();
    expect(await mint(state)).toEqual({
      ok: false,
      reason: 'service_principal_not_live',
    });
  });

  it('refuses an attested caller whose binding no longer names inference:invoke', async () => {
    const state = world();
    state.workloads.set(`${APP}:aws-iam:${HOMIIO_ROLE}`, {
      applicationId: APP,
      handle: HANDLE,
      scopes: ['acting-as:offline'],
    });
    expect(await mint(state)).toEqual({
      ok: false,
      reason: 'missing_inference_scope',
    });
  });

  it('fails closed without a signing key or a replay store', async () => {
    const broken = world();
    broken.signingBroken = true;
    expect(await mint(broken)).toEqual({ ok: false, reason: 'signing_unavailable' });

    const noStore = world();
    noStore.store = {
      put: async () => ({ status: 'unavailable' }),
      take: async () => ({ status: 'unavailable' }),
    };
    expect(await mint(noStore)).toEqual({ ok: false, reason: 'replay_store_unavailable' });
  });
});

describe('introspectRequesterAssertion', () => {
  it('answers active exactly once for the audience, then treats a replay as inactive', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    expect(await introspect(state, assertion)).toMatchObject({
      active: true,
      requesterAccountId: USER,
      agentId: AGENT,
      applicationId: APP,
      credentialId: HANDLE,
    });
    expect(await introspect(state, assertion)).toEqual({
      active: false,
      reason: 'not_found_or_replayed',
    });
  });

  it('lets only the audience application consume', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    expect(await introspect(state, assertion, { callerApplicationId: APP })).toEqual({
      active: false,
      reason: 'caller_not_audience',
    });
    // Not spent by the refused caller.
    expect((await introspect(state, assertion)).active).toBe(true);
  });

  it('refuses a presenter other than the application and credential it was minted for, without spending it', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    expect(
      await introspect(state, assertion, {
        presenter: { applicationId: 'other-app', credentialId: HANDLE },
      }),
    ).toEqual({ active: false, reason: 'presenter_mismatch' });
    expect(
      await introspect(state, assertion, {
        presenter: { applicationId: APP, credentialId: 'other-credential' },
      }),
    ).toEqual({ active: false, reason: 'presenter_mismatch' });
    expect((await introspect(state, assertion)).active).toBe(true);
  });

  it('refuses a forged signature, a foreign key id and a tampered payload', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    const other = generateKeyPairSync('ed25519');
    const payload = JSON.parse(
      Buffer.from(assertion.split('.')[1] as string, 'base64url').toString('utf8'),
    );
    const forged = signOxyRequesterAssertion(payload, {
      keyId: KEY_ID,
      privateKey: other.privateKey,
    });
    expect(await introspect(state, forged)).toEqual({ active: false, reason: 'invalid_signature' });
    const foreignKid = signOxyRequesterAssertion(payload, {
      keyId: 'someone-elses-kid',
      privateKey: KEY.privateKey,
    });
    expect(await introspect(state, foreignKid)).toEqual({ active: false, reason: 'unknown_key' });
    const [header, , signature] = assertion.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...payload, sub: 'victim' })).toString(
      'base64url',
    );
    expect(await introspect(state, `${header}.${tampered}.${signature}`)).toEqual({
      active: false,
      reason: 'invalid_signature',
    });
  });

  it('refuses an assertion signed for another audience or with no server-side record', async () => {
    const state = world();
    const iat = Math.floor(state.now.getTime() / 1000);
    const base = {
      iss: ISSUER,
      sub: USER,
      jti: randomUUID(),
      iat,
      exp: iat + 120,
      azp: APP,
      cid: HANDLE,
      agentId: AGENT,
    };
    const wrongAudience = signOxyRequesterAssertion(
      { ...base, aud: 'syra' },
      { keyId: KEY_ID, privateKey: KEY.privateKey },
    );
    expect(await introspect(state, wrongAudience)).toEqual({
      active: false,
      reason: 'wrong_audience',
    });
    // Validly signed (a leaked signing key, say) but never minted: no record.
    const neverMinted = signOxyRequesterAssertion(
      { ...base, aud: 'alia' },
      { keyId: KEY_ID, privateKey: KEY.privateKey },
    );
    expect(await introspect(state, neverMinted)).toEqual({
      active: false,
      reason: 'not_found_or_replayed',
    });
  });

  it('refuses an expired assertion', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.now = new Date(state.now.getTime() + 121_000);
    expect(await introspect(state, assertion)).toEqual({ active: false, reason: 'expired' });
  });

  it('refuses a wrong-agent assertion even when correctly signed', async () => {
    const state = world();
    const iat = Math.floor(state.now.getTime() / 1000);
    const otherAgent = signOxyRequesterAssertion(
      {
        iss: ISSUER,
        aud: 'alia',
        sub: USER,
        jti: randomUUID(),
        iat,
        exp: iat + 120,
        azp: APP,
        cid: HANDLE,
        agentId: 'not-sindi',
      },
      { keyId: KEY_ID, privateKey: KEY.privateKey },
    );
    expect(await introspect(state, otherAgent)).toEqual({
      active: false,
      reason: 'unknown_entry_point',
    });
  });

  it('refuses when the person signed out or the session was revoked between mint and use', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.sessions.delete(SESSION);
    expect(await introspect(state, assertion)).toEqual({
      active: false,
      reason: 'session_not_live',
    });
  });

  it('refuses when the account was archived between mint and use', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.sessions.set(SESSION, { ...state.sessions.get(SESSION)!, accountStatus: 'archived' });
    expect(await introspect(state, assertion)).toEqual({
      active: false,
      reason: 'account_inactive',
    });
  });

  /**
   * mint → replay store → introspect, all the way round on the attested path.
   * `cid` is the handle at every hop, which is what makes the presenter check
   * in `@oxy.so/core`'s `requesterAssertion.ts` (`claims.cid !==
   * serviceApp.credentialId`) pass for a presenter that has no credential.
   */
  it('round-trips an attested assertion: the handle is the cid, the record and the answer', async () => {
    const state = world();
    const minted = await mint(state);
    if (!minted.ok) throw new Error(`mint refused: ${minted.reason}`);
    const result = await introspect(state, minted.assertion);
    expect(result).toMatchObject({
      active: true,
      requesterAccountId: USER,
      agentId: AGENT,
      applicationId: APP,
      credentialId: HANDLE,
    });
    expect(await introspect(state, minted.assertion)).toEqual({
      active: false,
      reason: 'not_found_or_replayed',
    });
  });

  it('refuses an attested assertion presented under the retired credential id', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    expect(
      await introspect(state, assertion, {
        presenter: { applicationId: APP, credentialId: RETIRED_CREDENTIAL },
      }),
    ).toEqual({ active: false, reason: 'presenter_mismatch' });
  });

  /**
   * An assertion naming the retired credential — validly signed, presented by
   * that credential, with a record behind it — is refused at the entry point:
   * the credential is no longer a proof of anything here.
   */
  it('refuses an assertion minted for the retired credential, even with a record behind it', async () => {
    const state = world();
    const iat = Math.floor(state.now.getTime() / 1000);
    const claims = {
      iss: ISSUER,
      aud: 'alia',
      sub: USER,
      jti: randomUUID(),
      iat,
      exp: iat + 120,
      azp: APP,
      cid: RETIRED_CREDENTIAL,
      agentId: AGENT,
    };
    await state.store.put(
      claims.jti,
      {
        sessionId: SESSION,
        requesterAccountId: USER,
        applicationId: APP,
        credentialId: RETIRED_CREDENTIAL,
        agentId: AGENT,
      },
      120,
    );
    const assertion = signOxyRequesterAssertion(claims, {
      keyId: KEY_ID,
      privateKey: KEY.privateKey,
    });
    expect(
      await introspect(state, assertion, {
        presenter: { applicationId: APP, credentialId: RETIRED_CREDENTIAL },
      }),
    ).toEqual({ active: false, reason: 'unknown_entry_point' });
  });

  it('refuses an attested assertion when the binding lost its authority between mint and use', async () => {
    const state = world();
    const minted = await mint(state);
    if (!minted.ok) throw new Error(`mint refused: ${minted.reason}`);
    state.workloads.clear();
    expect(await introspect(state, minted.assertion)).toEqual({
      active: false,
      reason: 'service_principal_not_live',
    });
  });

  it('fails closed when the replay store cannot answer', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.store = { put: state.store.put, take: async () => ({ status: 'unavailable' }) };
    expect(await introspect(state, assertion)).toEqual({
      active: false,
      reason: 'replay_store_unavailable',
    });
  });

  it('lets only one of two concurrent presentations through', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    const results = await Promise.all([introspect(state, assertion), introspect(state, assertion)]);
    expect(results.filter((result) => result.active)).toHaveLength(1);
  });
});

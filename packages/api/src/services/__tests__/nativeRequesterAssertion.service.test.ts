/**
 * Present-requester assertions (ADR 0025): the authority logic, against
 * explicit fakes of the platform state it reads.
 *
 * Every refusal the ADR names has its own case. The positive path is asserted
 * once per half; everything else is a way the lane must NOT open: a product that
 * is not a pinned entry point, a credential that lost its authority, a bearer
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
  type LiveServicePrincipal,
  type RequesterAssertionDependencies,
  type RequesterAssertionStore,
  type ValidatedSubjectSession,
} from '../nativeRequesterAssertion.service';

jest.mock('../../config/redis', () => ({ getRedisClient: () => null }));

const HOMIIO = NATIVE_PRODUCT_AGENTS.products.homiio;
const APP = HOMIIO.applicationId;
const CREDENTIAL = HOMIIO.sindiServiceCredential.id;
const AGENT = HOMIIO.aliaAgent.id;
const USER = '6981c9178fcdefaf81988ffb';
const SESSION = 'session-1';
const HUMAN_BEARER = 'human-access-token';
const ISSUER = 'https://api.oxy.so';
const KEY = generateKeyPairSync('ed25519');
const KEY_ID = 'cap-test';

interface World {
  now: Date;
  principals: Map<string, LiveServicePrincipal>;
  bearers: Map<string, ValidatedSubjectSession>;
  sessions: Map<string, LiveSession>;
  store: RequesterAssertionStore;
  signingBroken: boolean;
}

function world(): World {
  const now = new Date('2026-09-17T12:00:00.000Z');
  return {
    now,
    principals: new Map([[`${APP}:${CREDENTIAL}`, {
      applicationId: APP,
      credentialId: CREDENTIAL,
      scopes: ['inference:invoke', 'acting-as:offline'],
    }]]),
    bearers: new Map([[HUMAN_BEARER, {
      sessionId: SESSION,
      subjectAccountId: USER,
      applicationId: null,
      accountStatus: 'active',
    }]]),
    sessions: new Map([[SESSION, {
      sessionId: SESSION,
      accountId: USER,
      applicationId: null,
      accountStatus: 'active',
    }]]),
    store: createMemoryRequesterAssertionStore(() => now.getTime()),
    signingBroken: false,
  };
}

function deps(state: World): RequesterAssertionDependencies {
  return {
    issuer: ISSUER,
    now: () => state.now,
    signing: () => {
      if (state.signingBroken) throw new Error('CAPABILITY_TICKET_SIGNING_KEY_ID is not configured');
      return { keyId: KEY_ID, privateKey: KEY.privateKey, publicKey: KEY.publicKey };
    },
    resolvePrincipal: async (applicationId, credentialId) => state.principals.get(`${applicationId}:${credentialId}`) ?? null,
    validateSubjectToken: async (token) => state.bearers.get(token) ?? null,
    loadLiveSession: async (sessionId) => state.sessions.get(sessionId) ?? null,
    store: state.store,
  };
}

const caller = { applicationId: APP, credentialId: CREDENTIAL, scopes: ['inference:invoke', 'acting-as:offline'] };
const presenter = { applicationId: APP, credentialId: CREDENTIAL };

async function mint(state: World, overrides: Partial<Parameters<typeof mintRequesterAssertion>[1]> = {}) {
  return mintRequesterAssertion(deps(state), { caller, agentId: AGENT, subjectToken: HUMAN_BEARER, ...overrides });
}

async function introspect(state: World, assertion: string, overrides: Partial<Parameters<typeof introspectRequesterAssertion>[1]> = {}) {
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
    const payload = JSON.parse(Buffer.from(result.assertion.split('.')[1] as string, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ iss: ISSUER, aud: 'alia', sub: USER, azp: APP, cid: CREDENTIAL, agentId: AGENT });
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
    ['another official application', { applicationId: '6a2f851751b784a86fd0e934', credentialId: CREDENTIAL }],
    ['another credential of the same application', { applicationId: APP, credentialId: 'other-credential' }],
  ])('refuses %s: only the pinned entry point may mint', async (_label, identity) => {
    const state = world();
    expect(await mint(state, { caller: { ...caller, ...identity } })).toEqual({ ok: false, reason: 'unknown_entry_point' });
  });

  it('refuses an agent that is not the entry point\'s own agent', async () => {
    const state = world();
    expect(await mint(state, { agentId: NATIVE_PRODUCT_AGENTS.products.clarity.aliaAgent.id }))
      .toEqual({ ok: false, reason: 'unknown_entry_point' });
  });

  it('refuses when the service token or the live credential lacks inference:invoke', async () => {
    const state = world();
    expect(await mint(state, { caller: { ...caller, scopes: ['acting-as:offline'] } }))
      .toEqual({ ok: false, reason: 'missing_inference_scope' });
    state.principals.set(`${APP}:${CREDENTIAL}`, { applicationId: APP, credentialId: CREDENTIAL, scopes: ['user:read'] });
    expect(await mint(state)).toEqual({ ok: false, reason: 'missing_inference_scope' });
  });

  it('refuses when the application or credential is no longer live (non-official, revoked, suspended)', async () => {
    const state = world();
    state.principals.clear();
    expect(await mint(state)).toEqual({ ok: false, reason: 'service_principal_not_live' });
  });

  it('refuses a forged, expired or unknown bearer', async () => {
    const state = world();
    expect(await mint(state, { subjectToken: 'forged.jwt.value' })).toEqual({ ok: false, reason: 'subject_session_invalid' });
  });

  it('refuses a session that was revoked after the per-task cache last saw it', async () => {
    const state = world();
    state.sessions.delete(SESSION);
    expect(await mint(state)).toEqual({ ok: false, reason: 'subject_session_not_live' });
  });

  it('refuses a session another application owns (a third-party OAuth bearer)', async () => {
    const state = world();
    state.bearers.set(HUMAN_BEARER, { ...state.bearers.get(HUMAN_BEARER)!, applicationId: 'third-party-app' });
    expect(await mint(state)).toEqual({ ok: false, reason: 'subject_session_other_application' });
  });

  it('refuses an archived account', async () => {
    const state = world();
    state.bearers.set(HUMAN_BEARER, { ...state.bearers.get(HUMAN_BEARER)!, accountStatus: 'archived' });
    expect(await mint(state)).toEqual({ ok: false, reason: 'subject_account_inactive' });
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
      credentialId: CREDENTIAL,
    });
    expect(await introspect(state, assertion)).toEqual({ active: false, reason: 'not_found_or_replayed' });
  });

  it('lets only the audience application consume', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    expect(await introspect(state, assertion, { callerApplicationId: APP }))
      .toEqual({ active: false, reason: 'caller_not_audience' });
    // Not spent by the refused caller.
    expect((await introspect(state, assertion)).active).toBe(true);
  });

  it('refuses a presenter other than the application and credential it was minted for, without spending it', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    expect(await introspect(state, assertion, { presenter: { applicationId: 'other-app', credentialId: CREDENTIAL } }))
      .toEqual({ active: false, reason: 'presenter_mismatch' });
    expect(await introspect(state, assertion, { presenter: { applicationId: APP, credentialId: 'other-credential' } }))
      .toEqual({ active: false, reason: 'presenter_mismatch' });
    expect((await introspect(state, assertion)).active).toBe(true);
  });

  it('refuses a forged signature, a foreign key id and a tampered payload', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    const other = generateKeyPairSync('ed25519');
    const payload = JSON.parse(Buffer.from(assertion.split('.')[1] as string, 'base64url').toString('utf8'));
    const forged = signOxyRequesterAssertion(payload, { keyId: KEY_ID, privateKey: other.privateKey });
    expect(await introspect(state, forged)).toEqual({ active: false, reason: 'invalid_signature' });
    const foreignKid = signOxyRequesterAssertion(payload, { keyId: 'someone-elses-kid', privateKey: KEY.privateKey });
    expect(await introspect(state, foreignKid)).toEqual({ active: false, reason: 'unknown_key' });
    const [header, , signature] = assertion.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...payload, sub: 'victim' })).toString('base64url');
    expect(await introspect(state, `${header}.${tampered}.${signature}`)).toEqual({ active: false, reason: 'invalid_signature' });
  });

  it('refuses an assertion signed for another audience or with no server-side record', async () => {
    const state = world();
    const iat = Math.floor(state.now.getTime() / 1000);
    const base = { iss: ISSUER, sub: USER, jti: randomUUID(), iat, exp: iat + 120, azp: APP, cid: CREDENTIAL, agentId: AGENT };
    const wrongAudience = signOxyRequesterAssertion({ ...base, aud: 'syra' }, { keyId: KEY_ID, privateKey: KEY.privateKey });
    expect(await introspect(state, wrongAudience)).toEqual({ active: false, reason: 'wrong_audience' });
    // Validly signed (a leaked signing key, say) but never minted: no record.
    const neverMinted = signOxyRequesterAssertion({ ...base, aud: 'alia' }, { keyId: KEY_ID, privateKey: KEY.privateKey });
    expect(await introspect(state, neverMinted)).toEqual({ active: false, reason: 'not_found_or_replayed' });
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
      { iss: ISSUER, aud: 'alia', sub: USER, jti: randomUUID(), iat, exp: iat + 120, azp: APP, cid: CREDENTIAL, agentId: 'not-sindi' },
      { keyId: KEY_ID, privateKey: KEY.privateKey },
    );
    expect(await introspect(state, otherAgent)).toEqual({ active: false, reason: 'unknown_entry_point' });
  });

  it('refuses when the person signed out or the session was revoked between mint and use', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.sessions.delete(SESSION);
    expect(await introspect(state, assertion)).toEqual({ active: false, reason: 'session_not_live' });
  });

  it('refuses when the account was archived between mint and use', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.sessions.set(SESSION, { ...state.sessions.get(SESSION)!, accountStatus: 'archived' });
    expect(await introspect(state, assertion)).toEqual({ active: false, reason: 'account_inactive' });
  });

  it('refuses when the product credential lost its authority between mint and use', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.principals.clear();
    expect(await introspect(state, assertion)).toEqual({ active: false, reason: 'service_principal_not_live' });
  });

  it('fails closed when the replay store cannot answer', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    state.store = { put: state.store.put, take: async () => ({ status: 'unavailable' }) };
    expect(await introspect(state, assertion)).toEqual({ active: false, reason: 'replay_store_unavailable' });
  });

  it('lets only one of two concurrent presentations through', async () => {
    const state = world();
    const assertion = await mintedAssertion(state);
    const results = await Promise.all([introspect(state, assertion), introspect(state, assertion)]);
    expect(results.filter((result) => result.active)).toHaveLength(1);
  });
});

import type React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

// Tripwire: the attest flow must NEVER touch the device biometric gate. If any
// module in this test's import graph calls `authenticate`, this spy records it.
const authenticateMock = jest.fn<Promise<{ success: boolean; error?: string }>, [string?]>();
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (...args: [string?]) => authenticateMock(...args),
}));

// eslint-disable-next-line import/first
import { useAttestStore, type AttestSubmitParams } from '@/hooks/civic/attestStore';
// eslint-disable-next-line import/first
import { useAttestFlow } from '@/hooks/civic/useAttestFlow';

const SUBJECT_DID = 'did:web:oxy.so:u:subjectUser';
const PARAMS: AttestSubmitParams = {
  subjectDid: SUBJECT_DID,
  context: 'ctx-1',
  nonce: 'nonce-1',
  exp: Date.now() + 5 * 60 * 1000,
};

const RESULT = {
  accepted: true as const,
  recordId: 'rec-1',
  subjectUserId: 'subjectUser',
  attestorUserId: 'me',
  points: 25,
};

const CARD = {
  card: {
    did: SUBJECT_DID,
    userId: 'subjectUser',
    name: 'Alex Subject',
    username: 'alex',
    trustTier: 'trusted' as const,
    personhoodStatus: 'unverified' as const,
    verifiedDomains: [],
    credentialBadges: [],
    issuedAt: 1,
  },
  attestation: null,
  verified: true,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('attestStore', () => {
  beforeEach(() => {
    useAttestStore.getState().reset();
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('submit signs + submits automatically and reaches done — no biometric call', async () => {
    const services = { submitRealLifeAttestation: jest.fn(async () => RESULT) };

    const pending = useAttestStore.getState().submit(PARAMS, services);
    // The flow must feel instant: `submitting` is entered synchronously with
    // the subject already resolved for the card lookup.
    expect(useAttestStore.getState().status).toBe('submitting');
    expect(useAttestStore.getState().subjectUserId).toBe('subjectUser');
    await pending;

    const state = useAttestStore.getState();
    expect(state.status).toBe('done');
    expect(state.result?.points).toBe(25);
    expect(state.errorCode).toBeNull();
    expect(services.submitRealLifeAttestation).toHaveBeenCalledTimes(1);
    expect(services.submitRealLifeAttestation).toHaveBeenCalledWith({
      subjectDid: SUBJECT_DID,
      context: 'ctx-1',
      nonce: 'nonce-1',
      exp: PARAMS.exp,
      biometricOk: false,
    });
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('classifies a server rejection into an error code (no retry fired)', async () => {
    const services = {
      submitRealLifeAttestation: jest.fn(async () => {
        throw new Error('Attestation rejected: nonce_used');
      }),
    };

    await useAttestStore.getState().submit(PARAMS, services);

    const state = useAttestStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorCode).toBe('nonce_used');
    expect(state.result).toBeNull();
    // A one-shot signed single-use nonce must never be auto-retried.
    expect(services.submitRealLifeAttestation).toHaveBeenCalledTimes(1);
  });

  it('errors as subject_not_found for an unresolvable DID without burning a request', async () => {
    const services = { submitRealLifeAttestation: jest.fn(async () => RESULT) };

    await useAttestStore.getState().submit({ ...PARAMS, subjectDid: 'not-a-did' }, services);

    const state = useAttestStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorCode).toBe('subject_not_found');
    expect(services.submitRealLifeAttestation).not.toHaveBeenCalled();
  });

  it('treats distinct payloads independently and allows re-confirming (no client dedupe)', async () => {
    const otherResult = { ...RESULT, recordId: 'rec-2', subjectUserId: 'otherUser', points: 25 };
    const services = {
      submitRealLifeAttestation: jest.fn(
        async (input: { subjectDid: string }) =>
          input.subjectDid === SUBJECT_DID ? RESULT : otherResult,
      ),
    };

    await useAttestStore.getState().submit(PARAMS, services);
    expect(useAttestStore.getState().result?.recordId).toBe('rec-1');

    const otherParams: AttestSubmitParams = {
      subjectDid: 'did:web:oxy.so:u:otherUser',
      context: 'ctx-2',
      nonce: 'nonce-2',
      exp: PARAMS.exp,
    };
    const pending = useAttestStore.getState().submit(otherParams, services);
    // The new payload's flow replaces the previous one immediately.
    expect(useAttestStore.getState().status).toBe('submitting');
    expect(useAttestStore.getState().subjectUserId).toBe('otherUser');
    expect(useAttestStore.getState().result).toBeNull();
    await pending;
    expect(useAttestStore.getState().result?.recordId).toBe('rec-2');

    // Re-confirming the same person just submits again — the server upserts.
    await useAttestStore.getState().submit(PARAMS, services);
    expect(useAttestStore.getState().status).toBe('done');
    expect(services.submitRealLifeAttestation).toHaveBeenCalledTimes(3);
  });

  it('ignores the late completion of a superseded submission', async () => {
    const first = deferred<typeof RESULT>();
    const second = deferred<typeof RESULT>();
    const services = {
      submitRealLifeAttestation: jest
        .fn<Promise<typeof RESULT>, [unknown]>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };

    const p1 = useAttestStore.getState().submit(PARAMS, services);
    const p2 = useAttestStore
      .getState()
      .submit({ ...PARAMS, subjectDid: 'did:web:oxy.so:u:otherUser', nonce: 'nonce-2' }, services);

    second.resolve({ ...RESULT, recordId: 'rec-2' });
    await p2;
    expect(useAttestStore.getState().result?.recordId).toBe('rec-2');

    first.resolve(RESULT); // stale — must not clobber the current flow
    await p1;
    expect(useAttestStore.getState().result?.recordId).toBe('rec-2');
    expect(useAttestStore.getState().status).toBe('done');
  });

  it('reset returns to idle and discards an in-flight submission outcome', async () => {
    const gate = deferred<typeof RESULT>();
    const services = { submitRealLifeAttestation: jest.fn(() => gate.promise) };

    const pending = useAttestStore.getState().submit(PARAMS, services);
    expect(useAttestStore.getState().status).toBe('submitting');

    useAttestStore.getState().reset();
    expect(useAttestStore.getState().status).toBe('idle');
    expect(useAttestStore.getState().subjectDid).toBeNull();

    gate.resolve(RESULT);
    await pending;
    expect(useAttestStore.getState().status).toBe('idle');
    expect(useAttestStore.getState().result).toBeNull();
  });

  it('prepare holds the payload in reviewing without signing', () => {
    useAttestStore.getState().prepare(PARAMS);

    const state = useAttestStore.getState();
    expect(state.status).toBe('reviewing');
    expect(state.subjectUserId).toBe('subjectUser');
    expect(state.pendingParams).toEqual(PARAMS);
    expect(state.result).toBeNull();
  });

  it('prepare surfaces subject_not_found for an unresolvable DID', () => {
    useAttestStore.getState().prepare({ ...PARAMS, subjectDid: 'not-a-did' });

    const state = useAttestStore.getState();
    expect(state.status).toBe('error');
    expect(state.errorCode).toBe('subject_not_found');
    expect(state.pendingParams).toBeNull();
  });

  it('confirm signs the held payload with biometricOk and reaches done', async () => {
    const services = { submitRealLifeAttestation: jest.fn(async () => RESULT) };

    useAttestStore.getState().prepare(PARAMS);
    await useAttestStore.getState().confirm(services, true);

    const state = useAttestStore.getState();
    expect(state.status).toBe('done');
    expect(state.result?.points).toBe(25);
    expect(state.pendingParams).toBeNull();
    expect(services.submitRealLifeAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'nonce-1', biometricOk: true }),
    );
  });

  it('confirm is a no-op when nothing is held for review', async () => {
    const services = { submitRealLifeAttestation: jest.fn(async () => RESULT) };

    await useAttestStore.getState().confirm(services, true);

    expect(useAttestStore.getState().status).toBe('idle');
    expect(services.submitRealLifeAttestation).not.toHaveBeenCalled();
  });
});

describe('useAttestFlow', () => {
  beforeEach(() => {
    useAttestStore.getState().reset();
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('submits via the SDK from context and resolves the subject card — no biometric', async () => {
    const services = {
      getPublicCard: jest.fn(async () => CARD),
      submitRealLifeAttestation: jest.fn(async () => RESULT),
    };
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: services });

    const { result } = renderHook(() => useAttestFlow(), { wrapper: makeWrapper() });
    expect(result.current.status).toBe('idle');

    // The trigger is the scan EVENT (here: this act call) — no mount effect.
    act(() => result.current.submit(PARAMS));

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.result?.points).toBe(25);
    expect(services.submitRealLifeAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'nonce-1', biometricOk: false }),
    );
    // The card read is TanStack-owned, keyed off the store's subject.
    expect(services.getPublicCard).toHaveBeenCalledWith('subjectUser');
    await waitFor(() => expect(result.current.subject?.card.name).toBe('Alex Subject'));
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('pins the card to a route-derived subject when an override is passed', async () => {
    const services = { getPublicCard: jest.fn(async () => CARD) };
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: services });

    const { result } = renderHook(() => useAttestFlow('subjectUser'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.subject?.card.name).toBe('Alex Subject'));
    expect(services.getPublicCard).toHaveBeenCalledWith('subjectUser');
    // The flow itself is untouched — nothing was submitted.
    expect(result.current.status).toBe('idle');
  });
});

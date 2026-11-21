import { act, render, renderHook, waitFor } from '@testing-library/react';
import { environment, setActiveStore, Store } from '@oxy.so/bloom-data';
import { SUPERVISION_CHANGED_EVENT } from '@oxy.so/contracts/client';
import { SupervisionStateObserver, useSupervision } from '../useSupervision';

const mockSupervisionState = jest.fn();
const mockServerEvents = new Map<string, (payload: unknown) => void>();
const mockSession = {
  user: { id: 'child', kind: 'personal' } as { id: string; kind: string } | null,
  canUsePrivateApi: true,
};
jest.mock('../../../context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    oxyServices: { safety: { supervisionState: mockSupervisionState } },
    user: mockSession.user,
    canUsePrivateApi: mockSession.canUsePrivateApi,
    activeSessionId: 'session',
    sessionClient: {
      onServerEvent: (event: string, listener: (payload: unknown) => void) => {
        mockServerEvents.set(event, listener);
        return () => mockServerEvents.delete(event);
      },
    },
  }),
}));

const state = (status: 'active' | 'ended') => ({
  self: {
    childAccountId: 'child',
    guardianAccountId: 'guardian',
    status,
    policyVersion: '2',
    consentVersion: '1',
    createdAt: '2026-10-23T00:00:00.000Z',
  },
  children: [],
  invitations: [],
});

beforeEach(() => {
  setActiveStore(new Store());
  mockSupervisionState.mockReset();
  mockServerEvents.clear();
  mockSession.user = { id: 'child', kind: 'personal' };
  mockSession.canUsePrivateApi = true;
});

it('serves the session state to a new screen from what is held, without a request', async () => {
  mockSupervisionState.mockResolvedValue(state('active'));
  render(<SupervisionStateObserver />);
  await waitFor(() => expect(mockSupervisionState).toHaveBeenCalledTimes(1));
  await act(async () => {});

  const { result } = renderHook(() => useSupervision());

  expect(result.current.value?.self?.status).toBe('active');
  expect(mockSupervisionState).toHaveBeenCalledTimes(1);
});

it('reads again when the session socket signals a supervision change', async () => {
  mockSupervisionState.mockResolvedValueOnce(state('active')).mockResolvedValue(state('ended'));
  render(<SupervisionStateObserver />);
  const { result } = renderHook(() => useSupervision());
  await waitFor(() => expect(result.current.value?.self?.status).toBe('active'));

  act(() => mockServerEvents.get(SUPERVISION_CHANGED_EVENT)?.(undefined));

  await waitFor(() => expect(result.current.value?.self?.status).toBe('ended'));
  expect(mockSupervisionState).toHaveBeenCalledTimes(2);
});

it('reads again on every return to the foreground, although the state never goes stale', async () => {
  mockSupervisionState.mockResolvedValueOnce(state('active')).mockResolvedValue(state('ended'));
  render(<SupervisionStateObserver />);
  const { result } = renderHook(() => useSupervision());
  await waitFor(() => expect(result.current.value?.self?.status).toBe('active'));

  act(() => {
    environment.setFocused(false);
    environment.setFocused(true);
  });

  await waitFor(() => expect(result.current.value?.self?.status).toBe('ended'));
  expect(mockSupervisionState).toHaveBeenCalledTimes(2);
});

it('reads nothing for an account that is not personal, or without a private session', async () => {
  mockSession.user = { id: 'org', kind: 'organization' };
  const organization = renderHook(() => useSupervision());
  mockSession.user = { id: 'child', kind: 'personal' };
  mockSession.canUsePrivateApi = false;
  const signedOut = renderHook(() => useSupervision());
  await act(async () => {});

  expect(mockSupervisionState).not.toHaveBeenCalled();
  expect(organization.result.current.value).toBeUndefined();
  expect(organization.result.current.isLoading).toBe(false);
  expect(signedOut.result.current.value).toBeUndefined();
});

it('shows no state after a failed read, and does not retry a refusal', async () => {
  mockSupervisionState.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
  const { result } = renderHook(() => useSupervision());

  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(result.current.value).toBeUndefined();
  expect(mockSupervisionState).toHaveBeenCalledTimes(1);
});

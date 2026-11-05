import type { ReactNode } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SUPERVISION_CHANGED_EVENT } from '@oxy.so/contracts/client';
import { SupervisionStateObserver, useSupervision } from '../useSupervision';

const mockSupervisionState = jest.fn();
const mockServerEvents = new Map<string, (payload: unknown) => void>();
jest.mock('../../../context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    oxyServices: { safety: { supervisionState: mockSupervisionState } },
    user: { id: 'child', kind: 'personal' },
    canUsePrivateApi: true,
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

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<SupervisionStateObserver />, { wrapper });
  return wrapper;
}

beforeEach(() => {
  mockSupervisionState.mockReset();
  mockServerEvents.clear();
});

it('serves the session state to a new screen from the cache, without a request', async () => {
  mockSupervisionState.mockResolvedValue(state('active'));
  const wrapper = setup();
  await waitFor(() => expect(mockSupervisionState).toHaveBeenCalledTimes(1));
  await act(async () => {});

  const { result } = renderHook(() => useSupervision(), { wrapper });

  expect(result.current.data?.self?.status).toBe('active');
  expect(mockSupervisionState).toHaveBeenCalledTimes(1);
});

it('refetches when the session socket signals a supervision change', async () => {
  mockSupervisionState.mockResolvedValueOnce(state('active')).mockResolvedValue(state('ended'));
  const wrapper = setup();
  const { result } = renderHook(() => useSupervision(), { wrapper });
  await waitFor(() => expect(result.current.data?.self?.status).toBe('active'));

  act(() => mockServerEvents.get(SUPERVISION_CHANGED_EVENT)?.(undefined));

  await waitFor(() => expect(result.current.data?.self?.status).toBe('ended'));
  expect(mockSupervisionState).toHaveBeenCalledTimes(2);
});

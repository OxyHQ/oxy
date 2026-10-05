import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
const mockCancel = jest.fn();
let mockUser = { id: 'first' };
const mockRefetch = jest.fn();
const mockSource = { sourceId: 'source-one', status: 'active', period: { end: '2026-11-05T00:00:00.000Z' },
  cancelAtPeriodEnd: false, canCancel: true, offers: [] };
jest.mock('react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled }: { children: React.ReactNode; onPress: () => void; disabled: boolean }) => <button disabled={disabled} onClick={onPress}>{children}</button>,
}));
jest.mock('@/components/section', () => ({ Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
jest.mock('@/components/themed-text', () => ({ ThemedText: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/core', () => ({ authenticatedApiCall: (_svc: unknown, _sid: unknown, run: () => unknown) => run() }));
jest.mock('@oxy.so/services', () => ({
  useOxy: () => ({ user: mockUser, isAuthenticated: true, activeSessionId: mockUser.id,
    oxyServices: { billing: { cancelProductSubscriptionWithStatus: mockCancel } } }),
  usePersonalPlans: () => ({ data: { state: 'unconfigured', plans: [] } }),
  usePersonalPlanSubscriptions: () => ({ data: [mockSource], refetch: mockRefetch }),
}));
import { PersonalPlansCard } from '@/components/payments/PersonalPlansCard';
beforeEach(() => { mockUser = { id: 'first' }; mockCancel.mockReset(); mockRefetch.mockReset(); });
it('requires confirmation, fences cancellation to the account, and explains pending reconciliation', async () => {
  mockCancel.mockResolvedValue({ sourceId: 'source-one', reconciliationPending: true });
  render(<PersonalPlansCard />);
  expect(screen.getByText('payments.one.unconfigured')).toBeTruthy();
  fireEvent.click(screen.getByText('payments.one.cancel'));
  expect(mockCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('source-one', 'first'));
  expect(await screen.findByText('payments.one.pending')).toBeTruthy();
});
it('clears a pending confirmation when the account changes', () => {
  const { rerender } = render(<PersonalPlansCard />);
  fireEvent.click(screen.getByText('payments.one.cancel'));
  expect(screen.getByText('payments.one.confirmCancel')).toBeTruthy();
  mockUser = { id: 'second' }; rerender(<PersonalPlansCard />);
  expect(screen.queryByText('payments.one.confirmCancel')).toBeNull();
  expect(mockCancel).not.toHaveBeenCalled();
});

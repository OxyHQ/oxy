import type React from 'react';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
let mockActionCounter = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `action_${++mockActionCounter}` }));
const mockCancel = jest.fn();
const mockCheckout = jest.fn();
const mockRenew = jest.fn();
const mockClearCheckoutKey = jest.fn();
let mockAuthenticatedCall = (run: () => unknown) => run();
const mockOpenURL = jest.fn();
let mockPurchase = 'unavailable';
const mockCheckoutKey = jest.fn(async () => 'stable-checkout-key');
jest.mock('@/lib/personal-plan-checkout', () => ({
  getPersonalPlanCheckoutKey: (...args: unknown[]) => mockCheckoutKey(...args),
  clearPersonalPlanCheckoutKey: (...args: unknown[]) => mockClearCheckoutKey(...args),
}));
let mockUser = { id: 'first' };
const mockRefetch = jest.fn();
let mockPlans: unknown[] = [];
let mockLocale = 'en-US';
const mockSource = {
  sourceId: 'source-one',
  status: 'active',
  period: { end: '2026-11-05T00:00:00.000Z' },
  cancelAtPeriodEnd: false,
  canCancel: true,
  canRenew: false,
  offers: [],
};
jest.mock('react-native', () => ({
  Linking: { openURL: (...args: unknown[]) => mockOpenURL(...args) },
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
jest.mock('@/components/section', () => ({
  Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
jest.mock('@/components/themed-text', () => ({
  ThemedText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    locale: mockLocale,
    t: (key: string, vars?: { price?: string }) =>
      key === 'payments.one.monthlyPrice'
        ? `${vars?.price}/${mockLocale === 'es-ES' ? 'mes' : 'month'}`
        : key,
  }),
}));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_svc: unknown, _sid: unknown, run: () => unknown) =>
    mockAuthenticatedCall(run),
}));
jest.mock('@oxy.so/services', () => ({
  DisplayCurrencySelector: () => <div>Display currency</div>,
  useDisplayPrice: () => ({
    currency: 'USD',
    formatUsd: (cents: number) =>
      new Intl.NumberFormat(mockLocale, { style: 'currency', currency: 'USD' }).format(cents / 100),
  }),
  useOxy: () => ({
    user: mockUser,
    isAuthenticated: true,
    activeSessionId: mockUser.id,
    oxyServices: {
      billing: {
        cancelProductSubscriptionWithStatus: mockCancel,
        startPersonalPlanCheckout: mockCheckout,
        renewProductSubscription: mockRenew,
      },
    },
  }),
  usePersonalPlans: () => ({
    data: { state: 'unconfigured', plans: mockPlans, purchase: mockPurchase },
  }),
  usePersonalPlanSubscriptions: () => ({ data: [mockSource], refetch: mockRefetch }),
}));
import { PersonalPlansCard } from '@/components/payments/PersonalPlansCard';
beforeEach(() => {
  mockSource.status = 'active';
  mockSource.canRenew = false;
  mockRenew.mockReset();
  mockClearCheckoutKey.mockReset();
  mockCheckoutKey.mockReset().mockResolvedValue('stable-checkout-key');
  mockAuthenticatedCall = (run) => run();
  mockSource.canCancel = true;
  mockActionCounter = 0;
  mockUser = { id: 'first' };
  mockCancel.mockReset();
  mockCheckout.mockReset();
  mockOpenURL.mockReset();
  mockPurchase = 'unavailable';
  mockRefetch.mockReset();
  mockPlans = [];
  mockLocale = 'en-US';
});
it('requires confirmation, fences cancellation to the account, and explains pending reconciliation', async () => {
  mockCancel.mockResolvedValue({ sourceId: 'source-one', reconciliationPending: true });
  render(<PersonalPlansCard />);
  expect(screen.getByText('payments.one.unconfigured')).toBeTruthy();
  fireEvent.click(screen.getByText('payments.one.cancel'));
  expect(mockCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('source-one', 'first', 'action_1'));
  expect(await screen.findByText('payments.one.pending')).toBeTruthy();
});
it('clears a pending confirmation when the account changes', () => {
  const { rerender } = render(<PersonalPlansCard />);
  fireEvent.click(screen.getByText('payments.one.cancel'));
  expect(screen.getByText('payments.one.confirmCancel')).toBeTruthy();
  mockUser = { id: 'second' };
  rerender(<PersonalPlansCard />);
  expect(screen.queryByText('payments.one.confirmCancel')).toBeNull();
  expect(mockCancel).not.toHaveBeenCalled();
});

it('shows the catalogue monthly price without offering checkout or trial', () => {
  mockPlans = [
    {
      offerId: 'synthetic-only',
      offerVersion: 1,
      displayName: 'Oxy One Personal',
      benefits: [],
      price: {
        currency: 'USD',
        amountMinorUnits: 2999,
        interval: 'month',
        trial: 'none',
        taxTreatment: 'inclusive',
        merchantTotal: 'final',
      },
    },
  ];
  render(<PersonalPlansCard />);
  expect(screen.getByText('$29.99/month')).toBeTruthy();
  expect(screen.getByText('payments.one.noTrial')).toBeTruthy();
  expect(screen.getByText('payments.one.finalTaxInclusive')).toBeTruthy();
  expect(screen.getByText('payments.one.unconfigured')).toBeTruthy();
  expect(screen.queryByText(/buy|checkout|subscribe/i)).toBeNull();
});
it('formats locale-aware prices and follows SDK amounts rather than a UI constant', () => {
  mockLocale = 'es-ES';
  mockPlans = [
    {
      offerId: 'synthetic-only',
      offerVersion: 2,
      displayName: 'Synthetic fixture',
      benefits: [],
      price: {
        currency: 'USD',
        amountMinorUnits: 1234,
        interval: 'month',
        trial: 'none',
        taxTreatment: 'inclusive',
        merchantTotal: 'final',
      },
    },
  ];
  render(<PersonalPlansCard />);
  expect(screen.getByText(/12,34.*US.*\/mes/)).toBeTruthy();
  expect(screen.queryByText(/29[.,]99/)).toBeNull();
});

it('retries same action and assigns new identity to later cancellation', async () => {
  mockCancel
    .mockRejectedValueOnce(new Error('unknown'))
    .mockResolvedValue({ sourceId: 'source-one', cancelAtPeriodEnd: true });
  render(<PersonalPlansCard />);
  fireEvent.click(screen.getByText('payments.one.cancel'));
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  await screen.findByText('payments.one.failed');
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  await screen.findByText('payments.one.scheduled');
  expect(mockCancel.mock.calls.map((v) => v[2])).toEqual(['action_1', 'action_1']);
  fireEvent.click(screen.getByText('payments.one.cancel'));
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  await waitFor(() => expect(mockCancel).toHaveBeenCalledTimes(3));
  expect(mockCancel.mock.calls[2][2]).toBe('action_2');
});

it.each(['past_due', 'unpaid'])(
  'shows owned %s cancellation from the trusted SDK read model',
  async (status) => {
    mockSource.status = status;
    mockCancel.mockResolvedValue({ sourceId: 'source-one', cancelAtPeriodEnd: true });
    render(<PersonalPlansCard />);
    fireEvent.click(screen.getByText('payments.one.cancel'));
    fireEvent.click(screen.getByText('payments.one.confirmCancel'));
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('source-one', 'first', 'action_1'));
  },
);
it('hides cancellation when the SDK ownership read model refuses it', () => {
  mockSource.status = 'past_due';
  mockSource.canCancel = false;
  render(<PersonalPlansCard />);
  expect(screen.queryByText('payments.one.cancel')).toBeNull();
});

it('keeps a confirmed cancellation when the list refresh fails, and does not mint a new action', async () => {
  mockCancel.mockResolvedValue({ sourceId: 'source-one', reconciliationPending: true });
  mockRefetch.mockRejectedValue(new Error('timeout'));
  render(<PersonalPlansCard />);
  fireEvent.click(screen.getByText('payments.one.cancel'));
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  expect(await screen.findByText('payments.one.pending')).toBeTruthy();
  expect(await screen.findByText('payments.one.refreshFailed')).toBeTruthy();
  expect(screen.queryByText('payments.one.failed')).toBeNull();
  expect(screen.queryByText('payments.one.confirmCancel')).toBeNull();
  expect(mockCancel).toHaveBeenCalledTimes(1);
});

it('opens the actual configured checkout with display-only preference and an account fence', async () => {
  mockPurchase = 'available';
  mockPlans = [{ offerId: 'one', offerVersion: 1, displayName: 'Oxy One', benefits: [] }];
  mockCheckout.mockResolvedValue({
    state: 'pending',
    intentId: 'ci1',
    checkoutUrl: 'https://checkout.peable.to/c/cs1#cs=secret',
  });
  render(<PersonalPlansCard />);
  fireEvent.click(screen.getByText('payments.one.checkout'));
  await waitFor(() =>
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://checkout.peable.to/c/cs1?displayCurrency=USD#cs=secret',
    ),
  );
  expect(mockCheckout).toHaveBeenCalledWith({
    expectedSubjectAccountId: 'first',
    offerId: 'one',
    offerVersion: 1,
    idempotencyKey: 'stable-checkout-key',
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['purchase', 'renew'])(
  'fences a %s after key lookup, auth refresh, and response across account switches',
  async (action) => {
    for (const stage of ['key', 'auth', 'response']) {
      mockPurchase = 'available';
      mockPlans = [{ offerId: 'one', offerVersion: 1, displayName: 'Oxy One', benefits: [] }];
      mockSource.canRenew = true;
      mockUser = { id: 'first' };
      const pending = deferred<unknown>();
      const sdk = action === 'purchase' ? mockCheckout : mockRenew;
      sdk
        .mockReset()
        .mockResolvedValue({ state: 'pending', checkoutUrl: 'https://checkout.peable.to/c/old' });
      mockOpenURL.mockClear();
      mockCheckoutKey.mockReset().mockResolvedValue('stable-checkout-key');
      mockAuthenticatedCall = (run) => run();
      if (stage === 'key') mockCheckoutKey.mockReturnValueOnce(pending.promise);
      if (stage === 'auth')
        mockAuthenticatedCall = async (run) => {
          await pending.promise;
          return run();
        };
      if (stage === 'response') sdk.mockReturnValueOnce(pending.promise);
      const view = render(<PersonalPlansCard />);
      fireEvent.click(
        screen.getByText(`payments.one.${action === 'purchase' ? 'checkout' : 'renew'}`),
      );
      await act(async () => {
        await Promise.resolve();
      });
      mockUser = { id: 'second' };
      view.rerender(<PersonalPlansCard />);
      await act(async () =>
        pending.resolve(
          stage === 'key'
            ? 'stable-checkout-key'
            : { state: 'pending', checkoutUrl: 'https://checkout.peable.to/c/old' },
        ),
      );
      expect(sdk).toHaveBeenCalledTimes(stage === 'response' ? 1 : 0);
      expect(mockOpenURL).not.toHaveBeenCalled();
      expect(mockClearCheckoutKey).not.toHaveBeenCalled();
      view.unmount();
    }
  },
);
it.each(['purchase', 'renew'])(
  'preserves %s recovery state when a response arrives after unmount',
  async (action) => {
    mockPurchase = 'available';
    mockPlans = [{ offerId: 'one', offerVersion: 1, displayName: 'Oxy One', benefits: [] }];
    mockSource.canRenew = true;
    const pending = deferred<{ state: string }>();
    const sdk = action === 'purchase' ? mockCheckout : mockRenew;
    sdk.mockReturnValue(pending.promise);
    const view = render(<PersonalPlansCard />);
    fireEvent.click(
      screen.getByText(`payments.one.${action === 'purchase' ? 'checkout' : 'renew'}`),
    );
    await waitFor(() => expect(sdk).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => pending.resolve({ state: 'fulfilled' }));
    expect(mockClearCheckoutKey).not.toHaveBeenCalled();
    expect(mockRefetch).not.toHaveBeenCalled();
    expect(mockOpenURL).not.toHaveBeenCalled();
  },
);
it.each(['purchase', 'renew'])(
  'keeps the %s retry key and shows a safe review path for uncertain funds',
  async (action) => {
    mockPurchase = 'available';
    mockPlans = [{ offerId: 'one', offerVersion: 1, displayName: 'Oxy One', benefits: [] }];
    mockSource.canRenew = true;
    (action === 'purchase' ? mockCheckout : mockRenew).mockRejectedValue(
      new Error('PAYMENT_REVIEW_REQUIRED'),
    );
    render(<PersonalPlansCard />);
    fireEvent.click(
      screen.getByText(`payments.one.${action === 'purchase' ? 'checkout' : 'renew'}`),
    );
    expect(await screen.findByText('payments.one.paymentReview')).toBeTruthy();
    expect(mockClearCheckoutKey).not.toHaveBeenCalled();
    expect(mockOpenURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('payments.one.reviewPayment'));
    expect(mockOpenURL).toHaveBeenCalledWith('https://peable.to');
  },
);

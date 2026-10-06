import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
let mockActionCounter=0;
jest.mock('expo-crypto',()=>({randomUUID:()=>`action_${++mockActionCounter}`}));
const mockCancel = jest.fn();
let mockUser = { id: 'first' };
const mockRefetch = jest.fn();
let mockPlans: unknown[] = [];
let mockLocale = 'en-US';
const mockSource = { sourceId: 'source-one', status: 'active', period: { end: '2026-11-05T00:00:00.000Z' },
  cancelAtPeriodEnd: false, canCancel: true, offers: [] };
jest.mock('react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled }: { children: React.ReactNode; onPress: () => void; disabled: boolean }) => <button disabled={disabled} onClick={onPress}>{children}</button>,
}));
jest.mock('@/components/section', () => ({ Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
jest.mock('@/components/themed-text', () => ({ ThemedText: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ locale: mockLocale, t: (key: string, vars?: { price?: string }) => key === 'payments.one.monthlyPrice' ? `${vars?.price}/${mockLocale === 'es-ES' ? 'mes' : 'month'}` : key }) }));
jest.mock('@oxy.so/core', () => ({ authenticatedApiCall: (_svc: unknown, _sid: unknown, run: () => unknown) => run() }));
jest.mock('@oxy.so/services', () => ({
  useOxy: () => ({ user: mockUser, isAuthenticated: true, activeSessionId: mockUser.id,
    oxyServices: { billing: { cancelProductSubscriptionWithStatus: mockCancel } } }),
  usePersonalPlans: () => ({ data: { state: 'unconfigured', plans: mockPlans } }),
  usePersonalPlanSubscriptions: () => ({ data: [mockSource], refetch: mockRefetch }),
}));
import { PersonalPlansCard } from '@/components/payments/PersonalPlansCard';
beforeEach(() => {mockSource.status='active';mockSource.canCancel=true;mockActionCounter=0; mockUser = { id: 'first' }; mockCancel.mockReset(); mockRefetch.mockReset(); mockPlans = []; mockLocale = 'en-US'; });
it('requires confirmation, fences cancellation to the account, and explains pending reconciliation', async () => {
  mockCancel.mockResolvedValue({ sourceId: 'source-one', reconciliationPending: true });
  render(<PersonalPlansCard />);
  expect(screen.getByText('payments.one.unconfigured')).toBeTruthy();
  fireEvent.click(screen.getByText('payments.one.cancel'));
  expect(mockCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('payments.one.confirmCancel'));
  await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('source-one', 'first','action_1'));
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

it('shows the catalogue monthly price without offering checkout or trial', () => {
  mockPlans = [{offerId:'synthetic-only', offerVersion:1,displayName:'Oxy One Personal',benefits:[],
    price:{currency:'USD',amountMinorUnits:2999,interval:'month',trial:'none',taxTreatment:'inclusive',merchantTotal:'final'}}];
  render(<PersonalPlansCard />);
  expect(screen.getByText('$29.99/month')).toBeTruthy();
  expect(screen.getByText('payments.one.noTrial')).toBeTruthy();
  expect(screen.getByText('payments.one.finalTaxInclusive')).toBeTruthy();
  expect(screen.getByText('payments.one.unconfigured')).toBeTruthy();
  expect(screen.queryByText(/buy|checkout|subscribe/i)).toBeNull();
});
it('formats locale-aware prices and follows SDK amounts rather than a UI constant', () => {
  mockLocale = 'es-ES';
  mockPlans = [{offerId:'synthetic-only',offerVersion:2,displayName:'Synthetic fixture',benefits:[],
    price:{currency:'USD',amountMinorUnits:1234,interval:'month',trial:'none',taxTreatment:'inclusive',merchantTotal:'final'}}];
  render(<PersonalPlansCard />);
  expect(screen.getByText(/12,34.*US.*\/mes/)).toBeTruthy();
  expect(screen.queryByText(/29[.,]99/)).toBeNull();
});

it('retries same action and assigns new identity to later cancellation',async()=>{
 mockCancel.mockRejectedValueOnce(new Error('unknown')).mockResolvedValue({sourceId:'source-one',cancelAtPeriodEnd:true});render(<PersonalPlansCard/>);
 fireEvent.click(screen.getByText('payments.one.cancel'));fireEvent.click(screen.getByText('payments.one.confirmCancel'));await screen.findByText('payments.one.failed');
 fireEvent.click(screen.getByText('payments.one.confirmCancel'));await screen.findByText('payments.one.scheduled');expect(mockCancel.mock.calls.map(v=>v[2])).toEqual(['action_1','action_1']);
 fireEvent.click(screen.getByText('payments.one.cancel'));fireEvent.click(screen.getByText('payments.one.confirmCancel'));await waitFor(()=>expect(mockCancel).toHaveBeenCalledTimes(3));expect(mockCancel.mock.calls[2][2]).toBe('action_2');
});

it.each(['past_due','unpaid'])('shows owned %s cancellation from the trusted SDK read model',async status=>{mockSource.status=status;mockCancel.mockResolvedValue({sourceId:'source-one',cancelAtPeriodEnd:true});render(<PersonalPlansCard/>);fireEvent.click(screen.getByText('payments.one.cancel'));fireEvent.click(screen.getByText('payments.one.confirmCancel'));await waitFor(()=>expect(mockCancel).toHaveBeenCalledWith('source-one','first','action_1'));});
it('hides cancellation when the SDK ownership read model refuses it',()=>{mockSource.status='past_due';mockSource.canCancel=false;render(<PersonalPlansCard/>);expect(screen.queryByText('payments.one.cancel')).toBeNull();});

it('keeps a confirmed cancellation when the list refresh fails, and does not mint a new action',async()=>{
 mockCancel.mockResolvedValue({sourceId:'source-one',reconciliationPending:true});mockRefetch.mockRejectedValue(new Error('timeout'));
 render(<PersonalPlansCard/>);
 fireEvent.click(screen.getByText('payments.one.cancel'));fireEvent.click(screen.getByText('payments.one.confirmCancel'));
 expect(await screen.findByText('payments.one.pending')).toBeTruthy();
 expect(await screen.findByText('payments.one.refreshFailed')).toBeTruthy();
 expect(screen.queryByText('payments.one.failed')).toBeNull();
 expect(screen.queryByText('payments.one.confirmCancel')).toBeNull();
 expect(mockCancel).toHaveBeenCalledTimes(1);
});

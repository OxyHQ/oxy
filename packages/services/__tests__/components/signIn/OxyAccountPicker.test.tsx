/**
 * The account picker's two row states that come from Bloom: the current
 * account's check (Avatar's `verified` slot) and the activating row's
 * animated `SpinnerIcon`.
 */
import { render, screen } from '@testing-library/react';

jest.mock('../../../src/ui/hooks/useI18n', () => {
  const { translate } = jest.requireActual('@oxy.so/core');
  return {
    __esModule: true,
    useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars), locale: 'en-US' }),
  };
});

// eslint-disable-next-line import/first
import { OxyAccountPicker } from '../../../src/ui/components/signIn/OxyAccountPicker';

const row = (contextId: string, displayName: string, isActive: boolean) => ({
  contextId,
  accountId: contextId,
  displayName,
  handle: displayName.toLowerCase(),
  avatarUrl: undefined,
  color: null,
  isActive,
  isDelegated: false,
  canActivate: true,
});
const principals = [
  {
    principalId: 'p1',
    displayName: 'Ada',
    handle: 'ada',
    avatarUrl: undefined,
    color: null,
    isActive: true,
    contexts: [row('c1', 'Ada', true), row('c2', 'Grace', false)],
  },
];

const renderPicker = (props: Partial<React.ComponentProps<typeof OxyAccountPicker>> = {}) =>
  render(<OxyAccountPicker principals={principals} onSelectContext={jest.fn()} onUseAnother={jest.fn()} {...props} />);

it('checks the current account in its avatar, and only that one', () => {
  renderPicker();
  const ada = screen.getByRole('button', { name: 'Ada' });
  const grace = screen.getByRole('button', { name: 'Grace' });
  expect(ada.querySelector('[data-icon="check"]')).not.toBeNull();
  expect(grace.querySelector('[data-icon="check"]')).toBeNull();
});

it('marks no account current where this origin is signed out', () => {
  renderPicker({ signedOut: true });
  expect(document.querySelector('[data-icon="check"]')).toBeNull();
});

it("spins on the row being activated, and nowhere else", () => {
  renderPicker({ pendingContextId: 'c2', isLoading: true });
  expect(screen.getByRole('button', { name: 'Grace' }).querySelector('[data-testid="spinner-icon"]')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Ada' }).querySelector('[data-testid="spinner-icon"]')).toBeNull();
});

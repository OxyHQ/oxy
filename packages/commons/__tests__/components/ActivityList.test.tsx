import React from 'react';
import { render } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxyhq-services';
import { __resetAsyncStorage } from '@/__mocks__/async-storage';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import { ActivityList } from '@/components/reputation/ActivityList';
import type { ReputationTransaction } from '@oxyhq/contracts';

const TRANSACTIONS: ReputationTransaction[] = [
  {
    id: 'txn-1',
    userId: 'me',
    points: 25,
    actionType: 'real_life_attested',
    category: 'physical',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'txn-2',
    userId: 'me',
    points: -10,
    actionType: 'validation_incorrect',
    category: 'moderation',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function renderList(props: React.ComponentProps<typeof ActivityList>) {
  return render(
    <LocaleProvider>
      <ActivityList {...props} />
    </LocaleProvider>,
  );
}

describe('ActivityList', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetOxyState();
    __setOxyState({ user: { id: 'me', language: 'en-US' } });
  });

  it('renders recent transactions with human labels and signed deltas', () => {
    const { container } = renderList({ transactions: TRANSACTIONS, isLoading: false, isError: false });
    expect(container.textContent).toContain('Real-life confirmation');
    expect(container.textContent).toContain('Incorrect verdict');
    expect(container.textContent).toContain('+25');
    expect(container.textContent).toContain('-10');
  });

  it('renders the empty state when there is no activity', () => {
    const { container } = renderList({ transactions: [], isLoading: false, isError: false });
    expect(container.textContent).toContain('No reputation activity yet');
  });

  it('renders the loading state before any data arrives', () => {
    const { container } = renderList({ transactions: undefined, isLoading: true, isError: false });
    expect(container.textContent).toContain('Loading activity');
  });

  it('renders the error state when the fetch fails with no cache', () => {
    const { container } = renderList({ transactions: undefined, isLoading: false, isError: true });
    expect(container.textContent).toContain("Couldn't load recent activity");
  });
});

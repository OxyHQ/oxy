/**
 * R5-9: while a rotation's encrypted backup is owed, Commons asks for it on the
 * ID tab and in Settings; otherwise the banner is not there.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import { BackupOwedBanner } from '@/components/identity/BackupOwedBanner';

function renderBanner(owed: boolean) {
  __setOxyState({
    isAuthenticated: true,
    oxyServices: {
      updateProfile: jest.fn(async () => undefined),
      'identity.backup.isOwed': jest.fn(async () => owed),
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <BackupOwedBanner />
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

describe('BackupOwedBanner', () => {
  afterEach(() => {
    __resetOxyState();
  });

  it('asks for the backup while it is owed', async () => {
    renderBanner(true);
    expect(await screen.findByTestId('backup-owed-banner')).toBeTruthy();
  });

  it('renders nothing once the backup exists', async () => {
    renderBanner(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('backup-owed-banner')).toBeNull();
  });
});

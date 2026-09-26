/**
 * `DomainsScreen` — request a domain verification, show the proof to publish,
 * verify it, and list what is verified (`oxy.identity.domains.*`).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const INSTRUCTIONS = {
  domain: 'example.com',
  token: 'tok',
  dns: { name: '_oxy.example.com', value: 'oxy-verify=tok' },
  wellKnown: { url: 'https://example.com/.well-known/oxy-verify', body: 'tok' },
};

const domains = {
  list: jest.fn(async () => [] as Array<{ domain: string; verifiedAt: string; method: 'dns-txt' | 'well-known' }>),
  requestVerification: jest.fn(async (_domain: string) => INSTRUCTIONS),
  verify: jest.fn(async (domain: string) => ({
    verified: true,
    domain: { domain, verifiedAt: '2026-09-26T00:00:00.000Z', method: 'dns-txt' as const },
  })),
  remove: jest.fn(async (_domain: string) => ({ success: true })),
};

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({ user: { id: 'u1' }, isAuthenticated: true, oxyServices: { identity: { domains } } }),
}));

jest.mock('../../src/ui/hooks/useI18n', () => ({
  __esModule: true,
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({
  __esModule: true,
  useSurfaceHeader: jest.fn(),
}));

jest.mock('../../src/ui/components/SettingsIcon', () => ({
  __esModule: true,
  SettingsIcon: () => null,
  default: () => null,
}));

import DomainsScreen from '../../src/ui/screens/DomainsScreen';

const renderScreen = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DomainsScreen />
    </QueryClientProvider>,
  );

beforeEach(() => jest.clearAllMocks());

describe('DomainsScreen', () => {
  it('requests a verification, shows both proofs, verifies and refreshes the list', async () => {
    renderScreen();
    fireEvent.change(await screen.findByTestId('domains-input'), { target: { value: 'Example.com ' } });
    fireEvent.click(screen.getByTestId('domains-request'));

    expect((await screen.findByTestId('domains-dns-value')).textContent).toBe('oxy-verify=tok');
    expect(screen.getByTestId('domains-wellknown-url').textContent).toBe(INSTRUCTIONS.wellKnown.url);
    expect(domains.requestVerification).toHaveBeenCalledWith('example.com');

    domains.list.mockResolvedValueOnce([{ domain: 'example.com', verifiedAt: '2026-09-26T00:00:00.000Z', method: 'dns-txt' }]);
    fireEvent.click(screen.getByTestId('domains-verify'));

    await waitFor(() => expect(domains.verify).toHaveBeenCalledWith('example.com'));
    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.queryByTestId('domains-verify')).toBeNull();
  });

  it('keeps the proof on screen when the domain is not verified yet', async () => {
    domains.verify.mockResolvedValueOnce({ verified: false, domain: { domain: 'example.com', verifiedAt: '', method: 'dns-txt' } });
    renderScreen();
    fireEvent.change(await screen.findByTestId('domains-input'), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByTestId('domains-request'));
    fireEvent.click(await screen.findByTestId('domains-verify'));

    await waitFor(() => expect(domains.verify).toHaveBeenCalled());
    expect(screen.getByTestId('domains-verify')).toBeTruthy();
  });
});

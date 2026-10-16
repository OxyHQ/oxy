/**
 * The file details' "Apps with access" section (ADR 0042 stage 4c): lists the
 * applications that can open the file with how they got access, and revokes
 * one only after the person confirms, naming the app.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const listAppAccess = jest.fn();
const revokeAppAccess = jest.fn();

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    oxyServices: { assets: { listAppAccess, revokeAppAccess } },
    activeSessionId: 'session-1',
  }),
}));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  authenticatedApiCall: (_oxy: unknown, _session: unknown, call: () => Promise<unknown>) => call(),
}));

jest.mock('../../src/ui/hooks/useI18n', () => ({
  __esModule: true,
  useI18n: () => ({
    t: (key: string, params?: { name?: string }) => (params?.name ? `${key}[${params.name}]` : key),
    locale: 'en-US',
  }),
}));

import { surfaces } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { FileAppAccessSection } from '../../src/ui/components/fileManagement/FileAppAccessSection';

let confirm: jest.SpyInstance;
let toastSuccess: jest.SpyInstance;
let toastError: jest.SpyInstance;

const apps = [
  {
    applicationId: 'app-syra',
    name: 'Syra',
    icon: null,
    via: ['upload'],
    since: '2026-10-16T00:00:00.000Z',
  },
  {
    applicationId: 'app-alia',
    name: 'Alia',
    icon: 'icon-file-id',
    via: ['upload', 'link'],
    since: '2026-10-15T00:00:00.000Z',
  },
];

const renderSection = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <FileAppAccessSection fileId="file-1" />
    </QueryClientProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  confirm = jest.spyOn(surfaces, 'confirm');
  toastSuccess = jest.spyOn(toast, 'success').mockImplementation(() => undefined as never);
  toastError = jest.spyOn(toast, 'error').mockImplementation(() => undefined as never);
});

afterEach(() => jest.restoreAllMocks());

describe('FileAppAccessSection', () => {
  it('lists each application with how it got access', async () => {
    listAppAccess.mockResolvedValue(apps);
    renderSection();
    expect(await screen.findByText('Syra')).toBeTruthy();
    expect(screen.getByText('Alia')).toBeTruthy();
    expect(screen.getByText('fileManagement.appAccess.via.upload')).toBeTruthy();
    expect(
      screen.getByText('fileManagement.appAccess.via.upload · fileManagement.appAccess.via.link'),
    ).toBeTruthy();
  });

  it('says so when no application has access, and when the list cannot load', async () => {
    listAppAccess.mockResolvedValueOnce([]);
    const { unmount } = renderSection();
    expect(await screen.findByText('fileManagement.appAccess.empty')).toBeTruthy();
    unmount();
    listAppAccess.mockRejectedValueOnce(new Error('offline'));
    renderSection();
    expect(await screen.findByText('fileManagement.appAccess.loadError')).toBeTruthy();
  });

  it('revokes only after the person confirms, naming the app', async () => {
    listAppAccess.mockResolvedValue(apps);
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    revokeAppAccess.mockResolvedValue({
      fileId: 'file-1',
      applicationId: 'app-syra',
      revoked: true,
      streamsRevoked: 0,
    });
    renderSection();
    const button = await screen.findByLabelText('fileManagement.appAccess.a11y.revoke[Syra]');

    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'fileManagement.appAccess.confirm.title[Syra]',
      description: 'fileManagement.appAccess.confirm.message[Syra]',
      destructive: true,
    });
    expect(revokeAppAccess).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(revokeAppAccess).toHaveBeenCalledWith('file-1', 'app-syra'));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('fileManagement.appAccess.toasts.revoked[Syra]'),
    );
  });

  it('tells the person when the revoke fails', async () => {
    listAppAccess.mockResolvedValue(apps);
    confirm.mockResolvedValueOnce(true);
    revokeAppAccess.mockRejectedValueOnce(new Error('offline'));
    renderSection();
    fireEvent.click(await screen.findByLabelText('fileManagement.appAccess.a11y.revoke[Alia]'));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('fileManagement.appAccess.toasts.revokeFailed[Alia]'),
    );
  });
});

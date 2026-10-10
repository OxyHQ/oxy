import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StickersClient } from '../client';
import {
  StickersProvider,
  useInstallStickerPack,
  useInstalledStickerPacks,
  useSticker,
} from '../react';

function fakeClient(overrides: Partial<StickersClient> = {}): StickersClient {
  return {
    listPacks: jest.fn(),
    getPack: jest.fn(),
    getSticker: jest.fn(async (id: string) => ({ id }) as never),
    resolve: jest.fn(),
    search: jest.fn(),
    installedPacks: jest.fn(async () => []),
    install: jest.fn(async () => undefined),
    uninstall: jest.fn(),
    reorder: jest.fn(),
    refOf: jest.fn(),
    ...overrides,
  };
}

function wrapperFor(client: StickersClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <StickersProvider client={client}>{children}</StickersProvider>
    </QueryClientProvider>
  );
}

it('loads a sticker by id, and waits while there is no id', async () => {
  const client = fakeClient();
  const { result, rerender } = renderHook(({ id }: { id: string | null }) => useSticker(id), {
    wrapper: wrapperFor(client),
    initialProps: { id: null as string | null },
  });
  expect(client.getSticker).not.toHaveBeenCalled();
  rerender({ id: 's1' });
  await waitFor(() => expect(result.current.data).toEqual({ id: 's1' }));
});

it('refetches the picker after installing a pack', async () => {
  const client = fakeClient();
  const wrapper = wrapperFor(client);
  const picker = renderHook(() => useInstalledStickerPacks(), { wrapper });
  await waitFor(() => expect(picker.result.current.isSuccess).toBe(true));
  expect(client.installedPacks).toHaveBeenCalledTimes(1);

  const install = renderHook(() => useInstallStickerPack(), { wrapper });
  await act(async () => {
    await install.result.current.mutateAsync('pack-1');
  });
  expect(client.install).toHaveBeenCalledWith('pack-1');
  await waitFor(() => expect(client.installedPacks).toHaveBeenCalledTimes(2));
});

it('says where it must be used when the provider is missing', () => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  expect(() => renderHook(() => useSticker('s1'), { wrapper })).toThrow('StickersProvider');
});

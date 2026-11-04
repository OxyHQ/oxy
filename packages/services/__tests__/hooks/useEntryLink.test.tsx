import { act, renderHook, waitFor } from '@testing-library/react';
import { Linking, Platform } from 'react-native';
import { useEntryLink } from '../../src/ui/hooks/useEntryLink';
import { createMemoryStorage } from '../../src/ui/utils/storageHelpers';

const onError = jest.fn();
let receive: ((event: { url: string }) => void) | undefined;
const originalPlatform = Platform.OS;
beforeEach(() => {
  Platform.OS = 'android';
  onError.mockClear();
  jest.spyOn(Linking, 'addEventListener').mockImplementation((_event, handler) => {
    receive = handler;
    return { remove: jest.fn() };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Platform.OS = originalPlatform;
});

it('persists first-touch once and retains it across new links and remounts', async () => {
  const storage = createMemoryStorage();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('mention://?utm_campaign=first');
  const options = { storage, storageKey: 'campaign', captureCampaign: true, onError };
  const first = renderHook(() => useEntryLink(options));
  await waitFor(() =>
    expect(first.result.current.campaignAttribution).toEqual({ utmCampaign: 'first' }),
  );
  await act(async () => receive?.({ url: 'mention://?lang=es&utm_campaign=second' }));
  expect(first.result.current.url).toContain('lang=es');
  expect(first.result.current.campaignAttribution).toEqual({ utmCampaign: 'first' });
  first.unmount();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('mention://?utm_campaign=third');
  const second = renderHook(() => useEntryLink(options));
  await waitFor(() => expect(second.result.current.campaignReady).toBe(true));
  expect(second.result.current.campaignAttribution).toEqual({ utmCampaign: 'first' });
});

it('keeps initial first-touch when a warm link arrives before getInitialURL resolves, while its language wins', async () => {
  const storage = createMemoryStorage();
  let resolveInitial: ((url: string) => void) | undefined;
  jest.spyOn(Linking, 'getInitialURL').mockReturnValue(
    new Promise((resolve) => {
      resolveInitial = resolve;
    }),
  );
  const screen = renderHook(() =>
    useEntryLink({ storage, storageKey: 'campaign', captureCampaign: true, onError }),
  );
  await act(async () => receive?.({ url: 'mention://?lang=es&utm_campaign=second' }));
  expect(screen.result.current.ready).toBe(false);
  await act(async () => resolveInitial?.('mention://?lang=en&utm_campaign=first'));
  await waitFor(() => expect(screen.result.current.campaignReady).toBe(true));
  expect(screen.result.current.url).toContain('lang=es');
  expect(screen.result.current.campaignAttribution).toEqual({ utmCampaign: 'first' });
});

it('reads languages without storing campaign labels unless the app enables capture', async () => {
  const storage = createMemoryStorage();
  const save = jest.spyOn(storage, 'setItem');
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('mention://?lang=es&utm_source=meta');
  const screen = renderHook(() =>
    useEntryLink({ storage, storageKey: 'campaign', captureCampaign: false, onError }),
  );
  await waitFor(() => expect(screen.result.current.ready).toBe(true));
  expect(screen.result.current.campaignAttribution).toBeUndefined();
  expect(save).not.toHaveBeenCalled();
});

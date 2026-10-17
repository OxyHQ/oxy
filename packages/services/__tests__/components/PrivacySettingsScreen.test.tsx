import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from '@oxy.so/bloom/toast';
import PrivacySettingsScreen from '../../src/ui/screens/PrivacySettingsScreen';
import SearchSettingsScreen from '../../src/ui/screens/SearchSettingsScreen';

let saved: Record<string, boolean>;
const privacy = {
  settings: jest.fn(async () => ({ ...saved })),
  updateSettings: jest.fn(async (patch: Record<string, boolean>) => {
    saved = { ...saved, ...patch };
    return { ...saved };
  }),
  blocked: jest.fn(async () => []),
  restricted: jest.fn(async () => []),
};
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ user: { id: 'owner' }, activeSessionId: 'session', oxyServices: { privacy } }),
}));
jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  authenticatedApiCall: (_client: unknown, _session: unknown, call: () => unknown) => call(),
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({ useSurfaceHeader: () => undefined }));

beforeEach(() => {
  jest.clearAllMocks();
  saved = { isPrivateAccount: false, autoFilter: true, dataSharing: true };
});
function mount(Screen = PrivacySettingsScreen) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
const checked = (index: number) =>
  (screen.getAllByRole('switch')[index] as HTMLInputElement).checked;
async function ready(client: QueryClient) {
  await waitFor(() => expect(client.isFetching()).toBe(0));
}

test('privacy changes survive reopening with a fresh query cache', async () => {
  const view = mount();
  await ready(view.client);
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await waitFor(() =>
    expect(privacy.updateSettings).toHaveBeenCalledWith({ isPrivateAccount: true }, 'owner'),
  );
  await waitFor(() => expect(checked(0)).toBe(true));
  expect(saved.autoFilter).toBe(true);
  view.unmount();
  mount();
  await waitFor(() => expect(checked(0)).toBe(true));
});
test('failed saves roll back and display a toast', async () => {
  privacy.updateSettings.mockRejectedValueOnce(new Error('Save failed'));
  const view = mount();
  await ready(view.client);
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save failed'));
  await waitFor(() => expect(checked(0)).toBe(false));
});
test('search uses the privacy endpoint and retains both changes', async () => {
  const view = mount(SearchSettingsScreen);
  await ready(view.client);
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await waitFor(() =>
    expect(privacy.updateSettings).toHaveBeenCalledWith({ autoFilter: false }, 'owner'),
  );
  await waitFor(() => expect(view.client.isMutating()).toBe(0));
  fireEvent.click(screen.getAllByRole('switch')[1]);
  await waitFor(() =>
    expect(privacy.updateSettings).toHaveBeenCalledWith({ dataSharing: false }, 'owner'),
  );
  expect(saved).toEqual({ isPrivateAccount: false, autoFilter: false, dataSharing: false });
});

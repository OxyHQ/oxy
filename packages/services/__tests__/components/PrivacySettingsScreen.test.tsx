import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DataProvider, Store } from '@oxy.so/bloom-data';
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
/** Each mount is a fresh start: nothing of an earlier read is held. */
function mount(Screen = PrivacySettingsScreen) {
  return render(
    <DataProvider store={new Store()}>
      <Screen />
    </DataProvider>,
  );
}
const checked = (index: number) =>
  (screen.getAllByRole('switch')[index] as HTMLInputElement).checked;
/** The settings were read and the switches show them. */
async function ready() {
  await waitFor(() => expect(privacy.settings).toHaveBeenCalled());
  await screen.findAllByRole('switch');
}

test('privacy changes survive reopening with nothing held', async () => {
  const view = mount();
  await ready();
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
  mount();
  await ready();
  fireEvent.click(screen.getAllByRole('switch')[0]);
  // The person's words for what failed, never the server's English `message`.
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('actionErrors.updatePrivacy'));
  expect(toast.error).not.toHaveBeenCalledWith('Save failed');
  await waitFor(() => expect(checked(0)).toBe(false));
});
test('search uses the privacy endpoint and retains both changes', async () => {
  mount(SearchSettingsScreen);
  await ready();
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await waitFor(() =>
    expect(privacy.updateSettings).toHaveBeenCalledWith({ autoFilter: false }, 'owner'),
  );
  await waitFor(() => expect(checked(0)).toBe(false));
  fireEvent.click(screen.getAllByRole('switch')[1]);
  await waitFor(() =>
    expect(privacy.updateSettings).toHaveBeenCalledWith({ dataSharing: false }, 'owner'),
  );
  expect(saved).toEqual({ isPrivateAccount: false, autoFilter: false, dataSharing: false });
});

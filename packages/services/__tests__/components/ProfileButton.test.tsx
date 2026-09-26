import { fireEvent, render, screen } from '@testing-library/react';
import ProfileButton from '../../src/ui/components/ProfileButton';

const signIn = jest.fn();
const openAccountDialog = jest.fn();
let auth = { user: { id: 'viewer', username: 'ada', name: { displayName: 'Ada' } } as { id: string; username: string; name: { displayName: string } } | null,
  isAuthenticated: true, isAuthResolved: true, isPrivateApiPending: false, signIn };
jest.mock('../../src/ui/hooks/useAuth', () => ({ useAuth: () => auth }));
jest.mock('../../src/ui/context/OxyContext', () => ({ useOxy: () => ({ openAccountDialog, oxyServices: { assets: { publicUrl: () => '' } } }) }));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
jest.mock('../../src/ui/navigation/accountDialogManager', () => ({ registerAccountDialogConsumerHooks: () => () => {} }));
jest.mock('react-native-css/components', () => jest.requireActual('../../__tests__/__mocks__/react-native'));

beforeEach(() => {
  jest.clearAllMocks();
  auth = { user: { id: 'viewer', username: 'ada', name: { displayName: 'Ada' } }, isAuthenticated: true, isAuthResolved: true, isPrivateApiPending: false, signIn };
});

it('shows no interactive account action until authentication resolves', () => {
  auth.isPrivateApiPending = true;
  render(<ProfileButton />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByTestId('skeleton-circle')).toBeTruthy();
});

it('opens the shared account dialog from an expanded identity', () => {
  render(<ProfileButton />);
  fireEvent.click(screen.getByRole('button', { name: 'accountSwitcher.switchWhileSignedInAs' }));
  expect(openAccountDialog).toHaveBeenCalledWith('accounts');
  expect(screen.getByText('Ada')).toBeTruthy();
});

it('keeps a compact circular trigger and its accessible name', () => {
  render(<ProfileButton expanded={false} avatarSize={32} />);
  const button = screen.getByRole('button', { name: 'accountSwitcher.switchWhileSignedInAs' });
  expect(button.style.width).toBe('48px');
  expect(button.style.height).toBe('48px');
  expect(screen.queryByText('Ada')).toBeNull();
  fireEvent.click(button);
  expect(openAccountDialog).toHaveBeenCalledWith('accounts');
});

it('delegates signed-out presses to the existing sign-in flow', () => {
  auth.isAuthenticated = false;
  auth.user = null;
  render(<ProfileButton />);
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.signIn' }));
  expect(signIn).toHaveBeenCalled();
  expect(openAccountDialog).not.toHaveBeenCalled();
});
